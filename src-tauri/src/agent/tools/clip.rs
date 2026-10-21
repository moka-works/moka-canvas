//! The cutting room's tools.
//!
//! Times are integer milliseconds throughout. A planner here changes only what
//! the caller named: moving a clip does not trim it, trimming it does not move
//! it, and every write checks that the track it lands on is not locked. The
//! command layer remains the last word on geometry; what this module does is
//! hand it a complete, valid intention rather than a guess.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::api::{ApiState, ProjectSession};
use crate::clip::jobs::ExportRun;
use crate::domain::{
    now_iso, ClipMove, ClipPatch, ClipPatchEntry, DocumentCommand, MokaFile, TextAlign,
    TextClipData, TextClipStyle, TextPosition, TimelineClip, TimelineDocument,
    TimelineSettingsPatch, TimelineTrack, TimelineTransition, TrackKind, TrackPatch,
    TransitionKind,
};
use crate::generate::{GenerateInput, GenerateRequest, InputRole};
use crate::project::ProjectStore;

use super::super::error::ToolError;
use super::ToolOutcome;
use super::{Args, TaskRef};

pub async fn command(
    state: Option<&ApiState>,
    _root: &std::path::Path,
    moka: &MokaFile,
    name: &str,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    let args = Args::new(name, input)?;
    match name {
        "timeline.list" => {
            let timelines = moka.timelines.as_deref().unwrap_or_default();
            let list: Vec<Value> = timelines
                .iter()
                .map(|timeline| {
                    json!({
                        "id": timeline.id,
                        "name": timeline.name,
                        "durationMs": duration_of(timeline),
                        "clipCount": timeline.clips.len(),
                        "trackCount": timeline.tracks.len(),
                        "updatedAt": timeline.updated_at,
                    })
                })
                .collect();
            Ok(ToolOutcome::read(
                format!("{} timelines", list.len()),
                json!({"timelines": list}),
            ))
        }
        "timeline.get" => {
            let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
            let limit = args.opt_i64("clipLimit").unwrap_or(200).clamp(1, 500) as usize;
            let around = args.opt_i64("aroundMs");
            let window = args.opt_i64("windowMs").unwrap_or(30_000);
            let clips: Vec<Value> = timeline
                .clips
                .iter()
                .filter(|clip| match around {
                    Some(around) => {
                        clip.start_ms <= around + window
                            && clip.start_ms + clip.duration_ms >= around - window
                    }
                    None => true,
                })
                .take(limit)
                .map(clip_value)
                .collect();
            Ok(ToolOutcome::read(
                format!("timeline {} ({})", timeline.name, timeline.clips.len()),
                json!({
                    "timeline": {
                        "id": timeline.id,
                        "name": timeline.name,
                        "settings": timeline.settings,
                        "durationMs": duration_of(timeline),
                        "playheadMs": around,
                    },
                    "tracks": timeline.tracks,
                    "clips": clips,
                    "transitions": timeline.transitions,
                    "truncated": timeline.clips.len() > limit,
                }),
            ))
        }
        "timeline.create" => {
            let timeline_name = args.req_str("name")?.to_string();
            let settings = settings_from(args.opt_object("settings"));
            let tracks = match args.opt_array("tracks") {
                Some(tracks) => tracks
                    .iter()
                    .map(|track| -> Result<TimelineTrack, ToolError> {
                        let kind = track.get("kind").and_then(Value::as_str).unwrap_or("video");
                        let track_name = track.get("name").and_then(Value::as_str).unwrap_or(kind);
                        Ok(track_of(parse_track_kind(kind)?, track_name))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                None => vec![
                    track_of(TrackKind::Video, "V1"),
                    track_of(TrackKind::Audio, "A1"),
                    track_of(TrackKind::Text, "Text"),
                ],
            };
            let now = now_iso();
            let timeline = TimelineDocument {
                id: crate::domain::new_id(),
                name: timeline_name.clone(),
                schema_version: crate::domain::timeline::TIMELINE_SCHEMA_VERSION,
                settings,
                tracks,
                clips: Vec::new(),
                transitions: Vec::new(),
                created_at: now.clone(),
                updated_at: now,
            };
            Ok(ToolOutcome::write(
                format!("Created timeline {timeline_name}"),
                json!({"timelineId": timeline.id}),
                vec![DocumentCommand::AddTimeline {
                    timeline,
                    index: None,
                }],
            ))
        }
        "timeline.update" => {
            let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
            let mut commands = Vec::new();
            if let Some(name) = args.opt_str("name") {
                commands.push(DocumentCommand::RenameTimeline {
                    timeline_id: timeline.id.clone(),
                    name: name.to_string(),
                });
            }
            if let Some(settings) = args.opt_object("settings") {
                let patch: TimelineSettingsPatch =
                    serde_json::from_value(Value::Object(settings.clone())).map_err(|error| {
                        ToolError::validation(format!("settings is not valid: {error}"))
                    })?;
                commands.push(DocumentCommand::UpdateTimelineSettings {
                    timeline_id: timeline.id.clone(),
                    settings: patch,
                });
            }
            if commands.is_empty() {
                return Err(ToolError::validation(
                    "timeline.update needs a name or settings",
                ));
            }
            Ok(ToolOutcome::write(
                format!("Updated timeline {}", timeline.name),
                json!({"timelineId": timeline.id}),
                commands,
            ))
        }
        "timeline.delete" => {
            args.confirmed()?;
            let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
            Ok(ToolOutcome::write(
                format!(
                    "Deleted timeline {} ({} clips)",
                    timeline.name,
                    timeline.clips.len()
                ),
                json!({"timelineId": timeline.id, "clips": timeline.clips.len()}),
                vec![DocumentCommand::RemoveTimeline {
                    timeline_id: timeline.id.clone(),
                }],
            ))
        }
        "timeline.add_track" => {
            let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
            let kind = parse_track_kind(args.req_str("kind")?)?;
            let track = track_of(
                kind,
                args.opt_str("name")
                    .unwrap_or_else(|| default_track_name(kind)),
            );
            let index = args.opt_i64("index").map(|index| index.max(0) as usize);
            Ok(ToolOutcome::write(
                format!("Added {} track", track.name),
                json!({"trackId": track.id, "kind": kind}),
                vec![DocumentCommand::AddTrack {
                    timeline_id: timeline.id.clone(),
                    track,
                    index,
                }],
            ))
        }
        "timeline.update_track" => {
            let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
            let track_id = args.req_str("trackId")?.to_string();
            track_of_id(timeline, &track_id)?;
            let patch = TrackPatch {
                name: args.opt_str("name").map(str::to_string),
                muted: args.raw("muted").and_then(Value::as_bool),
                hidden: args.raw("hidden").and_then(Value::as_bool),
                locked: args.raw("locked").and_then(Value::as_bool),
            };
            Ok(ToolOutcome::write(
                format!("Updated track {track_id}"),
                json!({"trackId": track_id}),
                vec![DocumentCommand::UpdateTrack {
                    timeline_id: timeline.id.clone(),
                    track_id,
                    patch,
                }],
            ))
        }
        "timeline.remove_track" => {
            args.confirmed()?;
            let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
            let track_id = args.req_str("trackId")?.to_string();
            track_of_id(timeline, &track_id)?;
            if timeline.clips.iter().any(|clip| clip.track_id == track_id) {
                return Err(ToolError::new(
                    "TRACK_NOT_EMPTY",
                    "Move or delete the track's clips before removing the track",
                ));
            }
            Ok(ToolOutcome::write(
                format!("Removed track {track_id}"),
                json!({"trackId": track_id}),
                vec![DocumentCommand::RemoveTrack {
                    timeline_id: timeline.id.clone(),
                    track_id,
                }],
            ))
        }
        "clip.add" => clip_add(moka, &args),
        "clip.update" => clip_update(moka, &args),
        "clip.move" => clip_move(moka, &args),
        "clip.trim" => clip_trim(moka, &args),
        "clip.split" => clip_split(moka, &args),
        "clip.remove" => clip_remove(moka, &args),
        "clip.duplicate" => clip_duplicate(moka, &args),
        "clip.align" => clip_align(moka, &args),
        "clip.add_text" => clip_add_text(moka, &args),
        "clip.import_srt" => clip_import_srt(moka, &args),
        "clip.apply_transcript" => {
            let state =
                state.ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
            clip_apply_transcript(state, moka, &args).await
        }
        "clip.add_transition" => clip_add_transition(moka, &args),
        "clip.remove_transition" => clip_remove_transition(moka, &args),
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not a cutting-room command"),
        )),
    }
}

