//! Story jobs, end to end: a batch asked for, answered, filed, and followed.
//!
//! What is checked here is the join between the batch machine and everything
//! under it — the gateway, the ingest, the project store, the routes. A
//! provider stands in for the far end, so a batch of drawings is answered with
//! real bytes that land in a real project's registry, a shot is placed and then
//! looked at until it answers, and a batch left waiting on one is picked up
//! again by the process that opens the project next.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::Path as Route;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use moka_canvas::domain::Capability;
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{Defaults, ModelDraft, Protocol};
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

/// The models tree every test in this binary shares, deployed once.
///
/// The converter registry is process-wide and is what model validation reads to
/// learn which script-backed protocols exist, so the tree is deployed into a
/// directory that outlives every test here: the first deploy wins the global
/// root, and one that went away with the test that made it would leave the rest
/// of the binary with no script protocols at all.
async fn converters() {
    static ROOT: tokio::sync::OnceCell<TempDir> = tokio::sync::OnceCell::const_new();
    ROOT.get_or_init(|| async {
        let dir = TempDir::new().expect("a temporary models root");
        moka_canvas::converter::deploy::ensure_deployed(dir.path())
            .await
            .expect("the built-in converters deploy");
        dir
    })
    .await;
}

/// The story every test here tells, and the chapter of it a piece is aimed at.
const STORY: &str = "story-1";
const NOW: &str = "2026-01-01T00:00:00.000Z";

/// The models a test configures, one per capability it asks of.
const WRITER: &str = "scribe-1";
const PAINTER: &str = "painter-1";
const SHOOTER: &str = "shooter-1";
const SPEAKER: &str = "speaker-1";
const COMPOSER: &str = "composer-1";
/// A second storyteller, which is what a room set to a model of its own asks.
const READER_CHOICE: &str = "scribe-2";

const API_KEY: &str = "sk-test-1234567890abcd";

/// What the writer says, which a text batch keeps whole.
const SENTENCE: &str = "第一集：他在站台上等一班已经停运的列车。";

/// The handle a provider's own endpoint issues for a shot, which the gateway
/// keeps to itself and polls with.
const JOB: &str = "job-at-the-provider";

/// The handle this app tracks a placed shot by, which is what a record carries
/// and what a process that comes next comes back by.
const TASK: &str = "0192b7d4-0000-7000-8000-000000000001";

/// A finished shot: the header of an MP4 and nothing else, because what a filed
/// asset is filed as is read off its bytes rather than trusted from an answer.
const SHOT: &[u8] = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom";

/// A second of sound, written as a real WAV so the probe can measure it. The
/// shelf needs no duration to file a file, but a score that cannot be measured
/// would not be the thing a story is assembled from either.
fn speech(seconds: u32) -> Vec<u8> {
    let sample_rate = 8_000u32;
    let data_size = sample_rate * seconds;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&8u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    bytes.resize(bytes.len() + data_size as usize, 128);
    bytes
}

struct Harness {
    app: Router,
    state: ApiState,
    /// The directory the whole app is opened over, kept alive by the caller so
    /// that one test can open a second app over the same one.
    root: PathBuf,
}

