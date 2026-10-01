//! The export pipeline's own evidence.
//!
//! Two halves. The first reads the real fixtures — `fixtures/tiny.mp4` and
//! `fixtures/beep.wav` — into a plan, which is how the document, the files,
//! and the graph are held together on any machine. The second renders a whole
//! timeline through the API and probes what came out: it needs an ffmpeg, so
//! on a machine without one it says so and stays green rather than failing
//! every machine that has not installed a renderer.

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use moka_canvas::api::ApiState;
use moka_canvas::clip::locate::{locate, probe};
use moka_canvas::clip::plan::build_plan;
use moka_canvas::clip::sources_for;
use moka_canvas::config::{parse_test_config, AppConfig, RuntimeMode};
use moka_canvas::domain::{
    AssetProbe, MokaFile, ProjectMetadata, ResourceEntry, ResourceRegistry, TextAlign,
    TextClipData, TextClipStyle, TextPosition, TimelineClip, TimelineDocument, TimelineSettings,
    TimelineTrack, TimelineTransition, TrackKind, TransitionKind, MOKA_FILE_VERSION,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tower::ServiceExt;

const NOW: &str = "2026-01-01T00:00:00.000Z";

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name)
}

/// The ffmpeg this machine has, by the same three-level search the server
/// makes: the environment first, then the search path. `None` is a machine
/// that cannot render, which is what the whole-timeline half skips on.
fn machine_ffmpeg() -> Option<PathBuf> {
    let program = locate(
        None,
        std::env::var_os("MOKA_FFMPEG")
            .map(PathBuf::from)
            .as_deref(),
        std::env::var_os("PATH").as_deref(),
    )?;
    let capabilities = probe(&program);
    capabilities.available.then_some(program)
}

/// The two solid pictures a render is made of, written as real PNG files.
fn write_png(path: &Path, colour: [u8; 3]) {
    let picture = image::RgbImage::from_pixel(320, 180, image::Rgb(colour));
    picture.save(path).expect("the fixture picture is written");
}

/// A track of the kind named, visible and audible.
fn track(id: &str, kind: TrackKind) -> TimelineTrack {
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

/// A block reading a named asset for the whole of its own length.
fn material(
    id: &str,
    track_id: &str,
    kind: TrackKind,
    asset_id: &str,
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
        asset_id: Some(asset_id.to_string()),
        adjust: None,
        filter: None,
        text: None,
    }
}

/// The caption style: white words on a black outline at the foot of the frame.
fn caption_style() -> TextClipStyle {
    TextClipStyle {
        font_family: "Inter, ui-sans-serif, system-ui, sans-serif".to_string(),
        font_size: 48,
        color: "#ffffff".to_string(),
        bold: false,
        italic: false,
        align: TextAlign::Center,
        position: TextPosition::Bottom,
        background: None,
        stroke_width: 4,
        stroke_color: "#000000".to_string(),
    }
}

/// The timeline the whole render is of: two pictures crossing over, a real
/// video file after them, a caption, and a second of tone.
fn cut(asset_a: &str, asset_b: &str, video: &str, tone: &str) -> TimelineDocument {
    let mut words = material("clip-words", "track-text", TrackKind::Text, "", 200, 600);
    words.asset_id = None;
    words.text = Some(TextClipData {
        content: "Burned in\nfor the export".to_string(),
        style: caption_style(),
    });
    TimelineDocument {
        id: "timeline-export".to_string(),
        name: "Export cut".to_string(),
        schema_version: 1,
        settings: TimelineSettings {
            fps: 30,
            width: 1920,
            height: 1080,
            background: "#000000".to_string(),
        },
        tracks: vec![
            track("track-video", TrackKind::Video),
            track("track-video-top", TrackKind::Video),
            track("track-audio", TrackKind::Audio),
            track("track-text", TrackKind::Text),
        ],
        clips: vec![
            // Two pictures crossing over: the second is pulled back by the
            // window the transition opens.
            material("clip-a", "track-video", TrackKind::Video, asset_a, 0, 600),
            material("clip-b", "track-video", TrackKind::Video, asset_b, 400, 600),
            // A real video file, after the pictures have crossed.
            material(
                "clip-video",
                "track-video-top",
                TrackKind::Video,
                video,
                1_200,
                400,
            ),
            words,
            material("clip-tone", "track-audio", TrackKind::Audio, tone, 0, 1_000),
        ],
        transitions: vec![TimelineTransition {
            id: "transition-a".to_string(),
            after_clip_id: "clip-a".to_string(),
            kind: TransitionKind::Crossfade,
            duration_ms: 200,
            created_at: NOW.to_string(),
        }],
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
    }
}