fn duration_of(timeline: &TimelineDocument) -> i64 {
    timeline
        .clips
        .iter()
        .map(|clip| clip.start_ms + clip.duration_ms)
        .max()
        .unwrap_or(0)
}

fn settings_from(
    value: Option<&serde_json::Map<String, Value>>,
) -> crate::domain::TimelineSettings {
    let read = |key: &str, fallback: i64| {
        value
            .and_then(|settings| settings.get(key))
            .and_then(Value::as_i64)
            .unwrap_or(fallback)
    };
    crate::domain::TimelineSettings {
        fps: read("fps", 30) as i32,
        width: read("width", 1920) as i32,
        height: read("height", 1080) as i32,
        background: value
            .and_then(|settings| settings.get("background"))
            .and_then(Value::as_str)
            .unwrap_or("#000000")
            .to_string(),
    }
}

fn parse_track_kind(value: &str) -> Result<TrackKind, ToolError> {
    match value {
        "video" => Ok(TrackKind::Video),
        "audio" => Ok(TrackKind::Audio),
        "text" => Ok(TrackKind::Text),
        other => Err(ToolError::validation(format!(
            "track kind '{other}' is not video, audio, or text"
        ))),
    }
}

fn default_track_name(kind: TrackKind) -> &'static str {
    match kind {
        TrackKind::Video => "V",
        TrackKind::Audio => "A",
        TrackKind::Text => "Text",
    }
}

fn track_of(kind: TrackKind, name: &str) -> TimelineTrack {
    TimelineTrack {
        id: crate::domain::new_id(),
        kind,
        name: name.to_string(),
        muted: false,
        hidden: false,
        locked: false,
        created_at: now_iso(),
    }
}

fn track_of_id<'a>(
    timeline: &'a TimelineDocument,
    id: &str,
) -> Result<&'a TimelineTrack, ToolError> {
    timeline
        .tracks
        .iter()
        .find(|track| track.id == id)
        .ok_or_else(|| ToolError::new("TRACK_NOT_FOUND", format!("track {id} does not exist")))
}

fn clip_of<'a>(timeline: &'a TimelineDocument, id: &str) -> Result<&'a TimelineClip, ToolError> {
    timeline
        .clips
        .iter()
        .find(|clip| clip.id == id)
        .ok_or_else(|| ToolError::new("CLIP_NOT_FOUND", format!("clip {id} does not exist")))
}

fn clip_value(clip: &TimelineClip) -> Value {
    json!({
        "id": clip.id,
        "trackId": clip.track_id,
        "kind": clip.kind,
        "label": clip.label,
        "assetId": clip.asset_id,
        "startMs": clip.start_ms,
        "durationMs": clip.duration_ms,
        "inPointMs": clip.in_point_ms,
        "outPointMs": clip.out_point_ms,
        "speed": clip.speed,
        "volume": clip.volume,
        "fadeInMs": clip.fade_in_ms,
        "fadeOutMs": clip.fade_out_ms,
        "muted": clip.muted,
        "opacity": clip.opacity,
        "filter": clip.filter,
        "adjust": clip.adjust,
        "text": clip.text,
    })
}

fn ensure_unlocked(timeline: &TimelineDocument, track_id: &str) -> Result<(), ToolError> {
    let track = track_of_id(timeline, track_id)?;
    if track.locked {
        return Err(ToolError::new(
            "TRACK_LOCKED",
            format!("track {} is locked", track.name),
        ));
    }
    Ok(())
}

fn validate_no_overlap(
    timeline: &TimelineDocument,
    track_id: &str,
    start: i64,
    duration: i64,
    skip: Option<&str>,
) -> Result<(), ToolError> {
    let end = start + duration;
    for clip in &timeline.clips {
        if clip.track_id != track_id || Some(clip.id.as_str()) == skip {
            continue;
        }
        let other_end = clip.start_ms + clip.duration_ms;
        let overlap_start = start.max(clip.start_ms);
        let overlap_end = end.min(other_end);
        if overlap_start < overlap_end {
            // A transition is a deliberate overlap: the follower sits inside
            // the leader's tail by exactly the window the seam names.
            let overlap = overlap_end - overlap_start;
            let covered_by_seam = timeline.transitions.iter().any(|transition| {
                transition.duration_ms >= overlap
                    && (transition.after_clip_id == clip.id || transition.after_clip_id == track_id)
            });
            if !covered_by_seam {
                return Err(ToolError::new(
                    "CLIP_OVERLAP",
                    format!(
                        "that position overlaps \"{}\" on the same track",
                        clip.label
                    ),
                )
                .details(json!({"clipId": clip.id})));
            }
        }
    }
    Ok(())
}