/// Opens the app over a temporary directory that already holds a master key:
/// a generation cannot be placed without a credential to send, and server mode
/// would only make one on the first credential stored.
fn harness_at(tmp: &TempDir) -> Harness {
    let config = parse_test_config(tmp.path());
    let metadata = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    std::fs::create_dir_all(&metadata).expect("the metadata directory is created");
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(metadata.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let state = ApiState::new(config, RuntimeMode::Web, &metadata).expect("the store opens");
    let app = moka_canvas::server::router(state.clone());
    Harness {
        app,
        state,
        root: tmp.path().to_path_buf(),
    }
}

impl Harness {
    /// Keeps one model of a capability, with its credential, and leaves the
    /// defaults alone: a model beside the deployment's own is what a reader's
    /// own choice is. Every capability is served by a converter script here, so
    /// the scripts are deployed before the first model is kept.
    async fn add_model(&self, base_url: &str, id: &str, capability: Capability) {
        converters().await;
        let (protocol, suffix) = match capability {
            Capability::Text => (Protocol::new("openaiResponses"), "/v1/responses"),
            Capability::Image => (Protocol::new("openaiImages"), "/v1/images/generations"),
            Capability::Speech => (Protocol::new("openaiSpeech"), "/v1/audio/speech"),
            Capability::Music => (
                Protocol::new("bailianMusic"),
                "/api/v1/services/audio/music/generation",
            ),
            Capability::Video => (Protocol::new("openaiVideos"), "/v1/videos"),
            Capability::Asr => (Protocol::new("bailianAsr"), "/v1/transcription"),
        };
        self.state
            .models
            .upsert(ModelDraft {
                id: id.into(),
                category: capability,
                protocol,
                url: format!("{base_url}{suffix}"),
                model: id.into(),
                display_name: id.into(),
                max_video_seconds: None,
                scenes: Vec::new(),
                sub_models: Vec::new(),
                enabled: true,
                expected_revision: None,
            })
            .await
            .expect("the model is stored");
        self.state
            .models
            .set_key(id, Some(API_KEY))
            .await
            .expect("the credential is stored");
    }

    /// Points the app at throwaway models and makes them the defaults.
    async fn configure(&self, base_url: &str, models: &[(&str, Capability)]) {
        let mut defaults = Defaults::default();
        for (id, capability) in models {
            self.add_model(base_url, id, *capability).await;
            match capability {
                Capability::Text => defaults.text = Some((*id).to_string()),
                Capability::Image => defaults.image = Some((*id).to_string()),
                Capability::Speech => defaults.speech = Some((*id).to_string()),
                Capability::Music => defaults.music = Some((*id).to_string()),
                Capability::Video => defaults.video = Some((*id).to_string()),
                Capability::Asr => defaults.asr = Some((*id).to_string()),
            }
        }
        self.state
            .models
            .set_defaults(&defaults, None)
            .await
            .expect("the defaults are stored");
    }

    /// Keeps a music model beside the models already configured and points the
    /// score at it, which is what a deployment with a composer looks like.
    async fn compose_with(&self, base_url: &str, id: &str) {
        converters().await;
        self.state
            .models
            .upsert(ModelDraft {
                id: id.into(),
                category: Capability::Music,
                // A converter script's protocol: the model names it, and what
                // it speaks is the script's business.
                protocol: Protocol::new("bailianMusic"),
                url: format!("{base_url}/api/v1/services/audio/music/generation"),
                model: "fun-music-v1".into(),
                display_name: id.into(),
                max_video_seconds: None,
                scenes: Vec::new(),
                sub_models: Vec::new(),
                enabled: true,
                expected_revision: None,
            })
            .await
            .expect("the music model is stored");
        self.state
            .models
            .set_key(id, Some(API_KEY))
            .await
            .expect("the credential is stored");
        let mut defaults = self
            .state
            .models
            .snapshot()
            .await
            .expect("the models are readable")
            .defaults;
        defaults.music = Some(id.to_string());
        self.state
            .models
            .set_defaults(&defaults, None)
            .await
            .expect("the music default is stored");
    }

    /// Creates the project a batch happens in, tells it one story, and answers
    /// with the directory a restart would open.
    async fn project(&self, name: &str) -> PathBuf {
        let created = self
            .send_json(
                json_request(
                    "POST",
                    "/api/v1/projects",
                    json!({
                        "directory": self.root.join("projects").to_string_lossy(),
                        "name": name,
                    }),
                ),
                StatusCode::CREATED,
            )
            .await;
        let root = PathBuf::from(created["root"].as_str().expect("a root is reported"));
        let revision = document_revision(&self.document().await);
        self.send_json(
            json_request(
                "POST",
                "/api/v1/projects/current/commands",
                json!({
                    "expectedRevision": revision,
                    "commands": [{ "type": "addStory", "story": story_document() }],
                }),
            ),
            StatusCode::OK,
        )
        .await;
        root
    }

    async fn document(&self) -> Value {
        self.send_json(get_request("/api/v1/projects/current"), StatusCode::OK)
            .await
    }

    /// Asks for a batch, and answers with whatever the server said.
    async fn start(&self, request: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(json_request(
                "POST",
                "/api/v1/projects/current/story/jobs",
                request,
            ))
            .await
            .unwrap();
        let status = response.status();
        (status, body_json(response).await)
    }

    async fn start_ok(&self, request: Value) -> Value {
        let (status, body) = self.start(request).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body
    }

    async fn job(&self, id: &str) -> Value {
        self.send_json(
            get_request(&format!("/api/v1/projects/current/story/jobs/{id}")),
            StatusCode::OK,
        )
        .await
    }

    async fn jobs(&self) -> Value {
        self.send_json(
            get_request("/api/v1/projects/current/story/jobs"),
            StatusCode::OK,
        )
        .await
    }

    async fn cancel(&self, id: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/current/story/jobs/{id}/cancel"))
            .body(Body::empty())
            .expect("a request is built");
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        (status, body_json(response).await)
    }

    /// Writes a batch's answer down as read, which is what a room does once
    /// what it answered is really in the story.
    async fn read_in(&self, id: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/current/story/jobs/{id}/read"))
            .body(Body::empty())
            .expect("a request is built");
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        (status, body_json(response).await)
    }

    /// Waits a batch out, which the provider here answers fast enough that a
    /// few seconds without a terminal state is a batch that never settles.
    async fn settled(&self, id: &str) -> Value {
        for _ in 0..240 {
            let job = self.job(id).await;
            let status = job["status"].as_str().expect("a job has a status");
            if status != "queued" && status != "running" {
                return job;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("story job {id} did not reach a terminal state");
    }

    /// Waits until a piece's handle is on the record, which is the moment a
    /// shot exists at the far end and nothing on this side has answered yet.
    async fn until_placed(&self, id: &str) -> String {
        for _ in 0..120 {
            let job = self.job(id).await;
            if let Some(task_id) = job["items"][0]["taskId"].as_str() {
                return task_id.to_string();
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("story job {id} never wrote the handle down");
    }

    /// Opens the project again, which is what a restart does before anything
    /// else and the moment the batches a previous process left are picked up.
    async fn reopen(&self) {
        let listed = self
            .send_json(get_request("/api/v1/recent-projects"), StatusCode::OK)
            .await;
        let path = listed[0]["path"]
            .as_str()
            .expect("the project that was made is the recent one")
            .to_string();
        self.send_json(
            json_request("POST", "/api/v1/projects/open", json!({ "path": path })),
            StatusCode::OK,
        )
        .await;
    }

    async fn send_json(&self, request: Request<Body>, expected: StatusCode) -> Value {
        let response = self.app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), expected);
        body_json(response).await
    }
}

async fn body_json(response: axum::http::Response<Body>) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).expect("a response body is JSON")
}

fn json_request(method: &str, uri: &str, payload: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap()
}

fn get_request(uri: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

fn document_revision(document: &Value) -> i64 {
    document["moka"]["metadata"]["revision"]
        .as_i64()
        .expect("the document carries a revision")
}

fn story_document() -> Value {
    json!({
        "id": STORY,
        "name": "雨夜列车",
        "schemaVersion": 1,
        "brief": {
            "idea": "末班列车上，两个陌生人交换了各自要说的话。",
            "totalDurationMs": 120000,
            "aspect": "16:9",
            "genre": "对白剧情",
            "style": "现代都市风"
        },
        "chapters": [],
        "elements": [],
        "shotGranularity": "act",
        "createdAt": NOW,
        "updatedAt": NOW,
    })
}

/// A batch of one kind, carrying the pieces given.
fn batch(kind: &str, items: Vec<Value>) -> Value {
    json!({ "storyId": STORY, "kind": kind, "items": items })
}

/// One piece, aimed at a slot of the kind its target names.
fn piece(id: &str, target: Value, capability: &str, prompt: &str) -> Value {
    json!({
        "id": id,
        "target": target,
        "capability": capability,
        "prompt": prompt,
        "params": {},
    })
}

fn keyframe_target(chapter: &str, act: &str, keyframe: &str) -> Value {
    json!({
        "kind": "keyframeArt",
        "chapterId": chapter,
        "actId": act,
        "keyframeId": keyframe,
    })
}

fn element_target(element: &str, view: &str) -> Value {
    json!({ "kind": "elementArt", "elementId": element, "view": view })
}

fn act_video_target(act: &str) -> Value {
    json!({ "kind": "actVideo", "chapterId": "chapter-1", "actId": act })
}

fn act_voice_target(act: &str) -> Value {
    json!({ "kind": "voice", "chapterId": "chapter-1", "actId": act })
}

fn act_music_target(act: &str) -> Value {
    json!({ "kind": "music", "chapterId": "chapter-1", "actId": act })
}

/// A story job record as a process that stopped in the middle of one left it:
/// one act being filmed, with the handle the far end issued for it or without.
fn abandoned_job(task_id: Option<&str>) -> Value {
    let mut item = json!({
        "id": "act",
        "target": act_video_target("act-1"),
        "capability": "video",
        "prompt": "站台上的灯一盏一盏亮起来",
        "params": {},
        "status": "running",
    });
    if let Some(task_id) = task_id {
        item["taskId"] = json!(task_id);
    }
    json!({
        "id": "job-abandoned",
        "projectId": "whatever",
        "storyId": STORY,
        "kind": "actVideo",
        "status": "running",
        "model": SHOOTER,
        "items": [item],
        "createdAt": NOW,
        "updatedAt": NOW,
    })
}

/// Writes a record straight into the project's history, the way a process that
/// stopped mid-flight would have left it behind.
fn leave_record(root: &Path, job: Value) {
    let dir = root.join("history").join("story-jobs");
    std::fs::create_dir_all(&dir).unwrap();
    let id = job["id"].as_str().unwrap();
    std::fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec_pretty(&job).unwrap(),
    )
    .unwrap();
}

/// Writes the note a placed shot leaves beside the project, which is the only
/// thing a process that comes next can find the job by.
fn leave_job_note(root: &Path, task_id: &str) {
    let dir = root.join("history").join("jobs");
    std::fs::create_dir_all(&dir).unwrap();
    let note = json!({
        "id": task_id,
        "reference": JOB,
        "protocol": "openaiVideos",
        "capability": "video",
        "model": SHOOTER,
        "createdAt": NOW,
    });
    std::fs::write(
        dir.join(format!("{task_id}.json")),
        serde_json::to_vec_pretty(&note).unwrap(),
    )
    .unwrap();
}

/// Starts a throwaway provider and returns the address a model would carry.
async fn serve(routes: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let address = listener.local_addr().expect("the socket has an address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, routes).await;
    });
    format!("http://{address}")
}