/// The project the fixtures are read as: every file in the project's own tree.
fn fixture_project(root: &Path) -> (MokaFile, TimelineDocument) {
    let timeline = cut(
        "asset-image-a",
        "asset-image-b",
        "asset-video",
        "asset-tone",
    );
    let assets = [
        (
            "asset-image-a",
            "images/a.png",
            "image/png",
            "the first picture",
        ),
        (
            "asset-image-b",
            "images/b.png",
            "image/png",
            "the second picture",
        ),
        ("asset-video", "videos/tiny.mp4", "video/mp4", "tiny.mp4"),
        ("asset-tone", "music/beep.wav", "audio/wav", "beep.wav"),
    ];
    let mut resources = ResourceRegistry::default();
    for (id, relative, mime, _) in &assets {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        match *mime {
            "image/png" => write_png(
                &path,
                if id.ends_with("a") {
                    [220, 40, 40]
                } else {
                    [40, 40, 220]
                },
            ),
            "audio/wav" => {
                std::fs::copy(fixture_path("beep.wav"), &path).expect("beep.wav is there");
            }
            _ => {
                std::fs::copy(fixture_path("tiny.mp4"), &path).expect("tiny.mp4 is there");
            }
        }
        let entry = ResourceEntry {
            id: id.to_string(),
            name: entry_name(mime, id),
            path: relative.to_string(),
            mime: Some(mime.to_string()),
            bytes: Some(std::fs::metadata(&path).unwrap().len() as i64),
            sha256: Some("0".repeat(64)),
            created_at: NOW.to_string(),
            updated_at: NOW.to_string(),
            probe: Some(AssetProbe {
                mime: mime.to_string(),
                bytes: 1_024,
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
        };
        let category = moka_canvas::assets::category_for_mime(mime).unwrap();
        resources.category_mut(category).unwrap().push(entry);
    }
    let moka = MokaFile {
        version: MOKA_FILE_VERSION.to_string(),
        metadata: ProjectMetadata {
            id: "project-export".to_string(),
            name: "An export".to_string(),
            description: None,
            cover_path: None,
            revision: 1,
            created_at: NOW.to_string(),
            updated_at: NOW.to_string(),
        },
        resources,
        folders: None,
        timelines: Some(vec![timeline.clone()]),
        stories: None,
        canvas: Vec::new(),
    };
    (moka, timeline)
}

/// The name an entry is filed under, kept simple: the mime's own tail.
fn entry_name(mime: &str, id: &str) -> String {
    format!("{}-{}", id, mime.rsplit('/').next().unwrap_or("file"))
}

#[test]
fn the_real_fixtures_read_into_a_plan_of_the_shape_the_cut_asks_for() {
    let root = tempfile::tempdir().unwrap();
    let (moka, timeline) = fixture_project(root.path());
    let sources = sources_for(root.path(), &moka, &timeline);
    let capabilities = match machine_ffmpeg() {
        Some(program) => probe(&program),
        None => moka_canvas::clip::locate::ClipCapabilities {
            available: true,
            version: Some("a stand-in".to_string()),
            path: None,
            video_encoder: Some("libx264".to_string()),
            transitions: vec!["fade".to_string(), "zoomin".to_string()],
            ass: true,
            reason: None,
        },
    };
    moka_canvas::domain::timeline::validate_timeline(&timeline, &moka)
        .is_empty()
        .then_some(())
        .expect("the fixture timeline is a valid document");
    let plan = build_plan(&sources, &timeline, &moka, &capabilities).expect("the plan builds");

    // Four files, each read once: the two pictures, the video, the tone.
    assert_eq!(plan.inputs.len(), 4);
    let video = plan
        .inputs
        .iter()
        .find(|input| input.path.ends_with("tiny.mp4"))
        .expect("the video is an input");
    // tiny.mp4 carries no sound track, and the plan heard that from the file
    // itself rather than mapping a stream that is not there.
    assert!(!video.has_audio, "tiny.mp4 is silent");
    assert_eq!(video.seek_ms, Some(0));
    assert_eq!(video.duration_ms, Some(400));
    let tone = plan
        .inputs
        .iter()
        .find(|input| input.path.ends_with("beep.wav"))
        .expect("the tone is an input");
    assert!(tone.has_audio);
    assert!(plan.audio);

    // The caption is burned in, and never enters the picture graph.
    let ass = plan.ass.expect("the words are written down");
    assert!(ass.contains("Burned in\\Nfor the export"), "{ass}");
    assert!(plan.graph.contains("ass=subs.ass:fontsdir=fonts[vout]"));
    // The crossfade window is the one the document patched.
    assert!(
        plan.graph.contains("xfade=transition=fade:duration=0.2"),
        "{}",
        plan.graph
    );
    // The render runs to the last block's end: the video block's.
    assert_eq!(plan.duration_ms, 1_600);
}

fn test_app(root: &Path, ffmpeg: Option<PathBuf>) -> axum::Router {
    let mut config: AppConfig = parse_test_config(root);
    config.clip.ffmpeg_path = ffmpeg;
    let metadata_root = config.metadata.dir.clone().expect("a metadata directory");
    let state = ApiState::new(config, RuntimeMode::Web, &metadata_root).expect("the store opens");
    moka_canvas::server::router(state)
}

async fn body_json(response: axum::http::Response<Body>) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).expect("response body must be JSON")
}