fn pick_track(
    timeline: &TimelineDocument,
    kind: TrackKind,
    start: i64,
    duration: i64,
) -> Result<String, ToolError> {
    for track in &timeline.tracks {
        if track.kind == kind
            && !track.locked
            && validate_no_overlap(timeline, &track.id, start, duration, None).is_ok()
        {
            return Ok(track.id.clone());
        }
    }
    Err(ToolError::new(
        "NO_TRACK_FOR_KIND",
        format!(
            "no free {} track at that position; add a track first",
            kind.as_str()
        ),
    ))
}

fn clip_add(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let kind = match args.req_str("kind")? {
        "video" | "image" => TrackKind::Video,
        "audio" => TrackKind::Audio,
        "text" => TrackKind::Text,
        other => {
            return Err(ToolError::validation(format!(
                "clip kind '{other}' is not video, image, audio, or text"
            )))
        }
    };
    let start = args.req_i64("startMs")?;
    let (label, asset_id, source_duration) = match args.opt_str("assetId") {
        Some(asset_id) => {
            let entry = moka.resources.find(asset_id).ok_or_else(|| {
                ToolError::new(
                    "ASSET_NOT_FOUND",
                    format!("asset {asset_id} is not in this project"),
                )
            })?;
            if !asset_fits(entry.path.as_str(), kind) {
                return Err(ToolError::validation(format!(
                    "{} cannot be placed on a {} track",
                    entry.name,
                    kind.as_str()
                )));
            }
            (
                entry.name.clone(),
                Some(asset_id.to_string()),
                entry
                    .probe
                    .as_ref()
                    .and_then(|probe| probe.duration_ms)
                    .unwrap_or(5_000),
            )
        }
        None => {
            if kind != TrackKind::Text {
                return Err(ToolError::validation("clip.add needs an assetId"));
            }
            ("Text".to_string(), None, 3_000)
        }
    };
    let duration = args
        .opt_i64("durationMs")
        .unwrap_or(source_duration.max(100));
    let in_point = args.opt_i64("inPointMs").unwrap_or(0);
    let speed = args.opt_f64("speed").unwrap_or(1.0);
    let out_point = args
        .opt_i64("outPointMs")
        .unwrap_or(in_point + (duration as f64 * speed).round() as i64);
    if out_point <= in_point {
        return Err(ToolError::validation(
            "a clip's out point must follow its in point",
        ));
    }
    if (duration as f64 * speed).round() as i64 != out_point - in_point {
        return Err(ToolError::validation(
            "duration, speed, and source points must agree: round(duration * speed) = out - in",
        ));
    }
    let track_id = match args.opt_str("trackId") {
        Some(track_id) => {
            let track = track_of_id(timeline, track_id)?;
            if track.kind != kind {
                return Err(ToolError::validation(format!(
                    "{} clips cannot go on a {} track",
                    kind.as_str(),
                    track.kind.as_str()
                )));
            }
            ensure_unlocked(timeline, track_id)?;
            validate_no_overlap(timeline, track_id, start, duration, None)?;
            track_id.to_string()
        }
        None => pick_track(timeline, kind, start, duration)?,
    };
    let now = now_iso();
    let text = if kind == TrackKind::Text {
        let text = args
            .opt_object("text")
            .ok_or_else(|| ToolError::validation("a text clip needs text"))?;
        Some(text_clip_from(text)?)
    } else {
        None
    };
    let clip = TimelineClip {
        id: crate::domain::new_id(),
        track_id: track_id.clone(),
        kind,
        label,
        start_ms: start,
        duration_ms: duration,
        in_point_ms: in_point,
        out_point_ms: out_point,
        speed,
        volume: args.opt_f64("volume").unwrap_or(1.0),
        fade_in_ms: 0,
        fade_out_ms: 0,
        muted: false,
        opacity: 1.0,
        created_at: now.clone(),
        updated_at: now,
        asset_id,
        adjust: None,
        filter: None,
        text,
    };
    Ok(ToolOutcome::write(
        format!("Added \"{}\" at {start} ms", clip.label),
        json!({"clipId": clip.id, "trackId": track_id}),
        vec![DocumentCommand::AddClips {
            timeline_id: timeline.id.clone(),
            clips: vec![clip],
            seams: None,
        }],
    ))
}

fn asset_fits(path: &str, kind: TrackKind) -> bool {
    let category = path.split('/').nth(1).unwrap_or_default();
    match kind {
        TrackKind::Video => matches!(category, "videos" | "images"),
        TrackKind::Audio => matches!(category, "music" | "voice"),
        TrackKind::Text => category == "texts",
    }
}

fn text_clip_from(value: &serde_json::Map<String, Value>) -> Result<TextClipData, ToolError> {
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let style = match value.get("style").and_then(Value::as_object) {
        Some(style) => serde_json::from_value(Value::Object(style.clone()))
            .map_err(|error| ToolError::validation(format!("text style is not valid: {error}")))?,
        None => default_text_style(),
    };
    Ok(TextClipData { content, style })
}

fn default_text_style() -> TextClipStyle {
    TextClipStyle {
        font_family: "Inter".into(),
        font_size: 48,
        color: "#ffffff".into(),
        bold: false,
        italic: false,
        align: TextAlign::Center,
        position: TextPosition::Bottom,
        background: None,
        stroke_width: 0,
        stroke_color: "#000000".into(),
    }
}