/// What a throwaway provider was asked, so a test can read the batch that
/// reached the far end of the whole pipeline — and tell a shot placed from a
/// shot merely looked at again.
#[derive(Clone, Default)]
struct Recorded {
    asks: Arc<Mutex<Vec<Value>>>,
    placed: Arc<Mutex<Vec<String>>>,
    looks: Arc<Mutex<Vec<String>>>,
}

impl Recorded {
    fn note(&self, body: &[u8]) {
        if let Ok(asked) = serde_json::from_slice::<Value>(body) {
            self.asks
                .lock()
                .expect("the notes are not poisoned")
                .push(asked);
        }
    }

    fn noted(&self, list: &Arc<Mutex<Vec<String>>>, value: &str) {
        list.lock()
            .expect("the notes are not poisoned")
            .push(value.to_string());
    }

    fn count(&self) -> usize {
        self.asks.lock().expect("the notes are not poisoned").len()
    }

    fn asks(&self) -> Vec<Value> {
        self.asks
            .lock()
            .expect("the notes are not poisoned")
            .clone()
    }

    fn placed(&self) -> Vec<String> {
        self.placed
            .lock()
            .expect("the notes are not poisoned")
            .clone()
    }

    fn looks(&self) -> Vec<String> {
        self.looks
            .lock()
            .expect("the notes are not poisoned")
            .clone()
    }
}

/// A provider that writes words, paints a picture, films a shot, speaks a line
/// and composes a song: everything one story step could ask for.
fn answering(recorded: Recorded, finished: Arc<AtomicBool>) -> Router {
    let writing = recorded.clone();
    let painting = recorded.clone();
    let speaking = recorded.clone();
    let composing = recorded.clone();
    let starting = recorded;
    let asking = starting.clone();
    Router::new()
        .route(
            "/v1/responses",
            post(move |body: Bytes| {
                let recorded = writing.clone();
                async move {
                    recorded.note(&body);
                    // The room asks for words as a stream, so the stand-in
                    // answers as one: the events a provider sends as it writes.
                    let events = format!(
                        "data: {{\"type\":\"response.output_text.delta\",\"delta\":{}}}\n\n\
                         data: {{\"type\":\"response.output_text.delta\",\"delta\":{}}}\n\n\
                         data: [DONE]\n\n",
                        json!(SENTENCE),
                        json!(""),
                    );
                    ([(header::CONTENT_TYPE, "text/event-stream")], events)
                }
            }),
        )
        .route(
            "/v1/images/generations",
            post(move |body: Bytes| {
                let recorded = painting.clone();
                async move {
                    recorded.note(&body);
                    Json(json!({
                        "created": 1_700_000_000u64,
                        "data": [{ "b64_json": encoded(&picture(8, 6)) }],
                    }))
                }
            }),
        )
        .route(
            "/v1/audio/speech",
            post(move |body: Bytes| {
                let recorded = speaking.clone();
                async move {
                    recorded.note(&body);
                    ([(header::CONTENT_TYPE, "audio/wav")], speech(1))
                }
            }),
        )
        // A song is asked for at the service's own address and answered with a
        // link to it, on this same stand-in: the second request is the one that
        // carries the music.
        .route(
            "/api/v1/services/audio/music/generation",
            post(move |headers: HeaderMap, body: Bytes| {
                let recorded = composing.clone();
                async move {
                    recorded.note(&body);
                    let host = headers
                        .get(header::HOST)
                        .and_then(|host| host.to_str().ok())
                        .unwrap_or("127.0.0.1");
                    Json(json!({
                        "output": {
                            "audio": { "url": format!("http://{host}/song.mp3?sig=stand-in") },
                            "extra_info": { "channels": 2, "sample_rate": 48_000 },
                            "finish_reason": "stop",
                        },
                        "usage": { "duration": 1 },
                    }))
                }
            }),
        )
        .route(
            "/song.mp3",
            get(|| async { ([(header::CONTENT_TYPE, "audio/wav")], speech(1)) }),
        )
        .route(
            "/v1/videos",
            post(move |body: Bytes| {
                let recorded = starting.clone();
                async move {
                    recorded.note(&body);
                    recorded.noted(&recorded.placed, JOB);
                    Json(json!({ "id": JOB, "status": "queued" }))
                }
            }),
        )
        .route(
            "/v1/videos/{reference}",
            get(move |Route(reference): Route<String>| {
                let recorded = asking.clone();
                let finished = Arc::clone(&finished);
                async move {
                    recorded.noted(&recorded.looks, &reference);
                    let status = if finished.load(Ordering::SeqCst) {
                        "succeeded"
                    } else {
                        "in_progress"
                    };
                    Json(json!({ "id": reference, "status": status }))
                }
            }),
        )
        .route(
            "/v1/videos/{reference}/content",
            get(|| async { ([(header::CONTENT_TYPE, "video/mp4")], SHOT.to_vec()) }),
        )
}

