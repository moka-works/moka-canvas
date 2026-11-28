//! The Rust half of the timeline command matrix, mirrored from
//! `src/shared/domain/timeline.test.ts`: the same cases, the same fixtures,
//! the same codes.

use moka_canvas::config::parse_test_config;
use moka_canvas::domain::commands::apply_commands;
use moka_canvas::domain::timeline::{
    MAX_CLIPS_PER_COMMAND, MAX_TIMELINES_PER_PROJECT, MAX_TRACKS_PER_TIMELINE,
};
use moka_canvas::domain::validate::validate_moka_file;
use moka_canvas::domain::{
    new_id, AssetProbe, CanvasDocument, ClipMove, ClipPatch, ClipPatchEntry, ClipSlide, ClipSlip,
    DocumentCommand, InsertMode, MokaFile, ProjectMetadata, ResourceEntry, ResourceRegistry,
    RippleScope, TextAlign, TextClipData, TextClipStyle, TextPosition, TimelineClip,
    TimelineDocument, TimelineMarker, TimelineSettings, TimelineSettingsPatch, TimelineTrack,
    TimelineTransition, TrackKind, TrackPatch, TransitionKind, MOKA_FILE_VERSION,
};
use moka_canvas::project::codec::{decode_moka_file, encode_moka_file};
use moka_canvas::project::store::ProjectRegistry;
use moka_canvas::project::{CreateProject, ProjectStore, StagedAsset};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

const NOW: &str = "2026-01-01T00:00:00.000Z";

// The timeline fixture, the same shape `buildTimelineMokaFile` gives: a
// four-second video clip on the video track and the two media assets it may
// read, with no transitions — a seam is a command's doing.
const TIMELINE: &str = "timeline-1";
const VIDEO_TRACK: &str = "track-video";
const AUDIO_TRACK: &str = "track-audio";
const TEXT_TRACK: &str = "track-text";
const VIDEO_CLIP: &str = "clip-video";
const VIDEO_ASSET: &str = "asset-video-a";
const FOLLOWER_ASSET: &str = "asset-video-b";

// The cut fixture's ids, as `cutFixtureIds` names them.
const CUT_TIMELINE: &str = "timeline-cut";
const CUT_VIDEO_TRACK: &str = "track-cut-video";
const CUT_CLIP_A: &str = "clip-cut-a";
const CUT_CLIP_B: &str = "clip-cut-b";
const CUT_CLIP_C: &str = "clip-cut-c";
const CUT_TRANSITION: &str = "transition-cut";
const CUT_TRANSITION_2: &str = "transition-cut-2";
const CUT_VIDEO_ASSET_A: &str = "asset-cut-video-a";
const CUT_VIDEO_ASSET_B: &str = "asset-cut-video-b";
const CUT_AUDIO_ASSET: &str = "asset-cut-audio";
const CUT_IMAGE_ASSET: &str = "asset-cut-image";

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name)
}

fn cut() -> MokaFile {
    let raw = std::fs::read_to_string(fixture_path("cut.moka.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn apply(moka: &MokaFile, commands: Vec<DocumentCommand>) -> (MokaFile, Vec<DocumentCommand>) {
    apply_commands(moka, &commands).expect("the commands apply")
}

fn code_of(moka: &MokaFile, command: DocumentCommand) -> &'static str {
    match apply_commands(moka, &[command]) {
        Ok(_) => "NO_ERROR",
        Err(error) => error.code,
    }
}

/// The round trip every command must survive: apply, undo with the inverse,
/// and the document is the one the step started from.
fn round_trip(moka: &MokaFile, commands: Vec<DocumentCommand>) -> MokaFile {
    let (next, inverse) = apply(moka, commands);
    let (undone, _) = apply(&next, inverse);
    assert_eq!(undone, *moka, "the inverse must put the document back");
    next
}

fn clip_ids(moka: &MokaFile, timeline: usize) -> Vec<String> {
    let mut ids: Vec<String> = moka.timelines.as_ref().unwrap()[timeline]
        .clips
        .iter()
        .map(|clip| clip.id.clone())
        .collect();
    ids.sort();
    ids
}

fn clip_at<'a>(moka: &'a MokaFile, timeline: usize, clip_id: &str) -> &'a TimelineClip {
    moka.timelines.as_ref().unwrap()[timeline]
        .clips
        .iter()
        .find(|clip| clip.id == clip_id)
        .expect("the fixture names that clip")
}

// Fixture builders ------------------------------------------------------

