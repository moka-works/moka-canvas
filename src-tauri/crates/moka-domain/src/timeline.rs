//! The cutting room: what a timeline may hold, and where a seam sits.
//!
//! This mirrors `src/shared/domain/timeline.ts` and the 13 timeline command
//! cases of `commands.ts` check for check, error code for error code, and in
//! the same order: the two languages must agree on what a document may be, and
//! on which thing is wrong with one that may not be.

use std::collections::{HashMap, HashSet};

use super::commands::CommandError;
use super::{
    new_id, now_iso, ClipMove, ClipPatch, ClipPatchEntry, ClipSlide, ClipSlip, DocumentCommand,
    InsertMode, MarkerPatch, MokaFile, RippleScope, TimelineClip, TimelineDocument, TimelineMarker,
    TimelineSettingsPatch, TimelineTrack, TimelineTransition, TrackKind, TrackPatch,
    TransitionKind,
};

// ---------------------------------------------------------------------------
// Limits, mirrored from `constants.ts` name for name
// ---------------------------------------------------------------------------

pub const TIMELINE_SCHEMA_VERSION: i32 = 2;
/// How many timelines one project's cutting room holds.
pub const MAX_TIMELINES_PER_PROJECT: usize = 12;
/// How many tracks one timeline holds, video, audio, and text together.
pub const MAX_TRACKS_PER_TIMELINE: usize = 8;
/// How many clips one timeline holds.
pub const MAX_CLIPS_PER_TIMELINE: usize = 400;
/// How many transitions one timeline holds.
pub const MAX_TRANSITIONS_PER_TIMELINE: usize = 100;
/// How many markers one timeline holds.
pub const MAX_MARKERS_PER_TIMELINE: usize = 200;
/// The colours a marker may wear.
pub const MARKER_COLORS: [&str; 6] = ["white", "yellow", "green", "blue", "purple", "red"];
pub const MARKER_LABEL_MAX: usize = 40;
pub const TIMELINE_NAME_MAX: usize = 80;
/// How long a clip's label may run, which is a name rather than a text.
pub const CLIP_LABEL_MAX: usize = 80;
/// The most one text clip may say, kept to the size a card may hold.
pub const MAX_TIMELINE_TEXT_CONTENT: usize = 2_000;
/// How many clips one command may land, which is one step of history. Kept at
/// the timeline's own ceiling so a whole cut can arrive in one step.
pub const MAX_CLIPS_PER_COMMAND: usize = 400;
/// Clip timing bounds: milliseconds are whole and positive, speed and volume
/// live in their working ranges, and a clip shorter than this cannot be seen.
pub const MIN_CLIP_DURATION_MS: i64 = 100;
pub const MIN_CLIP_SPEED: f64 = 0.25;
pub const MAX_CLIP_SPEED: f64 = 4.0;
pub const MAX_CLIP_VOLUME: f64 = 2.0;
/// Transition bounds, in the window two clips share.
pub const MIN_TRANSITION_MS: i64 = 200;
pub const MAX_TRANSITION_MS: i64 = 2_000;
/// The timeline frame rates a document may be set to.
pub const TIMELINE_FPS_CHOICES: [i32; 4] = [24, 25, 30, 60];
/// Resolution bounds for the timeline canvas, even numbers within these.
pub const TIMELINE_WIDTH_MIN: i32 = 720;
pub const TIMELINE_WIDTH_MAX: i32 = 3_840;
pub const TIMELINE_HEIGHT_MIN: i32 = 480;
pub const TIMELINE_HEIGHT_MAX: i32 = 2_160;
/// The eight ways two clips can meet.
pub const TRANSITION_KINDS: [TransitionKind; 8] = [
    TransitionKind::None,
    TransitionKind::Crossfade,
    TransitionKind::DipToBlack,
    TransitionKind::DipToWhite,
    TransitionKind::SlideLeft,
    TransitionKind::SlideUp,
    TransitionKind::Wipe,
    TransitionKind::ZoomIn,
];
/// The six preset looks a video clip can wear.
pub const CLIP_FILTER_PRESETS: [&str; 6] = ["none", "warm", "cool", "mono", "fade", "vivid"];

/// Keeps a value that crossed f64 or i128 arithmetic inside the i64 model.
fn to_i64(value: i128) -> i64 {
    value.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

pub fn check_hex_color(value: &str) -> Result<(), CommandError> {
    let bytes = value.as_bytes();
    let hex = bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit);
    if !hex {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Colour is not #rrggbb",
        ));
    }
    Ok(())
}

/// Whether a track can hold clips of this kind, which is whether they match.
pub fn track_accepts(track: &TimelineTrack, kind: TrackKind) -> bool {
    track.kind == kind
}

/// Refuses to touch a row whose lock says its clips are not the caller's to
/// edit. A locked row may still be read; what it will not take is new work.
/// Kept in the document layer so a caller writing commands directly cannot
/// step around what the interface refuses.
fn ensure_track_unlocked(timeline: &TimelineDocument, track_id: &str) -> Result<(), CommandError> {
    let track = timeline
        .tracks
        .iter()
        .find(|held| held.id == track_id)
        .ok_or_else(|| CommandError::new("TRACK_NOT_FOUND", "Clip's track not found"))?;
    if track.locked {
        return Err(CommandError::new(
            "TRACK_LOCKED",
            format!("The “{}” track is locked", track.name),
        ));
    }
    Ok(())
}

/// The static code behind a collected validation issue, for the commands that
/// read a whole timeline through the collector and then refuse it.
fn issue_code(code: &str) -> &'static str {
    match code {
        "CLIP_OVERLAP" => "CLIP_OVERLAP",
        "TRANSITION_SEAM" => "TRANSITION_SEAM",
        "TRACK_NOT_FOUND" => "TRACK_NOT_FOUND",
        "CLIP_NOT_FOUND" => "CLIP_NOT_FOUND",
        "CONFLICT" => "CONFLICT",
        _ => "VALIDATION_FAILED",
    }
}

/// The end of a clip on the timeline's clock, kept in i128 so a document that
/// arrived with absurd numbers cannot overflow the check that refuses it.
fn clip_end(clip: &TimelineClip) -> i128 {
    clip.start_ms as i128 + clip.duration_ms as i128
}

/// Whether two intervals overlap, counting the boundary as clear: two clips
/// that touch end-to-start hold different places, which a seam may want.
fn intervals_overlap(a: &TimelineClip, b: &TimelineClip) -> bool {
    (a.start_ms as i128) < clip_end(b) && (b.start_ms as i128) < clip_end(a)
}

/// The clips of a track in timeline order, which is the order seams are read
/// in: a clip's neighbour is the next clip to start after it on the same track.
pub fn track_clips_in_order<'a>(
    timeline: &'a TimelineDocument,
    track_id: &str,
) -> Vec<&'a TimelineClip> {
    let mut clips: Vec<&TimelineClip> = timeline
        .clips
        .iter()
        .filter(|clip| clip.track_id == track_id)
        .collect();
    clips.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then_with(|| a.id.cmp(&b.id)));
    clips
}

/// The clip behind the given one on its track, which is the seam's follower.
pub fn follower_of<'a>(
    timeline: &'a TimelineDocument,
    leader: &TimelineClip,
) -> Option<&'a TimelineClip> {
    let ordered = track_clips_in_order(timeline, &leader.track_id);
    let at = ordered.iter().position(|clip| clip.id == leader.id)?;
    ordered.get(at + 1).copied()
}

fn find_asset<'a>(moka: &'a MokaFile, asset_id: &str) -> Option<&'a super::ResourceEntry> {
    moka.resources.find(asset_id)
}

/// Validates one clip as a whole: its shape, its timing identity, its material,
/// and the text a text clip carries. The order of the checks is the order the
/// TypeScript twin reports them in.
pub fn check_clip(
    moka: &MokaFile,
    timeline: &TimelineDocument,
    clip: &TimelineClip,
) -> Result<(), CommandError> {
    let track = timeline
        .tracks
        .iter()
        .find(|track| track.id == clip.track_id)
        .ok_or_else(|| CommandError::new("TRACK_NOT_FOUND", "Clip's track not found"))?;
    if !track_accepts(track, clip.kind) {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            format!(
                "A {} clip cannot sit on a {} track",
                clip.kind.as_str(),
                track.kind.as_str()
            ),
        ));
    }
    if clip.start_ms < 0 {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Clip start is not a whole number of milliseconds",
        ));
    }
    if clip.duration_ms < MIN_CLIP_DURATION_MS {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            format!("Clips run at least {MIN_CLIP_DURATION_MS}ms"),
        ));
    }
    if clip.in_point_ms < 0 {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Clip in point is negative",
        ));
    }
    if clip.out_point_ms <= clip.in_point_ms {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Clip out point is at or before its in point",
        ));
    }
    if clip.speed < MIN_CLIP_SPEED || clip.speed > MAX_CLIP_SPEED {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            format!("Clip speed is outside {MIN_CLIP_SPEED}–{MAX_CLIP_SPEED}"),
        ));
    }
    // The timing identity: duration on the timeline is the material window over
    // speed, so a clip that breaks it would play back the wrong material. Read
    // in f64 like the TypeScript twin, which is where the rounding happens.
    if clip.freeze == Some(true) && clip.kind != TrackKind::Video {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Only a picture can be held on one frame",
        ));
    }
    if clip.reversed == Some(true) && clip.kind == TrackKind::Text {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Only a picture or a sound can play backwards",
        ));
    }
    let window = clip.out_point_ms as f64 - clip.in_point_ms as f64;
    if clip.freeze != Some(true) && (clip.duration_ms as f64 * clip.speed).round() != window {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Clip duration does not match its in/out window over its speed",
        ));
    }
    if clip.volume < 0.0 || clip.volume > MAX_CLIP_VOLUME {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            format!("Clip volume is outside 0–{MAX_CLIP_VOLUME}"),
        ));
    }
    if clip.opacity < 0.0 || clip.opacity > 1.0 {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Clip opacity is outside 0–1",
        ));
    }
    if let Some(transform) = &clip.transform {
        if clip.kind != TrackKind::Video {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Only a picture can be scaled or cropped",
            ));
        }
        if !transform.scale.is_finite()
            || !(0.05..=10.0).contains(&transform.scale)
            || !transform.x.is_finite()
            || !(-1.0..=1.0).contains(&transform.x)
            || !transform.y.is_finite()
            || !(-1.0..=1.0).contains(&transform.y)
            || !transform.rotation.is_finite()
            || !(-180.0..=180.0).contains(&transform.rotation)
        {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Scale runs 0.05–10, position −1–1, rotation −180–180",
            ));
        }
        if let Some(crop) = &transform.crop {
            let sides = [crop.top, crop.right, crop.bottom, crop.left];
            if sides
                .iter()
                .any(|side| !side.is_finite() || !(0.0..=0.45).contains(side))
                || crop.top + crop.bottom >= 0.9
                || crop.left + crop.right >= 0.9
            {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Crop sides run 0 to 0.45 and leave a picture between them",
                ));
            }
        }
    }
    if clip.fade_in_ms < 0
        || clip.fade_out_ms < 0
        || clip.fade_in_ms as i128 + clip.fade_out_ms as i128 > clip.duration_ms as i128
    {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Clip fades are negative or longer than the clip",
        ));
    }
    if clip.label.is_empty() || clip.label.chars().count() > CLIP_LABEL_MAX {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Clip label is empty or too long",
        ));
    }
    if let Some(filter) = &clip.filter {
        if !CLIP_FILTER_PRESETS.contains(&filter.as_str()) {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Clip filter is not one of the presets",
            ));
        }
    }
    if clip.kind == TrackKind::Text {
        let Some(text) = &clip.text else {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A text clip carries no text",
            ));
        };
        if text.content.chars().count() > MAX_TIMELINE_TEXT_CONTENT {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Text clip content is too long",
            ));
        }
        if clip.asset_id.is_some() {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A text clip names no asset",
            ));
        }
        // A text clip's material clock is its own duration, nothing else.
        if clip.in_point_ms != 0 || clip.out_point_ms != clip.duration_ms {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A text clip's window is its own duration",
            ));
        }
        // The outline is what keeps white words readable over a bright picture,
        // so its width is a whole count of pixels and its colour a real one. A
        // zero width is the honest way to say "no outline".
        if text.style.stroke_width < 0 {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Text outline width is not a whole count of pixels",
            ));
        }
        check_hex_color(&text.style.stroke_color)?;
    } else {
        let Some(asset_id) = &clip.asset_id else {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A material clip names no asset",
            ));
        };
        let asset = find_asset(moka, asset_id).ok_or_else(|| {
            CommandError::new("ASSET_MISSING", "Clip's asset is not in the project")
        })?;
        if asset
            .mime
            .as_deref()
            .is_some_and(|mime| mime.starts_with("image/"))
        {
            // An image's material clock is its duration, like a text clip's.
            if clip.in_point_ms != 0 || clip.out_point_ms != clip.duration_ms {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "An image clip's window is its own duration",
                ));
            }
        }
        if clip.text.is_some() {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A material clip carries no text",
            ));
        }
    }
    Ok(())
}