/// A provider that paints the first picture, refuses the second, and paints
/// everything after it: one refusal is one piece's bad luck.
fn refusing_the_second_picture() -> Router {
    Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| async move {
            let refused = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|asked| {
                    asked["prompt"]
                        .as_str()
                        .map(|prompt| prompt.contains("第二格"))
                })
                .unwrap_or(false);
            if refused {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": { "message": "that prompt cannot be drawn" } })),
                );
            }
            (
                StatusCode::OK,
                Json(json!({
                    "created": 1_700_000_000u64,
                    "data": [{ "b64_json": encoded(&picture(8, 6)) }],
                })),
            )
        }),
    )
}

fn encoded(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A provider that paints a picture whose shape says which prompt asked for
/// it: a batch's drawings are told apart by what is in the files it filed.
fn painting_by_prompt() -> Router {
    Router::new().route(
        "/v1/images/generations",
        post(|body: Bytes| async move {
            let prompt = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|asked| asked["prompt"].as_str().map(str::to_string))
                .unwrap_or_default();
            let drawn = if prompt.contains("第一格") {
                picture(8, 6)
            } else {
                picture(10, 4)
            };
            Json(json!({
                "created": 1_700_000_000u64,
                "data": [{ "b64_json": encoded(&drawn) }],
            }))
        }),
    )
}

/// A tiny PNG, sized so a test can tell one drawing from another.
fn picture(width: u32, height: u32) -> Vec<u8> {
    let mut png = image::RgbaImage::new(width, height);
    for pixel in png.pixels_mut() {
        *pixel = image::Rgba([30, 120, 200, 255]);
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
async fn a_batch_of_drawings_is_answered_and_filed_under_the_batch_that_asked() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let recorded = Recorded::default();
    let provider = serve(answering(recorded.clone(), Arc::new(AtomicBool::new(true)))).await;
    harness
        .configure(&provider, &[(PAINTER, Capability::Image)])
        .await;
    harness.project("Story Drawings").await;

    let job = harness
        .start_ok(batch(
            "keyframeArt",
            vec![piece(
                "kf:1",
                keyframe_target("chapter-1", "act-1", "frame-1"),
                "image",
                "雨中的站台",
            )],
        ))
        .await;
    assert_eq!(job["status"], "queued");
    let job_id = job["id"].as_str().expect("a job has an id").to_string();

    let settled = harness.settled(&job_id).await;
    assert_eq!(settled["status"], "succeeded", "{settled}");
    assert_eq!(settled["model"], PAINTER);
    let item = &settled["items"][0];
    assert_eq!(item["status"], "succeeded");
    let asset_id = item["assetIds"][0]
        .as_str()
        .expect("the answer became a file")
        .to_string();
    assert!(item["progress"].as_f64().unwrap_or_default() > 0.9);

    // The file is in the project, and it says which batch drew it and which
    // story it was drawn for.
    let document = harness.document().await;
    let entry = document["moka"]["resources"]["images"]
        .as_array()
        .expect("the shelf is a list")
        .iter()
        .find(|entry| entry["id"] == json!(asset_id))
        .expect("the drawing is on the shelf")
        .clone();
    assert_eq!(entry["provenance"]["storyJobId"], json!(job_id));
    assert_eq!(entry["provenance"]["storyId"], json!(STORY));
    assert!(
        entry["name"]
            .as_str()
            .unwrap_or_default()
            .contains("keyframe art"),
        "the file says what it is: {}",
        entry["name"]
    );
    assert_eq!(recorded.count(), 1, "one piece is one call");
}

/// A batch of characters drawn at once: every piece is a file of its own.
///
/// The pieces of one batch are named alike — one label, one batch — so the
/// names they are filed under must not be alike: a file written over another
/// is two characters wearing the same face.
#[tokio::test]
async fn a_batch_of_drawings_files_every_piece_in_a_file_of_its_own() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let provider = serve(painting_by_prompt()).await;
    harness
        .configure(&provider, &[(PAINTER, Capability::Image)])
        .await;
    let root = harness.project("Story Drawings").await;

    let job = harness
        .start_ok(batch(
            "elementArt",
            vec![
                piece(
                    "element:main:hero",
                    element_target("hero", "main"),
                    "image",
                    "第一格：雨里的站台",
                ),
                piece(
                    "element:main:other",
                    element_target("other", "main"),
                    "image",
                    "第二格：灯下的人",
                ),
            ],
        ))
        .await;
    let job_id = job["id"].as_str().expect("a job has an id").to_string();
    let settled = harness.settled(&job_id).await;
    assert_eq!(settled["status"], "succeeded", "{settled}");

    let document = harness.document().await;
    let shelf = document["moka"]["resources"]["images"]
        .as_array()
        .expect("the shelf is a list");
    let mut paths = Vec::new();
    for (at, expected) in [picture(8, 6), picture(10, 4)].iter().enumerate() {
        let asset_id = settled["items"][at]["assetIds"][0]
            .as_str()
            .expect("the answer became a file");
        let entry = shelf
            .iter()
            .find(|entry| entry["id"] == json!(asset_id))
            .expect("the drawing is on the shelf");
        let path = entry["path"].as_str().expect("a filed asset has a path");
        let bytes = std::fs::read(root.join(path)).expect("the file is in the project");
        assert_eq!(
            bytes, *expected,
            "piece {at} keeps the drawing it was answered with"
        );
        paths.push(path.to_string());
    }
    assert_ne!(paths[0], paths[1], "two drawings are two files");
}

