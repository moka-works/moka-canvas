//! What a timeline would be rendered as, decided before anything runs.
//!
//! Pure: a document, the files its clips name, and what the machine's ffmpeg
//! can do go in; the input list, the filter graph, the burn-in script, and the
//! length come out. Nothing here spawns anything or writes anything, so the
//! whole of an export's shape can be asserted line by line — and the same
//! reading of the document drives the graph whatever the machine is.
//!
//! The graph is built bottom-up, the way the picture is: a colour base, every
//! block composed on its own, chains of blocks fused with `xfade`, video rows
//! laid over one another in the order the document holds them, and the words
//! burned in last by the subtitle renderer.

use super::fonts::FONTS_DIR;
use super::locate::{ClipCapabilities, ASS_MISSING_REASON};
use super::{named_asset, PlanAsset, PlanInput, PlanSources};
use crate::domain::{
    MokaFile, TimelineClip, TimelineDocument, TimelineTrack, TimelineTransition, TrackKind,
    TransitionKind,
};
use std::collections::HashMap;
use std::path::PathBuf;
use thiserror::Error;

/// What is wrong with a timeline that cannot be rendered.
///
/// Every variant carries the code the API answers with: the dialog shows one
/// sentence, and a client branches on the code.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PlanError {
    #[error("{0}")]
    ValidationFailed(String),
    #[error("{0}")]
    AssetMissing(String),
    #[error("The timeline has nothing to render.")]
    Empty,
    #[error("{0}")]
    FfmpegUnavailable(String),
}

impl PlanError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ValidationFailed(_) => "VALIDATION_FAILED",
            Self::AssetMissing(_) => "ASSET_MISSING",
            Self::Empty => "RENDER_PLAN_EMPTY",
            Self::FfmpegUnavailable(_) => "FFMPEG_UNAVAILABLE",
        }
    }
}

/// Everything one render needs to know about itself.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderPlan {
    /// The files the command opens, in the order their stream numbers count in.
    pub inputs: Vec<PlanInput>,
    /// The `-filter_complex` body, relative file names and all.
    pub graph: String,
    /// The burn-in script, when the timeline has words on it.
    pub ass: Option<String>,
    /// How long the render runs: the last block's end on the timeline.
    pub duration_ms: i64,
    /// The frame rate the render is written at.
    pub fps: i32,
    /// Whether the graph ends in an audio stream that must be mapped.
    pub audio: bool,
}

/// What the planner decided about one file, before it is written down.
struct InputPlan {
    path: PathBuf,
    has_audio: bool,
    image: bool,
    /// Every clip that reads this file, which is what decides whether the
    /// seek can be pushed down to the input or the graph has to trim.
    clip_uses: usize,
    video_uses: usize,
    audio_uses: usize,
    /// The first reading clip's window, which is the window a single-reader
    /// input is asked for.
    first_window: Option<(i64, i64)>,
}

impl InputPlan {
    fn shared(&self) -> bool {
        self.clip_uses > 1
    }

    /// Whether the input itself is asked for a window rather than the whole file.
    fn seeked(&self) -> bool {
        !self.shared() && !self.image && self.first_window.is_some()
    }

    fn into_input(self) -> PlanInput {
        let seeked = self.seeked();
        let window = self.first_window;
        let shared = self.shared();
        let (seek_ms, duration_ms) = match (seeked, window) {
            (true, Some((start, end))) => (Some(start), Some(end - start)),
            _ => (None, None),
        };
        PlanInput {
            path: self.path,
            seek_ms,
            duration_ms,
            image: self.image,
            shared,
            has_audio: self.has_audio,
        }
    }
}