fn clip_update(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let clip_id = args.req_str("clipId")?;
    let clip = clip_of(timeline, clip_id)?;
    ensure_unlocked(timeline, &clip.track_id)?;
    let patch = args
        .opt_object("patch")
        .ok_or_else(|| ToolError::validation("clip.update needs a patch"))?;
    if patch.contains_key("text") && clip.kind != TrackKind::Text {
        return Err(ToolError::validation("text can only be set on a text clip"));
    }
    for forbidden in [
        "startMs",
        "durationMs",
        "inPointMs",
        "outPointMs",
        "speed",
        "trackId",
    ] {
        if patch.contains_key(forbidden) {
            return Err(ToolError::validation(format!(
                "{forbidden} is changed with clip.move or clip.trim, not clip.update"
            )));
        }
    }
    let patch: ClipPatch = serde_json::from_value(Value::Object(patch.clone()))
        .map_err(|error| ToolError::validation(format!("patch is not valid: {error}")))?;
    Ok(ToolOutcome::write(
        format!("Updated clip {}", clip.label),
        json!({"clipId": clip.id}),
        vec![DocumentCommand::UpdateClips {
            timeline_id: timeline.id.clone(),
            patches: vec![ClipPatchEntry {
                clip_id: clip.id.clone(),
                patch,
            }],
        }],
    ))
}