fn metadata() -> ProjectMetadata {
    ProjectMetadata {
        id: "project-1".into(),
        name: "Fixture".into(),
        description: None,
        cover_path: None,
        revision: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

/// A document with one empty canvas and no timelines, which is the shape a
/// project written before the cutting room existed has.
fn golden_document() -> MokaFile {
    MokaFile {
        version: MOKA_FILE_VERSION.to_string(),
        metadata: metadata(),
        resources: ResourceRegistry::default(),
        folders: None,
        timelines: None,
        stories: None,
        director_scenes: None,
        canvas: vec![CanvasDocument::empty("canvas-1".into(), "Canvas 1".into())],
    }
}

fn video_asset(id: &str, name: &str, duration_ms: i64) -> ResourceEntry {
    ResourceEntry {
        id: id.into(),
        name: name.into(),
        path: format!("assets/videos/{id}.mp4"),
        mime: Some("video/mp4".into()),
        bytes: Some(480_000),
        sha256: None,
        created_at: NOW.into(),
        updated_at: NOW.into(),
        probe: Some(AssetProbe {
            mime: "video/mp4".into(),
            bytes: 480_000,
            sha256: "a".repeat(64),
            width: Some(1920),
            height: Some(1080),
            duration_ms: Some(duration_ms),
            sample_rate: None,
            channels: None,
            codec_summary: Some("avc1".into()),
            poster_asset_id: None,
        }),
        provenance: None,
        tags: None,
        note: None,
        favorite: None,
        origin: None,
        keyword: None,
    }
}

fn track(id: &str, kind: TrackKind, name: &str) -> TimelineTrack {
    TimelineTrack {
        id: id.into(),
        kind,
        name: name.into(),
        muted: false,
        hidden: false,
        locked: false,
        created_at: NOW.into(),
    }
}

/// The clip an asset's material makes, as `createClipFromAsset` reads it: the
/// kind from the mime, the duration from the probe, the whole window at once.
fn clip_of(moka: &MokaFile, asset_id: &str, track_id: &str, start_ms: i64) -> TimelineClip {
    let asset = moka.resources.find(asset_id).expect("the fixture asset");
    let mime = asset.mime.clone().unwrap_or_default();
    let kind = if mime.starts_with("video/") {
        TrackKind::Video
    } else if mime.starts_with("audio/") {
        TrackKind::Audio
    } else {
        TrackKind::Video
    };
    let duration_ms = if mime.starts_with("image/") {
        4_000
    } else {
        asset
            .probe
            .as_ref()
            .and_then(|probe| probe.duration_ms)
            .unwrap_or(4_000)
    };
    TimelineClip {
        id: new_id(),
        track_id: track_id.into(),
        kind,
        label: asset.name.clone(),
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
        created_at: NOW.into(),
        updated_at: NOW.into(),
        asset_id: Some(asset.id.clone()),
        adjust: None,
        filter: None,
        text: None,
    }
}

fn default_text_style() -> TextClipStyle {
    TextClipStyle {
        font_family: "Inter, ui-sans-serif, system-ui, sans-serif".into(),
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

fn text_clip(content: &str, track_id: &str, start_ms: i64) -> TimelineClip {
    let label = if content.chars().count() > 24 {
        format!("{}…", content.chars().take(24).collect::<String>())
    } else {
        content.to_string()
    };
    TimelineClip {
        id: new_id(),
        track_id: track_id.into(),
        kind: TrackKind::Text,
        label,
        start_ms,
        duration_ms: 2_000,
        in_point_ms: 0,
        out_point_ms: 2_000,
        speed: 1.0,
        volume: 1.0,
        fade_in_ms: 0,
        fade_out_ms: 0,
        muted: false,
        opacity: 1.0,
        created_at: NOW.into(),
        updated_at: NOW.into(),
        asset_id: None,
        adjust: None,
        filter: None,
        text: Some(TextClipData {
            content: content.into(),
            style: default_text_style(),
        }),
    }
}

/// A timeline born empty but for its three rows, as `createTimeline` makes it.
fn create_timeline(name: &str) -> TimelineDocument {
    TimelineDocument {
        id: new_id(),
        name: name.into(),
        schema_version: 1,
        settings: TimelineSettings {
            fps: 30,
            width: 1920,
            height: 1080,
            background: "#000000".into(),
        },
        tracks: vec![
            track(&new_id(), TrackKind::Video, "Video 1"),
            track(&new_id(), TrackKind::Audio, "Audio 1"),
            track(&new_id(), TrackKind::Text, "Text 1"),
        ],
        clips: Vec::new(),
        transitions: Vec::new(),
        markers: None,
        in_point_ms: None,
        out_point_ms: None,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

fn timeline_fixture() -> MokaFile {
    let mut moka = golden_document();
    moka.resources.videos = vec![
        video_asset(VIDEO_ASSET, "opening.mp4", 4_000),
        video_asset(FOLLOWER_ASSET, "closing.mp4", 3_000),
    ];
    moka.timelines = Some(vec![TimelineDocument {
        id: TIMELINE.into(),
        name: "Timeline 1".into(),
        schema_version: 1,
        settings: TimelineSettings {
            fps: 30,
            width: 1920,
            height: 1080,
            background: "#000000".into(),
        },
        tracks: vec![
            track(VIDEO_TRACK, TrackKind::Video, "Video 1"),
            track(AUDIO_TRACK, TrackKind::Audio, "Audio 1"),
            track(TEXT_TRACK, TrackKind::Text, "Text 1"),
        ],
        clips: vec![TimelineClip {
            id: VIDEO_CLIP.into(),
            track_id: VIDEO_TRACK.into(),
            kind: TrackKind::Video,
            label: "opening.mp4".into(),
            start_ms: 0,
            duration_ms: 4_000,
            in_point_ms: 0,
            out_point_ms: 4_000,
            speed: 1.0,
            volume: 1.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            muted: false,
            opacity: 1.0,
            created_at: NOW.into(),
            updated_at: NOW.into(),
            asset_id: Some(VIDEO_ASSET.into()),
            adjust: None,
            filter: None,
            text: None,
        }],
        transitions: Vec::new(),
        markers: None,
        in_point_ms: None,
        out_point_ms: None,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }]);
    moka
}

fn transition(id: &str, after: &str, kind: TransitionKind, window: i64) -> TimelineTransition {
    TimelineTransition {
        id: id.into(),
        after_clip_id: after.into(),
        kind,
        duration_ms: window,
        created_at: NOW.into(),
    }
}

fn add_clips(clips: Vec<TimelineClip>) -> DocumentCommand {
    DocumentCommand::AddClips {
        timeline_id: TIMELINE.into(),
        clips,
        seams: None,
    }
}

/// The timeline fixture with a second clip of its material landing `start_ms`.
fn pair_at(moka: &MokaFile, start_ms: i64) -> (MokaFile, TimelineClip) {
    let second = clip_of(moka, VIDEO_ASSET, VIDEO_TRACK, start_ms);
    let (next, _) = apply(moka, vec![add_clips(vec![second.clone()])]);
    (next, second)
}

/// The cut fixture run into a chain: a clip C butted behind B and a 400ms
/// dip-to-black seam after B, which pulls C back to 5100ms. The id of C is
/// returned so a test can name the clip it added.
fn seam_chain() -> (MokaFile, String) {
    let moka = cut();
    let c = clip_of(&moka, CUT_VIDEO_ASSET_A, CUT_VIDEO_TRACK, 5_500);
    let c_id = c.id.clone();
    let (with_c, _) = apply(
        &moka,
        vec![DocumentCommand::AddClips {
            timeline_id: CUT_TIMELINE.into(),
            clips: vec![c],
            seams: None,
        }],
    );
    let chained = apply(
        &with_c,
        vec![DocumentCommand::AddTransitions {
            timeline_id: CUT_TIMELINE.into(),
            transitions: vec![transition(
                CUT_TRANSITION_2,
                CUT_CLIP_B,
                TransitionKind::DipToBlack,
                400,
            )],
        }],
    )
    .0;
    (chained, c_id)
}

// Lifecycle -------------------------------------------------------------

#[test]
fn adds_a_timeline_and_takes_it_back_out_whole() {
    let moka = golden_document();
    assert!(moka.timelines.is_none());

    let timeline = create_timeline("Cutting room");
    let next = round_trip(
        &moka,
        vec![DocumentCommand::AddTimeline {
            timeline: timeline.clone(),
            index: None,
        }],
    );
    let held = &next.timelines.as_ref().unwrap()[0];
    assert_eq!(held.tracks.len(), 3);
    assert_eq!(
        held.tracks
            .iter()
            .map(|track| track.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Video 1", "Audio 1", "Text 1"]
    );
}

#[test]
fn refuses_a_second_timeline_with_the_same_id() {
    let moka = timeline_fixture();
    let timeline = create_timeline("One");
    let (with_one, _) = apply(
        &moka,
        vec![DocumentCommand::AddTimeline {
            timeline: timeline.clone(),
            index: None,
        }],
    );
    assert_eq!(
        code_of(
            &with_one,
            DocumentCommand::AddTimeline {
                timeline,
                index: None,
            }
        ),
        "CONFLICT"
    );
}

#[test]
fn holds_a_project_to_its_timeline_count() {
    let mut moka = golden_document();
    for index in 0..MAX_TIMELINES_PER_PROJECT {
        let (next, _) = apply(
            &moka,
            vec![DocumentCommand::AddTimeline {
                timeline: create_timeline(&format!("Timeline {}", index + 1)),
                index: None,
            }],
        );
        moka = next;
    }
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddTimeline {
                timeline: create_timeline("One more"),
                index: None,
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn renames_a_timeline_and_the_undo_gives_the_name_back() {
    let moka = timeline_fixture();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::RenameTimeline {
            timeline_id: TIMELINE.into(),
            name: "Rough cut".into(),
        }],
    );
    assert_eq!(next.timelines.as_ref().unwrap()[0].name, "Rough cut");
}

#[test]
fn refuses_an_empty_or_overlong_timeline_name() {
    let moka = timeline_fixture();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::RenameTimeline {
                timeline_id: TIMELINE.into(),
                name: String::new(),
            }
        ),
        "VALIDATION_FAILED"
    );
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::RenameTimeline {
                timeline_id: TIMELINE.into(),
                name: "x".repeat(81),
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn changes_the_frame_only_where_asked_and_restores_it() {
    let moka = timeline_fixture();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateTimelineSettings {
            timeline_id: TIMELINE.into(),
            settings: TimelineSettingsPatch {
                fps: Some(60),
                ..Default::default()
            },
        }],
    );
    let settings = &next.timelines.as_ref().unwrap()[0].settings;
    assert_eq!(
        (
            settings.fps,
            settings.width,
            settings.height,
            settings.background.as_str()
        ),
        (60, 1920, 1080, "#000000")
    );
}

#[test]
fn refuses_a_frame_rate_that_is_not_one_of_the_choices() {
    let moka = timeline_fixture();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::UpdateTimelineSettings {
                timeline_id: TIMELINE.into(),
                settings: TimelineSettingsPatch {
                    fps: Some(48),
                    ..Default::default()
                },
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn takes_the_last_timeline_out_and_the_field_goes_with_it() {
    let moka = timeline_fixture();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::RemoveTimeline {
            timeline_id: TIMELINE.into(),
        }],
    );
    assert!(next.timelines.is_none());
}

// Tracks ----------------------------------------------------------------

#[test]
fn adds_a_track_at_a_place_and_takes_it_out_again() {
    let moka = timeline_fixture();
    let overlay = track("track-overlay", TrackKind::Video, "Video 2");
    let next = round_trip(
        &moka,
        vec![DocumentCommand::AddTrack {
            timeline_id: TIMELINE.into(),
            track: overlay.clone(),
            index: Some(0),
        }],
    );
    assert_eq!(next.timelines.as_ref().unwrap()[0].tracks[0].id, overlay.id);
}

#[test]
fn refuses_to_take_out_a_track_that_still_holds_clips() {
    let moka = timeline_fixture();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::RemoveTrack {
                timeline_id: TIMELINE.into(),
                track_id: VIDEO_TRACK.into(),
            }
        ),
        "TRACK_NOT_EMPTY"
    );
}

#[test]
fn mutes_a_track_without_touching_its_name_and_the_undo_restores_both() {
    let moka = timeline_fixture();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateTrack {
            timeline_id: TIMELINE.into(),
            track_id: AUDIO_TRACK.into(),
            patch: TrackPatch {
                muted: Some(true),
                ..Default::default()
            },
        }],
    );
    let audio = next.timelines.as_ref().unwrap()[0]
        .tracks
        .iter()
        .find(|track| track.id == AUDIO_TRACK)
        .unwrap();
    assert!(audio.muted);
    assert_eq!(audio.name, "Audio 1");
}

#[test]
fn locks_a_track_and_the_undo_unlocks_it() {
    let moka = timeline_fixture();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateTrack {
            timeline_id: TIMELINE.into(),
            track_id: VIDEO_TRACK.into(),
            patch: TrackPatch {
                locked: Some(true),
                ..Default::default()
            },
        }],
    );
    let video = next.timelines.as_ref().unwrap()[0]
        .tracks
        .iter()
        .find(|track| track.id == VIDEO_TRACK)
        .unwrap();
    assert!(video.locked);
}