/// Reads a timeline into the exact render it asks for.
pub fn build_plan(
    sources: &PlanSources,
    timeline: &TimelineDocument,
    moka: &MokaFile,
    caps: &ClipCapabilities,
) -> Result<RenderPlan, PlanError> {
    // The document's own collecting validator first: a timeline that is wrong
    // anywhere is refused before any of its blocks are read as material.
    let issues = crate::domain::timeline::validate_timeline(timeline, moka);
    if let Some(first) = issues.first() {
        return Err(PlanError::ValidationFailed(format!(
            "{}: {}",
            first.code, first.message
        )));
    }
    if timeline.clips.is_empty() {
        return Err(PlanError::Empty);
    }
    let words: Vec<&TimelineClip> = timeline
        .clips
        .iter()
        .filter(|clip| clip.kind == TrackKind::Text)
        .collect();
    // Words the preview shows must not disappear on the way out: a build
    // without the subtitle filter is unavailable for this timeline rather
    // than quietly wordless.
    if !words.is_empty() && !caps.ass {
        return Err(PlanError::FfmpegUnavailable(ASS_MISSING_REASON.to_string()));
    }
    for clip in &timeline.clips {
        if let Some(asset_id) = named_asset(clip) {
            if sources.file_of(asset_id).is_none() {
                return Err(PlanError::AssetMissing(format!(
                    "The file for asset {asset_id} is not in the project"
                )));
            }
        }
    }

    let settings = &timeline.settings;
    let (width, height, fps) = (settings.width, settings.height, settings.fps);
    let background = settings.background.as_str();
    let duration_ms = timeline
        .clips
        .iter()
        .map(|clip| clip.start_ms + clip.duration_ms)
        .max()
        .unwrap_or(0);

    // -- the inputs, and how many times each is read --------------------------
    let mut inputs: Vec<InputPlan> = Vec::new();
    let mut by_asset: HashMap<String, usize> = HashMap::new();
    for clip in &timeline.clips {
        let Some(asset_id) = named_asset(clip) else {
            continue;
        };
        let Some(asset) = sources.asset(asset_id) else {
            continue;
        };
        let track = track_of(timeline, &clip.track_id);
        let picture = draws_picture(clip, track, Some(asset));
        let sound = is_audible(clip, track, Some(asset));
        if !picture && !sound {
            continue;
        }
        let index = match by_asset.get(asset_id) {
            Some(index) => *index,
            None => {
                inputs.push(InputPlan {
                    path: asset.path.clone(),
                    has_audio: asset.has_audio,
                    image: asset.mime.starts_with("image/"),
                    clip_uses: 0,
                    video_uses: 0,
                    audio_uses: 0,
                    first_window: None,
                });
                by_asset.insert(asset_id.to_string(), inputs.len() - 1);
                inputs.len() - 1
            }
        };
        let input = &mut inputs[index];
        input.clip_uses += 1;
        if picture {
            input.video_uses += 1;
        }
        if sound {
            input.audio_uses += 1;
        }
        if input.first_window.is_none() {
            input.first_window = Some((clip.in_point_ms, clip.out_point_ms));
        }
    }
    if inputs.is_empty() {
        // Blocks exist but none of them draws or sounds: the render is the
        // background alone, which is still a render.
    }

    let mut lines: Vec<String> = Vec::new();
    let mut labels = Labels::default();
    // The frame everything else is drawn over: the background colour, for
    // exactly as long as the cut runs.
    let base = labels.fresh();
    lines.push(format!(
        "color=c={background}:s={width}x{height}:r={fps}:d={duration},format=yuv420p[{base}]",
        duration = num(duration_ms as f64 / 1000.0)
    ));
    // A file read more than once is read whole and fanned out: an input can
    // only be consumed once, and the window belongs to the clip rather than
    // to the file.
    let mut video_cursor: Vec<usize> = vec![0; inputs.len()];
    let mut audio_cursor: Vec<usize> = vec![0; inputs.len()];
    for (index, input) in inputs.iter().enumerate() {
        if input.video_uses > 1 {
            let labels: Vec<String> = (0..input.video_uses)
                .map(|use_index| format!("[v{index}_{use_index}]"))
                .collect();
            lines.push(format!(
                "[{index}:v]split={}{labels}",
                input.video_uses,
                labels = labels.concat()
            ));
        }
        if input.audio_uses > 1 {
            let labels: Vec<String> = (0..input.audio_uses)
                .map(|use_index| format!("[a{index}_{use_index}]"))
                .collect();
            lines.push(format!(
                "[{index}:a]asplit={}{labels}",
                input.audio_uses,
                labels = labels.concat()
            ));
        }
    }

    /// The source label one reading of a file takes: a split arm when the
    /// file is fanned out, the stream itself when it is read once.
    fn source_label(index: usize, arm: usize, uses: usize, audio: bool) -> String {
        if uses > 1 {
            format!("{}{index}_{arm}", if audio { "a" } else { "v" })
        } else {
            format!("{index}:{}", if audio { "a" } else { "v" })
        }
    }

    // -- the picture ---------------------------------------------------------
    let mut layers: Vec<String> = Vec::new();
    for track in timeline
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Video && !track.hidden)
    {
        let ordered: Vec<&TimelineClip> =
            crate::domain::timeline::track_clips_in_order(timeline, &track.id)
                .into_iter()
                .filter(|clip| {
                    draws_picture(
                        clip,
                        Some(track),
                        named_asset(clip).and_then(|id| sources.asset(id)),
                    )
                })
                .collect();
        let mut at = 0usize;
        while at < ordered.len() {
            let mut group: Vec<&TimelineClip> = vec![ordered[at]];
            while at + 1 < ordered.len()
                && transition_between(timeline, ordered[at], &ordered[at + 1].id).is_some()
            {
                at += 1;
                group.push(ordered[at]);
            }
            at += 1;

            let mut members: Vec<(String, &TimelineClip)> = Vec::new();
            for clip in &group {
                let input_index = by_asset[named_asset(clip).expect("a picture reads an asset")];
                let arm = video_cursor[input_index];
                video_cursor[input_index] += 1;
                let label = labels.fresh();
                let source = source_label(input_index, arm, inputs[input_index].video_uses, false);
                let composed = picture_filters(
                    clip,
                    &inputs[input_index],
                    width,
                    height,
                    background,
                    fps,
                    group.len() > 1,
                );
                lines.push(format!("[{source}]{composed}[{label}]"));
                members.push((label, clip));
            }

            let chain_start = group[0].start_ms;
            if group.len() == 1 {
                // A lone block is placed on the timeline where it starts.
                let placed = labels.fresh();
                lines.push(format!(
                    "[{from}]setpts=PTS+{at}/TB[{placed}]",
                    from = members[0].0,
                    at = num(chain_start as f64 / 1000.0)
                ));
                layers.push(placed);
            } else {
                let mut carry = members[0].0.clone();
                for (position, (_, clip)) in members.iter().enumerate().skip(1) {
                    let leader = members[position - 1].1;
                    let Some(window) = transition_between(timeline, leader, &clip.id) else {
                        continue;
                    };
                    let merged = labels.fresh();
                    lines.push(format!(
                        "[{carry}][{follower}]xfade=transition={kind}:duration={duration}:\
offset={offset}[{merged}]",
                        follower = members[position].0,
                        kind = xfade_name(window.kind, caps),
                        duration = num(window.duration_ms as f64 / 1000.0),
                        offset = num((leader.start_ms + leader.duration_ms
                            - window.duration_ms
                            - chain_start) as f64
                            / 1000.0),
                        merged = merged,
                    ));
                    carry = merged;
                }
                // The chain starts where its first block starts; every block
                // after it was pulled back by its window.
                let placed = labels.fresh();
                lines.push(format!(
                    "[{carry}]setpts=PTS+{at}/TB[{placed}]",
                    at = num(chain_start as f64 / 1000.0)
                ));
                layers.push(placed);
            }
        }
    }

    let words_wanted = !words.is_empty();
    let mut accum = base;
    if layers.is_empty() {
        let out = if words_wanted {
            labels.fresh()
        } else {
            "vout".to_string()
        };
        lines.push(format!("[{accum}]null[{out}]"));
        accum = out;
    } else {
        for (position, layer) in layers.iter().enumerate() {
            let last = position + 1 == layers.len();
            let out = if last && !words_wanted {
                "vout".to_string()
            } else {
                labels.fresh()
            };
            // Video rows lie over one another in the order the document holds
            // them, each passing the picture through where it has none.
            lines.push(format!("[{accum}][{layer}]overlay=eof_action=pass[{out}]"));
            accum = out;
        }
    }
    let ass = words_wanted.then(|| super::ass::build_ass(timeline));
    if ass.is_some() {
        // The faces the script names travel in the scratch directory beside
        // it, and the filter is told where: a renderer left to the machine's
        // own font set draws boxes instead of words on machines that are
        // missing them.
        lines.push(format!("[{accum}]ass=subs.ass:fontsdir={FONTS_DIR}[vout]"));
    }

    // -- the sound -----------------------------------------------------------
    let mut voices: Vec<String> = Vec::new();
    for clip in timeline.clips.iter() {
        let Some(asset_id) = named_asset(clip) else {
            continue;
        };
        let Some(asset) = sources.asset(asset_id) else {
            continue;
        };
        let track = track_of(timeline, &clip.track_id);
        if !is_audible(clip, track, Some(asset)) {
            continue;
        }
        let input_index = by_asset[asset_id];
        let arm = audio_cursor[input_index];
        audio_cursor[input_index] += 1;
        let source = source_label(input_index, arm, inputs[input_index].audio_uses, true);
        let trim = !inputs[input_index].seeked();
        let label = labels.fresh();
        let filters = audio_filters(clip, trim, transition_role(timeline, clip, track));
        lines.push(format!("[{source}]{filters}[{label}]"));
        voices.push(label);
    }
    let audio = !voices.is_empty();
    if audio {
        let arms: String = voices.iter().map(|voice| format!("[{voice}]")).collect();
        lines.push(format!(
            "{arms}amix=inputs={count}:normalize=0:dropout_transition=0,alimiter=limit=0.98,\
aresample=48000[aout]",
            count = voices.len()
        ));
    }

    Ok(RenderPlan {
        inputs: inputs.into_iter().map(InputPlan::into_input).collect(),
        graph: format!("{}\n", lines.join(";\n")),
        ass,
        duration_ms,
        fps,
        audio,
    })
}