fn clip_move(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let mut moves = Vec::new();
    for movement in args.req_array("moves")? {
        let clip_id = movement
            .get("clipId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::validation("every move needs clipId"))?;
        let clip = clip_of(timeline, clip_id)?;
        ensure_unlocked(timeline, &clip.track_id)?;
        let start = movement
            .get("startMs")
            .and_then(Value::as_i64)
            .unwrap_or(clip.start_ms);
        if start < 0 {
            return Err(ToolError::validation("a clip cannot start before zero"));
        }
        let track_id = movement
            .get("trackId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| clip.track_id.clone());
        let track = track_of_id(timeline, &track_id)?;
        if track.kind != clip.kind {
            return Err(ToolError::validation(
                "a clip cannot move to a track of another kind",
            ));
        }
        ensure_unlocked(timeline, &track_id)?;
        validate_no_overlap(timeline, &track_id, start, clip.duration_ms, Some(&clip.id))?;
        moves.push(ClipMove {
            clip_id: clip.id.clone(),
            start_ms: start,
            track_id: Some(track_id),
        });
    }
    Ok(ToolOutcome::write(
        format!("Moved {} clips", moves.len()),
        json!({"moved": moves.len()}),
        vec![DocumentCommand::MoveClips {
            timeline_id: timeline.id.clone(),
            moves,
        }],
    ))
}

fn clip_trim(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let mut patches = Vec::new();
    for edit in args.req_array("edits")? {
        let clip_id = edit
            .get("clipId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::validation("every edit needs clipId"))?;
        let clip = clip_of(timeline, clip_id)?;
        ensure_unlocked(timeline, &clip.track_id)?;
        let in_point = edit
            .get("inPointMs")
            .and_then(Value::as_i64)
            .unwrap_or(clip.in_point_ms);
        let speed = edit
            .get("speed")
            .and_then(Value::as_f64)
            .unwrap_or(clip.speed);
        let (duration, out_point) = match (
            edit.get("durationMs").and_then(Value::as_i64),
            edit.get("outPointMs").and_then(Value::as_i64),
        ) {
            (Some(duration), Some(out)) => (duration, out),
            (Some(duration), None) => (
                duration,
                in_point + (duration as f64 * speed).round() as i64,
            ),
            (None, Some(out)) => {
                if out <= in_point {
                    return Err(ToolError::validation(
                        "clip.trim's out point must follow its in point",
                    ));
                }
                ((((out - in_point) as f64) / speed).round() as i64, out)
            }
            (None, None) => (
                clip.duration_ms,
                in_point + (clip.duration_ms as f64 * speed).round() as i64,
            ),
        };
        if duration < 100 {
            return Err(ToolError::validation(
                "a clip cannot be shorter than 100 ms",
            ));
        }
        if out_point <= in_point {
            return Err(ToolError::validation(
                "a clip's out point must follow its in point",
            ));
        }
        if (duration as f64 * speed).round() as i64 != out_point - in_point {
            return Err(ToolError::validation(
                "duration, speed, and source points must agree",
            ));
        }
        let start = edit
            .get("startMs")
            .and_then(Value::as_i64)
            .unwrap_or(clip.start_ms);
        validate_no_overlap(timeline, &clip.track_id, start, duration, Some(&clip.id))?;
        patches.push(ClipPatchEntry {
            clip_id: clip.id.clone(),
            patch: ClipPatch {
                start_ms: Some(start),
                duration_ms: Some(duration),
                in_point_ms: Some(in_point),
                out_point_ms: Some(out_point),
                speed: Some(speed),
                ..empty_patch()
            },
        });
    }
    Ok(ToolOutcome::write(
        format!("Trimmed {} clips", patches.len()),
        json!({"trimmed": patches.len()}),
        vec![DocumentCommand::UpdateClips {
            timeline_id: timeline.id.clone(),
            patches,
        }],
    ))
}

fn empty_patch() -> ClipPatch {
    serde_json::from_value(json!({})).expect("an empty patch is valid")
}

fn clip_split(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let at = args.req_i64("atMs")?;
    let clip_ids = args.req_strings("clipIds")?;
    let keep = args.opt_bool("keepTransitions", true);
    let mut remove_transitions = Vec::new();
    let mut add_transitions = Vec::new();
    let mut remove_clips = Vec::new();
    let mut add_clips = Vec::new();
    let now = now_iso();
    for clip_id in &clip_ids {
        let clip = clip_of(timeline, clip_id)?;
        ensure_unlocked(timeline, &clip.track_id)?;
        if at <= clip.start_ms || at >= clip.start_ms + clip.duration_ms {
            continue;
        }
        let offset = at - clip.start_ms;
        let source_offset = (offset as f64 * clip.speed).round() as i64;
        let mut left = clip.clone();
        left.id = crate::domain::new_id();
        left.duration_ms = offset;
        left.out_point_ms = clip.in_point_ms + source_offset;
        left.updated_at = now.clone();
        let mut right = clip.clone();
        right.id = crate::domain::new_id();
        right.start_ms = at;
        right.in_point_ms = left.out_point_ms;
        right.out_point_ms = clip.out_point_ms;
        right.duration_ms =
            (((right.out_point_ms - right.in_point_ms) as f64) / clip.speed).round() as i64;
        right.updated_at = now.clone();
        if clip.kind == TrackKind::Text {
            // A text clip's source window is its own duration: a split gives
            // each half a fresh window rather than a slice of the other's.
            left.in_point_ms = 0;
            left.out_point_ms = left.duration_ms;
            right.in_point_ms = 0;
            right.out_point_ms = right.duration_ms;
        }
        remove_clips.push(clip.id.clone());
        add_clips.push(left);
        add_clips.push(right.clone());
        for transition in &timeline.transitions {
            if transition.after_clip_id == clip.id {
                remove_transitions.push(transition.id.clone());
                if keep {
                    let mut rebuilt = transition.clone();
                    rebuilt.id = crate::domain::new_id();
                    rebuilt.after_clip_id = right.id.clone();
                    rebuilt.created_at = now.clone();
                    add_transitions.push(rebuilt);
                }
            }
        }
    }
    if add_clips.is_empty() {
        return Err(ToolError::validation(
            "no clip crosses the requested split point",
        ));
    }
    let mut commands = Vec::new();
    if !remove_transitions.is_empty() {
        commands.push(DocumentCommand::RemoveTransitions {
            timeline_id: timeline.id.clone(),
            transition_ids: remove_transitions,
        });
    }
    commands.push(DocumentCommand::RemoveClips {
        timeline_id: timeline.id.clone(),
        clip_ids: remove_clips,
    });
    commands.push(DocumentCommand::AddClips {
        timeline_id: timeline.id.clone(),
        clips: add_clips.clone(),
        seams: None,
    });
    if !add_transitions.is_empty() {
        commands.push(DocumentCommand::AddTransitions {
            timeline_id: timeline.id.clone(),
            transitions: add_transitions,
        });
    }
    Ok(ToolOutcome::write(
        format!("Split {} clips at {at} ms", add_clips.len() / 2),
        json!({"clipIds": add_clips.iter().map(|clip| clip.id.clone()).collect::<Vec<_>>()}),
        commands,
    ))
}

fn clip_remove(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    args.confirmed()?;
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let clip_ids = args.req_strings("clipIds")?;
    for id in &clip_ids {
        let clip = clip_of(timeline, id)?;
        ensure_unlocked(timeline, &clip.track_id)?;
    }
    let labels: Vec<&str> = timeline
        .clips
        .iter()
        .filter(|clip| clip_ids.contains(&clip.id))
        .map(|clip| clip.label.as_str())
        .collect();
    let transition_ids: Vec<String> = timeline
        .transitions
        .iter()
        .filter(|transition| clip_ids.contains(&transition.after_clip_id))
        .map(|transition| transition.id.clone())
        .collect();
    let mut commands = Vec::new();
    if !transition_ids.is_empty() {
        commands.push(DocumentCommand::RemoveTransitions {
            timeline_id: timeline.id.clone(),
            transition_ids,
        });
    }
    commands.push(DocumentCommand::RemoveClips {
        timeline_id: timeline.id.clone(),
        clip_ids: clip_ids.clone(),
    });
    Ok(ToolOutcome::write(
        format!("Deleted {} clips: {}", clip_ids.len(), labels.join(", ")),
        json!({"clipIds": clip_ids}),
        commands,
    ))
}

fn clip_duplicate(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let clip_ids = args.req_strings("clipIds")?;
    let target = args.opt_str("trackId");
    let now = now_iso();
    let mut copies = Vec::new();
    for clip_id in &clip_ids {
        let clip = clip_of(timeline, clip_id)?;
        ensure_unlocked(timeline, &clip.track_id)?;
        let track_id = target.unwrap_or(&clip.track_id).to_string();
        let track = track_of_id(timeline, &track_id)?;
        if track.kind != clip.kind {
            return Err(ToolError::validation(
                "a copy must land on a track of the same kind",
            ));
        }
        let start = match args.opt_i64("offsetMs") {
            Some(offset) => clip.start_ms + offset,
            None => next_free_start(
                timeline,
                &track_id,
                clip.start_ms + clip.duration_ms,
                clip.duration_ms,
            ),
        };
        validate_no_overlap(timeline, &track_id, start, clip.duration_ms, None)?;
        let mut copy = clip.clone();
        copy.id = crate::domain::new_id();
        copy.track_id = track_id;
        copy.start_ms = start;
        copy.created_at = now.clone();
        copy.updated_at = now.clone();
        copies.push(copy);
    }
    let ids: Vec<String> = copies.iter().map(|clip| clip.id.clone()).collect();
    Ok(ToolOutcome::write(
        format!("Copied {} clips", copies.len()),
        json!({"clipIds": ids}),
        vec![DocumentCommand::AddClips {
            timeline_id: timeline.id.clone(),
            clips: copies,
            seams: None,
        }],
    ))
}

/// The first moment at or after `from` where a clip of this length fits.
fn next_free_start(timeline: &TimelineDocument, track_id: &str, from: i64, duration: i64) -> i64 {
    let mut start = from;
    loop {
        let hit = timeline
            .clips
            .iter()
            .filter(|clip| clip.track_id == track_id && clip.start_ms < start + duration)
            .max_by_key(|clip| clip.start_ms);
        match hit {
            Some(clip) if clip.start_ms + clip.duration_ms > start => {
                start = clip.start_ms + clip.duration_ms;
            }
            _ => return start,
        }
    }
}

fn clip_align(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let clip_ids = args.req_strings("clipIds")?;
    let mode = args.req_str("mode")?;
    let clips: Vec<&TimelineClip> = clip_ids
        .iter()
        .map(|id| clip_of(timeline, id))
        .collect::<Result<Vec<_>, _>>()?;
    for clip in &clips {
        ensure_unlocked(timeline, &clip.track_id)?;
    }
    let target = match mode {
        "start" => clips.iter().map(|clip| clip.start_ms).min().unwrap_or(0),
        "end" => {
            let end = clips
                .iter()
                .map(|clip| clip.start_ms + clip.duration_ms)
                .max()
                .unwrap_or(0);
            end - clips.iter().map(|clip| clip.duration_ms).max().unwrap_or(0)
        }
        "playhead" => args.req_i64("anchorMs")?,
        other => {
            return Err(ToolError::validation(format!(
                "align mode '{other}' is not start, end, or playhead"
            )))
        }
    };
    let moves = clips
        .iter()
        .map(|clip| ClipMove {
            clip_id: clip.id.clone(),
            start_ms: target.max(0),
            track_id: None,
        })
        .collect::<Vec<_>>();
    Ok(ToolOutcome::write(
        format!("Aligned {} clips", moves.len()),
        json!({"moved": moves.len()}),
        vec![DocumentCommand::MoveClips {
            timeline_id: timeline.id.clone(),
            moves,
        }],
    ))
}

fn clip_add_text(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let start = args.req_i64("startMs")?;
    let duration = args.req_i64("durationMs")?;
    if duration < 100 {
        return Err(ToolError::validation(
            "a text clip cannot be shorter than 100 ms",
        ));
    }
    let track_id = match args.opt_str("trackId") {
        Some(track_id) => {
            let track = track_of_id(timeline, track_id)?;
            if track.kind != TrackKind::Text {
                return Err(ToolError::validation("a text clip needs a text track"));
            }
            ensure_unlocked(timeline, track_id)?;
            validate_no_overlap(timeline, track_id, start, duration, None)?;
            track_id.to_string()
        }
        None => pick_track(timeline, TrackKind::Text, start, duration)?,
    };
    let text = TextClipData {
        content: args.req_str("content")?.to_string(),
        style: match args.opt_object("style") {
            Some(style) => serde_json::from_value(Value::Object(style.clone()))
                .map_err(|error| ToolError::validation(format!("style is not valid: {error}")))?,
            None => default_text_style(),
        },
    };
    let now = now_iso();
    let clip = TimelineClip {
        id: crate::domain::new_id(),
        track_id: track_id.clone(),
        kind: TrackKind::Text,
        label: text.content.chars().take(30).collect(),
        start_ms: start,
        duration_ms: duration,
        in_point_ms: 0,
        out_point_ms: duration,
        speed: 1.0,
        volume: 1.0,
        fade_in_ms: 0,
        fade_out_ms: 0,
        muted: false,
        opacity: 1.0,
        created_at: now.clone(),
        updated_at: now,
        asset_id: None,
        adjust: None,
        filter: None,
        text: Some(text),
    };
    Ok(ToolOutcome::write(
        format!("Added text \"{}\"", clip.label),
        json!({"clipId": clip.id, "trackId": track_id}),
        vec![DocumentCommand::AddClips {
            timeline_id: timeline.id.clone(),
            clips: vec![clip],
            seams: None,
        }],
    ))
}

struct Cue {
    start_ms: i64,
    end_ms: i64,
    text: String,
}

fn parse_srt(srt: &str) -> Result<Vec<Cue>, ToolError> {
    let mut cues = Vec::new();
    for block in srt.replace("\r\n", "\n").split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let mut lines = block.lines();
        let first = lines.next().unwrap_or_default().trim();
        let time_line = if first.contains("-->") {
            first
        } else {
            lines.next().unwrap_or_default().trim()
        };
        let Some((start, end)) = time_line.split_once("-->") else {
            return Err(ToolError::validation(format!(
                "a subtitle block has no time range: {block}"
            )));
        };
        let start_ms = parse_srt_time(start.trim())?;
        let end_ms = parse_srt_time(end.trim())?;
        if end_ms <= start_ms {
            return Err(ToolError::validation("a subtitle ends before it starts"));
        }
        let text = lines.collect::<Vec<_>>().join("\n").trim().to_string();
        if text.is_empty() {
            continue;
        }
        cues.push(Cue {
            start_ms,
            end_ms,
            text,
        });
    }
    if cues.is_empty() {
        return Err(ToolError::validation("the SRT has no subtitles"));
    }
    Ok(cues)
}

fn parse_srt_time(value: &str) -> Result<i64, ToolError> {
    let value = value.replace(',', ".");
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 3 {
        return Err(ToolError::validation(format!(
            "'{value}' is not a subtitle time"
        )));
    }
    let hours: i64 = parts[0]
        .parse()
        .map_err(|_| ToolError::validation("bad subtitle hours"))?;
    let minutes: i64 = parts[1]
        .parse()
        .map_err(|_| ToolError::validation("bad subtitle minutes"))?;
    let seconds: f64 = parts[2]
        .parse()
        .map_err(|_| ToolError::validation("bad subtitle seconds"))?;
    Ok(hours * 3_600_000 + minutes * 60_000 + (seconds * 1000.0).round() as i64)
}

fn serialize_srt(timeline: &TimelineDocument, track_id: &str) -> Result<String, ToolError> {
    let mut clips: Vec<&TimelineClip> = timeline
        .clips
        .iter()
        .filter(|clip| clip.track_id == track_id && clip.kind == TrackKind::Text)
        .collect();
    if clips.is_empty() {
        return Err(ToolError::new(
            "NO_TEXT_CLIPS",
            "That track holds no text clips",
        ));
    }
    clips.sort_by_key(|clip| clip.start_ms);
    let mut out = String::new();
    for (index, clip) in clips.iter().enumerate() {
        let content = clip
            .text
            .as_ref()
            .map(|text| text.content.as_str())
            .unwrap_or(&clip.label);
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            srt_time(clip.start_ms),
            srt_time(clip.start_ms + clip.duration_ms),
            content
        ));
    }
    Ok(out)
}