#[test]
fn refuses_every_clip_edit_on_a_locked_track() {
    let moka = timeline_fixture();
    let (locked, _) = apply(
        &moka,
        vec![DocumentCommand::UpdateTrack {
            timeline_id: TIMELINE.into(),
            track_id: VIDEO_TRACK.into(),
            patch: TrackPatch {
                locked: Some(true),
                ..Default::default()
            },
        }],
    );
    let follower = clip_of(&locked, FOLLOWER_ASSET, VIDEO_TRACK, 4_000);
    assert_eq!(code_of(&locked, add_clips(vec![follower])), "TRACK_LOCKED");
    assert_eq!(
        code_of(
            &locked,
            DocumentCommand::UpdateClips {
                timeline_id: TIMELINE.into(),
                patches: vec![ClipPatchEntry {
                    clip_id: VIDEO_CLIP.into(),
                    patch: ClipPatch {
                        volume: Some(0.5),
                        ..Default::default()
                    },
                }],
            }
        ),
        "TRACK_LOCKED"
    );
    assert_eq!(
        code_of(
            &locked,
            DocumentCommand::MoveClips {
                timeline_id: TIMELINE.into(),
                moves: vec![ClipMove {
                    clip_id: VIDEO_CLIP.into(),
                    start_ms: 1_000,
                    track_id: None,
                }],
            }
        ),
        "TRACK_LOCKED"
    );
    assert_eq!(
        code_of(
            &locked,
            DocumentCommand::RemoveClips {
                timeline_id: TIMELINE.into(),
                clip_ids: vec![VIDEO_CLIP.into()],
            }
        ),
        "TRACK_LOCKED"
    );

    let (unlocked, _) = apply(
        &locked,
        vec![DocumentCommand::UpdateTrack {
            timeline_id: TIMELINE.into(),
            track_id: VIDEO_TRACK.into(),
            patch: TrackPatch {
                locked: Some(false),
                ..Default::default()
            },
        }],
    );
    assert!(
        !unlocked.timelines.as_ref().unwrap()[0]
            .tracks
            .iter()
            .find(|track| track.id == VIDEO_TRACK)
            .unwrap()
            .locked
    );
}

#[test]
fn refuses_a_seam_on_a_locked_track_and_a_move_onto_one() {
    let moka = timeline_fixture();
    let (paired, _) = pair_at(&moka, 4_000);
    let (locked, _) = apply(
        &paired,
        vec![DocumentCommand::UpdateTrack {
            timeline_id: TIMELINE.into(),
            track_id: VIDEO_TRACK.into(),
            patch: TrackPatch {
                locked: Some(true),
                ..Default::default()
            },
        }],
    );
    assert_eq!(
        code_of(
            &locked,
            DocumentCommand::AddTransitions {
                timeline_id: TIMELINE.into(),
                transitions: vec![transition(
                    "transition-locked",
                    VIDEO_CLIP,
                    TransitionKind::Crossfade,
                    500,
                )],
            }
        ),
        "TRACK_LOCKED"
    );

    let (with_row, _) = apply(
        &moka,
        vec![DocumentCommand::AddTrack {
            timeline_id: TIMELINE.into(),
            track: track("track-video-2", TrackKind::Video, "Video 2"),
            index: None,
        }],
    );
    let (with_locked_row, _) = apply(
        &with_row,
        vec![DocumentCommand::UpdateTrack {
            timeline_id: TIMELINE.into(),
            track_id: "track-video-2".into(),
            patch: TrackPatch {
                locked: Some(true),
                ..Default::default()
            },
        }],
    );
    assert_eq!(
        code_of(
            &with_locked_row,
            DocumentCommand::MoveClips {
                timeline_id: TIMELINE.into(),
                moves: vec![ClipMove {
                    clip_id: VIDEO_CLIP.into(),
                    start_ms: 8_000,
                    track_id: Some("track-video-2".into()),
                }],
            }
        ),
        "TRACK_LOCKED"
    );
}

#[test]
fn refuses_a_timeline_that_arrives_with_bad_geometry_settings_or_seams() {
    let moka = timeline_fixture();

    let mut overlapping = create_timeline("Overlapping");
    let track_id = overlapping.tracks[0].id.clone();
    let first = clip_of(&moka, VIDEO_ASSET, &track_id, 0);
    let mut second = first.clone();
    second.id = new_id();
    second.start_ms = 1_000;
    overlapping.clips = vec![first, second];
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddTimeline {
                timeline: overlapping,
                index: None,
            }
        ),
        "CLIP_OVERLAP"
    );

    let mut bad_frame = create_timeline("Bad frame");
    bad_frame.settings.fps = 29;
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddTimeline {
                timeline: bad_frame,
                index: None,
            }
        ),
        "VALIDATION_FAILED"
    );

    let mut too_many = create_timeline("Too many");
    too_many.tracks = (0..=MAX_TRACKS_PER_TIMELINE)
        .map(|index| track(&new_id(), TrackKind::Text, &format!("Text {index}")))
        .collect();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddTimeline {
                timeline: too_many,
                index: None,
            }
        ),
        "VALIDATION_FAILED"
    );

    let mut doubled = create_timeline("Doubled");
    let track_id = doubled.tracks[0].id.clone();
    let first = clip_of(&moka, VIDEO_ASSET, &track_id, 0);
    let second = clip_of(&moka, VIDEO_ASSET, &track_id, 4_000);
    let one = transition("transition-1", &first.id, TransitionKind::Crossfade, 500);
    let mut two = one.clone();
    two.id = "transition-2".into();
    doubled.clips = vec![first, second];
    doubled.transitions = vec![one, two];
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddTimeline {
                timeline: doubled,
                index: None,
            }
        ),
        "CONFLICT"
    );
}

// Clips -----------------------------------------------------------------

#[test]
fn lands_a_clip_on_its_track_and_the_undo_clears_the_timeline_to_what_it_was() {
    let moka = timeline_fixture();
    let video = clip_of(&moka, FOLLOWER_ASSET, VIDEO_TRACK, 8_000);
    let next = round_trip(&moka, vec![add_clips(vec![video])]);
    assert_eq!(next.timelines.as_ref().unwrap()[0].clips.len(), 2);
}

#[test]
fn refuses_a_clip_that_overlaps_one_already_holding_the_place() {
    let moka = timeline_fixture();
    let overlapping = clip_of(&moka, FOLLOWER_ASSET, VIDEO_TRACK, 2_000);
    assert_eq!(code_of(&moka, add_clips(vec![overlapping])), "CLIP_OVERLAP");
}

#[test]
fn lets_two_clips_touch_end_to_start() {
    let moka = timeline_fixture();
    let beside = clip_of(&moka, FOLLOWER_ASSET, VIDEO_TRACK, 4_000);
    let (next, _) = apply(&moka, vec![add_clips(vec![beside])]);
    assert_eq!(next.timelines.as_ref().unwrap()[0].clips.len(), 2);
}

#[test]
fn refuses_a_clip_whose_kind_does_not_match_the_tracks() {
    let moka = timeline_fixture();
    let misplaced = clip_of(&moka, VIDEO_ASSET, AUDIO_TRACK, 8_000);
    assert_eq!(
        code_of(&moka, add_clips(vec![misplaced])),
        "VALIDATION_FAILED"
    );
}

#[test]
fn refuses_a_clip_whose_duration_disagrees_with_its_window_over_its_speed() {
    let moka = timeline_fixture();
    let mut broken = clip_of(&moka, VIDEO_ASSET, VIDEO_TRACK, 8_000);
    broken.duration_ms = 3_000;
    assert_eq!(code_of(&moka, add_clips(vec![broken])), "VALIDATION_FAILED");
}