/// The row a clip sits on, when the document still holds it.
fn track_of<'a>(timeline: &'a TimelineDocument, track_id: &str) -> Option<&'a TimelineTrack> {
    timeline.tracks.iter().find(|track| track.id == track_id)
}

/// Whether a clip puts a picture on the frame: a visible row, material that
/// carries pictures, and a block that is not words.
fn draws_picture(
    clip: &TimelineClip,
    track: Option<&TimelineTrack>,
    asset: Option<&PlanAsset>,
) -> bool {
    let Some(track) = track else { return false };
    if track.kind != TrackKind::Video || track.hidden || clip.kind == TrackKind::Text {
        return false;
    }
    matches!(asset, Some(asset) if asset.mime.starts_with("video/") || asset.mime.starts_with("image/"))
}

/// Whether a clip's sound is heard.
///
/// A hidden row is only hidden: its sound still mixes in, which is the
/// document's own reading of the two switches. A muted row, a muted block, a
/// silent block, or material with no sound track is heard as nothing.
fn is_audible(
    clip: &TimelineClip,
    track: Option<&TimelineTrack>,
    asset: Option<&PlanAsset>,
) -> bool {
    let Some(track) = track else { return false };
    if clip.kind == TrackKind::Text || track.muted || clip.muted || clip.volume <= 0.0 {
        return false;
    }
    matches!(asset, Some(asset) if asset.has_audio)
}

/// The transition laid on the seam a leader opens, when the clip behind it is
/// the one the caller is asking about.
fn transition_between<'a>(
    timeline: &'a TimelineDocument,
    leader: &TimelineClip,
    follower_id: &str,
) -> Option<&'a TimelineTransition> {
    let transition = timeline
        .transitions
        .iter()
        .find(|transition| transition.after_clip_id == leader.id)?;
    let follower = crate::domain::timeline::follower_of(timeline, leader)?;
    (follower.id == follower_id).then_some(transition)
}

/// Which side of a seam window an audible clip plays, when it plays one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeamRole {
    None,
    /// The block the window opens after: it fades out across the window.
    Leader {
        window_ms: i64,
    },
    /// The block pulled back into the window: it fades in across it.
    Follower {
        window_ms: i64,
    },
}

/// The seam role a block has on its own row.
fn transition_role(
    timeline: &TimelineDocument,
    clip: &TimelineClip,
    track: Option<&TimelineTrack>,
) -> SeamRole {
    if let Some(transition) = timeline
        .transitions
        .iter()
        .find(|transition| transition.after_clip_id == clip.id)
    {
        return SeamRole::Leader {
            window_ms: transition.duration_ms,
        };
    }
    let Some(track) = track else {
        return SeamRole::None;
    };
    for other in crate::domain::timeline::track_clips_in_order(timeline, &track.id) {
        if let Some(transition) = timeline
            .transitions
            .iter()
            .find(|transition| transition.after_clip_id == other.id)
        {
            let behind = crate::domain::timeline::follower_of(timeline, other);
            if behind.is_some_and(|behind| behind.id == clip.id) {
                return SeamRole::Follower {
                    window_ms: transition.duration_ms,
                };
            }
        }
    }
    SeamRole::None
}