fn srt_time(ms: i64) -> String {
    let ms = ms.max(0);
    let hours = ms / 3_600_000;
    let minutes = (ms % 3_600_000) / 60_000;
    let seconds = (ms % 60_000) / 1000;
    let millis = ms % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn clip_import_srt(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let srt = args.req_str("srt")?;
    if srt.len() > 1024 * 1024 {
        return Err(ToolError::validation("the SRT is larger than 1 MB"));
    }
    let cues = parse_srt(srt)?;
    let track_name = args.opt_str("trackName").unwrap_or("Subtitles");
    let track = timeline
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Text && track.name == track_name)
        .cloned()
        .unwrap_or_else(|| track_of(TrackKind::Text, track_name));
    let now = now_iso();
    let clips: Vec<TimelineClip> = cues
        .into_iter()
        .map(|cue| TimelineClip {
            id: crate::domain::new_id(),
            track_id: track.id.clone(),
            kind: TrackKind::Text,
            label: cue.text.chars().take(30).collect(),
            start_ms: cue.start_ms,
            duration_ms: cue.end_ms - cue.start_ms,
            in_point_ms: 0,
            out_point_ms: cue.end_ms - cue.start_ms,
            speed: 1.0,
            volume: 1.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            muted: false,
            opacity: 1.0,
            created_at: now.clone(),
            updated_at: now.clone(),
            asset_id: None,
            adjust: None,
            filter: None,
            text: Some(TextClipData {
                content: cue.text,
                style: default_text_style(),
            }),
        })
        .collect();
    let mut commands = Vec::new();
    if !timeline
        .tracks
        .iter()
        .any(|existing| existing.id == track.id)
    {
        commands.push(DocumentCommand::AddTrack {
            timeline_id: timeline.id.clone(),
            track: track.clone(),
            index: None,
        });
    }
    let count = clips.len();
    commands.push(DocumentCommand::AddClips {
        timeline_id: timeline.id.clone(),
        clips,
        seams: None,
    });
    Ok(ToolOutcome::write(
        format!("Imported {count} subtitles"),
        json!({"trackId": track.id, "cues": count}),
        commands,
    ))
}