/// Whether two clips hold the one overlap a track may carry: a transition
/// after the leader whose window is exactly how far the follower is pulled
/// back into it. The pair is given in track order, so adjacency has already
/// been decided by the caller.
fn is_seam_overlap(
    leader: &TimelineClip,
    follower: &TimelineClip,
    transitions: &[&TimelineTransition],
) -> bool {
    let leader_end = clip_end(leader);
    let follower_end = clip_end(follower);
    transitions.iter().any(|transition| {
        if transition.after_clip_id == leader.id {
            return follower.start_ms as i128 == leader_end - transition.duration_ms as i128;
        }
        if transition.after_clip_id == follower.id {
            return leader.start_ms as i128 == follower_end - transition.duration_ms as i128;
        }
        false
    })
}

fn describe_overlap(a: &TimelineClip, b: &TimelineClip) -> String {
    format!(
        "Clips {} and {} hold the same place on one track ({}–{}ms and {}–{}ms)",
        a.id,
        b.id,
        a.start_ms,
        clip_end(a),
        b.start_ms,
        clip_end(b)
    )
}

/// The first overlap among a set of clips that no seam allows, or nothing when
/// the set holds its places cleanly.
///
/// A seam overlap is the only one the document allows, and it must be a pair
/// adjacent in track order: a third clip pressed into a transition's window is
/// not part of any promise the document made and is refused like any other
/// overlap. Checking neighbouring pairs in start order is enough — an interval
/// that overlaps a non-neighbour always overlaps something between.
fn first_overlap<'a>(
    clips: &[&'a TimelineClip],
    transitions: &[&TimelineTransition],
) -> Option<(&'a TimelineClip, &'a TimelineClip)> {
    let mut by_track: Vec<Vec<&TimelineClip>> = Vec::new();
    let mut tracks: Vec<&str> = Vec::new();
    for clip in clips {
        match tracks
            .iter()
            .position(|track| *track == clip.track_id.as_str())
        {
            Some(at) => by_track[at].push(clip),
            None => {
                tracks.push(clip.track_id.as_str());
                by_track.push(vec![clip]);
            }
        }
    }
    for list in &mut by_track {
        list.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then_with(|| a.id.cmp(&b.id)));
        for pair in list.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if !intervals_overlap(a, b) {
                continue;
            }
            if is_seam_overlap(a, b, transitions) {
                continue;
            }
            return Some((a, b));
        }
    }
    None
}

/// Checks a set of clips against the places already held on their tracks and
/// against each other. Only a transition's own overlap is allowed, and that
/// exemption is read from the transitions the timeline holds plus the ones the
/// command is bringing in.
pub fn check_no_overlap(
    timeline: &TimelineDocument,
    clips: &[TimelineClip],
    excluding_ids: &[String],
    seams: &[TimelineTransition],
) -> Result<(), CommandError> {
    let excluded: HashSet<&str> = excluding_ids.iter().map(String::as_str).collect();
    let mut world: Vec<&TimelineClip> = timeline
        .clips
        .iter()
        .filter(|clip| !excluded.contains(clip.id.as_str()))
        .collect();
    world.extend(clips.iter());
    let transitions: Vec<&TimelineTransition> =
        timeline.transitions.iter().chain(seams.iter()).collect();
    if let Some((a, b)) = first_overlap(&world, &transitions) {
        return Err(CommandError::new("CLIP_OVERLAP", describe_overlap(a, b)));
    }
    Ok(())
}

/// What is wrong with a seam, as a code and words.
struct SeamFailure {
    code: &'static str,
    message: String,
}

/// What a transition record says about itself: its kind and its window.
fn transition_facts(transition: &TimelineTransition) -> Option<SeamFailure> {
    if transition.kind == TransitionKind::None || !TRANSITION_KINDS.contains(&transition.kind) {
        return Some(SeamFailure {
            code: "VALIDATION_FAILED",
            message: "Transition kind is not one of the eight".into(),
        });
    }
    if transition.duration_ms < MIN_TRANSITION_MS || transition.duration_ms > MAX_TRANSITION_MS {
        return Some(SeamFailure {
            code: "VALIDATION_FAILED",
            message: format!("Transition windows run {MIN_TRANSITION_MS}–{MAX_TRANSITION_MS}ms"),
        });
    }
    None
}