#[test]
fn refuses_a_window_past_the_end_of_its_file_but_leaves_an_old_one_editable() {
    let moka = timeline_fixture();
    let mut past = clip_of(&moka, VIDEO_ASSET, VIDEO_TRACK, 8_000);
    past.duration_ms = 5_000;
    past.out_point_ms = 5_000;
    assert_eq!(code_of(&moka, add_clips(vec![past])), "VALIDATION_FAILED");

    let mut legacy = timeline_fixture();
    let held = legacy.timelines.as_mut().unwrap()[0]
        .clips
        .iter_mut()
        .find(|clip| clip.id == VIDEO_CLIP)
        .unwrap();
    held.duration_ms = 5_000;
    held.out_point_ms = 5_000;
    apply(
        &legacy,
        vec![DocumentCommand::UpdateClips {
            timeline_id: TIMELINE.into(),
            patches: vec![ClipPatchEntry {
                clip_id: VIDEO_CLIP.into(),
                patch: ClipPatch {
                    volume: Some(0.5),
                    ..Default::default()
                },
            }],
        }],
    );
    assert_eq!(
        code_of(
            &legacy,
            DocumentCommand::UpdateClips {
                timeline_id: TIMELINE.into(),
                patches: vec![ClipPatchEntry {
                    clip_id: VIDEO_CLIP.into(),
                    patch: ClipPatch {
                        duration_ms: Some(4_500),
                        out_point_ms: Some(4_500),
                        ..Default::default()
                    },
                }],
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn refuses_a_material_clip_that_names_no_asset_and_a_text_clip_that_carries_none() {
    let moka = timeline_fixture();
    let mut assetless = clip_of(&moka, FOLLOWER_ASSET, VIDEO_TRACK, 10_000);
    assetless.asset_id = None;
    assert_eq!(
        code_of(&moka, add_clips(vec![assetless])),
        "VALIDATION_FAILED"
    );

    let mut wordless = text_clip("Hello", TEXT_TRACK, 0);
    wordless.text = None;
    assert_eq!(
        code_of(&moka, add_clips(vec![wordless])),
        "VALIDATION_FAILED"
    );
}

#[test]
fn reads_an_image_clip_for_its_own_duration_and_refuses_a_window_on_it() {
    let moka = cut();
    let still = clip_of(&moka, CUT_IMAGE_ASSET, CUT_VIDEO_TRACK, 9_500);
    assert_eq!(still.duration_ms, 4_000);
    let (next, _) = apply(
        &moka,
        vec![DocumentCommand::AddClips {
            timeline_id: CUT_TIMELINE.into(),
            clips: vec![still.clone()],
            seams: None,
        }],
    );
    assert_eq!(next.timelines.as_ref().unwrap()[0].clips.len(), 5);

    let mut trimmed = still;
    trimmed.in_point_ms = 100;
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddClips {
                timeline_id: CUT_TIMELINE.into(),
                clips: vec![trimmed],
                seams: None,
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn moves_a_clip_in_time_and_the_undo_puts_it_back() {
    let moka = timeline_fixture();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::MoveClips {
            timeline_id: TIMELINE.into(),
            moves: vec![ClipMove {
                clip_id: VIDEO_CLIP.into(),
                start_ms: 9_000,
                track_id: None,
            }],
        }],
    );
    assert_eq!(clip_at(&next, 0, VIDEO_CLIP).start_ms, 9_000);
}

#[test]
fn moves_a_clip_onto_another_track_of_its_kind_and_the_undo_returns_it() {
    let moka = timeline_fixture();
    let (with_row, _) = apply(
        &moka,
        vec![DocumentCommand::AddTrack {
            timeline_id: TIMELINE.into(),
            track: track("track-text-2", TrackKind::Text, "Text 2"),
            index: None,
        }],
    );
    let caption = text_clip("Caption", TEXT_TRACK, 0);
    let (with_clip, _) = apply(&with_row, vec![add_clips(vec![caption.clone()])]);
    let next = round_trip(
        &with_clip,
        vec![DocumentCommand::MoveClips {
            timeline_id: TIMELINE.into(),
            moves: vec![ClipMove {
                clip_id: caption.id.clone(),
                start_ms: 500,
                track_id: Some("track-text-2".into()),
            }],
        }],
    );
    let moved = clip_at(&next, 0, &caption.id);
    assert_eq!(moved.track_id, "track-text-2");
    assert_eq!(moved.start_ms, 500);
}

#[test]
fn refuses_a_move_onto_a_held_place() {
    let moka = timeline_fixture();
    // A second clip holds 8000–11000; moving the first onto it is refused.
    let (with_two, _) = pair_at(&moka, 8_000);
    assert_eq!(
        code_of(
            &with_two,
            DocumentCommand::MoveClips {
                timeline_id: TIMELINE.into(),
                moves: vec![ClipMove {
                    clip_id: VIDEO_CLIP.into(),
                    start_ms: 6_000,
                    track_id: None,
                }],
            }
        ),
        "CLIP_OVERLAP"
    );
}

#[test]
fn refuses_a_bare_overlap_the_width_of_a_seam() {
    let moka = timeline_fixture();
    let (with_second, second) = pair_at(&moka, 4_000);
    // With no transition on the seam, the same pull-back two clips would take
    // under one is a plain overlap and nothing exempts it.
    assert_eq!(
        code_of(
            &with_second,
            DocumentCommand::MoveClips {
                timeline_id: TIMELINE.into(),
                moves: vec![ClipMove {
                    clip_id: second.id,
                    start_ms: 3_500,
                    track_id: None,
                }],
            }
        ),
        "CLIP_OVERLAP"
    );
}

#[test]
fn patches_a_clips_volume_without_touching_its_speed_and_undoes_exactly_that() {
    let moka = timeline_fixture();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateClips {
            timeline_id: TIMELINE.into(),
            patches: vec![ClipPatchEntry {
                clip_id: VIDEO_CLIP.into(),
                patch: ClipPatch {
                    volume: Some(0.5),
                    ..Default::default()
                },
            }],
        }],
    );
    let clip = clip_at(&next, 0, VIDEO_CLIP);
    assert_eq!(clip.volume, 0.5);
    assert_eq!(clip.speed, 1.0);
}

#[test]
fn clears_an_adjust_and_the_undo_puts_it_back() {
    let moka = cut();
    let (cleared, inverse) = apply(
        &moka,
        vec![DocumentCommand::UpdateClips {
            timeline_id: CUT_TIMELINE.into(),
            patches: vec![ClipPatchEntry {
                clip_id: CUT_CLIP_A.into(),
                patch: ClipPatch {
                    adjust: Some(None),
                    ..Default::default()
                },
            }],
        }],
    );
    assert!(clip_at(&cleared, 0, CUT_CLIP_A).adjust.is_none());
    let (undone, _) = apply(&cleared, inverse);
    assert_eq!(undone, moka);
}

#[test]
fn brings_a_filter_in_and_the_undo_takes_it_back_out() {
    let moka = timeline_fixture();
    assert!(clip_at(&moka, 0, VIDEO_CLIP).filter.is_none());
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateClips {
            timeline_id: TIMELINE.into(),
            patches: vec![ClipPatchEntry {
                clip_id: VIDEO_CLIP.into(),
                patch: ClipPatch {
                    filter: Some(Some("cool".into())),
                    ..Default::default()
                },
            }],
        }],
    );
    assert_eq!(
        clip_at(&next, 0, VIDEO_CLIP).filter.as_deref(),
        Some("cool")
    );
}

#[test]
fn refuses_a_patch_that_stretches_a_clip_onto_its_neighbour() {
    let moka = timeline_fixture();
    let (with_two, _) = pair_at(&moka, 4_000);
    assert_eq!(
        code_of(
            &with_two,
            DocumentCommand::UpdateClips {
                timeline_id: TIMELINE.into(),
                patches: vec![ClipPatchEntry {
                    clip_id: VIDEO_CLIP.into(),
                    patch: ClipPatch {
                        duration_ms: Some(6_000),
                        out_point_ms: Some(6_000),
                        ..Default::default()
                    },
                }],
            }
        ),
        "CLIP_OVERLAP"
    );
}

#[test]
fn removes_a_clip_and_the_undo_clears_the_timeline_to_what_it_was() {
    let moka = timeline_fixture();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::RemoveClips {
            timeline_id: TIMELINE.into(),
            clip_ids: vec![VIDEO_CLIP.into()],
        }],
    );
    assert!(next.timelines.as_ref().unwrap()[0].clips.is_empty());
    assert!(next.timelines.as_ref().unwrap()[0].transitions.is_empty());
}

#[test]
fn lands_a_hundred_clips_in_one_step_past_the_old_fifty() {
    let moka = timeline_fixture();
    let timeline = create_timeline("Bulk");
    let timeline_id = timeline.id.clone();
    let track_id = timeline.tracks[0].id.clone();
    let (with_timeline, _) = apply(
        &moka,
        vec![DocumentCommand::AddTimeline {
            timeline,
            index: None,
        }],
    );
    let many: Vec<TimelineClip> = (0..100)
        .map(|index| clip_of(&with_timeline, VIDEO_ASSET, &track_id, index * 8_000))
        .collect();
    let (next, _) = apply(
        &with_timeline,
        vec![DocumentCommand::AddClips {
            timeline_id: timeline_id.clone(),
            clips: many,
            seams: None,
        }],
    );
    let held = next
        .timelines
        .as_ref()
        .unwrap()
        .iter()
        .find(|held| held.id == timeline_id)
        .unwrap();
    assert_eq!(held.clips.len(), 100);
}

#[test]
fn lands_no_more_clips_than_one_step_of_history_may_hold() {
    let moka = timeline_fixture();
    let many: Vec<TimelineClip> = (0..=MAX_CLIPS_PER_COMMAND)
        .map(|index| {
            clip_of(
                &moka,
                FOLLOWER_ASSET,
                VIDEO_TRACK,
                20_000 + index as i64 * 8_000,
            )
        })
        .collect();
    assert_eq!(code_of(&moka, add_clips(many)), "VALIDATION_FAILED");
}