fn json_request(method: &str, uri: &str, payload: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap()
}

fn upload_request(uri: &str, filename: &str, bytes: &[u8]) -> Request<Body> {
    let boundary = "X-MOKA-CLIP-BOUNDARY";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Request::builder()
        .method("POST")
        .uri(uri)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn a_whole_render_lands_where_it_was_asked_for() {
    let Some(program) = machine_ffmpeg() else {
        println!(
            "skipping the whole-render test: no ffmpeg on this machine \
             (the plan half above still ran)"
        );
        return;
    };
    let home = tempfile::tempdir().unwrap();
    let app = test_app(home.path(), Some(program));

    // A project of its own, opened through the API.
    let created = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({
                "directory": home.path().join("project").to_string_lossy(),
                "name": "Export evidence",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);

    // The two pictures are written here; the video and the tone are the
    // repository's own fixtures.
    let pictures = home.path().join("pictures");
    std::fs::create_dir_all(&pictures).unwrap();
    let picture_a = pictures.join("a.png");
    let picture_b = pictures.join("b.png");
    write_png(&picture_a, [220, 40, 40]);
    write_png(&picture_b, [40, 40, 220]);
    let mut ids = Vec::new();
    for (name, path) in [
        ("a.png", &picture_a),
        ("b.png", &picture_b),
        ("tiny.mp4", &fixture_path("tiny.mp4")),
        ("beep.wav", &fixture_path("beep.wav")),
    ] {
        let bytes = std::fs::read(path).unwrap();
        let response = app
            .clone()
            .oneshot(upload_request(
                "/api/v1/projects/current/assets",
                name,
                &bytes,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED, "uploading {name}");
        let body = body_json(response).await;
        ids.push(body["entry"]["id"].as_str().expect("an id").to_string());
    }
    let (asset_a, asset_b, asset_video, asset_tone) = (
        ids[0].clone(),
        ids[1].clone(),
        ids[2].clone(),
        ids[3].clone(),
    );

    // The timeline, added whole through the command pipeline.
    let timeline = cut(&asset_a, &asset_b, &asset_video, &asset_tone);
    let applied = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({ "expectedRevision": 4, "commands": [{ "type": "addTimeline", "timeline": timeline }] }),
        ))
        .await
        .unwrap();
    assert_eq!(
        applied.status(),
        StatusCode::OK,
        "{}",
        body_json(applied).await
    );

    // Where the save dialog would have pointed: a folder of the reader's own,
    // outside the project.
    let saved = home.path().join("saved");
    std::fs::create_dir_all(&saved).unwrap();
    let destination = saved.join("Export cut.mp4");

    // Started, and polled the way the dialog polls.
    let started = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/clip/export",
            json!({
                "timelineId": "timeline-export",
                "destination": destination.to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    let status = started.status();
    let task = body_json(started).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{task}");
    let handle = task["id"].as_str().expect("a handle").to_string();

    let deadline = Instant::now() + Duration::from_secs(180);
    let finished = loop {
        assert!(
            Instant::now() < deadline,
            "the render did not finish in time"
        );
        let polled = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/clip/export/{handle}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let task = body_json(polled).await;
        match task["status"].as_str().unwrap_or("") {
            "queued" | "running" => {
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            _ => break task,
        }
    };
    assert_eq!(finished["status"], "done", "{finished}");
    assert_eq!(finished["progress01"], 1.0, "{finished}");
    assert_eq!(
        finished["savedTo"].as_str(),
        Some(destination.to_string_lossy().as_ref()),
        "{finished}"
    );

    // And it is a real 1080p30 file with sound, a second and a bit long.
    let bytes = std::fs::read(&destination).expect("the render is where it was asked for");
    let media = moka_canvas::assets::probe::probe_media("video/mp4", &bytes);
    assert_eq!(media.width, Some(1920));
    assert_eq!(media.height, Some(1080));
    let duration = media.duration_ms.expect("a duration");
    assert!(
        (duration - 1_600).abs() <= 100,
        "the render runs a second and a bit: {duration}ms"
    );
    let codecs = media.codec_summary.clone().unwrap_or_default();
    assert!(codecs.contains("avc1"), "the picture is H.264: {codecs}");
    assert!(codecs.contains("mp4a"), "the sound is there: {codecs}");

    // The project keeps no copy of it: a render is a file the reader asked
    // for, and not material the project holds.
    let opened = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let current = body_json(opened).await;
    let videos = current["moka"]["resources"]["videos"]
        .as_array()
        .expect("the videos");
    assert_eq!(
        videos.len(),
        1,
        "the only video the project holds is the one it was given: {current}"
    );
    let root = PathBuf::from(current["root"].as_str().expect("the root"));

    // Nothing was left in the scratch directory.
    let scratch = root.join("tmp");
    if scratch.is_dir() {
        let leftovers: Vec<String> = std::fs::read_dir(&scratch)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("export-"))
            .collect();
        assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
    }
}

#[tokio::test]
async fn the_export_paths_are_as_unavailable_as_the_machine_is() {
    // The one thing the harness can make sure of on every machine: a renderer
    // that is not there is refused with the note that says how to fix it, and
    // the rest of the server does not care.
    let root = tempfile::tempdir().unwrap();
    let app = test_app(root.path(), Some(PathBuf::from("/nonexistent/ffmpeg")));

    // A render is asked for from inside a project, which is the only place a
    // room has a timeline to render.
    let created = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({
                "directory": root.path().join("project").to_string_lossy(),
                "name": "Unavailable",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);

    let capabilities = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/clip/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(capabilities.status(), StatusCode::OK);
    let body = body_json(capabilities).await;
    assert_eq!(body["available"], false, "{body}");
    assert_eq!(
        body["reason"],
        moka_canvas::clip::locate::UNAVAILABLE_REASON,
        "{body}"
    );

    // A destination is checked before the machine is, so this request reaches
    // the renderer's refusal with a destination a save dialog could have made.
    let refused = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/clip/export",
            json!({
                "timelineId": "timeline-anything",
                "destination": root.path().join("Cut.mp4").to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        refused
            .headers()
            .get("x-error-code")
            .and_then(|value| value.to_str().ok()),
        Some("FFMPEG_UNAVAILABLE")
    );

    // A request that names no destination, or one no save could have produced,
    // is refused before the machine is asked anything.
    let unnamed = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/clip/export",
            json!({ "timelineId": "timeline-anything" }),
        ))
        .await
        .unwrap();
    assert_eq!(unnamed.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        unnamed
            .headers()
            .get("x-error-code")
            .and_then(|value| value.to_str().ok()),
        Some("VALIDATION_FAILED")
    );

    let nowhere = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/clip/export",
            json!({
                "timelineId": "timeline-anything",
                "destination": root.path().join("nowhere").join("Cut.mp4").to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    assert_eq!(nowhere.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        nowhere
            .headers()
            .get("x-error-code")
            .and_then(|value| value.to_str().ok()),
        Some("VALIDATION_FAILED")
    );

    let missing = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/clip/export/nobody")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        missing
            .headers()
            .get("x-error-code")
            .and_then(|value| value.to_str().ok()),
        Some("EXPORT_NOT_FOUND")
    );
}

/// The repository's own media is real media: the render half reads it, and
/// this half proves it is a file worth reading on every machine.
#[test]
fn the_fixture_files_the_cut_reads_are_real_files() {
    let tiny = std::fs::metadata(fixture_path("tiny.mp4")).expect("tiny.mp4 exists");
    assert!(tiny.len() > 128, "tiny.mp4 is a real file");
    let beep = std::fs::read(fixture_path("beep.wav")).expect("beep.wav exists");
    assert!(beep.len() > 1_000, "beep.wav is a real file");
    let fields = moka_canvas::assets::probe::probe_media("audio/wav", &beep);
    assert_eq!(fields.sample_rate, Some(48_000));
    assert_eq!(fields.duration_ms, Some(500));
}

/// A cut of nothing but two captions, one after the other on the text row.
///
/// Both are four characters long and wear the same style, so a renderer
/// drawing boxes instead of glyphs would draw the very same picture twice.
fn caption_timeline() -> TimelineDocument {
    let caption = |id: &str, content: &str, start_ms: i64| {
        let mut words = material(id, "track-text", TrackKind::Text, "", start_ms, 1_000);
        words.asset_id = None;
        words.text = Some(TextClipData {
            content: content.to_string(),
            style: caption_style(),
        });
        words
    };
    TimelineDocument {
        id: "timeline-glyphs".to_string(),
        name: "Glyph cut".to_string(),
        schema_version: 1,
        settings: TimelineSettings {
            fps: 30,
            width: 1920,
            height: 1080,
            background: "#000000".to_string(),
        },
        tracks: vec![track("track-text", TrackKind::Text)],
        clips: vec![
            caption("cue-one", "中文标题", 0),
            caption("cue-two", "风雨雷电", 1_000),
        ],
        transitions: Vec::new(),
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
    }
}

/// One frame of a render, read back as plain grey bytes.
fn gray_frame(program: &Path, video: &Path, at_secs: f64) -> Option<Vec<u8>> {
    let output = std::process::Command::new(program)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            &at_secs.to_string(),
            "-i",
            &video.to_string_lossy(),
            "-frames:v",
            "1",
            "-pix_fmt",
            "gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

/// How much of a grey frame is words rather than the dark background.
fn ink(frame: &[u8]) -> usize {
    frame.iter().filter(|&&value| value > 160).count()
}

/// The words leave the app as glyphs, not as the boxes a renderer draws for
/// glyphs it cannot find.
///
/// This is the shape the whole-render test could not see: a caption rendered
/// as `.notdef` boxes is still a caption as far as size and stream count go.
/// Two different four-character captions are exported in one render and one
/// frame is read out of each half: boxes would make the two frames identical,
/// while real glyphs differ wherever the words do — and either way both
/// frames have ink in them at all, so a render with no words cannot pass for
/// one with words either.
#[tokio::test]
async fn a_rendered_caption_arrives_as_glyphs_and_not_boxes() {
    let Some(program) = machine_ffmpeg() else {
        println!(
            "skipping the glyph test: no ffmpeg on this machine \
             (the plan half above still ran)"
        );
        return;
    };
    let home = tempfile::tempdir().unwrap();
    let app = test_app(home.path(), Some(program.clone()));

    let created = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({
                "directory": home.path().join("project").to_string_lossy(),
                "name": "Glyph evidence",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);

    let applied = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({ "expectedRevision": 0, "commands": [{ "type": "addTimeline", "timeline": caption_timeline() }] }),
        ))
        .await
        .unwrap();
    assert_eq!(
        applied.status(),
        StatusCode::OK,
        "{}",
        body_json(applied).await
    );

    let saved = home.path().join("saved");
    std::fs::create_dir_all(&saved).unwrap();
    let destination = saved.join("Glyphs.mp4");
    let started = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/clip/export",
            json!({
                "timelineId": "timeline-glyphs",
                "destination": destination.to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    let status = started.status();
    let task = body_json(started).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{task}");
    let handle = task["id"].as_str().expect("a handle").to_string();

    let deadline = Instant::now() + Duration::from_secs(180);
    let finished = loop {
        assert!(
            Instant::now() < deadline,
            "the render did not finish in time"
        );
        let polled = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/clip/export/{handle}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let task = body_json(polled).await;
        match task["status"].as_str().unwrap_or("") {
            "queued" | "running" => {
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            _ => break task,
        }
    };
    assert_eq!(finished["status"], "done", "{finished}");

    // One frame out of the middle of each caption.
    let first = gray_frame(&program, &destination, 0.5).expect("a frame of the first caption");
    let second = gray_frame(&program, &destination, 1.5).expect("a frame of the second caption");
    assert!(ink(&first) > 500, "the first caption drew words");
    assert!(ink(&second) > 500, "the second caption drew words");
    let differing = first
        .iter()
        .zip(&second)
        .filter(|(left, right)| left != right)
        .count();
    assert!(
        differing > 1_000,
        "the two captions differ where their words do: {differing} pixels differ"
    );
}