/// The first thing wrong with the two clips a transition joins, as a code and
/// words, or nothing when they make the seam.
///
/// `geometry` is the reading of the overlap being asked about: a transition
/// about to land needs the clips butted and pulls the follower back itself,
/// while one already stored must hold the pull-back the record says (R1).
fn seam_shape(
    timeline: &TimelineDocument,
    transition: &TimelineTransition,
    geometry: SeamGeometry,
) -> Option<SeamFailure> {
    let after = timeline
        .clips
        .iter()
        .find(|clip| clip.id == transition.after_clip_id);
    let Some(after) = after else {
        return Some(SeamFailure {
            code: "CLIP_NOT_FOUND",
            message: "Transition's clip not found".into(),
        });
    };
    let Some(follower) = follower_of(timeline, after) else {
        return Some(SeamFailure {
            code: "VALIDATION_FAILED",
            message: "A transition needs a clip behind the one it follows".into(),
        });
    };
    let after_end = clip_end(after);
    let wanted_start = after_end - transition.duration_ms as i128;
    let holds = match geometry {
        SeamGeometry::Butted => follower.start_ms as i128 == after_end,
        SeamGeometry::PulledBack => follower.start_ms as i128 == wanted_start,
    };
    if !holds {
        return Some(SeamFailure {
            code: "VALIDATION_FAILED",
            message: match geometry {
                SeamGeometry::Butted => {
                    "A transition lands on a butted seam; the clip behind is not against the one it follows".into()
                }
                SeamGeometry::PulledBack => {
                    "The clip behind is not pulled back by the transition's window".into()
                }
            },
        });
    }
    if transition.duration_ms > after.duration_ms.min(follower.duration_ms) {
        return Some(SeamFailure {
            code: "VALIDATION_FAILED",
            message: "A transition cannot outlast the shorter clip it joins".into(),
        });
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SeamGeometry {
    Butted,
    PulledBack,
}

fn seam_failure(
    timeline: &TimelineDocument,
    transition: &TimelineTransition,
    geometry: SeamGeometry,
) -> Option<SeamFailure> {
    transition_facts(transition).or_else(|| seam_shape(timeline, transition, geometry))
}

/// Checks a transition about to make a seam (R3): the clips must be butted,
/// the command itself pulls the follower back, and the seam must be free. A
/// seam that already carries a transition is named as such before the geometry
/// is read — the record is what stands in the way, not the pull.
pub fn check_transition_landing(
    timeline: &TimelineDocument,
    transition: &TimelineTransition,
) -> Result<(), CommandError> {
    if let Some(facts) = transition_facts(transition) {
        return Err(CommandError::new(facts.code, facts.message));
    }
    if timeline
        .transitions
        .iter()
        .any(|existing| existing.after_clip_id == transition.after_clip_id)
    {
        return Err(CommandError::new(
            "CONFLICT",
            "That seam already carries a transition",
        ));
    }
    if let Some(shape) = seam_shape(timeline, transition, SeamGeometry::Butted) {
        return Err(CommandError::new(shape.code, shape.message));
    }
    Ok(())
}

/// Checks a transition restored together with its clips (R6): the seam must
/// already hold the pull-back its window states — nothing in this path moves a
/// clip — and the record itself must be sound.
pub fn check_transition_restoration(
    timeline: &TimelineDocument,
    transition: &TimelineTransition,
) -> Result<(), CommandError> {
    if let Some(failure) = seam_failure(timeline, transition, SeamGeometry::PulledBack) {
        return Err(CommandError::new(failure.code, failure.message));
    }
    Ok(())
}

/// Checks a stored transition still holds its seam (R1, R5): the clips must be
/// there, still neighbours, still overlapped by exactly the window. Any way it
/// fails is the seam's breaking, which is what a caller repairing geometry is
/// told.
pub fn check_existing_transition(
    timeline: &TimelineDocument,
    transition: &TimelineTransition,
) -> Result<(), CommandError> {
    if let Some(failure) = seam_failure(timeline, transition, SeamGeometry::PulledBack) {
        return Err(CommandError::new(
            "TRANSITION_SEAM",
            format!(
                "A stored transition no longer holds its seam: {}",
                failure.message
            ),
        ));
    }
    Ok(())
}

fn clip_too_short() -> CommandError {
    CommandError::new(
        "VALIDATION_FAILED",
        format!("Clips run at least {MIN_CLIP_DURATION_MS}ms"),
    )
}

fn fit_fades(mut clip: TimelineClip) -> TimelineClip {
    clip.fade_in_ms = clip.fade_in_ms.min(clip.duration_ms);
    clip.fade_out_ms = clip
        .fade_out_ms
        .min((clip.duration_ms - clip.fade_in_ms).max(0));
    clip
}

fn own_clock(moka: &MokaFile, clip: &TimelineClip) -> bool {
    if clip.kind == TrackKind::Text {
        return true;
    }
    let Some(asset_id) = clip.asset_id.as_deref() else {
        return false;
    };
    moka.resources
        .find(asset_id)
        .and_then(|asset| asset.mime.as_deref())
        .is_some_and(|mime| mime.starts_with("image/"))
}

fn trim_tail_to(
    moka: &MokaFile,
    clip: &TimelineClip,
    end_ms: i64,
) -> Result<TimelineClip, CommandError> {
    let mut duration = end_ms - clip.start_ms;
    if duration < MIN_CLIP_DURATION_MS {
        return Err(clip_too_short());
    }
    if own_clock(moka, clip) {
        let mut next = clip.clone();
        next.duration_ms = duration;
        next.in_point_ms = 0;
        next.out_point_ms = duration;
        return Ok(fit_fades(next));
    }
    let mut out_point = clip.in_point_ms + (duration as f64 * clip.speed).round() as i64;
    if out_point > clip.out_point_ms {
        duration = (((clip.out_point_ms - clip.in_point_ms) as f64) / clip.speed).floor() as i64;
        out_point = clip.in_point_ms + (duration as f64 * clip.speed).round() as i64;
        if out_point > clip.out_point_ms {
            duration -= 1;
            out_point = clip.in_point_ms + (duration as f64 * clip.speed).round() as i64;
        }
        if duration < MIN_CLIP_DURATION_MS {
            return Err(clip_too_short());
        }
    }
    let mut next = clip.clone();
    next.duration_ms = duration;
    next.out_point_ms = out_point;
    Ok(fit_fades(next))
}

fn trim_head_to(
    moka: &MokaFile,
    clip: &TimelineClip,
    start_ms: i64,
) -> Result<TimelineClip, CommandError> {
    let mut duration = clip.start_ms + clip.duration_ms - start_ms;
    if duration < MIN_CLIP_DURATION_MS {
        return Err(clip_too_short());
    }
    if own_clock(moka, clip) {
        let mut next = clip.clone();
        next.start_ms = start_ms;
        next.duration_ms = duration;
        next.in_point_ms = 0;
        next.out_point_ms = duration;
        return Ok(fit_fades(next));
    }
    let in_point =
        clip.in_point_ms + ((start_ms - clip.start_ms) as f64 * clip.speed).round() as i64;
    let mut out_point = in_point + (duration as f64 * clip.speed).round() as i64;
    if out_point > clip.out_point_ms {
        duration = (((clip.out_point_ms - in_point) as f64) / clip.speed).floor() as i64;
        out_point = in_point + (duration as f64 * clip.speed).round() as i64;
        if out_point > clip.out_point_ms {
            duration -= 1;
            out_point = in_point + (duration as f64 * clip.speed).round() as i64;
        }
        if duration < MIN_CLIP_DURATION_MS {
            return Err(clip_too_short());
        }
    }
    let mut next = clip.clone();
    next.start_ms = start_ms;
    next.duration_ms = duration;
    next.in_point_ms = in_point;
    next.out_point_ms = out_point;
    Ok(fit_fades(next))
}

fn split_clip_at(
    moka: &MokaFile,
    clip: &TimelineClip,
    at_ms: i64,
) -> Result<(TimelineClip, TimelineClip), CommandError> {
    let left = trim_tail_to(moka, clip, at_ms)?;
    let mut duration = clip.start_ms + clip.duration_ms - at_ms;
    if own_clock(moka, clip) {
        let mut right = clip.clone();
        right.id = new_id();
        right.start_ms = at_ms;
        right.duration_ms = duration;
        right.in_point_ms = 0;
        right.out_point_ms = duration;
        right.created_at = now_iso();
        right.updated_at = right.created_at.clone();
        return Ok((left, fit_fades(right)));
    }
    let mut out_point = left.out_point_ms + (duration as f64 * clip.speed).round() as i64;
    if out_point > clip.out_point_ms {
        duration = (((clip.out_point_ms - left.out_point_ms) as f64) / clip.speed).floor() as i64;
        out_point = left.out_point_ms + (duration as f64 * clip.speed).round() as i64;
        if out_point > clip.out_point_ms {
            duration -= 1;
            out_point = left.out_point_ms + (duration as f64 * clip.speed).round() as i64;
        }
        if duration < MIN_CLIP_DURATION_MS {
            return Err(clip_too_short());
        }
    }
    let mut right = clip.clone();
    right.id = new_id();
    right.start_ms = at_ms;
    right.duration_ms = duration;
    right.in_point_ms = left.out_point_ms;
    right.out_point_ms = out_point;
    right.created_at = now_iso();
    right.updated_at = right.created_at.clone();
    Ok((left, fit_fades(right)))
}

fn clips_overlap(a: &TimelineClip, b: &TimelineClip) -> bool {
    a.start_ms < b.start_ms + b.duration_ms && b.start_ms < a.start_ms + a.duration_ms
}

fn overlay_clips(
    moka: &MokaFile,
    timeline: &TimelineDocument,
    incoming: &[TimelineClip],
) -> Result<Vec<TimelineClip>, CommandError> {
    let mut list = timeline.clips.clone();
    for added in incoming {
        let start = added.start_ms;
        let end = start + added.duration_ms;
        let mut next = Vec::with_capacity(list.len() + 1);
        for held in &list {
            if held.track_id != added.track_id {
                next.push(held.clone());
                continue;
            }
            let held_end = held.start_ms + held.duration_ms;
            if held_end <= start || held.start_ms >= end {
                next.push(held.clone());
                continue;
            }
            if held.start_ms >= start && held_end <= end {
                continue;
            }
            if held.start_ms < start && held_end > end {
                let (left, middle) = split_clip_at(moka, held, start)?;
                let (_, right) = split_clip_at(moka, &middle, end)?;
                next.push(left);
                next.push(right);
                continue;
            }
            if held.start_ms < start {
                next.push(trim_tail_to(moka, held, start)?);
                continue;
            }
            next.push(trim_head_to(moka, held, end)?);
        }
        next.push(added.clone());
        list = next;
    }
    Ok(list)
}

fn ripple_clips(
    moka: &MokaFile,
    timeline: &TimelineDocument,
    incoming: &[TimelineClip],
    scope: RippleScope,
) -> Result<Vec<TimelineClip>, CommandError> {
    let start = incoming.iter().map(|clip| clip.start_ms).min().unwrap_or(0);
    let end = incoming
        .iter()
        .map(|clip| clip.start_ms + clip.duration_ms)
        .max()
        .unwrap_or(start);
    let total = end - start;
    let tracks: HashSet<&str> = match scope {
        RippleScope::All => timeline
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect(),
        RippleScope::Track => incoming.iter().map(|clip| clip.track_id.as_str()).collect(),
    };
    let mut next = Vec::with_capacity(timeline.clips.len() + incoming.len());
    for held in &timeline.clips {
        if !tracks.contains(held.track_id.as_str()) {
            next.push(held.clone());
            continue;
        }
        let held_end = held.start_ms + held.duration_ms;
        if held_end <= start {
            next.push(held.clone());
            continue;
        }
        if held.start_ms >= start {
            let mut shifted = held.clone();
            shifted.start_ms += total;
            next.push(shifted);
            continue;
        }
        let (left, right) = split_clip_at(moka, held, start)?;
        next.push(left);
        let mut shifted = right;
        shifted.start_ms += total;
        next.push(shifted);
    }
    next.extend(incoming.iter().cloned());
    Ok(next)
}

fn timing_changed(a: &TimelineClip, b: &TimelineClip) -> bool {
    a.start_ms != b.start_ms
        || a.duration_ms != b.duration_ms
        || a.in_point_ms != b.in_point_ms
        || a.out_point_ms != b.out_point_ms
        || a.speed != b.speed
        || a.fade_in_ms != b.fade_in_ms
        || a.fade_out_ms != b.fade_out_ms
}

fn timing_patch(a: &TimelineClip, b: &TimelineClip) -> ClipPatch {
    let mut patch = ClipPatch::default();
    if a.start_ms != b.start_ms {
        patch.start_ms = Some(b.start_ms);
    }
    if a.duration_ms != b.duration_ms {
        patch.duration_ms = Some(b.duration_ms);
    }
    if a.in_point_ms != b.in_point_ms {
        patch.in_point_ms = Some(b.in_point_ms);
    }
    if a.out_point_ms != b.out_point_ms {
        patch.out_point_ms = Some(b.out_point_ms);
    }
    if a.speed != b.speed {
        patch.speed = Some(b.speed);
    }
    if a.fade_in_ms != b.fade_in_ms {
        patch.fade_in_ms = Some(b.fade_in_ms);
    }
    if a.fade_out_ms != b.fade_out_ms {
        patch.fade_out_ms = Some(b.fade_out_ms);
    }
    patch
}

/// Re-checks a whole timeline as it would be: every clip against its own rules,
/// every transition against the seam it claims, and every pair of clips against
/// the one overlap the seams allow (R5, R7).
///
/// A broken seam is reported before the overlap it leaves behind, because the
/// overlap is a consequence: a caller told TRANSITION_SEAM knows which edit
/// went too far, while CLIP_OVERLAP would only say that two clips now share a
/// place.
pub fn check_timeline(moka: &MokaFile, timeline: &TimelineDocument) -> Result<(), CommandError> {
    for clip in &timeline.clips {
        check_clip(moka, timeline, clip)?;
    }
    for transition in &timeline.transitions {
        check_existing_transition(timeline, transition)?;
    }
    let clips: Vec<&TimelineClip> = timeline.clips.iter().collect();
    let transitions: Vec<&TimelineTransition> = timeline.transitions.iter().collect();
    if let Some((a, b)) = first_overlap(&clips, &transitions) {
        return Err(CommandError::new("CLIP_OVERLAP", describe_overlap(a, b)));
    }
    Ok(())
}

/// Refuses a material clip whose window runs past the end of its file.
///
/// A window the file cannot fill is not a longer clip: the renderer simply has
/// no more frames, and the export would hold or go black at the tail without
/// saying why. Read when material is added or re-timed, so an old document that
/// already carries one stays readable and its other fields stay editable.
fn check_clip_within_asset(moka: &MokaFile, clip: &TimelineClip) -> Result<(), CommandError> {
    if clip.kind == TrackKind::Text {
        return Ok(());
    }
    let Some(asset_id) = clip.asset_id.as_deref() else {
        return Ok(());
    };
    let asset = moka
        .resources
        .find(asset_id)
        .ok_or_else(|| CommandError::new("ASSET_MISSING", "Clip's asset is not in the project"))?;
    if asset
        .mime
        .as_deref()
        .is_some_and(|mime| mime.starts_with("image/"))
    {
        return Ok(());
    }
    let Some(duration) = asset.probe.as_ref().and_then(|probe| probe.duration_ms) else {
        return Ok(());
    };
    if clip.out_point_ms > duration {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            format!(
                "Clip “{}” reads to {}ms, past the {}ms of its file",
                asset.name, clip.out_point_ms, duration
            ),
        ));
    }
    Ok(())
}

/// The transitions on the seams of the given clips, which is what removing
/// those clips takes with them. A seam belongs to both of its clips: the clip
/// the transition follows, and the clip pulled back behind it — take away
/// either one and the seam is gone.
pub fn transitions_of_seams(
    timeline: &TimelineDocument,
    clip_ids: &[String],
) -> Vec<TimelineTransition> {
    let removing: HashSet<&str> = clip_ids.iter().map(String::as_str).collect();
    timeline
        .transitions
        .iter()
        .filter(|transition| {
            if removing.contains(transition.after_clip_id.as_str()) {
                return true;
            }
            let after = timeline
                .clips
                .iter()
                .find(|clip| clip.id == transition.after_clip_id);
            let Some(after) = after else {
                return false;
            };
            follower_of(timeline, after)
                .is_some_and(|follower| removing.contains(follower.id.as_str()))
        })
        .cloned()
        .collect()
}

/// Applies a patch to a clip: the fields it carries move, and a field it
/// carries as null goes.
pub fn merge_clip_patch(clip: &TimelineClip, patch: &ClipPatch) -> TimelineClip {
    let mut merged = clip.clone();
    if let Some(id) = &patch.id {
        merged.id = id.clone();
    }
    if let Some(track_id) = &patch.track_id {
        merged.track_id = track_id.clone();
    }
    if let Some(kind) = patch.kind {
        merged.kind = kind;
    }
    if let Some(label) = &patch.label {
        merged.label = label.clone();
    }
    if let Some(asset_id) = &patch.asset_id {
        merged.asset_id = Some(asset_id.clone());
    }
    if let Some(start_ms) = patch.start_ms {
        merged.start_ms = start_ms;
    }
    if let Some(duration_ms) = patch.duration_ms {
        merged.duration_ms = duration_ms;
    }
    if let Some(in_point_ms) = patch.in_point_ms {
        merged.in_point_ms = in_point_ms;
    }
    if let Some(out_point_ms) = patch.out_point_ms {
        merged.out_point_ms = out_point_ms;
    }
    if let Some(speed) = patch.speed {
        merged.speed = speed;
    }
    if let Some(volume) = patch.volume {
        merged.volume = volume;
    }
    if let Some(fade_in_ms) = patch.fade_in_ms {
        merged.fade_in_ms = fade_in_ms;
    }
    if let Some(fade_out_ms) = patch.fade_out_ms {
        merged.fade_out_ms = fade_out_ms;
    }
    if let Some(muted) = patch.muted {
        merged.muted = muted;
    }
    if let Some(opacity) = patch.opacity {
        merged.opacity = opacity;
    }
    if patch.clear_transform == Some(true) {
        merged.transform = None;
    } else if let Some(transform) = &patch.transform {
        merged.transform = Some(transform.clone());
    }
    if patch.clear_freeze == Some(true) {
        merged.freeze = None;
    } else if let Some(freeze) = patch.freeze {
        merged.freeze = Some(freeze);
    }
    if patch.clear_reversed == Some(true) {
        merged.reversed = None;
    } else if let Some(reversed) = patch.reversed {
        merged.reversed = Some(reversed);
    }
    // The double layer: left off leaves the grade, null clears it, a value sets
    // it. A plain Option could not tell the first two apart.
    if let Some(adjust) = &patch.adjust {
        merged.adjust = *adjust;
    }
    if let Some(filter) = &patch.filter {
        merged.filter = filter.clone();
    }
    if let Some(text) = &patch.text {
        merged.text = Some(text.clone());
    }
    if let Some(created_at) = &patch.created_at {
        merged.created_at = created_at.clone();
    }
    if let Some(updated_at) = &patch.updated_at {
        merged.updated_at = updated_at.clone();
    }
    merged
}