#[tokio::test]
async fn a_batch_of_sound_is_filed_as_voice_on_the_shelf_and_as_music_beside_it() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let recorded = Recorded::default();
    let provider = serve(answering(recorded.clone(), Arc::new(AtomicBool::new(true)))).await;
    harness
        .configure(&provider, &[(SPEAKER, Capability::Speech)])
        .await;
    // A score needs a music model of its own: with none kept, the ask is a
    // said-out-loud gap rather than a speech model asked for a tune.
    harness.compose_with(&provider, COMPOSER).await;
    harness.project("Story Sound").await;

    // A line of an act read aloud: audio like any other answer, filed under the
    // one category a sniffer cannot settle on its own. The voice travels in the
    // piece's parameters, as a telling's own planning sends it — a voiceless
    // ask is refused before it leaves.
    let mut spoken_piece = piece(
        "voice:1",
        act_voice_target("act-1"),
        "speech",
        "「我们到站了。」他轻声说。",
    );
    spoken_piece["params"] = json!({ "voice": "alloy" });
    let spoken = harness.start_ok(batch("voice", vec![spoken_piece])).await;
    let spoken_id = spoken["id"].as_str().unwrap().to_string();
    let settled = harness.settled(&spoken_id).await;
    assert_eq!(settled["status"], "succeeded", "{settled}");
    assert_eq!(settled["model"], SPEAKER);
    let voice_id = settled["items"][0]["assetIds"][0]
        .as_str()
        .expect("the answer became a file")
        .to_string();

    let document = harness.document().await;
    let voice = document["moka"]["resources"]["voice"]
        .as_array()
        .expect("the shelf keeps voices")
        .iter()
        .find(|entry| entry["id"] == json!(voice_id))
        .expect("the line is filed as voice")
        .clone();
    assert!(
        voice["name"]
            .as_str()
            .unwrap_or_default()
            .contains("act voice"),
        "the file says what it is: {}",
        voice["name"]
    );
    assert_eq!(voice["provenance"]["storyJobId"], json!(spoken_id));

    // The music and sound under the act is a music ask of its own, which is
    // what tells the two sound categories apart.
    let scored = piece(
        "music:1",
        act_music_target("act-1"),
        "music",
        "站台的风声，远处一列停运的列车。",
    );
    let score = harness.start_ok(batch("music", vec![scored])).await;
    let score_id = score["id"].as_str().unwrap().to_string();
    let settled = harness.settled(&score_id).await;
    assert_eq!(settled["status"], "succeeded", "{settled}");
    let music_id = settled["items"][0]["assetIds"][0]
        .as_str()
        .expect("the answer became a file")
        .to_string();

    let document = harness.document().await;
    let music = document["moka"]["resources"]["music"]
        .as_array()
        .expect("the shelf keeps music")
        .iter()
        .find(|entry| entry["id"] == json!(music_id))
        .expect("the score is filed as music")
        .clone();
    assert!(
        music["name"]
            .as_str()
            .unwrap_or_default()
            .contains("act music"),
        "the file says what it is: {}",
        music["name"]
    );
    assert_eq!(recorded.count(), 2, "two pieces are two calls");
}

#[tokio::test]
async fn a_score_is_composed_by_the_model_kept_for_music() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let recorded = Recorded::default();
    let provider = serve(answering(recorded.clone(), Arc::new(AtomicBool::new(true)))).await;
    harness
        .configure(&provider, &[(SPEAKER, Capability::Speech)])
        .await;
    harness.compose_with(&provider, COMPOSER).await;
    harness.project("Story Score").await;

    // A telling's music, asked for the way the fourth step asks for it: a
    // music ask with no vocals — the lines are read by a voice.
    let mut scored = piece(
        "music:1",
        act_music_target("act-1"),
        "music",
        "雨夜站台，低音提琴，缓慢",
    );
    scored["params"] = json!({ "instrumental": true, "format": "mp3" });
    let job = harness.start_ok(batch("music", vec![scored])).await;
    let job_id = job["id"].as_str().unwrap().to_string();
    let settled = harness.settled(&job_id).await;
    assert_eq!(settled["status"], "succeeded", "{settled}");
    // The batch is driven by the composer rather than by the voice, which is
    // the whole point of keeping one.
    assert_eq!(settled["model"], COMPOSER);

    // The service was asked in its own words, at its own address.
    let asked = recorded
        .asks()
        .into_iter()
        .find(|asked| asked["input"]["prompt"] == json!("雨夜站台，低音提琴，缓慢"))
        .expect("the service was asked for a song");
    assert_eq!(asked["model"], "fun-music-v1");
    assert_eq!(asked["input"]["is_instrumental"], true);
    assert_eq!(asked["input"]["format"], "mp3");
    assert!(asked["input"].get("music").is_none(), "{asked}");
    assert!(asked["input"].get("voice").is_none(), "{asked}");

    // And the song it pointed at is what landed on the shelf.
    let item = &settled["items"][0];
    let asset_id = item["assetIds"][0]
        .as_str()
        .expect("the answer became a file")
        .to_string();
    let document = harness.document().await;
    assert!(
        document["moka"]["resources"]["music"]
            .as_array()
            .expect("the shelf keeps music")
            .iter()
            .any(|entry| entry["id"] == json!(asset_id)),
        "the song is filed as music"
    );
}

#[tokio::test]
async fn a_batch_is_asked_of_the_model_the_reader_named() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let recorded = Recorded::default();
    let provider = serve(answering(recorded.clone(), Arc::new(AtomicBool::new(true)))).await;
    // The deployment keeps a storyteller and answers with it by default; the
    // room is set to a second one, which is the model a named batch must reach.
    harness
        .configure(&provider, &[(WRITER, Capability::Text)])
        .await;
    harness
        .add_model(&provider, READER_CHOICE, Capability::Text)
        .await;
    harness.project("Story Own Model").await;

    let mut request = batch(
        "outline",
        vec![piece(
            "outline",
            json!({ "kind": "outline" }),
            "text",
            "把它拆成两集",
        )],
    );
    request["model"] = json!(READER_CHOICE);
    let job = harness.start_ok(request).await;
    let job_id = job["id"].as_str().unwrap().to_string();

    assert_eq!(job["model"], READER_CHOICE);
    let settled = harness.settled(&job_id).await;
    assert_eq!(settled["status"], "succeeded", "{settled}");
    let asked = recorded
        .asks()
        .into_iter()
        .find(|asked| asked["input"] == json!("把它拆成两集"))
        .expect("the storyteller was asked");
    assert_eq!(asked["model"], READER_CHOICE);

    // A name the deployment cannot serve is refused rather than quietly swapped
    // for the default, which is what tells the room to be set again.
    let mut unknown = batch(
        "outline",
        vec![piece(
            "outline",
            json!({ "kind": "outline" }),
            "text",
            "再来一次",
        )],
    );
    unknown["model"] = json!("nobody");
    let (status, view) = harness.start(unknown).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{view}");
    assert_eq!(view["code"], "PROVIDER_NOT_CONFIGURED");
}