/// The transition an `xfade` is asked for, falling back to a crossfade when
/// the build does not know the one the document named.
pub fn xfade_name(kind: TransitionKind, caps: &ClipCapabilities) -> &'static str {
    let wanted = match kind {
        TransitionKind::Crossfade | TransitionKind::None => "fade",
        TransitionKind::DipToBlack => "fadeblack",
        TransitionKind::DipToWhite => "fadewhite",
        TransitionKind::SlideLeft => "slideleft",
        TransitionKind::SlideUp => "slideup",
        TransitionKind::Wipe => "wipeleft",
        TransitionKind::ZoomIn => "zoomin",
    };
    // An empty list means the probe read nothing, which is not the same as a
    // build that has none of them: the modern names are assumed then.
    if caps.transitions.is_empty() || caps.transitions.iter().any(|held| held == wanted) {
        wanted
    } else {
        "fade"
    }
}

/// One picture's filters, from the material's own window to a composed frame.
fn picture_filters(
    clip: &TimelineClip,
    input: &InputPlan,
    width: i32,
    height: i32,
    background: &str,
    fps: i32,
    in_chain: bool,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !input.seeked() {
        parts.push(format!(
            "trim=start={start}:end={end}",
            start = num(clip.in_point_ms as f64 / 1000.0),
            end = num(clip.out_point_ms as f64 / 1000.0)
        ));
        parts.push("setpts=PTS-STARTPTS".to_string());
    }
    if clip.speed != 1.0 {
        parts.push(format!("setpts=PTS/{}", num(clip.speed)));
    }
    parts.push(format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease,\
pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={background}"
    ));
    if let Some(adjust) = &clip.adjust {
        parts.push(format!(
            "eq=brightness={brightness}:contrast={contrast}:saturation={saturation}",
            brightness = num(adjust.brightness.clamp(-1.0, 1.0)),
            // A contrast of zero is a grey frame; ffmpeg's own floor is what
            // the preset curve is clipped to.
            contrast = num((1.0 + adjust.contrast).clamp(0.0, 2.0)),
            saturation = num((1.0 + adjust.saturation).clamp(0.0, 2.0)),
        ));
    }
    if let Some(preset) = clip.filter.as_deref() {
        if let Some(filters) = preset_filters(preset) {
            parts.push(filters.to_string());
        }
    }
    if clip.opacity < 1.0 {
        parts.push(format!(
            "format=rgba,colorchannelmixer=aa={}",
            num(clip.opacity.clamp(0.0, 1.0))
        ));
    }
    if clip.fade_in_ms > 0 {
        parts.push(format!(
            "fade=t=in:st=0:d={}",
            num(clip.fade_in_ms as f64 / 1000.0)
        ));
    }
    if clip.fade_out_ms > 0 {
        parts.push(format!(
            "fade=t=out:st={start}:d={duration}",
            start = num((clip.duration_ms - clip.fade_out_ms) as f64 / 1000.0),
            duration = num(clip.fade_out_ms as f64 / 1000.0)
        ));
    }
    parts.push(format!("fps={fps}"));
    parts.push("format=yuv420p".to_string());
    if in_chain {
        // Two input streams must sample the same pixels: a phone's picture is
        // often not square-pixeled, and `xfade` refuses a mismatch.
        parts.push("setsar=1".to_string());
    }
    parts.join(",")
}

/// One audible block's filters, from its window to a delayed, mixed stream.
fn audio_filters(clip: &TimelineClip, trim: bool, seam: SeamRole) -> String {
    let mut parts: Vec<String> = Vec::new();
    if trim {
        parts.push(format!(
            "atrim=start={start}:end={end}",
            start = num(clip.in_point_ms as f64 / 1000.0),
            end = num(clip.out_point_ms as f64 / 1000.0)
        ));
        parts.push("asetpts=PTS-STARTPTS".to_string());
    }
    if clip.speed != 1.0 {
        // `atempo` only takes 0.5–2, so a bigger change is a short chain of
        // stages rather than one filter outside its range.
        for stage in atempo_stages(clip.speed) {
            parts.push(format!("atempo={}", num(stage)));
        }
    }
    parts.push(format!("volume={}", num(clip.volume.clamp(0.0, 2.0))));
    if clip.fade_in_ms > 0 {
        parts.push(format!(
            "afade=t=in:st=0:d={}",
            num(clip.fade_in_ms as f64 / 1000.0)
        ));
    }
    if clip.fade_out_ms > 0 {
        parts.push(format!(
            "afade=t=out:st={start}:d={duration}",
            start = num((clip.duration_ms - clip.fade_out_ms) as f64 / 1000.0),
            duration = num(clip.fade_out_ms as f64 / 1000.0)
        ));
    }
    match seam {
        // The window is the follower's head, so the follower fades in from
        // zero and the leader fades out into it — linearly, as the preview's
        // own ramp does.
        SeamRole::Follower { window_ms } => parts.push(format!(
            "afade=t=in:st=0:d={}",
            num(window_ms as f64 / 1000.0)
        )),
        SeamRole::Leader { window_ms } => parts.push(format!(
            "afade=t=out:st={start}:d={duration}",
            start = num((clip.duration_ms - window_ms) as f64 / 1000.0),
            duration = num(window_ms as f64 / 1000.0)
        )),
        SeamRole::None => {}
    }
    // Placed on the timeline's clock, in every channel: a block that starts
    // late is silent before it, not compressed into the mix's head.
    parts.push(format!("adelay={}:all=1", clip.start_ms.max(0)));
    parts.join(",")
}