/// The patch that puts back what a patch moved: every key the patch carried
/// gets the value the clip held, and a key the patch brought in — no old value
/// to restore — goes back out as null, which the merge reads as "this key
/// goes". Without the null an undo would leave the introduced field behind.
pub fn invert_clip_patch(clip: &TimelineClip, patch: &ClipPatch) -> ClipPatch {
    let mut inverse = ClipPatch::default();
    if patch.id.is_some() {
        inverse.id = Some(clip.id.clone());
    }
    if patch.track_id.is_some() {
        inverse.track_id = Some(clip.track_id.clone());
    }
    if patch.kind.is_some() {
        inverse.kind = Some(clip.kind);
    }
    if patch.label.is_some() {
        inverse.label = Some(clip.label.clone());
    }
    if patch.asset_id.is_some() {
        inverse.asset_id = clip.asset_id.clone();
    }
    if patch.start_ms.is_some() {
        inverse.start_ms = Some(clip.start_ms);
    }
    if patch.duration_ms.is_some() {
        inverse.duration_ms = Some(clip.duration_ms);
    }
    if patch.in_point_ms.is_some() {
        inverse.in_point_ms = Some(clip.in_point_ms);
    }
    if patch.out_point_ms.is_some() {
        inverse.out_point_ms = Some(clip.out_point_ms);
    }
    if patch.speed.is_some() {
        inverse.speed = Some(clip.speed);
    }
    if patch.volume.is_some() {
        inverse.volume = Some(clip.volume);
    }
    if patch.fade_in_ms.is_some() {
        inverse.fade_in_ms = Some(clip.fade_in_ms);
    }
    if patch.fade_out_ms.is_some() {
        inverse.fade_out_ms = Some(clip.fade_out_ms);
    }
    if patch.muted.is_some() {
        inverse.muted = Some(clip.muted);
    }
    if patch.opacity.is_some() {
        inverse.opacity = Some(clip.opacity);
    }
    if patch.transform.is_some() || patch.clear_transform == Some(true) {
        inverse.transform = clip.transform.clone();
        inverse.clear_transform = Some(clip.transform.is_none());
    }
    if patch.freeze.is_some() || patch.clear_freeze == Some(true) {
        inverse.freeze = clip.freeze;
        inverse.clear_freeze = Some(clip.freeze.is_none());
    }
    if patch.reversed.is_some() || patch.clear_reversed == Some(true) {
        inverse.reversed = clip.reversed;
        inverse.clear_reversed = Some(clip.reversed.is_none());
    }
    if let Some(adjust) = &patch.adjust {
        // A grade the patch brought in from nothing goes back out as null; one
        // that was there comes back as it was.
        inverse.adjust = if adjust.is_some() || clip.adjust.is_some() {
            Some(clip.adjust)
        } else {
            None
        };
    }
    if let Some(filter) = &patch.filter {
        inverse.filter = if filter.is_some() || clip.filter.is_some() {
            Some(clip.filter.clone())
        } else {
            None
        };
    }
    if patch.text.is_some() {
        inverse.text = clip.text.clone();
    }
    if patch.created_at.is_some() {
        inverse.created_at = Some(clip.created_at.clone());
    }
    if patch.updated_at.is_some() {
        inverse.updated_at = Some(clip.updated_at.clone());
    }
    inverse
}

/// Everything wrong with one timeline, in a list rather than a throw: a
/// document validator reports every fault at once, so this is the collecting
/// twin of `check_timeline` and shares its checks with it.
pub fn validate_timeline(
    timeline: &TimelineDocument,
    moka: &MokaFile,
) -> Vec<super::ValidationIssue> {
    let mut issues: Vec<super::ValidationIssue> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for track in &timeline.tracks {
        if !seen.insert(format!("track:{}", track.id)) {
            issues.push(super::ValidationIssue {
                code: "VALIDATION_FAILED".into(),
                message: format!("Duplicate track id {}", track.id),
                timeline_id: Some(timeline.id.clone()),
                track_id: Some(track.id.clone()),
                ..Default::default()
            });
        }
    }
    for clip in &timeline.clips {
        if !seen.insert(format!("clip:{}", clip.id)) {
            issues.push(super::ValidationIssue {
                code: "VALIDATION_FAILED".into(),
                message: format!("Duplicate clip id {}", clip.id),
                timeline_id: Some(timeline.id.clone()),
                clip_id: Some(clip.id.clone()),
                ..Default::default()
            });
        }
    }
    for transition in &timeline.transitions {
        if !seen.insert(format!("transition:{}", transition.id)) {
            issues.push(super::ValidationIssue {
                code: "VALIDATION_FAILED".into(),
                message: format!("Duplicate transition id {}", transition.id),
                timeline_id: Some(timeline.id.clone()),
                transition_id: Some(transition.id.clone()),
                ..Default::default()
            });
        }
    }
    for clip in &timeline.clips {
        if let Err(failure) = check_clip(moka, timeline, clip) {
            issues.push(super::ValidationIssue {
                code: failure.code.into(),
                message: failure.to_string(),
                timeline_id: Some(timeline.id.clone()),
                track_id: Some(clip.track_id.clone()),
                clip_id: Some(clip.id.clone()),
                ..Default::default()
            });
        }
    }
    for transition in &timeline.transitions {
        if let Some(failure) = seam_failure(timeline, transition, SeamGeometry::PulledBack) {
            issues.push(super::ValidationIssue {
                code: "TRANSITION_SEAM".into(),
                message: format!(
                    "A stored transition no longer holds its seam: {}",
                    failure.message
                ),
                timeline_id: Some(timeline.id.clone()),
                transition_id: Some(transition.id.clone()),
                ..Default::default()
            });
        }
    }
    let clips: Vec<&TimelineClip> = timeline.clips.iter().collect();
    let transitions: Vec<&TimelineTransition> = timeline.transitions.iter().collect();
    if let Some((a, b)) = first_overlap(&clips, &transitions) {
        issues.push(super::ValidationIssue {
            code: "CLIP_OVERLAP".into(),
            message: describe_overlap(a, b),
            timeline_id: Some(timeline.id.clone()),
            clip_id: Some(a.id.clone()),
            ..Default::default()
        });
    }
    issues
}

// ---------------------------------------------------------------------------
// The 13 commands, mirroring the TypeScript apply/inverse cases one for one
// ---------------------------------------------------------------------------

/// A project carrying these timelines, or carrying the field not at all when
/// it has none — the same honest reading the folders give an empty tree.
fn with_timelines(moka: &MokaFile, timelines: Vec<TimelineDocument>) -> MokaFile {
    MokaFile {
        timelines: if timelines.is_empty() {
            None
        } else {
            Some(timelines)
        },
        ..moka.clone()
    }
}

fn timeline_of<'a>(
    moka: &'a MokaFile,
    timeline_id: &str,
) -> Result<&'a TimelineDocument, CommandError> {
    moka.timelines
        .iter()
        .flatten()
        .find(|timeline| timeline.id == timeline_id)
        .ok_or_else(|| CommandError::new("TIMELINE_NOT_FOUND", "Timeline not found"))
}

fn replace_timeline(moka: &MokaFile, timeline: TimelineDocument) -> MokaFile {
    let timelines: Vec<TimelineDocument> = moka
        .timelines
        .iter()
        .flatten()
        .map(|held| {
            if held.id == timeline.id {
                timeline.clone()
            } else {
                held.clone()
            }
        })
        .collect();
    with_timelines(moka, timelines)
}

fn check_timeline_name(name: &str) -> Result<(), CommandError> {
    if name.is_empty() {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Timeline name is empty",
        ));
    }
    if name.chars().count() > TIMELINE_NAME_MAX {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Timeline name is too long",
        ));
    }
    Ok(())
}

fn validate_timeline_settings(settings: &TimelineSettingsPatch) -> Result<(), CommandError> {
    if let Some(fps) = settings.fps {
        if !TIMELINE_FPS_CHOICES.contains(&fps) {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Frame rate is not one of the choices",
            ));
        }
    }
    if let Some(width) = settings.width {
        if !(TIMELINE_WIDTH_MIN..=TIMELINE_WIDTH_MAX).contains(&width) || width % 2 != 0 {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Width is out of range or odd",
            ));
        }
    }
    if let Some(height) = settings.height {
        if !(TIMELINE_HEIGHT_MIN..=TIMELINE_HEIGHT_MAX).contains(&height) || height % 2 != 0 {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Height is out of range or odd",
            ));
        }
    }
    if let Some(background) = &settings.background {
        check_hex_color(background)?;
    }
    Ok(())
}

fn check_marker(marker: &TimelineMarker) -> Result<(), CommandError> {
    if marker.at_ms < 0 {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "A marker sits at a whole, positive millisecond",
        ));
    }
    if marker.label.is_empty() || marker.label.chars().count() > MARKER_LABEL_MAX {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "A marker's name must be a word or two",
        ));
    }
    if !MARKER_COLORS.contains(&marker.color.as_str()) {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "A marker's colour is not one of the six",
        ));
    }
    Ok(())
}