#[test]
fn inserts_a_block_and_moves_what_follows_and_the_undo_puts_the_cut_back() {
    let moka = timeline_fixture();
    let (paired, follower) = pair_at(&moka, 4_000);
    let mut inserted = clip_of(&paired, FOLLOWER_ASSET, VIDEO_TRACK, 4_000);
    inserted.duration_ms = 2_000;
    inserted.out_point_ms = 2_000;
    let next = round_trip(
        &paired,
        vec![DocumentCommand::InsertClips {
            timeline_id: TIMELINE.into(),
            clips: vec![inserted.clone()],
            mode: InsertMode::Ripple,
            ripple_scope: None,
        }],
    );
    let clips = &next.timelines.as_ref().unwrap()[0].clips;
    assert_eq!(clips.len(), 3);
    assert_eq!(clip_at(&next, 0, &follower.id).start_ms, 6_000);
    assert_eq!(clip_at(&next, 0, &inserted.id).start_ms, 4_000);
}

#[test]
fn splits_a_clip_the_insertion_point_falls_inside() {
    let moka = timeline_fixture();
    let mut inserted = clip_of(&moka, FOLLOWER_ASSET, VIDEO_TRACK, 2_000);
    inserted.duration_ms = 2_000;
    inserted.out_point_ms = 2_000;
    let next = round_trip(
        &moka,
        vec![DocumentCommand::InsertClips {
            timeline_id: TIMELINE.into(),
            clips: vec![inserted.clone()],
            mode: InsertMode::Ripple,
            ripple_scope: None,
        }],
    );
    let clips = &next.timelines.as_ref().unwrap()[0].clips;
    assert_eq!(clips.len(), 3);
    assert_eq!(clip_at(&next, 0, VIDEO_CLIP).duration_ms, 2_000);
    assert_eq!(clip_at(&next, 0, &inserted.id).start_ms, 2_000);
    let tail = clips
        .iter()
        .find(|clip| clip.id != VIDEO_CLIP && clip.id != inserted.id)
        .unwrap();
    assert_eq!(tail.start_ms, 4_000);
    assert_eq!(tail.duration_ms, 2_000);
}

#[test]
fn overwrites_the_place_it_lands_on_trimming_or_splitting_around_it() {
    let moka = timeline_fixture();
    let mut inside = clip_of(&moka, FOLLOWER_ASSET, VIDEO_TRACK, 1_000);
    inside.duration_ms = 1_000;
    inside.out_point_ms = 1_000;
    let next = round_trip(
        &moka,
        vec![DocumentCommand::InsertClips {
            timeline_id: TIMELINE.into(),
            clips: vec![inside.clone()],
            mode: InsertMode::Overwrite,
            ripple_scope: None,
        }],
    );
    let clips = &next.timelines.as_ref().unwrap()[0].clips;
    assert_eq!(clips.len(), 3);
    assert_eq!(clip_at(&next, 0, VIDEO_CLIP).duration_ms, 1_000);
    assert_eq!(clip_at(&next, 0, &inside.id).start_ms, 1_000);

    let mut tail_only = clip_of(&moka, FOLLOWER_ASSET, VIDEO_TRACK, 3_000);
    tail_only.duration_ms = 2_000;
    tail_only.out_point_ms = 2_000;
    let trimmed = round_trip(
        &moka,
        vec![DocumentCommand::InsertClips {
            timeline_id: TIMELINE.into(),
            clips: vec![tail_only],
            mode: InsertMode::Overwrite,
            ripple_scope: None,
        }],
    );
    assert_eq!(clip_at(&trimmed, 0, VIDEO_CLIP).duration_ms, 3_000);
}

#[test]
fn moves_every_row_for_a_ripple_or_only_the_row_it_names() {
    let moka = timeline_fixture();
    let caption = text_clip("Caption", TEXT_TRACK, 5_000);
    let caption_id = caption.id.clone();
    let (with_caption, _) = apply(&moka, vec![add_clips(vec![caption])]);
    let mut inserted = clip_of(&with_caption, FOLLOWER_ASSET, VIDEO_TRACK, 2_000);
    inserted.duration_ms = 1_000;
    inserted.out_point_ms = 1_000;

    let (all, _) = apply(
        &with_caption,
        vec![DocumentCommand::InsertClips {
            timeline_id: TIMELINE.into(),
            clips: vec![inserted.clone()],
            mode: InsertMode::Ripple,
            ripple_scope: Some(RippleScope::All),
        }],
    );
    assert_eq!(clip_at(&all, 0, &caption_id).start_ms, 6_000);

    let (track, _) = apply(
        &with_caption,
        vec![DocumentCommand::InsertClips {
            timeline_id: TIMELINE.into(),
            clips: vec![inserted],
            mode: InsertMode::Ripple,
            ripple_scope: Some(RippleScope::Track),
        }],
    );
    assert_eq!(clip_at(&track, 0, &caption_id).start_ms, 5_000);
}

#[test]
fn refuses_a_landing_on_a_locked_row() {
    let moka = timeline_fixture();
    let (locked, _) = apply(
        &moka,
        vec![DocumentCommand::UpdateTrack {
            timeline_id: TIMELINE.into(),
            track_id: VIDEO_TRACK.into(),
            patch: TrackPatch {
                locked: Some(true),
                ..Default::default()
            },
        }],
    );
    let mut inserted = clip_of(&locked, FOLLOWER_ASSET, VIDEO_TRACK, 2_000);
    inserted.duration_ms = 1_000;
    inserted.out_point_ms = 1_000;
    assert_eq!(
        code_of(
            &locked,
            DocumentCommand::InsertClips {
                timeline_id: TIMELINE.into(),
                clips: vec![inserted],
                mode: InsertMode::Ripple,
                ripple_scope: None,
            }
        ),
        "TRACK_LOCKED"
    );
}

#[test]
fn deletes_a_clip_and_pulls_what_followed_it_back() {
    let moka = timeline_fixture();
    let (paired, follower) = pair_at(&moka, 4_000);
    let (next, inverse) = apply(
        &paired,
        vec![DocumentCommand::RippleDeleteClips {
            timeline_id: TIMELINE.into(),
            clip_ids: vec![VIDEO_CLIP.into()],
            scope: Some(RippleScope::All),
        }],
    );
    assert_eq!(next.timelines.as_ref().unwrap()[0].clips.len(), 1);
    assert_eq!(clip_at(&next, 0, &follower.id).start_ms, 0);
    let (undone, _) = apply(&next, inverse);
    let mut before = paired.timelines.as_ref().unwrap()[0].clips.clone();
    let mut after = undone.timelines.as_ref().unwrap()[0].clips.clone();
    before.sort_by(|a, b| a.id.cmp(&b.id));
    after.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(after, before);
}

#[test]
fn pulls_every_row_for_a_ripple_delete_or_only_the_row_it_names() {
    let moka = timeline_fixture();
    let caption = text_clip("Caption", TEXT_TRACK, 5_000);
    let caption_id = caption.id.clone();
    let (with_caption, _) = apply(&moka, vec![add_clips(vec![caption])]);
    let (all, _) = apply(
        &with_caption,
        vec![DocumentCommand::RippleDeleteClips {
            timeline_id: TIMELINE.into(),
            clip_ids: vec![VIDEO_CLIP.into()],
            scope: Some(RippleScope::All),
        }],
    );
    assert_eq!(clip_at(&all, 0, &caption_id).start_ms, 1_000);
    let (track, _) = apply(
        &with_caption,
        vec![DocumentCommand::RippleDeleteClips {
            timeline_id: TIMELINE.into(),
            clip_ids: vec![VIDEO_CLIP.into()],
            scope: Some(RippleScope::Track),
        }],
    );
    assert_eq!(clip_at(&track, 0, &caption_id).start_ms, 5_000);
}

#[test]
fn closes_a_gap_and_takes_a_gap_out() {
    let moka = timeline_fixture();
    let later = clip_of(&moka, FOLLOWER_ASSET, VIDEO_TRACK, 6_000);
    let later_id = later.id.clone();
    let (with_later, _) = apply(&moka, vec![add_clips(vec![later])]);
    let closed = round_trip(
        &with_later,
        vec![DocumentCommand::CloseGaps {
            timeline_id: TIMELINE.into(),
            track_id: Some(VIDEO_TRACK.into()),
        }],
    );
    assert_eq!(clip_at(&closed, 0, &later_id).start_ms, 4_000);
    let without_gap = round_trip(
        &with_later,
        vec![DocumentCommand::DeleteGap {
            timeline_id: TIMELINE.into(),
            track_id: VIDEO_TRACK.into(),
            at_ms: 5_000,
            scope: None,
        }],
    );
    assert_eq!(clip_at(&without_gap, 0, &later_id).start_ms, 4_000);
    assert_eq!(
        code_of(
            &with_later,
            DocumentCommand::DeleteGap {
                timeline_id: TIMELINE.into(),
                track_id: VIDEO_TRACK.into(),
                at_ms: 1_000,
                scope: None,
            }
        ),
        "GAP_NOT_FOUND"
    );
}

fn three_butted() -> MokaFile {
    let base = timeline_fixture();
    let mut moka = base.clone();
    let make = |id: &str, asset: &str, start: i64| {
        let mut clip = clip_of(&base, asset, VIDEO_TRACK, start);
        clip.id = id.into();
        clip.start_ms = start;
        clip.duration_ms = 2_000;
        clip.in_point_ms = 1_000;
        clip.out_point_ms = 3_000;
        clip
    };
    moka.timelines.as_mut().unwrap()[0].clips = vec![
        make("clip-a", VIDEO_ASSET, 0),
        make("clip-b", FOLLOWER_ASSET, 2_000),
        make("clip-c", VIDEO_ASSET, 4_000),
    ];
    moka
}

