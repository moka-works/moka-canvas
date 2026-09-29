//! Small documents the clip tests read: a timeline with its rows and blocks,
//! and the project files behind those blocks.
//!
//! Everything is explicit rather than defaulted where a test cares about it,
//! and the shapes match what the two languages write: the same field names,
//! the same numbers, one timeline at a time.

use crate::clip::locate::ClipCapabilities;
use crate::clip::{PlanAsset, PlanSources};
use crate::domain::{
    AssetProbe, ClipAdjust, MokaFile, ProjectMetadata, ResourceEntry, ResourceRegistry, TextAlign,
    TextClipData, TextClipStyle, TextPosition, TimelineClip, TimelineDocument, TimelineSettings,
    TimelineTrack, TimelineTransition, TrackKind, TransitionKind,
};

pub const NOW: &str = "2026-01-01T00:00:00.000Z";

/// The frame the cut is read at: 1080p, thirty frames a second, black.
pub fn settings() -> TimelineSettings {
    TimelineSettings {
        fps: 30,
        width: 1920,
        height: 1080,
        background: "#000000".to_string(),
    }
}

/// A row, visible and audible unless a test says otherwise.
pub fn track(id: &str, kind: TrackKind) -> TimelineTrack {
    TimelineTrack {
        id: id.to_string(),
        kind,
        name: id.to_string(),
        muted: false,
        hidden: false,
        locked: false,
        created_at: NOW.to_string(),
    }
}

/// A block reading the whole window at its own pace, nothing on it yet.
pub fn clip(
    id: &str,
    track_id: &str,
    kind: TrackKind,
    start_ms: i64,
    duration_ms: i64,
) -> TimelineClip {
    TimelineClip {
        id: id.to_string(),
        track_id: track_id.to_string(),
        kind,
        label: id.to_string(),
        start_ms,
        duration_ms,
        in_point_ms: 0,
        out_point_ms: duration_ms,
        speed: 1.0,
        volume: 1.0,
        fade_in_ms: 0,
        fade_out_ms: 0,
        muted: false,
        opacity: 1.0,
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
        asset_id: None,
        adjust: None,
        filter: None,
        text: None,
    }
}

/// A block of material reading a named asset.
pub fn material(
    id: &str,
    track_id: &str,
    kind: TrackKind,
    asset_id: &str,
    start_ms: i64,
    duration_ms: i64,
) -> TimelineClip {
    let mut clip = clip(id, track_id, kind, start_ms, duration_ms);
    clip.asset_id = Some(asset_id.to_string());
    clip
}

/// The default words a text clip is born with, as the domain writes them.
pub fn text_style() -> TextClipStyle {
    TextClipStyle {
        font_family: "Inter, ui-sans-serif, system-ui, sans-serif".to_string(),
        font_size: 36,
        color: "#ffffff".to_string(),
        bold: false,
        italic: false,
        align: TextAlign::Center,
        position: TextPosition::Bottom,
        background: None,
        stroke_width: 0,
        stroke_color: "#000000".to_string(),
    }
}

/// A block of words, its own window being its whole length.
pub fn text(
    id: &str,
    track_id: &str,
    start_ms: i64,
    duration_ms: i64,
    content: &str,
    style: TextClipStyle,
) -> TimelineClip {
    let mut clip = clip(id, track_id, TrackKind::Text, start_ms, duration_ms);
    clip.text = Some(TextClipData {
        content: content.to_string(),
        style,
    });
    clip
}

pub fn transition(
    id: &str,
    after_clip_id: &str,
    kind: TransitionKind,
    duration_ms: i64,
) -> TimelineTransition {
    TimelineTransition {
        id: id.to_string(),
        after_clip_id: after_clip_id.to_string(),
        kind,
        duration_ms,
        created_at: NOW.to_string(),
    }
}

/// A timeline holding exactly what the caller laid down.
pub fn timeline(
    name: &str,
    tracks: Vec<TimelineTrack>,
    clips: Vec<TimelineClip>,
    transitions: Vec<TimelineTransition>,
) -> TimelineDocument {
    TimelineDocument {
        id: "tl-1".to_string(),
        name: name.to_string(),
        schema_version: 1,
        settings: settings(),
        tracks,
        clips,
        transitions,
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
    }
}