fn merged_spans(mut spans: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    spans.sort_by_key(|(start, _)| *start);
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (start, end) in spans {
        if let Some(last) = merged.last_mut() {
            if start < last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

fn pulled_by(start_ms: i64, spans: &[(i64, i64)]) -> i64 {
    spans
        .iter()
        .filter(|(_, end)| *end <= start_ms)
        .map(|(start, end)| end - start)
        .sum()
}

fn ripple_deleted(
    timeline: &TimelineDocument,
    clip_ids: &[String],
    scope: RippleScope,
) -> Vec<TimelineClip> {
    let removing: HashSet<&str> = clip_ids.iter().map(String::as_str).collect();
    let removed: Vec<&TimelineClip> = timeline
        .clips
        .iter()
        .filter(|clip| removing.contains(clip.id.as_str()))
        .collect();
    let global = merged_spans(
        removed
            .iter()
            .map(|clip| {
                (
                    clip.start_ms,
                    clip.start_ms.saturating_add(clip.duration_ms),
                )
            })
            .collect(),
    );
    let mut by_track: HashMap<&str, Vec<(i64, i64)>> = HashMap::new();
    for clip in &removed {
        by_track.entry(clip.track_id.as_str()).or_default().push((
            clip.start_ms,
            clip.start_ms.saturating_add(clip.duration_ms),
        ));
    }
    for spans in by_track.values_mut() {
        *spans = merged_spans(std::mem::take(spans));
    }
    timeline
        .clips
        .iter()
        .filter(|clip| !removing.contains(clip.id.as_str()))
        .map(|clip| {
            let spans: &[(i64, i64)] = match scope {
                RippleScope::All => &global,
                RippleScope::Track => by_track
                    .get(clip.track_id.as_str())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            };
            let shift = pulled_by(clip.start_ms, spans);
            if shift == 0 {
                clip.clone()
            } else {
                let mut next = clip.clone();
                next.start_ms = clip.start_ms - shift;
                next
            }
        })
        .collect()
}

fn closed_gaps(timeline: &TimelineDocument, track_id: Option<&str>) -> Vec<TimelineClip> {
    let tracks: Vec<&str> = match track_id {
        Some(id) => vec![id],
        None => timeline
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect(),
    };
    let mut next = timeline.clips.clone();
    for id in tracks {
        let mut on_track: Vec<(String, i64, i64)> = next
            .iter()
            .filter(|clip| clip.track_id == id)
            .map(|clip| (clip.id.clone(), clip.start_ms, clip.duration_ms))
            .collect();
        on_track.sort_by_key(|(_, start, _)| *start);
        let mut cursor = on_track.first().map(|(_, start, _)| *start).unwrap_or(0);
        for (clip_id, _, duration) in on_track {
            if let Some(clip) = next.iter_mut().find(|held| held.id == clip_id) {
                clip.start_ms = cursor;
            }
            cursor += duration;
        }
    }
    next
}

fn gap_at(timeline: &TimelineDocument, track_id: &str, at_ms: i64) -> Option<(i64, i64)> {
    let mut on_track: Vec<&TimelineClip> = timeline
        .clips
        .iter()
        .filter(|clip| clip.track_id == track_id)
        .collect();
    on_track.sort_by_key(|clip| clip.start_ms);
    let mut cursor = 0;
    for clip in on_track {
        if at_ms < clip.start_ms {
            return (at_ms >= cursor && cursor < clip.start_ms).then_some((cursor, clip.start_ms));
        }
        cursor = cursor.max(clip.start_ms.saturating_add(clip.duration_ms));
    }
    None
}

/// Applies a planned clip list through the commands that already validate and
/// undo themselves, so a landing and a compaction share one kind of history.
fn apply_planned_clips(
    moka: &MokaFile,
    timeline: &TimelineDocument,
    final_clips: Vec<TimelineClip>,
) -> Result<(MokaFile, Vec<DocumentCommand>), CommandError> {
    let original: HashMap<&str, &TimelineClip> = timeline
        .clips
        .iter()
        .map(|clip| (clip.id.as_str(), clip))
        .collect();
    let final_ids: HashSet<&str> = final_clips.iter().map(|clip| clip.id.as_str()).collect();
    let removed: Vec<String> = timeline
        .clips
        .iter()
        .filter(|clip| !final_ids.contains(clip.id.as_str()))
        .map(|clip| clip.id.clone())
        .collect();
    let added: Vec<TimelineClip> = final_clips
        .iter()
        .filter(|clip| !original.contains_key(clip.id.as_str()))
        .cloned()
        .collect();
    let mut patches: Vec<ClipPatchEntry> = Vec::new();
    for clip in &final_clips {
        if let Some(held) = original.get(clip.id.as_str()) {
            if timing_changed(held, clip) {
                patches.push(ClipPatchEntry {
                    clip_id: clip.id.clone(),
                    patch: timing_patch(held, clip),
                });
            }
        }
    }
    let mut commands: Vec<DocumentCommand> = Vec::new();
    if !removed.is_empty() {
        commands.push(DocumentCommand::RemoveClips {
            timeline_id: timeline.id.clone(),
            clip_ids: removed,
        });
    }
    if !patches.is_empty() {
        commands.push(DocumentCommand::UpdateClips {
            timeline_id: timeline.id.clone(),
            patches,
        });
    }
    if !added.is_empty() {
        commands.push(DocumentCommand::AddClips {
            timeline_id: timeline.id.clone(),
            clips: added,
            seams: None,
        });
    }
    if commands.is_empty() {
        return Ok((moka.clone(), Vec::new()));
    }
    let mut current = moka.clone();
    let mut inverses: Vec<DocumentCommand> = Vec::new();
    for command in commands {
        let (next, inverse) = apply_timeline_command(&current, &command)?;
        current = next;
        let mut combined = inverse;
        combined.extend(inverses);
        inverses = combined;
    }
    Ok((current, inverses))
}

fn material_duration(moka: &MokaFile, clip: &TimelineClip) -> Option<i64> {
    clip.asset_id
        .as_deref()
        .and_then(|id| moka.resources.find(id))
        .and_then(|asset| asset.probe.as_ref())
        .and_then(|probe| probe.duration_ms)
}

fn tail_room(moka: &MokaFile, clip: &TimelineClip) -> f64 {
    if own_clock(moka, clip) {
        return f64::INFINITY;
    }
    match material_duration(moka, clip) {
        Some(duration) => ((duration - clip.out_point_ms) as f64 / clip.speed).max(0.0),
        None => f64::INFINITY,
    }
}

fn head_room(moka: &MokaFile, clip: &TimelineClip) -> f64 {
    if own_clock(moka, clip) {
        return f64::INFINITY;
    }
    (clip.in_point_ms as f64 / clip.speed).max(0.0)
}

fn extend_tail_to(
    moka: &MokaFile,
    clip: &TimelineClip,
    end_ms: i64,
) -> Result<TimelineClip, CommandError> {
    let mut duration = end_ms - clip.start_ms;
    if duration < MIN_CLIP_DURATION_MS {
        return Err(clip_too_short());
    }
    if own_clock(moka, clip) {
        let mut next = clip.clone();
        next.duration_ms = duration;
        next.in_point_ms = 0;
        next.out_point_ms = duration;
        return Ok(fit_fades(next));
    }
    let mut out_point = clip.in_point_ms + (duration as f64 * clip.speed).round() as i64;
    if let Some(material) = material_duration(moka, clip) {
        if out_point > material {
            duration = ((material - clip.in_point_ms) as f64 / clip.speed).floor() as i64;
            out_point = clip.in_point_ms + (duration as f64 * clip.speed).round() as i64;
            if out_point > material {
                duration -= 1;
                out_point = clip.in_point_ms + (duration as f64 * clip.speed).round() as i64;
            }
            if duration < MIN_CLIP_DURATION_MS {
                return Err(clip_too_short());
            }
        }
    }
    let mut next = clip.clone();
    next.duration_ms = duration;
    next.out_point_ms = out_point;
    Ok(fit_fades(next))
}

fn slip_planned_clips(
    moka: &MokaFile,
    timeline: &TimelineDocument,
    edits: &[ClipSlip],
) -> Result<Vec<TimelineClip>, CommandError> {
    let wanted: HashMap<&str, i64> = edits
        .iter()
        .map(|edit| (edit.clip_id.as_str(), edit.by_ms))
        .collect();
    let mut next = Vec::with_capacity(timeline.clips.len());
    for clip in &timeline.clips {
        let Some(by_ms) = wanted.get(clip.id.as_str()) else {
            next.push(clip.clone());
            continue;
        };
        if own_clock(moka, clip) {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A cue or a still has no source window to slip",
            ));
        }
        let highest = material_duration(moka, clip)
            .map(|duration| duration - clip.out_point_ms)
            .unwrap_or(i64::MAX);
        let by = (*by_ms).clamp(-clip.in_point_ms, highest);
        if by == 0 {
            next.push(clip.clone());
            continue;
        }
        let mut slipped = clip.clone();
        slipped.in_point_ms += by;
        slipped.out_point_ms += by;
        next.push(slipped);
    }
    Ok(next)
}

fn slide_planned_clips(
    moka: &MokaFile,
    timeline: &TimelineDocument,
    moves: &[ClipSlide],
) -> Result<Vec<TimelineClip>, CommandError> {
    let wanted: HashMap<&str, i64> = moves
        .iter()
        .map(|movement| (movement.clip_id.as_str(), movement.by_ms))
        .collect();
    let mut next: HashMap<String, TimelineClip> = timeline
        .clips
        .iter()
        .map(|clip| (clip.id.clone(), clip.clone()))
        .collect();
    for (clip_id, by_ms) in wanted {
        let Some(clip) = next.get(clip_id).cloned() else {
            continue;
        };
        let mut ordered: Vec<TimelineClip> = next
            .values()
            .filter(|held| held.track_id == clip.track_id)
            .cloned()
            .collect();
        ordered.sort_by_key(|held| held.start_ms);
        let at = ordered.iter().position(|held| held.id == clip.id);
        let (Some(at), true) = (at, ordered.len() > 1) else {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A slide needs a joined clip on each side of the one it moves",
            ));
        };
        if at == 0 || at + 1 >= ordered.len() {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A slide needs a joined clip on each side of the one it moves",
            ));
        }
        let previous = ordered[at - 1].clone();
        let follower = ordered[at + 1].clone();
        if previous.start_ms + previous.duration_ms != clip.start_ms
            || clip.start_ms + clip.duration_ms != follower.start_ms
        {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A slide needs a joined clip on each side of the one it moves",
            ));
        }
        if timeline.transitions.iter().any(|transition| {
            transition.after_clip_id == previous.id || transition.after_clip_id == clip.id
        }) {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Remove the transition before rolling this cut",
            ));
        }
        let lowest = (-(previous.duration_ms - MIN_CLIP_DURATION_MS) as f64)
            .max(-head_room(moka, &follower));
        let highest =
            tail_room(moka, &previous).min((follower.duration_ms - MIN_CLIP_DURATION_MS) as f64);
        if lowest > highest {
            continue;
        }
        let delta = (by_ms as f64).clamp(lowest, highest).round() as i64;
        if delta == 0 {
            continue;
        }
        let previous_end = previous.start_ms + previous.duration_ms + delta;
        next.insert(
            previous.id.clone(),
            if delta > 0 {
                extend_tail_to(moka, &previous, previous_end)?
            } else {
                trim_tail_to(moka, &previous, previous_end)?
            },
        );
        let mut moved = clip.clone();
        moved.start_ms += delta;
        next.insert(clip.id.clone(), moved);
        next.insert(
            follower.id.clone(),
            trim_head_to(moka, &follower, follower.start_ms + delta)?,
        );
    }
    Ok(next.into_values().collect())
}

fn roll_planned_clips(
    moka: &MokaFile,
    timeline: &TimelineDocument,
    after_clip_id: &str,
    by_ms: i64,
) -> Result<Vec<TimelineClip>, CommandError> {
    let leader = timeline
        .clips
        .iter()
        .find(|clip| clip.id == after_clip_id)
        .cloned()
        .ok_or_else(|| CommandError::new("CLIP_NOT_FOUND", "Clip not found"))?;
    let follower = follower_of(timeline, &leader).cloned().ok_or_else(|| {
        CommandError::new(
            "VALIDATION_FAILED",
            "A roll needs two clips joined at the cut",
        )
    })?;
    if follower.start_ms != leader.start_ms + leader.duration_ms {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "A roll needs two clips joined at the cut",
        ));
    }
    if timeline
        .transitions
        .iter()
        .any(|transition| transition.after_clip_id == leader.id)
    {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Remove the transition before rolling this cut",
        ));
    }
    let lowest =
        (-(follower.duration_ms - MIN_CLIP_DURATION_MS) as f64).max(-head_room(moka, &follower));
    let highest = (leader.duration_ms - MIN_CLIP_DURATION_MS) as f64;
    let highest = highest.min(tail_room(moka, &leader));
    if lowest > highest {
        return Ok(timeline.clips.clone());
    }
    let delta = (by_ms as f64).clamp(lowest, highest).round() as i64;
    if delta == 0 {
        return Ok(timeline.clips.clone());
    }
    let mut next: HashMap<String, TimelineClip> = timeline
        .clips
        .iter()
        .map(|clip| (clip.id.clone(), clip.clone()))
        .collect();
    let leader_end = leader.start_ms + leader.duration_ms + delta;
    next.insert(
        leader.id.clone(),
        if delta > 0 {
            extend_tail_to(moka, &leader, leader_end)?
        } else {
            trim_tail_to(moka, &leader, leader_end)?
        },
    );
    next.insert(
        follower.id.clone(),
        trim_head_to(moka, &follower, follower.start_ms + delta)?,
    );
    Ok(next.into_values().collect())
}

fn range_planned_clips(
    moka: &MokaFile,
    timeline: &TimelineDocument,
    start_ms: i64,
    end_ms: i64,
    scope: RippleScope,
    track_id: Option<&str>,
) -> Result<Vec<TimelineClip>, CommandError> {
    let length = end_ms - start_ms;
    let mut next = Vec::with_capacity(timeline.clips.len());
    for clip in &timeline.clips {
        if scope == RippleScope::Track && clip.track_id != track_id.unwrap_or_default() {
            next.push(clip.clone());
            continue;
        }
        let clip_end = clip.start_ms + clip.duration_ms;
        if clip_end <= start_ms {
            next.push(clip.clone());
            continue;
        }
        if clip.start_ms >= end_ms {
            let mut moved = clip.clone();
            moved.start_ms -= length;
            next.push(moved);
            continue;
        }
        if clip.start_ms >= start_ms && clip_end <= end_ms {
            continue;
        }
        if clip.start_ms < start_ms && clip_end > end_ms {
            let (left, middle) = split_clip_at(moka, clip, start_ms)?;
            let (_, right) = split_clip_at(moka, &middle, end_ms)?;
            next.push(left);
            let mut shifted = right;
            shifted.start_ms -= length;
            next.push(shifted);
            continue;
        }
        if clip.start_ms < start_ms {
            next.push(trim_tail_to(moka, clip, start_ms)?);
            continue;
        }
        let mut tail = trim_head_to(moka, clip, end_ms)?;
        tail.start_ms -= length;
        next.push(tail);
    }
    Ok(next)
}