#[test]
fn slips_a_clips_source_window_without_moving_it() {
    let moka = three_butted();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::SlipClips {
            timeline_id: TIMELINE.into(),
            edits: vec![ClipSlip {
                clip_id: "clip-a".into(),
                by_ms: 500,
            }],
        }],
    );
    let clip = clip_at(&next, 0, "clip-a");
    assert_eq!(
        [
            clip.start_ms,
            clip.duration_ms,
            clip.in_point_ms,
            clip.out_point_ms
        ],
        [0, 2_000, 1_500, 3_500]
    );
}

#[test]
fn slides_a_clip_and_carries_its_neighbours_edges() {
    let moka = three_butted();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::SlideClips {
            timeline_id: TIMELINE.into(),
            moves: vec![ClipSlide {
                clip_id: "clip-b".into(),
                by_ms: 200,
            }],
        }],
    );
    let a = clip_at(&next, 0, "clip-a");
    let b = clip_at(&next, 0, "clip-b");
    let c = clip_at(&next, 0, "clip-c");
    assert_eq!([a.duration_ms, a.out_point_ms], [2_200, 3_200]);
    assert_eq!(b.start_ms, 2_200);
    assert_eq!(
        [c.start_ms, c.duration_ms, c.in_point_ms],
        [4_200, 1_800, 1_200]
    );
}

#[test]
fn rolls_one_cut_and_keeps_the_total_length() {
    let moka = three_butted();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::RollEdit {
            timeline_id: TIMELINE.into(),
            after_clip_id: "clip-a".into(),
            by_ms: 200,
        }],
    );
    let a = clip_at(&next, 0, "clip-a");
    let b = clip_at(&next, 0, "clip-b");
    assert_eq!(a.duration_ms, 2_200);
    assert_eq!(
        [b.start_ms, b.duration_ms, b.in_point_ms],
        [2_200, 1_800, 1_200]
    );
    assert_eq!(clip_at(&next, 0, "clip-c").start_ms, 4_000);
}

#[test]
fn takes_a_range_out_across_every_row() {
    let moka = three_butted();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::RemoveRange {
            timeline_id: TIMELINE.into(),
            start_ms: 1_000,
            end_ms: 3_000,
            scope: Some(RippleScope::All),
            track_id: None,
        }],
    );
    let mut clips = next.timelines.as_ref().unwrap()[0].clips.clone();
    clips.sort_by_key(|clip| clip.start_ms);
    assert_eq!(
        clips
            .iter()
            .map(|clip| [clip.start_ms, clip.duration_ms])
            .collect::<Vec<_>>(),
        vec![[0, 1_000], [1_000, 1_000], [2_000, 2_000]]
    );
}

#[test]
fn adds_edits_and_removes_markers_and_keeps_the_range() {
    let mut moka = timeline_fixture();
    moka.timelines.as_mut().unwrap()[0].schema_version = 2;
    let with_markers = round_trip(
        &moka,
        vec![DocumentCommand::AddMarkers {
            timeline_id: TIMELINE.into(),
            markers: vec![
                TimelineMarker {
                    id: "marker-1".into(),
                    at_ms: 1_000,
                    label: "Verse".into(),
                    color: "yellow".into(),
                },
                TimelineMarker {
                    id: "marker-2".into(),
                    at_ms: 3_000,
                    label: "Drop".into(),
                    color: "red".into(),
                },
            ],
        }],
    );
    assert_eq!(
        with_markers.timelines.as_ref().unwrap()[0]
            .markers
            .as_ref()
            .unwrap()
            .len(),
        2
    );
    let updated = round_trip(
        &with_markers,
        vec![DocumentCommand::UpdateMarkers {
            timeline_id: TIMELINE.into(),
            patches: vec![moka_canvas::domain::MarkerPatch {
                marker_id: "marker-1".into(),
                at_ms: Some(1_500),
                label: Some("Chorus".into()),
                color: Some("blue".into()),
            }],
        }],
    );
    let marker = updated.timelines.as_ref().unwrap()[0]
        .markers
        .as_ref()
        .unwrap()
        .iter()
        .find(|marker| marker.id == "marker-1")
        .unwrap();
    assert_eq!(marker.at_ms, 1_500);
    assert_eq!(marker.label, "Chorus");
    assert_eq!(marker.color, "blue");
    let removed = round_trip(
        &updated,
        vec![DocumentCommand::RemoveMarkers {
            timeline_id: TIMELINE.into(),
            marker_ids: Some(vec!["marker-2".into()]),
            all: None,
        }],
    );
    assert_eq!(
        removed.timelines.as_ref().unwrap()[0]
            .markers
            .as_ref()
            .unwrap()
            .len(),
        1
    );

    let ranged = round_trip(
        &moka,
        vec![DocumentCommand::SetTimelineRange {
            timeline_id: TIMELINE.into(),
            in_ms: Some(1_000),
            out_ms: Some(3_000),
        }],
    );
    let timeline = &ranged.timelines.as_ref().unwrap()[0];
    assert_eq!(
        [timeline.in_point_ms, timeline.out_point_ms],
        [Some(1_000), Some(3_000)]
    );
    let cleared = round_trip(
        &ranged,
        vec![DocumentCommand::SetTimelineRange {
            timeline_id: TIMELINE.into(),
            in_ms: None,
            out_ms: None,
        }],
    );
    let timeline = &cleared.timelines.as_ref().unwrap()[0];
    assert_eq!([timeline.in_point_ms, timeline.out_point_ms], [None, None]);
}

#[test]
fn moves_an_older_timeline_to_the_current_schema_when_it_gains_a_marker() {
    let moka = timeline_fixture();
    assert_eq!(moka.timelines.as_ref().unwrap()[0].schema_version, 1);
    let (next, _) = apply(
        &moka,
        vec![DocumentCommand::AddMarkers {
            timeline_id: TIMELINE.into(),
            markers: vec![TimelineMarker {
                id: "marker-1".into(),
                at_ms: 0,
                label: "Head".into(),
                color: "white".into(),
            }],
        }],
    );
    assert_eq!(next.timelines.as_ref().unwrap()[0].schema_version, 2);
}

// Transitions -----------------------------------------------------------

#[test]
fn lands_a_transition_on_a_butted_seam_pulling_the_follower_back_itself_and_the_undo_puts_it_back()
{
    let moka = timeline_fixture();
    let (with_second, second) = pair_at(&moka, 4_000);
    let next = round_trip(
        &with_second,
        vec![DocumentCommand::AddTransitions {
            timeline_id: TIMELINE.into(),
            transitions: vec![transition(
                "transition-new",
                VIDEO_CLIP,
                TransitionKind::Crossfade,
                500,
            )],
        }],
    );
    assert_eq!(clip_at(&next, 0, &second.id).start_ms, 3_500);
    assert_eq!(next.timelines.as_ref().unwrap()[0].transitions.len(), 1);
}