async fn clip_apply_transcript(
    state: &ApiState,
    moka: &MokaFile,
    args: &Args<'_>,
) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let source = clip_of(timeline, args.req_str("sourceClipId")?)?;
    let task_id = args.req_str("taskId")?;
    let cached = state.agent_tasks.lock().await.get(task_id).cloned();
    let text = args
        .opt_str("text")
        .map(str::to_string)
        .or_else(|| {
            cached
                .as_ref()
                .and_then(|status| status.pointer("/result/text"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| {
            ToolError::validation(format!(
                "task {task_id} has no transcript yet; poll task.get until it succeeds"
            ))
        })?;
    let text = &text;
    let cues = split_cues(text, source.start_ms, source.duration_ms);
    if cues.is_empty() {
        return Err(ToolError::new("NO_TEXT_CLIPS", "the transcript is empty"));
    }
    let track_name = args.opt_str("trackName").unwrap_or("Subtitles");
    let existing = timeline
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Text && track.name == track_name)
        .cloned();
    let track = existing
        .clone()
        .unwrap_or_else(|| track_of(TrackKind::Text, track_name));
    let mut commands = Vec::new();
    if existing.is_none() {
        commands.push(DocumentCommand::AddTrack {
            timeline_id: timeline.id.clone(),
            track: track.clone(),
            index: None,
        });
    } else if args.opt_bool("replaceExisting", false) {
        args.confirmed()?;
        let old: Vec<String> = timeline
            .clips
            .iter()
            .filter(|clip| clip.track_id == track.id)
            .map(|clip| clip.id.clone())
            .collect();
        if !old.is_empty() {
            commands.push(DocumentCommand::RemoveClips {
                timeline_id: timeline.id.clone(),
                clip_ids: old,
            });
        }
    }
    let now = now_iso();
    let clips: Vec<TimelineClip> = cues
        .into_iter()
        .map(|cue| TimelineClip {
            id: crate::domain::new_id(),
            track_id: track.id.clone(),
            kind: TrackKind::Text,
            label: cue.text.chars().take(30).collect(),
            start_ms: cue.start_ms,
            duration_ms: cue.end_ms - cue.start_ms,
            in_point_ms: 0,
            out_point_ms: cue.end_ms - cue.start_ms,
            speed: 1.0,
            volume: 1.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            muted: false,
            opacity: 1.0,
            created_at: now.clone(),
            updated_at: now.clone(),
            asset_id: None,
            adjust: None,
            filter: None,
            text: Some(TextClipData {
                content: cue.text,
                style: default_text_style(),
            }),
        })
        .collect();
    let count = clips.len();
    commands.push(DocumentCommand::AddClips {
        timeline_id: timeline.id.clone(),
        clips,
        seams: None,
    });
    Ok(ToolOutcome::write(
        format!("Wrote {count} subtitle cues"),
        json!({"trackId": track.id, "cues": count}),
        commands,
    ))
}

fn split_cues(text: &str, start_ms: i64, duration_ms: i64) -> Vec<Cue> {
    let sentences: Vec<String> = text
        .split(['。', '！', '？', '!', '?', '\n'])
        .map(str::trim)
        .filter(|sentence| !sentence.is_empty())
        .map(str::to_string)
        .collect();
    let sentences = if sentences.is_empty() {
        vec![text.trim().to_string()]
    } else {
        sentences
    };
    let total: usize = sentences
        .iter()
        .map(|sentence| sentence.chars().count().max(1))
        .sum();
    let mut cursor = start_ms;
    let mut cues = Vec::new();
    for sentence in sentences {
        let share = sentence.chars().count().max(1) as f64 / total as f64;
        let cue_duration = ((duration_ms as f64 * share).round() as i64).max(300);
        cues.push(Cue {
            start_ms: cursor,
            end_ms: (cursor + cue_duration).min(start_ms + duration_ms),
            text: sentence,
        });
        cursor += cue_duration;
    }
    cues
}

fn clip_add_transition(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let after = clip_of(timeline, args.req_str("afterClipId")?)?;
    ensure_unlocked(timeline, &after.track_id)?;
    let duration = args.opt_i64("durationMs").unwrap_or(600);
    if !(200..=2000).contains(&duration) {
        return Err(ToolError::validation(
            "a transition window is between 200 and 2000 ms",
        ));
    }
    let kind: TransitionKind = serde_json::from_value(json!(args.req_str("kind")?))
        .map_err(|_| ToolError::validation("unknown transition kind"))?;
    let transition = TimelineTransition {
        id: crate::domain::new_id(),
        after_clip_id: after.id.clone(),
        kind,
        duration_ms: duration,
        created_at: now_iso(),
    };
    Ok(ToolOutcome::write(
        format!("Added a {} ms transition", duration),
        json!({"transitionId": transition.id}),
        vec![DocumentCommand::AddTransitions {
            timeline_id: timeline.id.clone(),
            transitions: vec![transition],
        }],
    ))
}

fn clip_remove_transition(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
    let id = args.req_str("transitionId")?.to_string();
    let transition = timeline
        .transitions
        .iter()
        .find(|transition| transition.id == id)
        .ok_or_else(|| {
            ToolError::new(
                "TRANSITION_NOT_FOUND",
                format!("transition {id} does not exist"),
            )
        })?;
    if let Some(clip) = timeline
        .clips
        .iter()
        .find(|clip| clip.id == transition.after_clip_id)
    {
        ensure_unlocked(timeline, &clip.track_id)?;
    }
    Ok(ToolOutcome::write(
        "Removed the transition",
        json!({"transitionId": id}),
        vec![DocumentCommand::RemoveTransitions {
            timeline_id: timeline.id.clone(),
            transition_ids: vec![id],
        }],
    ))
}

/// Effects in the cutting room: recognition, export, and a path import that
/// belongs to the asset tools but is served by the same clip capability probe.
pub async fn effect(
    state: &ApiState,
    session: &ProjectSession,
    name: &str,
    input: &Value,
    moka: &MokaFile,
) -> Result<ToolOutcome, ToolError> {
    match name {
        "clip.transcribe" => {
            let args = Args::new(name, input)?;
            let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
            let clip = clip_of(timeline, args.req_str("clipId")?)?;
            let Some(asset_id) = clip.asset_id.clone() else {
                return Err(ToolError::validation("the clip has no audio"));
            };
            if clip.kind == TrackKind::Text {
                return Err(ToolError::validation("a text clip has no audio"));
            }
            let request = GenerateRequest {
                capability: crate::domain::Capability::Asr,
                model: String::new(),
                inputs: vec![GenerateInput {
                    role: InputRole::Reference,
                    asset_id,
                    window: Some(crate::generate::InputWindow {
                        start_ms: clip.in_point_ms.max(0) as u64,
                        duration_ms: (clip.out_point_ms - clip.in_point_ms).max(0) as u64,
                    }),
                }],
                params: args
                    .opt_str("language")
                    .map(|language| {
                        let mut params = serde_json::Map::new();
                        params.insert("language".into(), json!(language));
                        params
                    })
                    .unwrap_or_default(),
                ..GenerateRequest::default()
            };
            let task = state
                .gateway
                .transcribe(&session.0, request, &crate::generate::Cancel::new())
                .await?;
            Ok(ToolOutcome {
                summary: "Started speech recognition".into(),
                data: json!({"clipId": clip.id, "taskId": task.id}),
                task: Some(TaskRef {
                    kind: "asr".into(),
                    id: task.id,
                }),
                ..ToolOutcome::default()
            })
        }
        "clip.export_srt" => {
            let args = Args::new(name, input)?;
            let timeline = super::timeline_of(moka, args.req_str("timelineId")?)?;
            let track_id = match args.opt_str("trackId") {
                Some(track_id) => track_id.to_string(),
                None => timeline
                    .tracks
                    .iter()
                    .find(|track| track.kind == TrackKind::Text)
                    .map(|track| track.id.clone())
                    .ok_or_else(|| {
                        ToolError::new("NO_TEXT_CLIPS", "the timeline has no text track")
                    })?,
            };
            let srt = serialize_srt(timeline, &track_id)?;
            if let Some(destination) = args.opt_str("destination") {
                let destination = PathBuf::from(destination);
                if destination.exists() && !args.opt_bool("overwrite", false) {
                    return Err(ToolError::new(
                        "DESTINATION_EXISTS",
                        format!("{} already exists", destination.display()),
                    ));
                }
                std::fs::write(&destination, srt.as_bytes()).map_err(|error| {
                    ToolError::new(
                        "DESTINATION_NOT_FOUND",
                        format!("the subtitles could not be written: {error}"),
                    )
                })?;
                return Ok(ToolOutcome::effect(
                    format!("Wrote subtitles to {}", destination.display()),
                    json!({"path": destination, "bytes": srt.len()}),
                ));
            }
            Ok(ToolOutcome::effect(
                "Read the subtitle track",
                json!({"srt": srt}),
            ))
        }
        "timeline.export" => export(state, session, input).await,
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not a cutting-room effect"),
        )),
    }
}