#[tokio::test]
async fn a_batch_of_words_keeps_what_the_provider_said() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let recorded = Recorded::default();
    let provider = serve(answering(recorded.clone(), Arc::new(AtomicBool::new(true)))).await;
    harness
        .configure(&provider, &[(WRITER, Capability::Text)])
        .await;
    harness.project("Story Words").await;

    let outline = json!({ "kind": "outline" });
    let mut asked = piece("outline", outline.clone(), "text", "把它拆成两集");
    // The room's standing instruction travels as the ask's system half rather
    // than folded into the prompt.
    asked["system"] = json!("Answer with one json shape and nothing else.");
    let job = harness.start_ok(batch("outline", vec![asked])).await;
    let job_id = job["id"].as_str().unwrap().to_string();

    let settled = harness.settled(&job_id).await;
    assert_eq!(settled["status"], "succeeded");
    // Parsing the answer is the room's business: what is kept here is the whole
    // of what the provider said.
    assert_eq!(settled["items"][0]["text"], json!(SENTENCE));
    assert_eq!(
        settled["items"][0]["system"],
        json!("Answer with one json shape and nothing else.")
    );
    let heard = recorded
        .asks()
        .into_iter()
        .find(|heard| heard["input"] == json!("把它拆成两集"))
        .expect("the storyteller was asked");
    assert_eq!(
        heard["instructions"],
        json!("Answer with one json shape and nothing else.")
    );
    assert!(
        settled["items"][0]["assetIds"]
            .as_array()
            .map(|ids| ids.is_empty())
            .unwrap_or(true),
        "words are kept, not filed"
    );
}

#[tokio::test]
async fn a_shot_is_placed_written_down_and_then_waited_out() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let finished = Arc::new(AtomicBool::new(false));
    let recorded = Recorded::default();
    let provider = serve(answering(recorded.clone(), Arc::clone(&finished))).await;
    harness
        .configure(&provider, &[(SHOOTER, Capability::Video)])
        .await;
    let project = harness.project("Story Shots").await;

    let job = harness
        .start_ok(batch(
            "actVideo",
            vec![piece(
                "act",
                act_video_target("act-1"),
                "video",
                "站台上的灯一盏一盏亮起来",
            )],
        ))
        .await;
    let job_id = job["id"].as_str().unwrap().to_string();

    // The handle reaches the record while the provider is still filming, which
    // is the whole of what a restart comes back by.
    let placed = harness.until_placed(&job_id).await;
    assert_eq!(placed.len(), 36, "a handle of our own: {placed}");
    assert!(
        project
            .join("history")
            .join("jobs")
            .join(format!("{placed}.json"))
            .exists(),
        "the handle is written down beside the project"
    );

    finished.store(true, Ordering::SeqCst);
    let settled = harness.settled(&job_id).await;
    assert_eq!(settled["status"], "succeeded", "{settled}");
    let asset_id = settled["items"][0]["assetIds"][0].as_str().unwrap();
    let document = harness.document().await;
    assert!(
        document["moka"]["resources"]["videos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == json!(asset_id)),
        "the shot landed on the shelf"
    );
    assert_eq!(recorded.placed(), vec![JOB.to_string()], "placed once");
}

#[tokio::test]
async fn a_batch_left_waiting_on_a_shot_is_picked_up_by_the_process_that_comes_next() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let recorded = Recorded::default();
    let provider = serve(answering(recorded.clone(), Arc::new(AtomicBool::new(true)))).await;
    harness
        .configure(&provider, &[(SHOOTER, Capability::Video)])
        .await;
    let project = harness.project("Story Restart").await;

    // A batch the process before this one placed and was waiting on when it
    // stopped: the handle is on the record and the shot is out there.
    leave_record(&project, abandoned_job(Some(TASK)));
    leave_job_note(&project, TASK);

    harness.reopen().await;

    let mut settled = harness.job("job-abandoned").await;
    for _ in 0..240 {
        settled = harness.job("job-abandoned").await;
        if settled["status"] == json!("succeeded") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(settled["status"], "succeeded", "{settled}");
    assert_eq!(settled["items"][0]["taskId"], json!(TASK));
    assert!(
        !settled["items"][0]["assetIds"]
            .as_array()
            .unwrap()
            .is_empty(),
        "the answer the provider was holding all along was collected"
    );
    assert!(
        recorded.placed().is_empty(),
        "the shot was waited out, not asked for a second time"
    );
    assert_eq!(
        recorded.looks().len(),
        1,
        "and it was waited out by the handle the record carried"
    );
}

#[tokio::test]
async fn a_batch_is_cancelled_without_losing_the_pieces_that_answered() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let finished = Arc::new(AtomicBool::new(false));
    let provider = serve(answering(Recorded::default(), Arc::clone(&finished))).await;
    harness
        .configure(&provider, &[(SHOOTER, Capability::Video)])
        .await;
    harness.project("Story Cancel").await;

    let job = harness
        .start_ok(batch(
            "actVideo",
            vec![
                piece("act", act_video_target("act-1"), "video", "第一幕"),
                piece("act:2", act_video_target("act-2"), "video", "第二幕"),
                piece("act:3", act_video_target("act-3"), "video", "第三幕"),
            ],
        ))
        .await;
    let job_id = job["id"].as_str().unwrap().to_string();
    harness.until_placed(&job_id).await;

    let (status, answered) = harness.cancel(&job_id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(answered["cancelRequested"], json!(true));

    let settled = harness.settled(&job_id).await;
    assert_eq!(settled["status"], "cancelled", "{settled}");
    // The pieces that were in flight are over; the one that was still waiting
    // its turn is still queued, which is what a room reads to ask for the rest
    // of the batch and not for the whole of it.
    assert_eq!(settled["items"][0]["status"], "cancelled", "{settled}");
    assert_eq!(settled["items"][2]["status"], "queued", "{settled}");
}