/// How a speed becomes `atempo` stages: every stage inside 0.5–2.0, and their
/// product the speed that was asked for.
pub fn atempo_stages(speed: f64) -> Vec<f64> {
    let mut remaining = speed;
    let mut stages = Vec::new();
    while remaining > 2.0 {
        stages.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        stages.push(0.5);
        remaining /= 0.5;
    }
    stages.push(remaining);
    stages
}

/// The colours a preset wears on the export side, from the plan's own table.
pub fn preset_filters(preset: &str) -> Option<&'static str> {
    match preset {
        "warm" => Some("colorbalance=rs=0.12:gs=0.04:bs=-0.12"),
        "cool" => Some("colorbalance=rs=-0.1:gs=0:bs=0.12"),
        "mono" => Some("hue=s=0"),
        "fade" => Some("eq=saturation=0.8:contrast=0.9:brightness=0.04"),
        "vivid" => Some("eq=saturation=1.35:contrast=1.12"),
        _ => None,
    }
}

/// A number as the filter graph spells it: three decimals at most and no
/// trailing zeros, so a snapshot reads the way a person would write it.
pub fn num(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let mut text = format!("{value:.3}");
    if text.contains('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    if text == "-0" {
        text = "0".to_string();
    }
    text
}

/// The names the graph's own labels are made of.
///
/// Numbered rather than named after clips so a snapshot shows the shape of
/// the graph rather than the shape of the ids, and so two blocks that happen
/// to share nothing still cannot collide.
#[derive(Default)]
struct Labels {
    next: usize,
}

impl Labels {
    fn fresh(&mut self) -> String {
        self.next += 1;
        format!("v{}", self.next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip::fixtures::{self, FakeAsset};
    use crate::domain::TransitionKind;

    fn video() -> FakeAsset {
        FakeAsset {
            id: "a1",
            relative: "assets/videos/a.mp4",
            mime: "video/mp4",
            has_audio: true,
        }
    }

    fn silent_video() -> FakeAsset {
        FakeAsset {
            id: "a1",
            relative: "assets/videos/a.mp4",
            mime: "video/mp4",
            has_audio: false,
        }
    }

    fn sound() -> FakeAsset {
        FakeAsset {
            id: "a2",
            relative: "assets/music/b.wav",
            mime: "audio/wav",
            has_audio: true,
        }
    }

    fn picture() -> FakeAsset {
        FakeAsset {
            id: "a3",
            relative: "assets/images/c.png",
            mime: "image/png",
            has_audio: false,
        }
    }

    struct World {
        /// Kept alive for the files the sources point at.
        _root: tempfile::TempDir,
        project: MokaFile,
        sources: PlanSources,
    }

    /// A project holding the named entries, with the files behind them written.
    fn world(assets: &[FakeAsset]) -> World {
        let root = tempfile::tempdir().unwrap();
        let sources = fixtures::sources_with(root.path(), assets);
        let entries: Vec<crate::domain::ResourceEntry> = assets
            .iter()
            .map(|asset| fixtures::entry(asset.id, "material", asset.relative, asset.mime))
            .collect();
        World {
            project: fixtures::moka(entries, Vec::new()),
            sources,
            _root: root,
        }
    }

    fn plan(
        world: &World,
        timeline: &TimelineDocument,
        caps: &ClipCapabilities,
    ) -> Result<RenderPlan, PlanError> {
        build_plan(&world.sources, timeline, &world.project, caps)
    }

    fn ok(world: &World, timeline: &TimelineDocument, caps: &ClipCapabilities) -> RenderPlan {
        plan(world, timeline, caps).expect("the plan is built")
    }

    #[test]
    fn a_single_picture_hands_its_window_to_the_input() {
        let world = world(&[video()]);
        let mut clip = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 2000);
        clip.in_point_ms = 500;
        clip.out_point_ms = 2500;
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![clip],
            Vec::new(),
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert_eq!(plan.inputs.len(), 1);
        assert_eq!(plan.inputs[0].seek_ms, Some(500));
        assert_eq!(plan.inputs[0].duration_ms, Some(2000));
        assert!(!plan.inputs[0].shared);
        assert_eq!(plan.duration_ms, 2000);
        // The window was handed to the input, so the graph has no trim of its
        // own — and no `trim` in the audio chain either.
        assert!(!plan.graph.contains("trim="), "{}", plan.graph);
        assert!(plan
            .graph
            .contains("scale=1920:1080:force_original_aspect_ratio=decrease"));
        assert!(plan
            .graph
            .contains("pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#000000"));
        assert!(plan.graph.contains("fps=30,format=yuv420p"));
        assert!(plan.graph.contains("setpts=PTS+0/TB"));
        assert!(plan.audio);
        assert!(plan.ass.is_none());
    }

    #[test]
    fn a_crossfade_lands_on_the_window_the_document_patched() {
        let world = world(&[video()]);
        let first = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 2000);
        // The follower is pulled back by half a second: it starts where the
        // window opens.
        let mut second = fixtures::material("c2", "t1", TrackKind::Video, "a1", 1500, 2000);
        second.in_point_ms = 4000;
        second.out_point_ms = 6000;
        let seam = fixtures::transition("x1", "c1", TransitionKind::Crossfade, 500);
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![first, second],
            vec![seam],
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        // One file read by both blocks: read whole, trimmed per block.
        assert_eq!(plan.inputs.len(), 1);
        assert!(plan.inputs[0].shared);
        assert!(plan
            .graph
            .contains("xfade=transition=fade:duration=0.5:offset=1.5"));
        assert!(plan.graph.contains("trim=start=0:end=2"), "{}", plan.graph);
        assert!(plan.graph.contains("trim=start=4:end=6"), "{}", plan.graph);
        // Both sides of an xfade have to sample the same pixels.
        assert_eq!(plan.graph.matches("setsar=1").count(), 2, "{}", plan.graph);
        // The chain is placed where its first block starts.
        assert!(plan.graph.contains("setpts=PTS+0/TB"));
    }