/// Applies one of the timeline commands and returns the new document plus
/// the inverse commands. Anything else is a programming error: `commands.rs`
/// routes only the timeline variants here.
pub fn apply_timeline_command(
    moka: &MokaFile,
    command: &DocumentCommand,
) -> Result<(MokaFile, Vec<DocumentCommand>), CommandError> {
    match command {
        DocumentCommand::AddTimeline { timeline, index } => {
            let timelines = moka.timelines.clone().unwrap_or_default();
            if timelines.len() + 1 > MAX_TIMELINES_PER_PROJECT {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Timeline limit reached",
                ));
            }
            if timelines.iter().any(|held| held.id == timeline.id) {
                return Err(CommandError::new("CONFLICT", "Timeline id already exists"));
            }
            check_timeline_name(&timeline.name)?;
            if timeline.schema_version > TIMELINE_SCHEMA_VERSION {
                return Err(CommandError::new(
                    "MOKA_VERSION_UNSUPPORTED",
                    "Timeline schema is newer than this build reads",
                ));
            }
            if timeline.tracks.len() > MAX_TRACKS_PER_TIMELINE {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Track limit reached",
                ));
            }
            if timeline.clips.len() > MAX_CLIPS_PER_TIMELINE {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Timeline clip limit reached",
                ));
            }
            if timeline.transitions.len() > MAX_TRANSITIONS_PER_TIMELINE {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Timeline transition limit reached",
                ));
            }
            for track in &timeline.tracks {
                if track.name.is_empty() || track.name.chars().count() > TIMELINE_NAME_MAX {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "Track name is empty or too long",
                    ));
                }
            }
            let mut seam_leaders: HashSet<&str> = HashSet::new();
            for transition in &timeline.transitions {
                if !seam_leaders.insert(transition.after_clip_id.as_str()) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "That seam already carries a transition",
                    ));
                }
            }
            let settings = TimelineSettingsPatch {
                fps: Some(timeline.settings.fps),
                width: Some(timeline.settings.width),
                height: Some(timeline.settings.height),
                background: Some(timeline.settings.background.clone()),
            };
            validate_timeline_settings(&settings)?;
            let markers = timeline.markers.as_deref().unwrap_or(&[]);
            if markers.len() > MAX_MARKERS_PER_TIMELINE {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "This timeline holds as many markers as it can",
                ));
            }
            let mut marker_ids: HashSet<&str> = HashSet::new();
            for marker in markers {
                if !marker_ids.insert(marker.id.as_str()) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "A marker with that id is already here",
                    ));
                }
                check_marker(marker)?;
            }
            if let (Some(start), Some(end)) = (timeline.in_point_ms, timeline.out_point_ms) {
                if start >= end {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "The range needs whole milliseconds and an end after its start",
                    ));
                }
            }
            if let Some(first) = validate_timeline(timeline, moka).first() {
                return Err(CommandError::new(
                    issue_code(&first.code),
                    first.message.clone(),
                ));
            }
            let at = index.unwrap_or(timelines.len()).min(timelines.len());
            let mut list = timelines;
            list.insert(at, timeline.clone());
            Ok((
                with_timelines(moka, list),
                vec![DocumentCommand::RemoveTimeline {
                    timeline_id: timeline.id.clone(),
                }],
            ))
        }

        DocumentCommand::RemoveTimeline { timeline_id } => {
            let timelines = moka.timelines.clone().unwrap_or_default();
            let at = timelines
                .iter()
                .position(|held| held.id == *timeline_id)
                .ok_or_else(|| CommandError::new("TIMELINE_NOT_FOUND", "Timeline not found"))?;
            let removed = timelines[at].clone();
            let list: Vec<TimelineDocument> = timelines
                .into_iter()
                .filter(|held| held.id != *timeline_id)
                .collect();
            // Put back whole, at the place it was read: a timeline is a
            // document in its own right, so what it held comes back with it.
            Ok((
                with_timelines(moka, list),
                vec![DocumentCommand::AddTimeline {
                    timeline: removed,
                    index: Some(at),
                }],
            ))
        }

        DocumentCommand::RenameTimeline { timeline_id, name } => {
            let timeline = timeline_of(moka, timeline_id)?;
            check_timeline_name(name)?;
            let previous = timeline.name.clone();
            let mut renamed = timeline.clone();
            renamed.name = name.clone();
            Ok((
                replace_timeline(moka, renamed),
                vec![DocumentCommand::RenameTimeline {
                    timeline_id: timeline_id.clone(),
                    name: previous,
                }],
            ))
        }

        DocumentCommand::UpdateTimelineSettings {
            timeline_id,
            settings,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            validate_timeline_settings(settings)?;
            let mut previous = TimelineSettingsPatch::default();
            if settings.fps.is_some() {
                previous.fps = Some(timeline.settings.fps);
            }
            if settings.width.is_some() {
                previous.width = Some(timeline.settings.width);
            }
            if settings.height.is_some() {
                previous.height = Some(timeline.settings.height);
            }
            if settings.background.is_some() {
                previous.background = Some(timeline.settings.background.clone());
            }
            let mut next_settings = timeline.settings.clone();
            if let Some(fps) = settings.fps {
                next_settings.fps = fps;
            }
            if let Some(width) = settings.width {
                next_settings.width = width;
            }
            if let Some(height) = settings.height {
                next_settings.height = height;
            }
            if let Some(background) = &settings.background {
                next_settings.background = background.clone();
            }
            let mut updated = timeline.clone();
            updated.settings = next_settings;
            Ok((
                replace_timeline(moka, updated),
                vec![DocumentCommand::UpdateTimelineSettings {
                    timeline_id: timeline_id.clone(),
                    settings: previous,
                }],
            ))
        }

        DocumentCommand::AddTrack {
            timeline_id,
            track,
            index,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if timeline.tracks.len() + 1 > MAX_TRACKS_PER_TIMELINE {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Track limit reached",
                ));
            }
            if timeline.tracks.iter().any(|held| held.id == track.id) {
                return Err(CommandError::new("CONFLICT", "Track id already exists"));
            }
            if track.name.is_empty() || track.name.chars().count() > TIMELINE_NAME_MAX {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Track name is empty or too long",
                ));
            }
            let at = index
                .unwrap_or(timeline.tracks.len())
                .min(timeline.tracks.len());
            let mut tracks = timeline.tracks.clone();
            tracks.insert(at, track.clone());
            let mut updated = timeline.clone();
            updated.tracks = tracks;
            Ok((
                replace_timeline(moka, updated),
                vec![DocumentCommand::RemoveTrack {
                    timeline_id: timeline_id.clone(),
                    track_id: track.id.clone(),
                }],
            ))
        }

        DocumentCommand::RemoveTrack {
            timeline_id,
            track_id,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            let at = timeline
                .tracks
                .iter()
                .position(|held| held.id == *track_id)
                .ok_or_else(|| CommandError::new("TRACK_NOT_FOUND", "Track not found"))?;
            // A track holding clips is not taken out: the clips are work, and a
            // caller that wants the row gone moves them first.
            if timeline.clips.iter().any(|clip| clip.track_id == *track_id) {
                return Err(CommandError::new(
                    "TRACK_NOT_EMPTY",
                    "That track still holds clips",
                ));
            }
            let removed = timeline.tracks[at].clone();
            let tracks: Vec<TimelineTrack> = timeline
                .tracks
                .iter()
                .filter(|held| held.id != *track_id)
                .cloned()
                .collect();
            let mut updated = timeline.clone();
            updated.tracks = tracks;
            Ok((
                replace_timeline(moka, updated),
                vec![DocumentCommand::AddTrack {
                    timeline_id: timeline_id.clone(),
                    track: removed,
                    index: Some(at),
                }],
            ))
        }

        DocumentCommand::UpdateTrack {
            timeline_id,
            track_id,
            patch,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            let track = timeline
                .tracks
                .iter()
                .find(|held| held.id == *track_id)
                .ok_or_else(|| CommandError::new("TRACK_NOT_FOUND", "Track not found"))?;
            if let Some(name) = &patch.name {
                if name.is_empty() || name.chars().count() > TIMELINE_NAME_MAX {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "Track name is empty or too long",
                    ));
                }
            }
            let mut previous = TrackPatch::default();
            if patch.name.is_some() {
                previous.name = Some(track.name.clone());
            }
            if patch.muted.is_some() {
                previous.muted = Some(track.muted);
            }
            if patch.hidden.is_some() {
                previous.hidden = Some(track.hidden);
            }
            if patch.locked.is_some() {
                previous.locked = Some(track.locked);
            }
            if patch.gain_db.is_some() || patch.clear_gain_db == Some(true) {
                previous.gain_db = track.gain_db;
                previous.clear_gain_db = Some(track.gain_db.is_none());
            }
            if patch.solo.is_some() || patch.clear_solo == Some(true) {
                previous.solo = track.solo;
                previous.clear_solo = Some(track.solo.is_none());
            }
            if let Some(gain) = patch.gain_db {
                if !gain.is_finite() || !(-60.0..=12.0).contains(&gain) {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "A row's level runs −60 to 12 dB",
                    ));
                }
            }
            let tracks: Vec<TimelineTrack> = timeline
                .tracks
                .iter()
                .map(|held| {
                    if held.id != *track_id {
                        return held.clone();
                    }
                    let mut updated = held.clone();
                    if let Some(name) = &patch.name {
                        updated.name = name.clone();
                    }
                    if let Some(muted) = patch.muted {
                        updated.muted = muted;
                    }
                    if let Some(hidden) = patch.hidden {
                        updated.hidden = hidden;
                    }
                    if let Some(locked) = patch.locked {
                        updated.locked = locked;
                    }
                    if patch.clear_gain_db == Some(true) {
                        updated.gain_db = None;
                    } else if patch.gain_db.is_some() {
                        updated.gain_db = patch.gain_db;
                    }
                    if patch.clear_solo == Some(true) {
                        updated.solo = None;
                    } else if let Some(solo) = patch.solo {
                        updated.solo = Some(solo);
                    }
                    updated
                })
                .collect();
            let mut updated = timeline.clone();
            updated.tracks = tracks;
            Ok((
                replace_timeline(moka, updated),
                vec![DocumentCommand::UpdateTrack {
                    timeline_id: timeline_id.clone(),
                    track_id: track_id.clone(),
                    patch: previous,
                }],
            ))
        }

        DocumentCommand::AddClips {
            timeline_id,
            clips,
            seams,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if clips.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to add"));
            }
            if clips.len() > MAX_CLIPS_PER_COMMAND {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    format!("One step lands at most {MAX_CLIPS_PER_COMMAND} clips"),
                ));
            }
            if timeline.clips.len() + clips.len() > MAX_CLIPS_PER_TIMELINE {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Timeline clip limit reached",
                ));
            }
            let mut known: HashSet<&str> =
                timeline.clips.iter().map(|clip| clip.id.as_str()).collect();
            for clip in clips {
                if !known.insert(clip.id.as_str()) {
                    return Err(CommandError::new("CONFLICT", "Clip id already exists"));
                }
                check_clip(moka, timeline, clip)?;
                ensure_track_unlocked(timeline, &clip.track_id)?;
            }
            let seams: &[TimelineTransition] = seams.as_deref().unwrap_or(&[]);
            // Restored seams are read against the clips as this command leaves
            // them: a seam's leader may already be on the timeline or land with
            // this batch, and its geometry must already hold — this path
            // restores a pull-back, it does not make one (R6).
            let mut world = timeline.clone();
            world.clips.extend(clips.iter().cloned());
            let mut seam_ids: HashSet<&str> = timeline
                .transitions
                .iter()
                .map(|held| held.id.as_str())
                .collect();
            let mut seam_leaders: HashSet<&str> = timeline
                .transitions
                .iter()
                .map(|held| held.after_clip_id.as_str())
                .collect();
            for seam in seams {
                if !seam_ids.insert(seam.id.as_str()) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "Transition id already exists",
                    ));
                }
                if !seam_leaders.insert(seam.after_clip_id.as_str()) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "That seam already carries a transition",
                    ));
                }
                check_transition_restoration(&world, seam)?;
            }
            check_no_overlap(timeline, clips, &[], seams)?;
            for clip in clips {
                check_clip_within_asset(moka, clip)?;
            }
            let mut next = timeline.clone();
            next.clips.extend(clips.iter().cloned());
            next.transitions.extend(seams.iter().cloned());
            // No transition can point at a clip that did not exist, so there is
            // nothing here to restore beside the clips and seams themselves.
            let inverse = vec![DocumentCommand::RemoveClips {
                timeline_id: timeline_id.clone(),
                clip_ids: clips.iter().map(|clip| clip.id.clone()).collect(),
            }];
            Ok((replace_timeline(moka, next), inverse))
        }

        DocumentCommand::RemoveClips {
            timeline_id,
            clip_ids,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            let removing: HashSet<&str> = clip_ids.iter().map(String::as_str).collect();
            let removed: Vec<TimelineClip> = timeline
                .clips
                .iter()
                .filter(|clip| removing.contains(clip.id.as_str()))
                .cloned()
                .collect();
            if removed.len() != removing.len() {
                return Err(CommandError::new(
                    "CLIP_NOT_FOUND",
                    "Some clips were not found",
                ));
            }
            for clip in &removed {
                ensure_track_unlocked(timeline, &clip.track_id)?;
            }
            // Each seam transition goes with its seam, and both seams a removed
            // clip touched — the one ahead of it and the one behind it — go.
            let removed_transitions = transitions_of_seams(timeline, clip_ids);
            let removed_ids: HashSet<&str> = removed_transitions
                .iter()
                .map(|transition| transition.id.as_str())
                .collect();
            let mut next = timeline.clone();
            next.clips = timeline
                .clips
                .iter()
                .filter(|clip| !removing.contains(clip.id.as_str()))
                .cloned()
                .collect();
            next.transitions = timeline
                .transitions
                .iter()
                .filter(|transition| !removed_ids.contains(transition.id.as_str()))
                .cloned()
                .collect();
            // The clips and their seams come back in one command, in the
            // geometry they were stored in: restoring the clips alone would put
            // the follower in the bare overlap the seam is made of, and the
            // first step of a two-step restore would be refused there. The
            // `seams` key is left off entirely when there is none, so the JSON
            // reads as the TypeScript twin writes it.
            let inverse = vec![DocumentCommand::AddClips {
                timeline_id: timeline_id.clone(),
                clips: removed,
                seams: if removed_transitions.is_empty() {
                    None
                } else {
                    Some(removed_transitions)
                },
            }];
            Ok((replace_timeline(moka, next), inverse))
        }

        DocumentCommand::UpdateClips {
            timeline_id,
            patches,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if patches.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to update"));
            }
            if patches.len() > MAX_CLIPS_PER_COMMAND {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    format!("One step touches at most {MAX_CLIPS_PER_COMMAND} clips"),
                ));
            }
            let by_id: HashMap<&str, &TimelineClip> = timeline
                .clips
                .iter()
                .map(|clip| (clip.id.as_str(), clip))
                .collect();
            let mut updated: HashMap<String, TimelineClip> = HashMap::new();
            let mut material_checked: Vec<TimelineClip> = Vec::new();
            let mut inverse_patches: Vec<ClipPatchEntry> = Vec::new();
            for entry in patches {
                let clip = by_id
                    .get(entry.clip_id.as_str())
                    .copied()
                    .ok_or_else(|| CommandError::new("CLIP_NOT_FOUND", "Clip not found"))?;
                ensure_track_unlocked(timeline, &clip.track_id)?;
                if updated.contains_key(&entry.clip_id) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "A clip is patched twice in one step",
                    ));
                }
                let merged = merge_clip_patch(clip, &entry.patch);
                check_clip(moka, timeline, &merged)?;
                if entry.patch.asset_id.is_some()
                    || entry.patch.duration_ms.is_some()
                    || entry.patch.in_point_ms.is_some()
                    || entry.patch.out_point_ms.is_some()
                    || entry.patch.speed.is_some()
                {
                    material_checked.push(merged.clone());
                }
                updated.insert(entry.clip_id.clone(), merged);
                // The inverse patch carries back what this one moved, and
                // nothing else — a field this patch brought in goes with a null.
                inverse_patches.push(ClipPatchEntry {
                    clip_id: entry.clip_id.clone(),
                    patch: invert_clip_patch(clip, &entry.patch),
                });
            }
            let mut next = timeline.clone();
            next.clips = timeline
                .clips
                .iter()
                .map(|clip| {
                    updated
                        .get(&clip.id)
                        .cloned()
                        .unwrap_or_else(|| clip.clone())
                })
                .collect();
            // The whole timeline as it would be, so a clip stretched onto a
            // neighbour is CLIP_OVERLAP and one that tears a seam is
            // TRANSITION_SEAM (R5, R7).
            check_timeline(moka, &next)?;
            for clip in &material_checked {
                check_clip_within_asset(moka, clip)?;
            }
            Ok((
                replace_timeline(moka, next),
                // One command over every patch: applied one by one, two clips
                // moving past each other would be an overlap half way home.
                vec![DocumentCommand::UpdateClips {
                    timeline_id: timeline_id.clone(),
                    patches: inverse_patches,
                }],
            ))
        }

        DocumentCommand::InsertClips {
            timeline_id,
            clips,
            mode,
            ripple_scope,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if clips.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to add"));
            }
            if clips.len() > MAX_CLIPS_PER_COMMAND {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    format!("One step lands at most {MAX_CLIPS_PER_COMMAND} clips"),
                ));
            }
            let mut known: HashSet<&str> =
                timeline.clips.iter().map(|clip| clip.id.as_str()).collect();
            for clip in clips {
                if !known.insert(clip.id.as_str()) {
                    return Err(CommandError::new("CONFLICT", "Clip id already exists"));
                }
                check_clip(moka, timeline, clip)?;
                check_clip_within_asset(moka, clip)?;
            }
            for at in 0..clips.len() {
                for other in at + 1..clips.len() {
                    let a = &clips[at];
                    let b = &clips[other];
                    if a.track_id == b.track_id && clips_overlap(a, b) {
                        return Err(CommandError::new("CLIP_OVERLAP", describe_overlap(a, b)));
                    }
                }
            }
            let start = clips.iter().map(|clip| clip.start_ms).min().unwrap_or(0);
            if start < 0 {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Clip start is not a whole number of milliseconds",
                ));
            }
            let final_clips = match mode {
                InsertMode::Overwrite => overlay_clips(moka, timeline, clips)?,
                InsertMode::Ripple => ripple_clips(
                    moka,
                    timeline,
                    clips,
                    ripple_scope.unwrap_or(RippleScope::All),
                )?,
            };
            if final_clips.len() > MAX_CLIPS_PER_TIMELINE {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Timeline clip limit reached",
                ));
            }
            let original: HashMap<&str, &TimelineClip> = timeline
                .clips
                .iter()
                .map(|clip| (clip.id.as_str(), clip))
                .collect();
            let final_ids: HashSet<&str> =
                final_clips.iter().map(|clip| clip.id.as_str()).collect();
            let removed: Vec<String> = timeline
                .clips
                .iter()
                .filter(|clip| !final_ids.contains(clip.id.as_str()))
                .map(|clip| clip.id.clone())
                .collect();
            let added: Vec<TimelineClip> = final_clips
                .iter()
                .filter(|clip| !original.contains_key(clip.id.as_str()))
                .cloned()
                .collect();
            let mut patches: Vec<ClipPatchEntry> = Vec::new();
            for clip in &final_clips {
                if let Some(held) = original.get(clip.id.as_str()) {
                    if timing_changed(held, clip) {
                        patches.push(ClipPatchEntry {
                            clip_id: clip.id.clone(),
                            patch: timing_patch(held, clip),
                        });
                    }
                }
            }
            let mut commands: Vec<DocumentCommand> = Vec::new();
            if !removed.is_empty() {
                commands.push(DocumentCommand::RemoveClips {
                    timeline_id: timeline_id.clone(),
                    clip_ids: removed,
                });
            }
            if !patches.is_empty() {
                commands.push(DocumentCommand::UpdateClips {
                    timeline_id: timeline_id.clone(),
                    patches,
                });
            }
            if !added.is_empty() {
                commands.push(DocumentCommand::AddClips {
                    timeline_id: timeline_id.clone(),
                    clips: added,
                    seams: None,
                });
            }
            // The landing is expressed through the commands that already know
            // how to validate and undo themselves, so its history is exactly
            // the trims, removals, and additions it took.
            let mut current = moka.clone();
            let mut inverses: Vec<DocumentCommand> = Vec::new();
            for command in commands {
                let (next, inverse) = apply_timeline_command(&current, &command)?;
                current = next;
                let mut combined = inverse;
                combined.extend(inverses);
                inverses = combined;
            }
            Ok((current, inverses))
        }

        DocumentCommand::RippleDeleteClips {
            timeline_id,
            clip_ids,
            scope,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if clip_ids.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to remove"));
            }
            let removing: HashSet<&str> = clip_ids.iter().map(String::as_str).collect();
            if timeline
                .clips
                .iter()
                .filter(|clip| removing.contains(clip.id.as_str()))
                .count()
                != removing.len()
            {
                return Err(CommandError::new(
                    "CLIP_NOT_FOUND",
                    "Some clips were not found",
                ));
            }
            apply_planned_clips(
                moka,
                timeline,
                ripple_deleted(timeline, clip_ids, scope.unwrap_or(RippleScope::All)),
            )
        }

        DocumentCommand::CloseGaps {
            timeline_id,
            track_id,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if let Some(id) = track_id {
                if !timeline.tracks.iter().any(|track| track.id == *id) {
                    return Err(CommandError::new(
                        "TRACK_NOT_FOUND",
                        "Clip's track not found",
                    ));
                }
            }
            apply_planned_clips(moka, timeline, closed_gaps(timeline, track_id.as_deref()))
        }

        DocumentCommand::DeleteGap {
            timeline_id,
            track_id,
            at_ms,
            scope,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if !timeline.tracks.iter().any(|track| track.id == *track_id) {
                return Err(CommandError::new(
                    "TRACK_NOT_FOUND",
                    "Clip's track not found",
                ));
            }
            let (gap_start, gap_end) = gap_at(timeline, track_id, *at_ms).ok_or_else(|| {
                CommandError::new("GAP_NOT_FOUND", "There is no gap at that moment")
            })?;
            let shift = gap_end - gap_start;
            let final_clips = timeline
                .clips
                .iter()
                .map(|clip| {
                    if *scope != Some(RippleScope::All) && clip.track_id != *track_id {
                        return clip.clone();
                    }
                    if clip.start_ms < gap_end {
                        return clip.clone();
                    }
                    let mut next = clip.clone();
                    next.start_ms -= shift;
                    next
                })
                .collect();
            apply_planned_clips(moka, timeline, final_clips)
        }

        DocumentCommand::SlipClips { timeline_id, edits } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if edits.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to update"));
            }
            let mut seen: HashSet<&str> = HashSet::new();
            for edit in edits {
                if !seen.insert(edit.clip_id.as_str()) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "A clip is patched twice in one step",
                    ));
                }
                if !timeline.clips.iter().any(|clip| clip.id == edit.clip_id) {
                    return Err(CommandError::new("CLIP_NOT_FOUND", "Clip not found"));
                }
            }
            apply_planned_clips(moka, timeline, slip_planned_clips(moka, timeline, edits)?)
        }

        DocumentCommand::SlideClips { timeline_id, moves } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if moves.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to move"));
            }
            let mut seen: HashSet<&str> = HashSet::new();
            for movement in moves {
                if !seen.insert(movement.clip_id.as_str()) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "A clip is patched twice in one step",
                    ));
                }
                if !timeline
                    .clips
                    .iter()
                    .any(|clip| clip.id == movement.clip_id)
                {
                    return Err(CommandError::new("CLIP_NOT_FOUND", "Clip not found"));
                }
            }
            apply_planned_clips(moka, timeline, slide_planned_clips(moka, timeline, moves)?)
        }

        DocumentCommand::RollEdit {
            timeline_id,
            after_clip_id,
            by_ms,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            apply_planned_clips(
                moka,
                timeline,
                roll_planned_clips(moka, timeline, after_clip_id, *by_ms)?,
            )
        }

        DocumentCommand::RemoveRange {
            timeline_id,
            start_ms,
            end_ms,
            scope,
            track_id,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if *start_ms < 0 || *end_ms <= *start_ms {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "The range to remove is empty",
                ));
            }
            let scope = scope.unwrap_or(RippleScope::All);
            if scope == RippleScope::Track && track_id.is_none() {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Removing from one row needs that row",
                ));
            }
            if let Some(id) = track_id {
                if !timeline.tracks.iter().any(|track| track.id == *id) {
                    return Err(CommandError::new(
                        "TRACK_NOT_FOUND",
                        "Clip's track not found",
                    ));
                }
            }
            apply_planned_clips(
                moka,
                timeline,
                range_planned_clips(
                    moka,
                    timeline,
                    *start_ms,
                    *end_ms,
                    scope,
                    track_id.as_deref(),
                )?,
            )
        }

        DocumentCommand::AddMarkers {
            timeline_id,
            markers,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if markers.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to add"));
            }
            let held = timeline.markers.clone().unwrap_or_default();
            if held.len() + markers.len() > MAX_MARKERS_PER_TIMELINE {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "This timeline holds as many markers as it can",
                ));
            }
            let mut ids: HashSet<&str> = held.iter().map(|marker| marker.id.as_str()).collect();
            for marker in markers {
                if !ids.insert(marker.id.as_str()) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "A marker with that id is already here",
                    ));
                }
                check_marker(marker)?;
            }
            let mut next = timeline.clone();
            next.markers = Some(
                held.into_iter()
                    .chain(markers.iter().cloned())
                    .collect::<Vec<_>>(),
            );
            next.schema_version = TIMELINE_SCHEMA_VERSION;
            Ok((
                replace_timeline(moka, next),
                vec![DocumentCommand::RemoveMarkers {
                    timeline_id: timeline_id.clone(),
                    marker_ids: Some(markers.iter().map(|marker| marker.id.clone()).collect()),
                    all: None,
                }],
            ))
        }

        DocumentCommand::UpdateMarkers {
            timeline_id,
            patches,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if patches.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to update"));
            }
            let held = timeline.markers.clone().unwrap_or_default();
            let mut updated: HashMap<String, TimelineMarker> = HashMap::new();
            let mut inverse_patches: Vec<MarkerPatch> = Vec::new();
            for patch in patches {
                let marker = held
                    .iter()
                    .find(|marker| marker.id == patch.marker_id)
                    .cloned()
                    .ok_or_else(|| {
                        CommandError::new(
                            "MOKA_FIELD_MISSING",
                            "That marker is not on this timeline",
                        )
                    })?;
                if updated.contains_key(&patch.marker_id) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "A clip is patched twice in one step",
                    ));
                }
                let mut next = marker.clone();
                if let Some(at_ms) = patch.at_ms {
                    next.at_ms = at_ms;
                }
                if let Some(label) = &patch.label {
                    next.label = label.clone();
                }
                if let Some(color) = &patch.color {
                    next.color = color.clone();
                }
                check_marker(&next)?;
                inverse_patches.push(MarkerPatch {
                    marker_id: marker.id.clone(),
                    at_ms: Some(marker.at_ms),
                    label: Some(marker.label.clone()),
                    color: Some(marker.color.clone()),
                });
                updated.insert(patch.marker_id.clone(), next);
            }
            let mut next = timeline.clone();
            next.markers = Some(
                held.into_iter()
                    .map(|marker| updated.get(&marker.id).cloned().unwrap_or(marker))
                    .collect(),
            );
            next.schema_version = TIMELINE_SCHEMA_VERSION;
            Ok((
                replace_timeline(moka, next),
                vec![DocumentCommand::UpdateMarkers {
                    timeline_id: timeline_id.clone(),
                    patches: inverse_patches,
                }],
            ))
        }

        DocumentCommand::RemoveMarkers {
            timeline_id,
            marker_ids,
            all,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            let held = timeline.markers.clone().unwrap_or_default();
            let removing: HashSet<String> = match (all, marker_ids) {
                (Some(true), _) => held.iter().map(|marker| marker.id.clone()).collect(),
                (_, Some(ids)) => ids.iter().cloned().collect(),
                _ => HashSet::new(),
            };
            if removing.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to remove"));
            }
            let removed: Vec<TimelineMarker> = held
                .iter()
                .filter(|marker| removing.contains(&marker.id))
                .cloned()
                .collect();
            if removed.len() != removing.len() {
                return Err(CommandError::new(
                    "MOKA_FIELD_MISSING",
                    "Some markers are not on this timeline",
                ));
            }
            let remaining: Vec<TimelineMarker> = held
                .into_iter()
                .filter(|marker| !removing.contains(&marker.id))
                .collect();
            let mut next = timeline.clone();
            next.markers = (!remaining.is_empty()).then_some(remaining);
            next.schema_version = TIMELINE_SCHEMA_VERSION;
            Ok((
                replace_timeline(moka, next),
                vec![DocumentCommand::AddMarkers {
                    timeline_id: timeline_id.clone(),
                    markers: removed,
                }],
            ))
        }

        DocumentCommand::SetTimelineRange {
            timeline_id,
            in_ms,
            out_ms,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if in_ms.is_some_and(|value| value < 0) || out_ms.is_some_and(|value| value < 0) {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "The range needs whole milliseconds and an end after its start",
                ));
            }
            if let (Some(start), Some(end)) = (in_ms, out_ms) {
                if start >= end {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "The range needs whole milliseconds and an end after its start",
                    ));
                }
            }
            let previous_in = timeline.in_point_ms;
            let previous_out = timeline.out_point_ms;
            let mut next = timeline.clone();
            next.in_point_ms = *in_ms;
            next.out_point_ms = *out_ms;
            next.schema_version = TIMELINE_SCHEMA_VERSION;
            Ok((
                replace_timeline(moka, next),
                vec![DocumentCommand::SetTimelineRange {
                    timeline_id: timeline_id.clone(),
                    in_ms: previous_in,
                    out_ms: previous_out,
                }],
            ))
        }

        DocumentCommand::MoveClips { timeline_id, moves } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if moves.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to move"));
            }
            if moves.len() > MAX_CLIPS_PER_COMMAND {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    format!("One step moves at most {MAX_CLIPS_PER_COMMAND} clips"),
                ));
            }
            let by_id: HashMap<&str, &TimelineClip> = timeline
                .clips
                .iter()
                .map(|clip| (clip.id.as_str(), clip))
                .collect();
            // Last one wins for a clip moved twice in one command, and the undo
            // remembers where the clip started, in the order it was first named.
            let mut moved: HashMap<String, TimelineClip> = HashMap::new();
            let mut positions: Vec<(String, i64, String)> = Vec::new();
            for held_move in moves {
                let clip = by_id
                    .get(held_move.clip_id.as_str())
                    .copied()
                    .ok_or_else(|| CommandError::new("CLIP_NOT_FOUND", "Clip not found"))?;
                let target_track_id = held_move
                    .track_id
                    .as_deref()
                    .unwrap_or(clip.track_id.as_str());
                let target = timeline
                    .tracks
                    .iter()
                    .find(|track| track.id == target_track_id)
                    .ok_or_else(|| {
                        CommandError::new("TRACK_NOT_FOUND", "Clip's track not found")
                    })?;
                if !track_accepts(target, clip.kind) {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        format!(
                            "A {} clip cannot sit on a {} track",
                            clip.kind.as_str(),
                            target.kind.as_str()
                        ),
                    ));
                }
                ensure_track_unlocked(timeline, &clip.track_id)?;
                ensure_track_unlocked(timeline, target_track_id)?;
                if held_move.start_ms < 0 {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "Clip start is not a whole number of milliseconds",
                    ));
                }
                if !positions.iter().any(|(id, _, _)| id == &held_move.clip_id) {
                    positions.push((
                        held_move.clip_id.clone(),
                        clip.start_ms,
                        clip.track_id.clone(),
                    ));
                }
                let mut placed = clip.clone();
                placed.start_ms = held_move.start_ms;
                placed.track_id = target_track_id.to_string();
                moved.insert(held_move.clip_id.clone(), placed);
            }
            let mut next = timeline.clone();
            next.clips = timeline
                .clips
                .iter()
                .map(|clip| moved.get(&clip.id).cloned().unwrap_or_else(|| clip.clone()))
                .collect();
            // The whole timeline as it would be: a move onto a held place is
            // CLIP_OVERLAP, and one that leaves a transition's clips no longer
            // making its seam is TRANSITION_SEAM (R5, R7). Moving both ends of
            // a seam by the same shift moves the seam along with them.
            check_timeline(moka, &next)?;
            let inverse_moves: Vec<ClipMove> = positions
                .into_iter()
                .map(|(clip_id, start_ms, track_id)| {
                    let track_changed = moved
                        .get(&clip_id)
                        .is_some_and(|clip| clip.track_id != track_id);
                    ClipMove {
                        clip_id,
                        start_ms,
                        track_id: if track_changed { Some(track_id) } else { None },
                    }
                })
                .collect();
            Ok((
                replace_timeline(moka, next),
                vec![DocumentCommand::MoveClips {
                    timeline_id: timeline_id.clone(),
                    moves: inverse_moves,
                }],
            ))
        }

        DocumentCommand::AddTransitions {
            timeline_id,
            transitions,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            if transitions.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to add"));
            }
            if timeline.transitions.len() + transitions.len() > MAX_TRANSITIONS_PER_TIMELINE {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Timeline transition limit reached",
                ));
            }
            let mut known: HashSet<&str> = timeline
                .transitions
                .iter()
                .map(|held| held.id.as_str())
                .collect();
            let mut seam_leaders: HashSet<&str> = timeline
                .transitions
                .iter()
                .map(|held| held.after_clip_id.as_str())
                .collect();
            // The batch reads the timeline as the command entered it: a chain
            // being reassembled has every follower still butted until this
            // command pulls them back, one after the other.
            for transition in transitions {
                if !known.insert(transition.id.as_str()) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "Transition id already exists",
                    ));
                }
                if !seam_leaders.insert(transition.after_clip_id.as_str()) {
                    return Err(CommandError::new(
                        "CONFLICT",
                        "That seam already carries a transition",
                    ));
                }
                if let Some(leader) = timeline
                    .clips
                    .iter()
                    .find(|clip| clip.id == transition.after_clip_id)
                {
                    ensure_track_unlocked(timeline, &leader.track_id)?;
                }
                check_transition_landing(timeline, transition)?;
            }
            // Install the records and pull each follower back as the timeline
            // stands at that point, so each seam of a chain is measured against
            // the geometry the seams before it left behind.
            let mut pulled = timeline.clone();
            for transition in transitions {
                let leader = pulled
                    .clips
                    .iter()
                    .find(|clip| clip.id == transition.after_clip_id)
                    .cloned()
                    .ok_or_else(|| {
                        CommandError::new("CLIP_NOT_FOUND", "Transition's clip not found")
                    })?;
                let follower = follower_of(&pulled, &leader).cloned().ok_or_else(|| {
                    CommandError::new(
                        "VALIDATION_FAILED",
                        "A transition needs a clip behind the one it follows",
                    )
                })?;
                let start_ms = to_i64(
                    leader.start_ms as i128 + leader.duration_ms as i128
                        - transition.duration_ms as i128,
                );
                let delta = start_ms - follower.start_ms;
                for clip in &mut pulled.clips {
                    if clip.track_id == follower.track_id && clip.start_ms >= follower.start_ms {
                        clip.start_ms += delta;
                    }
                }
            }
            let mut next = pulled;
            next.transitions = timeline
                .transitions
                .iter()
                .chain(transitions.iter())
                .cloned()
                .collect();
            check_timeline(moka, &next)?;
            let inverse = vec![DocumentCommand::RemoveTransitions {
                timeline_id: timeline_id.clone(),
                transition_ids: transitions
                    .iter()
                    .map(|transition| transition.id.clone())
                    .collect(),
            }];
            Ok((replace_timeline(moka, next), inverse))
        }

        DocumentCommand::RemoveTransitions {
            timeline_id,
            transition_ids,
        } => {
            let timeline = timeline_of(moka, timeline_id)?;
            let by_id: HashMap<&str, &TimelineTransition> = timeline
                .transitions
                .iter()
                .map(|transition| (transition.id.as_str(), transition))
                .collect();
            let removing: HashSet<&str> = transition_ids.iter().map(String::as_str).collect();
            if removing.len() != transition_ids.len() {
                return Err(CommandError::new(
                    "CONFLICT",
                    "A transition is named twice in one step",
                ));
            }
            // Release each follower back against its leader, one seam at a time
            // in the order the ids are given: a chain comes apart left to
            // right, because taking a seam out right to left would move its
            // follower into one that is still pulled back.
            let mut working = timeline.clone();
            for transition_id in transition_ids {
                let transition = by_id.get(transition_id.as_str()).ok_or_else(|| {
                    CommandError::new("TRANSITION_NOT_FOUND", "Some transitions were not found")
                })?;
                let leader = working
                    .clips
                    .iter()
                    .find(|clip| clip.id == transition.after_clip_id)
                    .cloned();
                let follower = leader
                    .as_ref()
                    .and_then(|leader| follower_of(&working, leader).cloned());
                let (Some(leader), Some(follower)) = (leader, follower) else {
                    return Err(CommandError::new(
                        "TRANSITION_NOT_FOUND",
                        "The seam a transition names is not on the timeline",
                    ));
                };
                ensure_track_unlocked(&working, &leader.track_id)?;
                let start_ms = to_i64(leader.start_ms as i128 + leader.duration_ms as i128);
                let delta = start_ms - follower.start_ms;
                for clip in &mut working.clips {
                    if clip.track_id == follower.track_id && clip.start_ms >= follower.start_ms {
                        clip.start_ms += delta;
                    }
                }
            }
            let removed: Vec<TimelineTransition> = transition_ids
                .iter()
                .filter_map(|id| {
                    by_id
                        .get(id.as_str())
                        .map(|transition| (*transition).clone())
                })
                .collect();
            let mut next = working;
            next.transitions = next
                .transitions
                .iter()
                .filter(|transition| !removing.contains(transition.id.as_str()))
                .cloned()
                .collect();
            // What the releases leave behind has to be a state the document may
            // hold: a follower running into the clip behind it is CLIP_OVERLAP,
            // and a seam torn out from under the seam behind it is
            // TRANSITION_SEAM. Seams this same batch released are no longer on
            // the timeline, so they are not among what this reads (R4, R7).
            check_timeline(moka, &next)?;
            Ok((
                replace_timeline(moka, next),
                // Same order in, same order out: the pull-backs replay left to
                // right.
                vec![DocumentCommand::AddTransitions {
                    timeline_id: timeline_id.clone(),
                    transitions: removed,
                }],
            ))
        }

        other => Err(CommandError::new(
            "INTERNAL",
            format!("{other:?} is not a timeline command"),
        )),
    }
}