#[tokio::test]
async fn one_piece_being_refused_does_not_take_the_others_with_it() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let provider = serve(refusing_the_second_picture()).await;
    harness
        .configure(&provider, &[(PAINTER, Capability::Image)])
        .await;
    harness.project("Story Refusal").await;

    let job = harness
        .start_ok(batch(
            "keyframeArt",
            vec![
                piece(
                    "kf:1",
                    keyframe_target("chapter-1", "act-1", "frame-1"),
                    "image",
                    "第一格",
                ),
                piece(
                    "kf:2",
                    keyframe_target("chapter-1", "act-1", "frame-2"),
                    "image",
                    "第二格",
                ),
                piece(
                    "kf:3",
                    keyframe_target("chapter-1", "act-1", "frame-3"),
                    "image",
                    "第三格",
                ),
            ],
        ))
        .await;
    let job_id = job["id"].as_str().unwrap().to_string();

    let settled = harness.settled(&job_id).await;
    assert_eq!(settled["status"], "failed");
    assert_eq!(settled["error"], json!("1 of 3 items failed"));
    assert_eq!(settled["items"][0]["status"], "succeeded", "{settled}");
    assert_eq!(settled["items"][1]["status"], "failed", "{settled}");
    assert_eq!(
        settled["items"][1]["retryable"],
        json!(false),
        "a refusal is not worth asking again as it stands"
    );
    // And the kind of trouble travels with it, so a client can say the same
    // thing in the reader's own language rather than only in the provider's.
    assert_eq!(
        settled["items"][1]["errorCode"],
        json!("PROVIDER_BAD_REQUEST"),
        "{settled}"
    );
    assert!(settled["items"][1]["errorDetails"]["detail"].is_string());
    assert_eq!(settled["items"][2]["status"], "succeeded");
    assert!(!settled["items"][2]["assetIds"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_piece_that_found_no_key_says_which_model_and_that_settings_fix_it() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let provider = serve(refusing_the_second_picture()).await;
    harness
        .configure(&provider, &[(PAINTER, Capability::Image)])
        .await;
    // The model is configured and holds nothing: the reader is owed the model
    // that is missing its key, and the news that asking again changes nothing.
    harness
        .state
        .models
        .set_key(PAINTER, None)
        .await
        .expect("the credential is cleared");
    harness.project("Story No Key").await;

    let job = harness
        .start_ok(batch(
            "keyframeArt",
            vec![piece(
                "kf:1",
                keyframe_target("chapter-1", "act-1", "frame-1"),
                "image",
                "第一格",
            )],
        ))
        .await;

    let settled = harness.settled(job["id"].as_str().unwrap()).await;
    assert_eq!(settled["status"], "failed", "{settled}");
    let item = &settled["items"][0];
    assert_eq!(item["status"], "failed", "{settled}");
    assert_eq!(
        item["errorCode"],
        json!("PROVIDER_KEY_MISSING"),
        "{settled}"
    );
    assert_eq!(item["errorDetails"]["model"], json!(PAINTER), "{settled}");
    assert_eq!(item["retryable"], json!(false), "{settled}");
}

#[tokio::test]
async fn a_batch_that_asks_for_too_much_is_refused_before_a_provider_hears_of_it() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let recorded = Recorded::default();
    let provider = serve(answering(recorded.clone(), Arc::new(AtomicBool::new(true)))).await;
    harness
        .configure(&provider, &[(PAINTER, Capability::Image)])
        .await;
    harness.project("Story Limits").await;

    // Nothing in it.
    let (status, body) = harness.start(batch("keyframeArt", Vec::new())).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["details"]["issues"][0]["code"], "STORY_JOB_ITEM_LIMIT");

    // A story that is not there.
    let (status, body) = harness
        .start(json!({
            "storyId": "story-9",
            "kind": "keyframeArt",
            "items": [piece(
                "kf:1",
                keyframe_target("chapter-1", "act-1", "frame-1"),
                "image",
                "一格"
            )],
        }))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["details"]["issues"][0]["code"], "STORY_NOT_FOUND");

    // A piece aimed at a slot of another kind.
    let (status, body) = harness
        .start(batch(
            "actVideo",
            vec![piece(
                "kf:1",
                keyframe_target("chapter-1", "act-1", "frame-1"),
                "image",
                "一格",
            )],
        ))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["details"]["issues"][0]["code"], "STORY_TARGET_INVALID");

    // A reference to a file the project does not have.
    let (status, body) = harness
        .start(batch(
            "keyframeArt",
            vec![json!({
                "id": "kf:1",
                "target": keyframe_target("chapter-1", "act-1", "frame-1"),
                "capability": "image",
                "prompt": "一格",
                "inputs": [{ "role": "reference", "assetId": "asset-missing" }],
            })],
        ))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["details"]["issues"][0]["code"], "ASSET_MISSING");

    // A piece asking for a parameter its capability does not take.
    let (status, body) = harness
        .start(batch(
            "keyframeArt",
            vec![json!({
                "id": "kf:1",
                "target": keyframe_target("chapter-1", "act-1", "frame-1"),
                "capability": "image",
                "prompt": "一格",
                "params": { "seconds": 5 },
            })],
        ))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["details"]["issues"][0]["code"], "VALIDATION_FAILED");

    assert_eq!(recorded.count(), 0, "nothing reached the provider");
    assert!(
        harness.jobs().await.as_array().unwrap().is_empty(),
        "and no record was written"
    );
}

#[tokio::test]
async fn another_batch_for_a_story_already_drawing_is_a_batch_of_its_own() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let finished = Arc::new(AtomicBool::new(false));
    let provider = serve(answering(Recorded::default(), Arc::clone(&finished))).await;
    harness
        .configure(&provider, &[(SHOOTER, Capability::Video)])
        .await;
    harness.project("Story Busy").await;

    // Two shots of one story, asked for while neither has answered: two
    // independent asks, each placed with the provider in its own turn rather
    // than one refused for the other's sake.
    let request = batch(
        "actVideo",
        vec![piece("act", act_video_target("act-1"), "video", "站台")],
    );
    let first = harness.start_ok(request.clone()).await;
    let second = harness
        .start_ok(batch(
            "actVideo",
            vec![piece("act:2", act_video_target("act-2"), "video", "车厢")],
        ))
        .await;
    assert_ne!(first["id"], second["id"]);

    finished.store(true, Ordering::SeqCst);
    harness.settled(first["id"].as_str().unwrap()).await;
    harness.settled(second["id"].as_str().unwrap()).await;

    // Both recorded and both answered, which is what a room draws its two
    // cards from.
    let listed = harness.jobs().await;
    assert_eq!(listed.as_array().unwrap().len(), 2, "{listed}");
    for job in listed.as_array().unwrap() {
        assert_eq!(
            job["items"][0]["status"], "succeeded",
            "no ask was left unanswered: {job}"
        );
    }
}

#[tokio::test]
async fn a_batch_a_previous_process_was_running_is_failed_on_the_next_open() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let provider = serve(answering(
        Recorded::default(),
        Arc::new(AtomicBool::new(true)),
    ))
    .await;
    harness
        .configure(&provider, &[(PAINTER, Capability::Image)])
        .await;
    let project = harness.project("Story Sweep").await;

    // A batch nothing will ever answer: no shot was placed, so no handle is
    // out there and the work stopped with the process.
    leave_record(&project, abandoned_job(None));

    harness.reopen().await;

    let swept = harness.job("job-abandoned").await;
    assert_eq!(swept["status"], "failed");
    assert_eq!(
        swept["error"],
        json!("The app stopped while this job was in progress")
    );
    assert_eq!(swept["items"][0]["status"], "failed");
    assert_eq!(
        swept["items"][0]["retryable"],
        json!(true),
        "the same request is worth asking again"
    );
}