    #[test]
    fn three_fused_blocks_step_the_window_along() {
        let world = world(&[video()]);
        let first = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 2000);
        let second = fixtures::material("c2", "t1", TrackKind::Video, "a1", 1500, 2000);
        let third = fixtures::material("c3", "t1", TrackKind::Video, "a1", 3000, 2000);
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![first, second, third],
            vec![
                fixtures::transition("x1", "c1", TransitionKind::Crossfade, 500),
                fixtures::transition("x2", "c2", TransitionKind::Crossfade, 500),
            ],
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        // Two windows, each measured from the chain's own head: the second
        // block's end is 3.5s in, and its window opens half a second earlier.
        assert!(plan.graph.contains("offset=1.5"), "{}", plan.graph);
        assert!(plan.graph.contains("offset=3["), "{}", plan.graph);
        assert_eq!(plan.graph.matches("xfade=").count(), 2);
    }

    #[test]
    fn a_loose_block_is_placed_on_its_own_clock() {
        let world = world(&[video()]);
        let first = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 1000);
        let second = fixtures::material("c2", "t1", TrackKind::Video, "a1", 800, 1000);
        // A third block, well clear of the seam: its own placement.
        let third = fixtures::material("c3", "t1", TrackKind::Video, "a1", 4000, 1000);
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![first, second, third],
            vec![fixtures::transition(
                "x1",
                "c1",
                TransitionKind::Crossfade,
                200,
            )],
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert!(plan.graph.contains("offset=0.8"), "{}", plan.graph);
        assert!(plan.graph.contains("setpts=PTS+4/TB"), "{}", plan.graph);
        // One file, read three times, so it is read whole and fanned out.
        assert_eq!(plan.inputs.len(), 1);
        assert!(plan.inputs[0].shared);
        assert_eq!(plan.inputs[0].seek_ms, None);
        assert!(plan.graph.contains("[0:v]split=3"));
        assert!(plan.graph.contains("[0:a]asplit=3"));
    }

    #[test]
    fn a_hidden_row_draws_nothing_but_keeps_its_sound() {
        let world = world(&[video(), sound()]);
        let shown = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 1000);
        let hidden = fixtures::material("c2", "t2", TrackKind::Video, "a2", 0, 1000);
        let mut lower = fixtures::track("t2", TrackKind::Video);
        lower.hidden = true;
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video), lower],
            vec![shown, hidden],
            Vec::new(),
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert_eq!(plan.inputs.len(), 2);
        // The hidden row contributes no picture...
        assert!(!plan.graph.contains("[1:v]"), "{}", plan.graph);
        // ...and both blocks are heard, so both are mixed in.
        assert!(plan.audio);
        assert!(plan.graph.contains("amix=inputs=2"));
    }

    #[test]
    fn a_muted_row_is_heard_as_nothing() {
        let world = world(&[sound()]);
        let clip = fixtures::material("c1", "t1", TrackKind::Audio, "a2", 0, 1000);
        let mut quiet = fixtures::track("t1", TrackKind::Audio);
        quiet.muted = true;
        let timeline = fixtures::timeline("Cut", vec![quiet], vec![clip], Vec::new());

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert!(plan.inputs.is_empty());
        assert!(!plan.audio);
        assert!(!plan.graph.contains("amix"));
    }

    #[test]
    fn a_muted_or_silent_block_is_left_out_of_the_sound() {
        let world = world(&[sound()]);
        let silent = {
            let mut clip = fixtures::material("c1", "t1", TrackKind::Audio, "a2", 0, 1000);
            clip.volume = 0.0;
            clip
        };
        let muted = {
            let mut clip = fixtures::material("c2", "t1", TrackKind::Audio, "a2", 1000, 1000);
            clip.muted = true;
            clip
        };
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Audio)],
            vec![silent, muted],
            Vec::new(),
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert!(plan.inputs.is_empty());
        assert!(!plan.audio);
    }

    #[test]
    fn material_read_twice_is_read_whole_and_fanned_out() {
        let world = world(&[video()]);
        let mut first = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 1000);
        first.in_point_ms = 100;
        first.out_point_ms = 1100;
        let mut second = fixtures::material("c2", "t1", TrackKind::Video, "a1", 2000, 1000);
        second.in_point_ms = 5000;
        second.out_point_ms = 6000;
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![first, second],
            Vec::new(),
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert_eq!(plan.inputs.len(), 1);
        assert!(plan.inputs[0].shared);
        assert_eq!(plan.inputs[0].seek_ms, None);
        assert_eq!(plan.inputs[0].duration_ms, None);
        // Each reader gets its own arm of the split, on both streams.
        assert!(plan.graph.contains("[0:v]split=2"), "{}", plan.graph);
        assert!(plan.graph.contains("[0:a]asplit=2"), "{}", plan.graph);
        // The windows the input could not be asked for are cut in the graph,
        // one per reader rather than one for the file.
        assert!(plan.graph.contains("trim=start=0.1:end=1.1"));
        assert!(plan.graph.contains("atrim=start=5:end=6"));
        assert!(plan.graph.contains("adelay=2000:all=1"));
    }

    #[test]
    fn an_image_is_read_once_and_cut_by_its_window() {
        let world = world(&[picture()]);
        let clip = fixtures::material("c1", "t1", TrackKind::Video, "a3", 0, 3000);
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![clip],
            Vec::new(),
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert_eq!(plan.inputs.len(), 1);
        assert!(plan.inputs[0].image);
        assert_eq!(plan.inputs[0].seek_ms, None);
        assert!(plan.graph.contains("[0:v]trim=start=0:end=3"));
        // A still picture has no sound to mix.
        assert!(!plan.audio);
        assert!(!plan.graph.contains("[0:a]"));
    }

    #[test]
    fn words_are_burned_in_and_never_enter_the_graph() {
        let world = world(&[video()]);
        let picture = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 2000);
        let words = fixtures::text(
            "c2",
            "t2",
            0,
            2000,
            "Hello\nfrom the cut",
            fixtures::text_style(),
        );
        let timeline = fixtures::timeline(
            "Cut",
            vec![
                fixtures::track("t1", TrackKind::Video),
                fixtures::track("t2", TrackKind::Text),
            ],
            vec![picture, words],
            Vec::new(),
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        let ass = plan.ass.expect("the words are written down");
        assert!(ass.contains("Hello\\Nfrom the cut"), "{ass}");
        assert!(
            plan.graph.contains("ass=subs.ass:fontsdir=fonts[vout]"),
            "{}",
            plan.graph
        );
        assert!(!plan.graph.contains("Hello"));
    }

    #[test]
    fn a_speech_only_timeline_is_a_background_with_sound() {
        let world = world(&[sound()]);
        let clip = fixtures::material("c1", "t1", TrackKind::Audio, "a2", 0, 1000);
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Audio)],
            vec![clip],
            Vec::new(),
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert!(plan.graph.contains("color=c=#000000"), "{}", plan.graph);
        assert!(plan.audio);
        assert!(plan.graph.contains("[vout]"));
    }

    #[test]
    fn a_silent_video_is_not_mapped_as_though_it_had_sound() {
        let world = world(&[silent_video()]);
        let clip = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 1000);
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![clip],
            Vec::new(),
        );

        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert!(!plan.audio, "{}", plan.graph);
        assert!(!plan.graph.contains(":a"));
    }

    #[test]
    fn an_empty_timeline_has_nothing_to_render() {
        let world = world(&[]);
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            Vec::new(),
            Vec::new(),
        );
        let error = plan(&world, &timeline, &fixtures::caps(&["fade"], true)).unwrap_err();
        assert_eq!(error.code(), "RENDER_PLAN_EMPTY");
        assert_eq!(error.to_string(), "The timeline has nothing to render.");
    }

    #[test]
    fn a_file_that_is_not_there_is_an_asset_missing() {
        let root = tempfile::tempdir().unwrap();
        // The entry exists and the file does not: the document is fine, the
        // project is what is short of something.
        let sources = PlanSources {
            root: root.path().to_path_buf(),
            assets: HashMap::from([(
                "a1".to_string(),
                PlanAsset {
                    path: root.path().join("assets/videos/gone.mp4"),
                    mime: "video/mp4".to_string(),
                    category: Some("videos".to_string()),
                    has_audio: true,
                },
            )]),
        };
        let project = fixtures::moka(
            vec![fixtures::entry(
                "a1",
                "gone",
                "assets/videos/gone.mp4",
                "video/mp4",
            )],
            Vec::new(),
        );
        let clip = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 1000);
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![clip],
            Vec::new(),
        );
        let error = build_plan(
            &sources,
            &timeline,
            &project,
            &fixtures::caps(&["fade"], true),
        )
        .unwrap_err();
        assert_eq!(error.code(), "ASSET_MISSING");
        assert!(error.to_string().contains("a1"), "{error}");
    }

    #[test]
    fn a_document_the_validator_refuses_is_a_validation_failure() {
        let world = world(&[video()]);
        let mut clip = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 1000);
        clip.duration_ms = 50; // shorter than anything that can be seen
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![clip],
            Vec::new(),
        );
        let error = plan(&world, &timeline, &fixtures::caps(&["fade"], true)).unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
        assert!(error.to_string().contains("Clips run at least"), "{error}");
    }

    #[test]
    fn words_without_libass_are_unavailable_rather_than_wordless() {
        let world = world(&[]);
        let words = fixtures::text("c1", "t1", 0, 2000, "Hello", fixtures::text_style());
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![words],
            Vec::new(),
        );
        let error = plan(&world, &timeline, &fixtures::caps(&["fade"], false)).unwrap_err();
        assert_eq!(error.code(), "FFMPEG_UNAVAILABLE");
        assert!(error.to_string().contains("ass"), "{error}");
    }

    #[test]
    fn a_transition_the_build_does_not_know_falls_back_to_a_crossfade() {
        use crate::clip::locate::parse_transitions;
        let modern = crate::clip::locate::probe(std::path::Path::new("/nonexistent"));
        assert!(!modern.available);
        let old = fixtures::caps(&["fade", "wipeleft"], true);
        assert_eq!(xfade_name(TransitionKind::ZoomIn, &old), "fade");
        assert_eq!(xfade_name(TransitionKind::Wipe, &old), "wipeleft");
        let modern = fixtures::caps(&["fade", "zoomin"], true);
        assert_eq!(xfade_name(TransitionKind::ZoomIn, &modern), "zoomin");
        // Nothing read is not the same as none supported.
        let unread = fixtures::caps(&[], true);
        assert_eq!(xfade_name(TransitionKind::ZoomIn, &unread), "zoomin");
        assert!(parse_transitions("").is_empty());
    }

    #[test]
    fn speed_becomes_a_chain_of_stages_each_inside_the_filter_range() {
        assert_eq!(atempo_stages(1.0), vec![1.0]);
        assert_eq!(atempo_stages(2.0), vec![2.0]);
        assert_eq!(atempo_stages(4.0), vec![2.0, 2.0]);
        assert_eq!(atempo_stages(0.25), vec![0.5, 0.5]);
        assert_eq!(atempo_stages(0.5), vec![0.5]);
        for speed in [0.25, 0.3, 0.75, 1.5, 3.0, 4.0] {
            let stages = atempo_stages(speed);
            let product: f64 = stages.iter().product();
            assert!(
                (product - speed).abs() < 1e-9,
                "{speed} came out as {product}"
            );
            assert!(stages.iter().all(|stage| (0.5..=2.0).contains(stage)));
        }
    }

    #[test]
    fn one_number_reader_writes_numbers_the_way_a_person_would() {
        assert_eq!(num(0.0), "0");
        assert_eq!(num(2.0), "2");
        assert_eq!(num(1.5), "1.5");
        assert_eq!(num(0.8), "0.8");
        assert_eq!(num(-0.0), "0");
        assert_eq!(num(1.0 / 3.0), "0.333");
    }

    #[test]
    fn the_grade_fades_and_speed_of_a_block_land_in_its_own_chain() {
        let world = world(&[video()]);
        let mut clip = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 2000);
        clip.adjust = Some(fixtures::adjust(0.25, 0.5, -1.0));
        clip.filter = Some("warm".to_string());
        clip.opacity = 0.5;
        clip.fade_in_ms = 200;
        clip.fade_out_ms = 300;
        // Twice as fast: the window it reads is twice its length on the clock.
        clip.speed = 2.0;
        clip.out_point_ms = 4_000;
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![clip],
            Vec::new(),
        );
        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        // Brightness as it stands, contrast and saturation around one, all
        // inside the ranges the filter takes.
        assert!(
            plan.graph
                .contains("eq=brightness=0.25:contrast=1.5:saturation=0"),
            "{}",
            plan.graph
        );
        // The preset table, exactly as the plan states it.
        assert!(
            plan.graph.contains("colorbalance=rs=0.12:gs=0.04:bs=-0.12"),
            "{}",
            plan.graph
        );
        assert!(
            plan.graph.contains("format=rgba,colorchannelmixer=aa=0.5"),
            "{}",
            plan.graph
        );
        assert!(
            plan.graph.contains("fade=t=in:st=0:d=0.2"),
            "{}",
            plan.graph
        );
        assert!(
            plan.graph.contains("fade=t=out:st=1.7:d=0.3"),
            "{}",
            plan.graph
        );
        assert!(plan.graph.contains("setpts=PTS/2"), "{}", plan.graph);

        // The other presets, one line each, from the same table.
        for (preset, filter) in [
            ("cool", "colorbalance=rs=-0.1:gs=0:bs=0.12"),
            ("mono", "hue=s=0"),
            ("fade", "eq=saturation=0.8:contrast=0.9:brightness=0.04"),
            ("vivid", "eq=saturation=1.35:contrast=1.12"),
        ] {
            assert_eq!(preset_filters(preset), Some(filter), "{preset}");
        }
        assert_eq!(preset_filters("none"), None);
    }

    #[test]
    fn a_graded_block_with_fades_is_placed_where_it_starts() {
        let world = world(&[video()]);
        let mut clip = fixtures::material("c1", "t1", TrackKind::Video, "a1", 2500, 2000);
        clip.speed = 0.5;
        clip.out_point_ms = 1_000;
        clip.fade_in_ms = 400;
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![clip],
            Vec::new(),
        );
        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert!(plan.graph.contains("setpts=PTS/0.5"), "{}", plan.graph);
        assert!(plan.graph.contains("setpts=PTS+2.5/TB"), "{}", plan.graph);
        // Slowed sound is one stage, since 0.5 is the filter's own floor.
        assert!(plan.graph.contains("atempo=0.5"), "{}", plan.graph);
    }

    #[test]
    fn the_graph_for_one_picture_and_its_sound_reads_as_a_short_script() {
        let world = world(&[video()]);
        let clip = fixtures::material("c1", "t1", TrackKind::Video, "a1", 1000, 2000);
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![clip],
            Vec::new(),
        );
        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert_eq!(
            plan.graph,
            "color=c=#000000:s=1920x1080:r=30:d=3,format=yuv420p[v1];\n\
[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#000000,fps=30,format=yuv420p[v2];\n\
[v2]setpts=PTS+1/TB[v3];\n\
[v1][v3]overlay=eof_action=pass[vout];\n\
[0:a]volume=1,adelay=1000:all=1[v4];\n\
[v4]amix=inputs=1:normalize=0:dropout_transition=0,alimiter=limit=0.98,aresample=48000[aout]\n"
        );
    }

    #[test]
    fn the_graph_for_a_seam_with_words_reads_as_a_short_script() {
        let world = world(&[silent_video()]);
        let first = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 2000);
        let second = fixtures::material("c2", "t1", TrackKind::Video, "a1", 1500, 2000);
        let words = fixtures::text("c3", "t2", 0, 1000, "Hello", fixtures::text_style());
        let timeline = fixtures::timeline(
            "Cut",
            vec![
                fixtures::track("t1", TrackKind::Video),
                fixtures::track("t2", TrackKind::Text),
            ],
            vec![first, second, words],
            vec![fixtures::transition(
                "x1",
                "c1",
                TransitionKind::Crossfade,
                500,
            )],
        );
        let plan = ok(&world, &timeline, &fixtures::caps(&["fade"], true));
        assert_eq!(
            plan.graph,
            "color=c=#000000:s=1920x1080:r=30:d=3.5,format=yuv420p[v1];\n\
[0:v]split=2[v0_0][v0_1];\n\
[v0_0]trim=start=0:end=2,setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#000000,fps=30,format=yuv420p,setsar=1[v2];\n\
[v0_1]trim=start=0:end=2,setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#000000,fps=30,format=yuv420p,setsar=1[v3];\n\
[v2][v3]xfade=transition=fade:duration=0.5:offset=1.5[v4];\n\
[v4]setpts=PTS+0/TB[v5];\n\
[v1][v5]overlay=eof_action=pass[v6];\n\
[v6]ass=subs.ass:fontsdir=fonts[vout]\n"
        );
    }
}