/// A project file holding the given assets and timelines.
pub fn moka(entries: Vec<ResourceEntry>, timelines: Vec<TimelineDocument>) -> MokaFile {
    let mut resources = ResourceRegistry::default();
    for entry in entries {
        let category = crate::assets::category_for_mime(entry.mime.as_deref().unwrap_or_default())
            .unwrap_or("videos");
        resources
            .category_mut(category)
            .expect("category checked above")
            .push(entry);
    }
    MokaFile {
        version: "v1".to_string(),
        metadata: ProjectMetadata {
            id: "p-1".to_string(),
            name: "A project".to_string(),
            description: None,
            cover_path: None,
            revision: 1,
            created_at: NOW.to_string(),
            updated_at: NOW.to_string(),
        },
        resources,
        folders: None,
        timelines: if timelines.is_empty() {
            None
        } else {
            Some(timelines)
        },
        stories: None,
        canvas: Vec::new(),
    }
}

/// An asset entry pointing at a path inside the project.
pub fn entry(id: &str, name: &str, path: &str, mime: &str) -> ResourceEntry {
    ResourceEntry {
        id: id.to_string(),
        name: name.to_string(),
        path: path.to_string(),
        mime: Some(mime.to_string()),
        bytes: Some(1024),
        sha256: Some("0".repeat(64)),
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
        probe: Some(AssetProbe {
            mime: mime.to_string(),
            bytes: 1024,
            sha256: "0".repeat(64),
            width: None,
            height: None,
            duration_ms: Some(1_000),
            sample_rate: None,
            channels: None,
            codec_summary: None,
            poster_asset_id: None,
        }),
        provenance: None,
        origin: Some("brought".to_string()),
        tags: None,
        note: None,
        favorite: None,
        keyword: None,
    }
}

/// Writes a file of the given bytes, with the directories above it made.
pub fn write_file(root: &std::path::Path, relative: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("fixture directory");
    }
    std::fs::write(&path, bytes).expect("fixture file");
    path
}

/// A grade of the shape a slider leaves behind.
pub fn adjust(brightness: f64, contrast: f64, saturation: f64) -> ClipAdjust {
    ClipAdjust {
        brightness,
        contrast,
        saturation,
    }
}

/// An asset a test's plan reads, with its reading spelled out.
pub struct FakeAsset {
    pub id: &'static str,
    pub relative: &'static str,
    pub mime: &'static str,
    pub has_audio: bool,
}

/// The files behind a timeline, written and described.
///
/// The sound flag is given rather than probed: what a test is about is the
/// shape of the plan, and one test is about the probing itself.
pub fn sources_with(root: &std::path::Path, assets: &[FakeAsset]) -> PlanSources {
    let mut sources = PlanSources {
        root: root.to_path_buf(),
        assets: std::collections::HashMap::new(),
    };
    for asset in assets {
        write_file(root, asset.relative, b"fixture bytes");
        sources.assets.insert(
            asset.id.to_string(),
            PlanAsset {
                path: root.join(asset.relative),
                mime: asset.mime.to_string(),
                category: None,
                has_audio: asset.has_audio,
            },
        );
    }
    sources
}

/// What a machine with a renderer reports, for the tests that are not about
/// the machine.
pub fn caps(transitions: &[&str], ass: bool) -> ClipCapabilities {
    ClipCapabilities {
        available: true,
        version: Some("6.1.1".to_string()),
        path: Some(std::path::PathBuf::from("/usr/local/bin/ffmpeg")),
        video_encoder: Some("libx264".to_string()),
        transitions: transitions.iter().map(|name| name.to_string()).collect(),
        ass,
        reason: None,
    }
}

/// A little ISO base media file: an `ftyp` and a `moov` holding one track
/// whose handler is sound or picture, whichever the caller asked for.
pub fn mp4_bytes(sound: bool) -> Vec<u8> {
    fn box_of(kind: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(kind.as_bytes());
        bytes.extend_from_slice(body);
        bytes
    }
    let mut hdlr = vec![0u8; 4]; // version and flags
    hdlr.extend_from_slice(&0u32.to_be_bytes()); // pre-defined
    hdlr.extend_from_slice(if sound { b"soun" } else { b"vide" });
    hdlr.extend_from_slice(&[0u8; 12]);
    let trak = box_of("trak", &box_of("mdia", &box_of("hdlr", &hdlr)));
    let moov = box_of("moov", &trak);
    let mut file = box_of("ftyp", b"isom\x00\x00\x00\x01isom");
    file.extend_from_slice(&moov);
    file
}