async fn export(
    state: &ApiState,
    session: &ProjectSession,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    let args = Args::new("timeline.export", input)?;
    let timeline_id = args.req_str("timelineId")?.to_string();
    let asked = PathBuf::from(args.req_str("destination")?);
    if asked.is_relative() {
        return Err(ToolError::validation(
            "the destination must be an absolute path",
        ));
    }
    if asked.is_dir() {
        return Err(ToolError::validation("the destination is a directory"));
    }
    if !asked.parent().is_some_and(|parent| parent.is_dir()) {
        return Err(ToolError::new(
            "DESTINATION_NOT_FOUND",
            "The destination's folder does not exist",
        ));
    }
    if asked.exists() && !args.opt_bool("overwrite", false) {
        return Err(ToolError::new(
            "DESTINATION_EXISTS",
            format!("{} already exists", asked.display()),
        ));
    }
    let capabilities = state.clip_capabilities();
    if !capabilities.available {
        return Err(ToolError::new(
            "FFMPEG_UNAVAILABLE",
            capabilities
                .reason
                .unwrap_or_else(|| crate::clip::locate::UNAVAILABLE_REASON.to_string()),
        ));
    }
    let opened = session
        .0
        .current()
        .await
        .map_err(ToolError::from)?
        .ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
    let timeline = super::timeline_of(&opened.moka, &timeline_id)?.clone();
    let sources = crate::clip::sources_for(&opened.root, &opened.moka, &timeline);
    let plan = crate::clip::plan::build_plan(&sources, &timeline, &opened.moka, &capabilities)
        .map_err(|error| ToolError::new("CLIP_EXPORT_FAILED", error.to_string()))?;
    let Some(program) = capabilities.path.clone() else {
        return Err(ToolError::new(
            "FFMPEG_UNAVAILABLE",
            crate::clip::locate::UNAVAILABLE_REASON,
        ));
    };
    let reservation = state
        .exports
        .begin(&timeline_id)
        .map_err(|error| ToolError::new("CLIP_EXPORT_FAILED", error.to_string()))?;
    let run = ExportRun {
        id: reservation.task.id.clone(),
        timeline_id: timeline_id.clone(),
        plan,
        program,
        encoder: capabilities
            .video_encoder
            .unwrap_or_else(|| "libx264".to_string()),
        temp_root: opened.root.join("tmp"),
        destination: asked.clone(),
        timeout: state.config.clip.timeout(),
    };
    let registry = std::sync::Arc::clone(&state.exports);
    tokio::spawn(async move {
        crate::clip::jobs::drive(registry, run, reservation.cancel).await;
    });
    Ok(ToolOutcome {
        summary: format!("Started a render to {}", asked.display()),
        data: json!({"timelineId": timeline_id, "destination": asked}),
        task: Some(TaskRef {
            kind: "clipExport".into(),
            id: reservation.task.id,
        }),
        ..ToolOutcome::default()
    })
}