#[tokio::test]
async fn a_batch_whose_pieces_already_answered_is_not_asked_for_them_again() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let recorded = Recorded::default();
    let provider = serve(answering(recorded.clone(), Arc::new(AtomicBool::new(true)))).await;
    harness
        .configure(&provider, &[(SHOOTER, Capability::Video)])
        .await;
    let project = harness.project("Story Resent").await;

    // A batch that answered one piece and was interrupted before the next: the
    // piece that came back is on the record, and asking for it again would pay
    // twice for one act.
    let mut job = abandoned_job(None);
    job["items"] = json!([
        {
            "id": "act-1",
            "target": act_video_target("act-1"),
            "capability": "video",
            "prompt": "站台上的灯一盏一盏亮起来",
            "params": {},
            "status": "succeeded",
            "assetIds": ["asset-already-made"],
        },
        {
            "id": "act-2",
            "target": act_video_target("act-2"),
            "capability": "video",
            "prompt": "列车进站，风把雨吹成斜的",
            "params": {},
            "status": "queued",
            "taskId": TASK,
        },
    ]);
    leave_record(&project, job);
    leave_job_note(&project, TASK);

    harness.reopen().await;

    let mut settled = harness.job("job-abandoned").await;
    for _ in 0..240 {
        settled = harness.job("job-abandoned").await;
        if settled["status"] == json!("succeeded") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(settled["status"], "succeeded", "{settled}");
    assert_eq!(
        settled["items"][0]["assetIds"],
        json!(["asset-already-made"])
    );
    assert!(!settled["items"][1]["assetIds"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(
        recorded.placed().is_empty(),
        "the piece that had answered was not asked for again: {:?}",
        recorded.placed()
    );
    assert_eq!(
        recorded.looks(),
        vec![JOB.to_string()],
        "the piece that had not answered was waited out rather than shot"
    );
}

#[tokio::test]
async fn a_batch_that_has_finished_cannot_be_cancelled() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let provider = serve(answering(
        Recorded::default(),
        Arc::new(AtomicBool::new(true)),
    ))
    .await;
    harness
        .configure(&provider, &[(WRITER, Capability::Text)])
        .await;
    harness.project("Story Late Cancel").await;

    let outline = json!({ "kind": "outline" });
    let job = harness
        .start_ok(batch(
            "outline",
            vec![piece("outline", outline, "text", "拆成两集")],
        ))
        .await;
    let job_id = job["id"].as_str().unwrap().to_string();
    harness.settled(&job_id).await;

    let (status, body) = harness.cancel(&job_id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "STORY_JOB_NOT_CANCELLABLE");
}

#[tokio::test]
async fn a_batch_is_written_down_as_read_once_it_has_settled_and_not_before() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let finished = Arc::new(AtomicBool::new(false));
    let provider = serve(answering(Recorded::default(), Arc::clone(&finished))).await;
    harness
        .configure(&provider, &[(SHOOTER, Capability::Video)])
        .await;
    harness.project("Story Read In").await;

    let job = harness
        .start_ok(batch(
            "actVideo",
            vec![piece("act-1", act_video_target("act-1"), "video", "站台")],
        ))
        .await;
    let job_id = job["id"].as_str().unwrap().to_string();
    harness.until_placed(&job_id).await;

    // A batch still being driven is not written down as read: pieces of it are
    // still to come, and a note saying its answer is in would leave them unread
    // by every room opened after this one.
    let (status, early) = harness.read_in(&job_id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(early["status"], json!("running"));
    assert_eq!(early["readAt"], Value::Null);

    finished.store(true, Ordering::SeqCst);
    let settled = harness.settled(&job_id).await;
    assert_eq!(
        settled["readAt"],
        Value::Null,
        "the room has not said so yet"
    );

    let (status, marked) = harness.read_in(&job_id).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        marked["readAt"].is_string(),
        "the answer is written down as read: {marked}"
    );

    // The note is kept, and saying it twice says the same thing: the moment is
    // the one the answer was first read in at.
    let listed = harness.jobs().await;
    assert!(listed[0]["readAt"].is_string(), "{listed}");
    let (_, again) = harness.read_in(&job_id).await;
    assert_eq!(again["readAt"], marked["readAt"]);
}

#[tokio::test]
async fn a_record_from_before_there_was_a_note_reads_as_one_still_owed_the_room() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let project = harness.project("Story Legacy").await;

    // A record written by a build that knew nothing of the note: it reads as a
    // batch whose answer nobody has read in, which is what it is.
    leave_record(&project, abandoned_job(None));

    let job = harness.job("job-abandoned").await;
    assert_eq!(job["readAt"], Value::Null);
    let listed = harness.jobs().await;
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
}

#[tokio::test]
async fn only_the_records_whose_answers_were_read_in_are_forgotten() {
    let tmp = TempDir::new().unwrap();
    let harness = harness_at(&tmp);
    let project = harness.project("Story Keep").await;

    // A ceiling's worth of settled batches and two more: the oldest two are
    // past what the project keeps, and one of them has never been read in.
    let past = 102;
    for at in 0..past {
        let mut job = abandoned_job(None);
        job["id"] = json!(format!("job-{at:03}"));
        job["status"] = json!("succeeded");
        job["items"][0]["status"] = json!("succeeded");
        job["createdAt"] = json!(format!("2026-01-01T{:02}:{:02}:00.000Z", at / 60, at % 60));
        job["updatedAt"] = job["createdAt"].clone();
        if at > 0 {
            job["readAt"] = json!("2026-02-01T00:00:00.000Z");
        }
        leave_record(&project, job);
    }

    // The list is what prunes, so asking for it is asking for the old records
    // to be looked over.
    harness.jobs().await;

    let kept = harness
        .send_json(
            get_request("/api/v1/projects/current/story/jobs/job-000"),
            StatusCode::OK,
        )
        .await;
    assert_eq!(
        kept["readAt"],
        Value::Null,
        "an answer nobody has read in is not clutter: {kept}"
    );
    harness
        .send_json(
            get_request("/api/v1/projects/current/story/jobs/job-001"),
            StatusCode::NOT_FOUND,
        )
        .await;
}