#[test]
fn refuses_a_transition_when_the_clips_are_not_butted() {
    let moka = timeline_fixture();
    let (with_gap, _) = pair_at(&moka, 4_500);
    assert_eq!(
        code_of(
            &with_gap,
            DocumentCommand::AddTransitions {
                timeline_id: TIMELINE.into(),
                transitions: vec![transition(
                    "transition-new",
                    VIDEO_CLIP,
                    TransitionKind::Crossfade,
                    500,
                )],
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn refuses_a_second_transition_on_the_same_seam() {
    let moka = timeline_fixture();
    let (with_second, _) = pair_at(&moka, 4_000);
    let (with_one, _) = apply(
        &with_second,
        vec![DocumentCommand::AddTransitions {
            timeline_id: TIMELINE.into(),
            transitions: vec![transition(
                "transition-first",
                VIDEO_CLIP,
                TransitionKind::Crossfade,
                500,
            )],
        }],
    );
    assert_eq!(
        code_of(
            &with_one,
            DocumentCommand::AddTransitions {
                timeline_id: TIMELINE.into(),
                transitions: vec![transition(
                    "transition-second",
                    VIDEO_CLIP,
                    TransitionKind::Wipe,
                    400,
                )],
            }
        ),
        "CONFLICT"
    );
}

#[test]
fn refuses_a_transition_on_the_last_clip_of_a_track() {
    let moka = timeline_fixture();
    let tail = text_clip("Tail", TEXT_TRACK, 10_000);
    let (with_text, _) = apply(&moka, vec![add_clips(vec![tail.clone()])]);
    assert_eq!(
        code_of(
            &with_text,
            DocumentCommand::AddTransitions {
                timeline_id: TIMELINE.into(),
                transitions: vec![transition(
                    "transition-tail",
                    &tail.id,
                    TransitionKind::Crossfade,
                    400,
                )],
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn refuses_a_third_clip_pressed_into_a_seam_window() {
    let moka = cut();
    // The seam after A pulled B back into the window; a third clip landing
    // inside that window is part of no promise the document made, so the pair
    // it makes with B is an ordinary overlap and nothing exempts it.
    let intruder = clip_of(&moka, CUT_VIDEO_ASSET_A, CUT_VIDEO_TRACK, 3_800);
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddClips {
                timeline_id: CUT_TIMELINE.into(),
                clips: vec![intruder],
                seams: None,
            }
        ),
        "CLIP_OVERLAP"
    );
}

#[test]
fn refuses_a_move_that_would_break_a_seam() {
    let moka = cut();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::MoveClips {
                timeline_id: CUT_TIMELINE.into(),
                moves: vec![ClipMove {
                    clip_id: CUT_CLIP_A.into(),
                    start_ms: 1_000,
                    track_id: None,
                }],
            }
        ),
        "TRANSITION_SEAM"
    );
    // Both ends move together and the seam travels with them.
    let (shifted, _) = apply(
        &moka,
        vec![DocumentCommand::MoveClips {
            timeline_id: CUT_TIMELINE.into(),
            moves: vec![
                ClipMove {
                    clip_id: CUT_CLIP_A.into(),
                    start_ms: 1_000,
                    track_id: None,
                },
                ClipMove {
                    clip_id: CUT_CLIP_B.into(),
                    start_ms: 1_000 + 4_000 - 500,
                    track_id: None,
                },
            ],
        }],
    );
    assert_eq!(shifted.timelines.as_ref().unwrap()[0].transitions.len(), 1);
    assert_eq!(clip_at(&shifted, 0, CUT_CLIP_B).start_ms, 4_500);
}

#[test]
fn refuses_a_trim_that_would_break_a_seam() {
    let moka = cut();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::UpdateClips {
                timeline_id: CUT_TIMELINE.into(),
                patches: vec![ClipPatchEntry {
                    clip_id: CUT_CLIP_A.into(),
                    patch: ClipPatch {
                        duration_ms: Some(5_000),
                        out_point_ms: Some(5_000),
                        ..Default::default()
                    },
                }],
            }
        ),
        "TRANSITION_SEAM"
    );
}

#[test]
fn removes_a_transition_and_gives_the_follower_its_place_back() {
    let moka = cut();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::RemoveTransitions {
            timeline_id: CUT_TIMELINE.into(),
            transition_ids: vec![CUT_TRANSITION.into()],
        }],
    );
    assert!(next.timelines.as_ref().unwrap()[0].transitions.is_empty());
    assert_eq!(clip_at(&next, 0, CUT_CLIP_B).start_ms, 4_000);
}

#[test]
fn releases_the_seam_and_moves_a_clip_in_the_way_along() {
    let moka = cut();
    let tail = clip_of(&moka, CUT_VIDEO_ASSET_A, CUT_VIDEO_TRACK, 5_500);
    let (with_tail, _) = apply(
        &moka,
        vec![DocumentCommand::AddClips {
            timeline_id: CUT_TIMELINE.into(),
            clips: vec![tail],
            seams: None,
        }],
    );
    let (next, _) = apply(
        &with_tail,
        vec![DocumentCommand::RemoveTransitions {
            timeline_id: CUT_TIMELINE.into(),
            transition_ids: vec![CUT_TRANSITION.into()],
        }],
    );
    assert_eq!(clip_at(&next, 0, CUT_CLIP_B).start_ms, 4_000);
    assert!(next.timelines.as_ref().unwrap()[0]
        .clips
        .iter()
        .any(|clip| clip.start_ms == 6_000));
}

#[test]
fn tears_one_seam_out_and_keeps_the_chain_behind_it_whole() {
    let (chained, clip_c) = seam_chain();
    let (next, _) = apply(
        &chained,
        vec![DocumentCommand::RemoveTransitions {
            timeline_id: CUT_TIMELINE.into(),
            transition_ids: vec![CUT_TRANSITION.into()],
        }],
    );
    assert_eq!(next.timelines.as_ref().unwrap()[0].transitions.len(), 1);
    assert_eq!(clip_at(&next, 0, CUT_CLIP_B).start_ms, 4_000);
    assert_eq!(clip_at(&next, 0, &clip_c).start_ms, 5_600);
}

#[test]
fn takes_a_clip_and_its_seam_out_together_and_the_undo_restores_both_in_one_step() {
    let moka = cut();
    let (next, inverse) = apply(
        &moka,
        vec![DocumentCommand::RemoveClips {
            timeline_id: CUT_TIMELINE.into(),
            clip_ids: vec![CUT_CLIP_B.into()],
        }],
    );
    assert!(next.timelines.as_ref().unwrap()[0].transitions.is_empty());
    assert_eq!(
        clip_ids(&next, 0),
        vec![
            CUT_CLIP_A.to_string(),
            CUT_CLIP_C.to_string(),
            "clip-cut-d".to_string()
        ]
    );

    // The undo appends the clip it brings back, so the arrays are compared as
    // sets of clips rather than as lists: what has to hold is that every clip
    // is itself again and the seam is whole.
    let (undone, _) = apply(&next, inverse);
    assert_eq!(
        clip_ids(&undone, 0),
        vec![
            CUT_CLIP_A.to_string(),
            CUT_CLIP_B.to_string(),
            CUT_CLIP_C.to_string(),
            "clip-cut-d".to_string()
        ]
    );
    assert_eq!(
        undone.timelines.as_ref().unwrap()[0].transitions,
        moka.timelines.as_ref().unwrap()[0].transitions
    );
    for clip in &moka.timelines.as_ref().unwrap()[0].clips {
        assert_eq!(clip_at(&undone, 0, &clip.id), clip);
    }
}

#[test]
fn takes_a_whole_seam_chain_down_in_one_command_and_puts_it_back() {
    let (moka, clip_c) = seam_chain();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::RemoveTransitions {
            timeline_id: CUT_TIMELINE.into(),
            transition_ids: vec![CUT_TRANSITION.into(), CUT_TRANSITION_2.into()],
        }],
    );
    assert!(next.timelines.as_ref().unwrap()[0].transitions.is_empty());
    assert_eq!(clip_at(&next, 0, CUT_CLIP_B).start_ms, 4_000);
    assert_eq!(clip_at(&next, 0, &clip_c).start_ms, 6_000);

    // Taking the same chain apart right to left leaves the same cut: every
    // release moves the suffix along with it.
    let (reversed, _) = apply(
        &moka,
        vec![DocumentCommand::RemoveTransitions {
            timeline_id: CUT_TIMELINE.into(),
            transition_ids: vec![CUT_TRANSITION_2.into(), CUT_TRANSITION.into()],
        }],
    );
    assert_eq!(clip_at(&reversed, 0, CUT_CLIP_B).start_ms, 4_000);
    assert_eq!(clip_at(&reversed, 0, &clip_c).start_ms, 6_000);
}

#[test]
fn recomposes_a_seam_chain_through_the_public_commands_and_one_undo_puts_the_old_chain_back() {
    let (moka, clip_c) = seam_chain();
    let next = round_trip(
        &moka,
        vec![
            DocumentCommand::RemoveTransitions {
                timeline_id: CUT_TIMELINE.into(),
                transition_ids: vec![CUT_TRANSITION.into(), CUT_TRANSITION_2.into()],
            },
            DocumentCommand::AddTransitions {
                timeline_id: CUT_TIMELINE.into(),
                transitions: vec![
                    transition(CUT_TRANSITION, CUT_CLIP_A, TransitionKind::DipToBlack, 400),
                    transition(
                        CUT_TRANSITION_2,
                        CUT_CLIP_B,
                        TransitionKind::DipToBlack,
                        400,
                    ),
                ],
            },
        ],
    );
    // The new window moved the first follower, and the second followed it.
    assert_eq!(clip_at(&next, 0, CUT_CLIP_B).start_ms, 3_600);
    assert_eq!(clip_at(&next, 0, &clip_c).start_ms, 5_200);
    assert!(next.timelines.as_ref().unwrap()[0]
        .transitions
        .iter()
        .all(|transition| transition.kind == TransitionKind::DipToBlack));
}

#[test]
fn refuses_a_negative_stroke_width_and_keeps_a_stroked_style_through_the_codec() {
    let moka = timeline_fixture();
    let mut caption = text_clip("Readable", TEXT_TRACK, 0);
    caption.text.as_mut().unwrap().style.stroke_width = -1;
    assert_eq!(
        code_of(&moka, add_clips(vec![caption])),
        "VALIDATION_FAILED"
    );

    let mut miscoloured = text_clip("Readable", TEXT_TRACK, 0);
    miscoloured.text.as_mut().unwrap().style.stroke_color = "#10101".into();
    assert_eq!(
        code_of(&moka, add_clips(vec![miscoloured])),
        "VALIDATION_FAILED"
    );

    let mut stroked = text_clip("Readable", TEXT_TRACK, 0);
    stroked.text.as_mut().unwrap().style.stroke_width = 4;
    stroked.text.as_mut().unwrap().style.stroke_color = "#101010".into();
    let (landed, _) = apply(&moka, vec![add_clips(vec![stroked.clone()])]);
    let decoded = decode_moka_file(&encode_moka_file(&landed, None).unwrap()).unwrap();
    let style = decoded.timelines.as_ref().unwrap()[0]
        .clips
        .iter()
        .find(|clip| clip.id == stroked.id)
        .unwrap()
        .text
        .as_ref()
        .unwrap()
        .style
        .clone();
    assert_eq!(
        (style.stroke_width, style.stroke_color.as_str()),
        (4, "#101010")
    );
}

#[test]
fn round_trips_a_document_without_timelines_as_carrying_none() {
    let moka = golden_document();
    let bytes = encode_moka_file(&moka, None).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    assert!(decoded.timelines.is_none());
    assert_eq!(encode_moka_file(&decoded, None).unwrap(), bytes);
}

// Validation ------------------------------------------------------------

#[test]
fn passes_the_cut_fixture_and_names_what_is_wrong_with_a_broken_one() {
    let moka = cut();
    assert_eq!(validate_moka_file(&moka), vec![]);

    let mut broken = cut();
    broken.timelines.as_mut().unwrap()[0]
        .clips
        .iter_mut()
        .find(|clip| clip.id == CUT_CLIP_B)
        .unwrap()
        .start_ms = 2_000;
    let issues = validate_moka_file(&broken);
    assert!(issues.iter().any(|issue| issue.code == "TRANSITION_SEAM"));
    assert!(issues
        .iter()
        .all(|issue| issue.timeline_id.as_deref() == Some(CUT_TIMELINE)));
}

#[test]
fn apply_commands_unshifts_each_inverse_so_one_undo_replays_them_in_reverse() {
    let moka = timeline_fixture();
    let caption = text_clip("Caption", "track-text-2", 0);
    let (next, inverse) = apply(
        &moka,
        vec![
            DocumentCommand::AddTrack {
                timeline_id: TIMELINE.into(),
                track: track("track-text-2", TrackKind::Text, "Text 2"),
                index: None,
            },
            add_clips(vec![caption]),
        ],
    );
    assert_eq!(
        next.timelines.as_ref().unwrap()[0].tracks.len(),
        4,
        "both commands landed"
    );
    // One undo replays the last step's inverse first: the clip comes off
    // before the row holding it, or the row would still be occupied.
    let (undone, _) = apply(&next, inverse);
    assert_eq!(undone, moka);
}

#[test]
fn asset_references_include_timeline_clips() {
    let moka = cut();
    let refs = moka.asset_references();
    assert!(refs[CUT_VIDEO_ASSET_A].contains(&CUT_CLIP_A.to_string()));
    assert!(refs[CUT_VIDEO_ASSET_B].contains(&CUT_CLIP_B.to_string()));
    assert!(refs[CUT_AUDIO_ASSET].contains(&CUT_CLIP_C.to_string()));
    // The canvas half is read exactly as it was.
    assert!(refs["00000000-0000-7000-8000-00000000001e"]
        .contains(&"00000000-0000-7000-8000-00000000000b".to_string()));
}

// Factories -------------------------------------------------------------

#[test]
fn the_three_rows_a_timeline_starts_with_are_told_apart() {
    let timeline = create_timeline("Fresh");
    let kinds: Vec<TrackKind> = timeline.tracks.iter().map(|track| track.kind).collect();
    assert_eq!(
        kinds,
        vec![TrackKind::Video, TrackKind::Audio, TrackKind::Text]
    );
    let names: std::collections::HashSet<&str> = timeline
        .tracks
        .iter()
        .map(|track| track.name.as_str())
        .collect();
    assert_eq!(names.len(), 3);
    assert!(timeline.tracks.iter().all(|track| !track.locked));
}

#[test]
fn a_clip_reads_the_material_its_asset_measures() {
    let moka = timeline_fixture();
    let video = clip_of(&moka, VIDEO_ASSET, VIDEO_TRACK, 0);
    assert_eq!(video.duration_ms, 4_000);
    assert_eq!(video.kind, TrackKind::Video);
    assert_eq!(video.out_point_ms, 4_000);

    let still = clip_of(&cut(), CUT_IMAGE_ASSET, CUT_VIDEO_TRACK, 0);
    assert_eq!(still.duration_ms, 4_000);
    assert_eq!(still.kind, TrackKind::Video);
}

// The wire ---------------------------------------------------------------

#[test]
fn a_null_adjust_in_a_wire_patch_clears_the_grade_and_an_absent_one_leaves_it() {
    // JSON cannot spell "this key goes away" any other way, so a null and a
    // missing key must read differently even though both are Option-shaped.
    let clearing: DocumentCommand = serde_json::from_str(
        r#"{"type":"updateClips","timelineId":"timeline-cut","patches":[{"clipId":"clip-cut-a","patch":{"adjust":null}}]}"#,
    )
    .unwrap();
    match &clearing {
        DocumentCommand::UpdateClips { patches, .. } => {
            assert_eq!(patches[0].patch.adjust, Some(None));
        }
        other => panic!("unexpected command {other:?}"),
    }
    let moka = cut();
    let (cleared, inverse) = apply(&moka, vec![clearing]);
    assert!(clip_at(&cleared, 0, CUT_CLIP_A).adjust.is_none());
    let (undone, _) = apply(&cleared, inverse);
    assert_eq!(undone, moka);

    let leaving: DocumentCommand = serde_json::from_str(
        r#"{"type":"updateClips","timelineId":"timeline-cut","patches":[{"clipId":"clip-cut-a","patch":{"volume":0.4}}]}"#,
    )
    .unwrap();
    match &leaving {
        DocumentCommand::UpdateClips { patches, .. } => {
            assert_eq!(patches[0].patch.adjust, None);
        }
        other => panic!("unexpected command {other:?}"),
    }
    let (leaving_applied, _) = apply(&moka, vec![leaving]);
    assert!(clip_at(&leaving_applied, 0, CUT_CLIP_A).adjust.is_some());
    assert_eq!(clip_at(&leaving_applied, 0, CUT_CLIP_A).volume, 0.4);
}

#[test]
fn an_inverse_omits_the_seams_key_when_it_brought_no_transition_back() {
    let moka = timeline_fixture();
    let (_, inverse) = apply(
        &moka,
        vec![DocumentCommand::RemoveClips {
            timeline_id: TIMELINE.into(),
            clip_ids: vec![VIDEO_CLIP.into()],
        }],
    );
    assert_eq!(inverse.len(), 1);
    let wire = serde_json::to_value(&inverse[0]).unwrap();
    assert_eq!(wire["type"], "addClips");
    assert!(
        wire.get("seams").is_none(),
        "an empty seam list is left off the wire, as the TypeScript twin writes it"
    );
    assert_eq!(wire["clips"][0]["id"], VIDEO_CLIP);
}

#[test]
fn an_add_clips_command_reads_without_its_seams_key() {
    let command: DocumentCommand =
        serde_json::from_str(r#"{"type":"addClips","timelineId":"timeline-cut","clips":[]}"#)
            .unwrap();
    match command {
        DocumentCommand::AddClips { seams, clips, .. } => {
            assert!(seams.is_none());
            assert!(clips.is_empty());
        }
        other => panic!("unexpected command {other:?}"),
    }
}

// Store pipeline --------------------------------------------------------

fn test_png() -> Vec<u8> {
    let mut png = image::RgbaImage::new(64, 64);
    for pixel in png.pixels_mut() {
        *pixel = image::Rgba([200, 120, 60, 255]);
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(png)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

#[tokio::test]
async fn removing_an_asset_still_referenced_by_a_clip_is_refused() {
    let tmp = TempDir::new().unwrap();
    let config = Arc::new(parse_test_config(tmp.path()));
    let registry = ProjectRegistry::new(config);
    let root = tmp.path().join("demo-project");
    let (store, _opened) = registry
        .create_project(
            &root,
            CreateProject {
                name: "Demo".into(),
                first_canvas_name: None,
            },
        )
        .await
        .unwrap();

    let staging = root.join("tmp").join("upload-clip.bin");
    std::fs::write(&staging, test_png()).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "plate.png".into(),
            tmp_path: staging,
            declared_mime: Some("image/png".into()),
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;

    let current = store.current().await.unwrap().unwrap();
    let mut timeline = create_timeline("Timeline 1");
    timeline.tracks = vec![track("track-image", TrackKind::Video, "Video 1")];
    let still = clip_of(&current.moka, &entry.id, "track-image", 0);
    timeline.clips = vec![still];
    store
        .apply_commands(
            current.moka.metadata.revision,
            vec![DocumentCommand::AddTimeline {
                timeline,
                index: None,
            }],
        )
        .await
        .unwrap();

    // The clip reads the asset, so taking the asset away is refused whether
    // the reader is a card or a clip.
    let result = store.remove_asset(&entry.id).await;
    assert_eq!(result.unwrap_err().code(), "ASSET_IN_USE");
}
