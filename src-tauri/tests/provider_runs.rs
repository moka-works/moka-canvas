//! A run that reaches a provider.
//!
//! The gateway, the adapters and the ingest each have tests of their own; what
//! is checked here is the join between them and the run pipeline. That a
//! generation node is scheduled onto the provider executor rather than refused,
//! that the answer it comes back with is filed in the project bearing the run
//! it came from, that an answer from earlier in the same run reaches the node
//! below it, that what the panel showed before a run is what the provider was
//! handed during it, that an ask answered several times over is written back
//! onto the canvas whole, that a cancel arrives at a step already waiting on a
//! provider, that a shot is written down the moment it is placed rather than
//! when it answers, that a run left waiting on one asks after the same job
//! when the project is opened again, that a listener hears a run's words
//! as they arrive and its ending last, that a run asked for past the ceiling on
//! how many drive at once waits with its own record still saying so, that a
//! deployment which says nothing reaches a provider refuses a generation node
//! before the run starts rather than failing inside it, that an answer
//! carrying more than a node can hold is refused whole and filed nowhere,
//! that a generation a provider refuses leaves the node saying what it said
//! before, that an ask answered while the node is already showing something
//! puts the answer beside it rather than over it, and that an upstream answer
//! already on the canvas is read rather than asked for again.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::{Multipart, Path as Route};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, AppConfig, RuntimeMode};
use moka_canvas::domain::commands::make_node;
use moka_canvas::domain::{
    generation_capability_for, new_id, now_iso, Capability, GenerationInputMode, GenerationMode,
    GenerationSpec, NodeKind,
};
use moka_canvas::generate::AsyncTask;
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{Defaults, ModelDraft, Protocol, Scene, SubModel};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::Notify;
use tower::ServiceExt;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// The models every test here configures, each named by its own identifier.
const WRITER: &str = "gpt-scribe-1";
const PAINTER: &str = "painter-1";
const SHOOTER: &str = "shooter-1";

/// The handle a provider's job endpoint issues for a shot. It is the provider's
/// own, and the whole point of keeping it out of a run record is that a client
/// never sees it.
const JOB: &str = "job-at-the-provider";

/// What the writer says, and what the painter says it drew.
const SENTENCE: &str = "A paper lantern drifts over a quiet lake.";
const CAPTION: &str = "a paper lantern, asleep";

/// What a node said before anything was asked of a provider, which is what a
/// generation that fails has to leave it saying.
const KEPT: &str = "A lantern, written down before it was asked for.";

/// What a provider sends for a finished shot. The header of an MP4 and nothing
/// else, because what a filed asset is filed as is read off its bytes rather
/// than trusted from the answer that carried them.
const SHOT: &[u8] = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom";

struct Harness {
    app: Router,
    state: ApiState,
    /// Keeps the tree the store was opened in alive for the whole test.
    tmp: TempDir,
}

/// The converter tree every test in this binary shares, deployed once.
///
/// The converter root is process-wide and is what a scripted protocol is found
/// through, so the tree is deployed into a directory that outlives every test
/// here: the first deploy wins the global root, and one that went away with the
/// test that made it would leave the rest of the binary with no scripts at all.
async fn converters() {
    static ROOT: tokio::sync::OnceCell<TempDir> = tokio::sync::OnceCell::const_new();
    ROOT.get_or_init(|| async {
        let dir = TempDir::new().expect("a temporary converter tree");
        moka_canvas::converter::deploy::ensure_deployed(dir.path())
            .await
            .expect("the built-in converters deploy");
        dir
    })
    .await;
}

/// Opens the app over a temporary directory that already holds a master key.
/// Server mode would create one on the first credential stored, but a
/// generation cannot be placed without a credential to send, so the tier is
/// fixed here rather than left incidental.
fn harness() -> Harness {
    budgeted(|_| {})
}

/// The same app with the budgets changed before anything reads them.
///
/// Changed rather than written to a file: what is under test is how a ceiling
/// behaves once it is in force, and the numbers a deployment ships with have
/// their own test where they are parsed.
fn budgeted(tune: impl FnOnce(&mut AppConfig)) -> Harness {
    let tmp = TempDir::new().expect("a temporary directory");
    let mut config = parse_test_config(tmp.path());
    tune(&mut config);
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
    Harness { app, state, tmp }
}

impl Harness {
    /// Points the app at throwaway models and makes them the defaults, which
    /// is what Settings does before a generation can be placed at all. One
    /// configuration per model, addressed at the endpoint its category speaks
    /// on the throwaway provider; text speaks the responses endpoint, which
    /// is what the providers below serve. Every protocol is served by a
    /// converter script, so the scripts are deployed before the first model is
    /// configured.
    async fn configure(&self, base_url: &str, models: &[(&str, Capability)]) {
        converters().await;
        let mut defaults = Defaults::default();
        for (id, capability) in models {
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
                    id: (*id).into(),
                    category: *capability,
                    protocol,
                    url: format!("{base_url}{suffix}"),
                    model: (*id).into(),
                    display_name: (*id).into(),
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

    /// The same shot model, routing its scenarios through sub-models: the
    /// reference scenario is served under a name and an address of its own.
    async fn configure_routed(&self, base_url: &str) {
        converters().await;
        self.state
            .models
            .upsert(ModelDraft {
                id: SHOOTER.into(),
                category: Capability::Video,
                protocol: Protocol::new("openaiVideos"),
                url: format!("{base_url}/v1/videos"),
                model: "shooter-text".into(),
                display_name: SHOOTER.into(),
                max_video_seconds: None,
                scenes: Vec::new(),
                sub_models: vec![
                    SubModel {
                        model: "shooter-ref".into(),
                        url: Some(format!("{base_url}/v1/video-images")),
                        scenes: vec![Scene::ReferenceToVideo],
                    },
                    SubModel {
                        model: "shooter-text".into(),
                        url: None,
                        scenes: vec![
                            Scene::TextToVideo,
                            Scene::ImageToVideo,
                            Scene::FirstLastFrame,
                        ],
                    },
                ],
                enabled: true,
                expected_revision: None,
            })
            .await
            .expect("the routed model is stored");
        self.state
            .models
            .set_key(SHOOTER, Some(API_KEY))
            .await
            .expect("the credential is stored");
        let defaults = Defaults {
            video: Some(SHOOTER.to_string()),
            ..Defaults::default()
        };
        self.state
            .models
            .set_defaults(&defaults, None)
            .await
            .expect("the default is stored");
    }

    /// Creates the project a run happens in, and returns its canvas and the
    /// directory its files land in.
    async fn project(&self, name: &str) -> (String, String) {
        let created = self
            .send_json(
                json_request(
                    "POST",
                    "/api/v1/projects",
                    json!({
                        "directory": self.tmp.path().join("projects").to_string_lossy(),
                        "name": name,
                    }),
                ),
                StatusCode::CREATED,
            )
            .await;
        let canvas_id = created["moka"]["canvas"][0]["id"]
            .as_str()
            .expect("a canvas is made with the project")
            .to_string();
        let root = created["root"]
            .as_str()
            .expect("a root is reported")
            .to_string();
        (canvas_id, root)
    }

    async fn apply(&self, commands: Value) {
        let revision = self.document().await["moka"]["metadata"]["revision"]
            .as_i64()
            .expect("the document carries a revision");
        self.send_json(
            json_request(
                "POST",
                "/api/v1/projects/current/commands",
                json!({ "expectedRevision": revision, "commands": commands }),
            ),
            StatusCode::OK,
        )
        .await;
    }

    async fn document(&self) -> Value {
        self.send_json(get_request("/api/v1/projects/current"), StatusCode::OK)
            .await
    }

    /// Files an asset in the open project the way a drop on the canvas does, and
    /// answers with the id it was filed under.
    async fn upload(&self, filename: &str, bytes: &[u8]) -> String {
        let filed = self
            .send_json(
                multipart_request("/api/v1/projects/current/assets", filename, bytes),
                StatusCode::CREATED,
            )
            .await;
        filed["entry"]["id"]
            .as_str()
            .expect("an uploaded asset is answered with its id")
            .to_string()
    }

    /// What a node will send, asked of the server before anything is sent: the
    /// very answer the panel renders for whoever is about to press the button.
    async fn preview(&self, canvas_id: &str, node_id: &str) -> Value {
        self.send_json(
            json_request(
                "POST",
                "/api/v1/projects/current/generate/preview",
                json!({ "canvasId": canvas_id, "nodeId": node_id }),
            ),
            StatusCode::OK,
        )
        .await
    }

    /// Starts a run and returns its id, which is all a caller can follow it by.
    async fn start(&self, canvas_id: &str, node_ids: Value) -> String {
        let run = self
            .send_json(
                json_request(
                    "POST",
                    "/api/v1/projects/current/runs",
                    json!({ "canvasId": canvas_id, "nodeIds": node_ids }),
                ),
                StatusCode::CREATED,
            )
            .await;
        assert_eq!(run["status"], "queued");
        run["id"].as_str().expect("a run has an id").to_string()
    }

    async fn run(&self, run_id: &str) -> Value {
        self.send_json(
            get_request(&format!("/api/v1/projects/current/runs/{run_id}")),
            StatusCode::OK,
        )
        .await
    }

    /// Waits a run out. A generation is the slowest thing in the app, but the
    /// provider here is a mock on the loopback, so a run that has not settled in
    /// a few seconds is a run that never will.
    async fn settled(&self, run_id: &str) -> Value {
        for _ in 0..200 {
            let run = self.run(run_id).await;
            let status = run["status"].as_str().expect("a run has a status");
            if status != "queued" && status != "running" {
                return run;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("run {run_id} did not reach a terminal state");
    }

    async fn cancel(&self, run_id: &str) -> Value {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/current/runs/{run_id}/cancel"))
            .body(Body::empty())
            .expect("a request is built");
        let response = self
            .app
            .clone()
            .oneshot(request)
            .await
            .expect("the request is served");
        assert_eq!(response.status(), StatusCode::OK);
        body_json(response).await
    }

    /// Opens the project again, which is what a restart does before anything
    /// else and the moment the runs a previous process left behind are picked up.
    async fn reopen(&self, root: &str) {
        self.send_json(
            json_request("POST", "/api/v1/projects/open", json!({ "path": root })),
            StatusCode::OK,
        )
        .await;
    }

    async fn send_json(&self, request: Request<Body>, expected: StatusCode) -> Value {
        let response = self
            .app
            .clone()
            .oneshot(request)
            .await
            .expect("the request is served");
        let status = response.status();
        let body = body_json(response).await;
        assert_eq!(status, expected, "{body}");
        body
    }
}

fn get_request(uri: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .body(Body::empty())
        .expect("a request is built")
}

fn json_request(method: &str, uri: &str, payload: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .expect("a request is built")
}

/// A file dropped on the canvas, sent the way the editor sends one.
fn multipart_request(uri: &str, filename: &str, bytes: &[u8]) -> Request<Body> {
    let boundary = "X-MOKA-RUN-TEST";
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
        .expect("a request is built")
}

async fn body_json(response: axum::http::Response<Body>) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body is read");
    serde_json::from_slice(&bytes).expect("the body is JSON")
}

/// Joins a run's listeners.
///
/// The answer comes back as soon as the frames start and the body is left
/// unread, so a test can be listening before it lets a provider answer.
async fn follow(harness: &Harness, run_id: &str) -> (StatusCode, HeaderMap, Body) {
    let response = harness
        .app
        .clone()
        .oneshot(get_request(&format!(
            "/api/v1/generate/stream?runId={run_id}"
        )))
        .await
        .expect("the request is served");
    (
        response.status(),
        response.headers().clone(),
        response.into_body(),
    )
}

/// Reads a stream to its end, which is where a listener stops, and says what it
/// heard: the kind of each frame and the body it carried, in order.
async fn said(body: Body) -> Vec<(String, Value)> {
    let bytes = to_bytes(body, usize::MAX)
        .await
        .expect("the stream is read");
    let stream = String::from_utf8(bytes.to_vec()).expect("the frames are text");
    stream
        .split("\n\n")
        .filter_map(|frame| {
            // A comment line keeps a stream alive and says nothing, so it is
            // not a frame and a test that counted one would see a run talking
            // when it was only breathing.
            let mut lines = frame.lines();
            let kind = lines.next()?.strip_prefix("event: ")?.to_string();
            let body = lines.next()?.strip_prefix("data: ")?;
            Some((
                kind,
                serde_json::from_str(body).expect("a frame carries JSON"),
            ))
        })
        .collect()
}

/// Starts a throwaway provider and returns the address a channel would carry.
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

/// What a throwaway provider was asked, in the order it was asked. A test reads
/// this to see the request that reached the far end of the whole pipeline.
#[derive(Clone, Default)]
struct Recorded {
    asks: Arc<Mutex<Vec<Value>>>,
    /// The jobs it was asked about afterwards, by the handle it issued for each.
    /// Kept apart from the asks because a shot is placed once and looked at as
    /// often as it takes, and a test that could not tell the two apart could not
    /// see one placed twice.
    looks: Arc<Mutex<Vec<String>>>,
    /// The references an ask carried, by the name each was sent under and in the
    /// order they were sent.
    ///
    /// Kept apart from the asks because an ask that carries a reference travels
    /// as fields and files rather than as JSON, so there is no body for it to be
    /// read out of afterwards.
    files: Arc<Mutex<Vec<String>>>,
}

impl Recorded {
    fn note(&self, body: &Bytes) {
        self.asks
            .lock()
            .expect("the recorder is not poisoned")
            .push(serde_json::from_slice(body).expect("a generation is sent as JSON"));
    }

    /// Notes an ask that came as fields and files. The words are kept with the
    /// asks, so a test reads the prompt of a call without caring which of the two
    /// endpoints it went to.
    fn noted_edit(&self, prompt: &str, references: Vec<String>) {
        self.asks
            .lock()
            .expect("the recorder is not poisoned")
            .push(json!({ "prompt": prompt }));
        self.files
            .lock()
            .expect("the recorder is not poisoned")
            .extend(references);
    }

    fn files(&self) -> Vec<String> {
        self.files
            .lock()
            .expect("the recorder is not poisoned")
            .clone()
    }

    fn calls(&self) -> usize {
        self.asks
            .lock()
            .expect("the recorder is not poisoned")
            .len()
    }

    fn call(&self, index: usize) -> Value {
        self.asks.lock().expect("the recorder is not poisoned")[index].clone()
    }

    fn look(&self, reference: &str) {
        self.looks
            .lock()
            .expect("the recorder is not poisoned")
            .push(reference.to_string());
    }

    fn looks(&self) -> usize {
        self.looks
            .lock()
            .expect("the recorder is not poisoned")
            .len()
    }

    fn last_look(&self) -> String {
        self.looks
            .lock()
            .expect("the recorder is not poisoned")
            .last()
            .expect("the job was asked about")
            .clone()
    }
}

/// A written answer sent a piece at a time, in the frames the endpoint that
/// streams one uses.
///
/// The totals arrive with the event that closes it, which is why what is stored
/// is the whole answer rather than the pieces it was shown as.
fn pieces(answer: &[&str]) -> Response {
    let mut stream = String::new();
    for piece in answer {
        stream.push_str(&format!(
            "data: {{\"type\":\"response.output_text.delta\",\"delta\":{}}}\n\n",
            json!(piece)
        ));
    }
    stream.push_str(
        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}}\n\n",
    );
    stream.push_str("data: [DONE]\n\n");
    ([(header::CONTENT_TYPE, "text/event-stream")], stream).into_response()
}

/// A provider that answers both capabilities, so one channel can serve a chain,
/// and takes a reference as readily as it paints from nothing.
fn answering(recorded: Recorded) -> Router {
    let writing = recorded.clone();
    let editing = recorded.clone();
    Router::new()
        .route(
            "/v1/responses",
            post(move |body: Bytes| {
                let recorded = writing.clone();
                async move {
                    // Answered in the shape it was asked for: a run being
                    // listened to asks for a stream, and a mock that sent a
                    // document either way could not be talked to by one.
                    let streaming = serde_json::from_slice::<Value>(&body)
                        .map(|asked| asked["stream"] == json!(true))
                        .unwrap_or(false);
                    recorded.note(&body);
                    if streaming {
                        return pieces(&[SENTENCE]);
                    }
                    Json(json!({
                        "output_text": SENTENCE,
                        "usage": { "input_tokens": 4, "output_tokens": 2 },
                    }))
                    .into_response()
                }
            }),
        )
        .route(
            "/v1/images/generations",
            post(move |body: Bytes| {
                let recorded = recorded.clone();
                async move {
                    recorded.note(&body);
                    painted()
                }
            }),
        )
        .route(
            "/v1/images/edits",
            post(move |mut fields: Multipart| {
                let recorded = editing.clone();
                async move {
                    // Every part is read, because a part left unread is a part a
                    // test cannot compare with what the panel showed.
                    let mut prompt = String::new();
                    let mut references = Vec::new();
                    while let Some(field) = fields.next_field().await.expect("a part reads") {
                        let sent_under = field.file_name().map(str::to_string);
                        let is_prompt = field.name() == Some("prompt");
                        if let Some(name) = sent_under {
                            references.push(name);
                        } else if is_prompt {
                            prompt = field.text().await.expect("the words read");
                        } else {
                            let _ = field.bytes().await.expect("the part reads");
                        }
                    }
                    recorded.noted_edit(&prompt, references);
                    painted()
                }
            }),
        )
}

/// A provider that refuses everything, the way one does when a key has been
/// revoked or a model retired: every request is answered, and none of them is
/// answered with anything.
fn refusing(recorded: Recorded) -> Router {
    Router::new().fallback(move |body: Bytes| {
        let recorded = recorded.clone();
        async move {
            recorded.note(&body);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": { "message": "the key no longer works" } })),
            )
                .into_response()
        }
    })
}

/// A provider that holds its answer until the test lets it go, so a cancel can
/// be asked for while a step is still waiting on one.
fn hesitant(recorded: Recorded, gate: Arc<Notify>) -> Router {
    Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| {
            let recorded = recorded.clone();
            let gate = Arc::clone(&gate);
            async move {
                recorded.note(&body);
                gate.notified().await;
                painted()
            }
        }),
    )
}

/// A provider that holds a written answer until the test lets it go, then sends
/// it a piece at a time.
///
/// Held so that a listener can be in place before the first word arrives, which
/// is the only way to tell a stream from a record read after the fact.
fn writing(recorded: Recorded, gate: Arc<Notify>, answer: &[&str]) -> Router {
    let answer: Vec<String> = answer.iter().map(|piece| (*piece).to_string()).collect();
    Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let recorded = recorded.clone();
            let answer = answer.clone();
            let gate = Arc::clone(&gate);
            async move {
                recorded.note(&body);
                gate.notified().await;
                pieces(&answer.iter().map(String::as_str).collect::<Vec<&str>>())
            }
        }),
    )
}

/// A provider that answers one ask with several pictures, each a different size
/// so three answers cannot be mistaken for one answer three times over.
fn painting(recorded: Recorded, sizes: &[(u32, u32)]) -> Router {
    let sizes = sizes.to_vec();
    Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| {
            let recorded = recorded.clone();
            let sizes = sizes.clone();
            async move {
                recorded.note(&body);
                Json(json!({
                    "created": 1_700_000_000u64,
                    "data": sizes
                        .iter()
                        .map(|(width, height)| json!({
                            "b64_json": encoded(&picture(*width, *height)),
                            "revised_prompt": CAPTION,
                        }))
                        .collect::<Vec<Value>>(),
                }))
            }
        }),
    )
}

/// A provider that takes a shot as a job and answers about it afterwards.
///
/// Whether the job has finished is the test's to say, because that is what a
/// restart has to survive: the app is not in the middle of a call when it stops,
/// it is in the middle of a wait between two looks at a job somebody else is
/// running.
fn shooting(recorded: Recorded, finished: Arc<AtomicBool>) -> Router {
    let starting = recorded.clone();
    let asking = recorded.clone();
    Router::new()
        .route(
            "/v1/videos",
            post(move |body: Bytes| {
                let recorded = starting.clone();
                async move {
                    recorded.note(&body);
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
                    recorded.look(&reference);
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

/// A provider whose shots are served at a sub-model's own address: a look
/// records which address answered, so a poll that asked the configuration's
/// address instead is visible rather than a mystery.
fn shooting_routed(recorded: Recorded, finished: Arc<AtomicBool>) -> Router {
    let asking = recorded.clone();
    Router::new()
        .route(
            "/v1/video-images",
            post(move |body: Bytes| {
                let recorded = recorded.clone();
                async move {
                    recorded.note(&body);
                    Json(json!({ "id": JOB, "status": "queued" }))
                }
            }),
        )
        .route(
            "/v1/video-images/{reference}",
            get(move |Route(reference): Route<String>| {
                let recorded = asking.clone();
                let finished = Arc::clone(&finished);
                async move {
                    recorded.look(&format!("sub:{reference}"));
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
            "/v1/video-images/{reference}/content",
            get(|| async { ([(header::CONTENT_TYPE, "video/mp4")], SHOT.to_vec()) }),
        )
}

/// A node in a canvas as the API reports it.
fn node_by_id<'a>(nodes: &'a [Value], id: &str) -> &'a Value {
    nodes
        .iter()
        .find(|node| node["id"] == json!(id))
        .unwrap_or_else(|| panic!("node {id} is on the canvas"))
}

fn revision(document: &Value) -> i64 {
    document["moka"]["metadata"]["revision"]
        .as_i64()
        .expect("the document carries a revision")
}

fn painted() -> Json<Value> {
    Json(json!({
        "created": 1_700_000_000u64,
        "data": [{ "b64_json": encoded(&picture(8, 6)), "revised_prompt": CAPTION }],
    }))
}

fn encoded(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The bytes a provider would send back, small enough to compare whole.
fn picture(width: u32, height: u32) -> Vec<u8> {
    let mut canvas = image::RgbaImage::new(width, height);
    for pixel in canvas.pixels_mut() {
        *pixel = image::Rgba([40, 200, 120, 255]);
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("a picture is written");
    bytes
}

/// The reference a generation spec stores: which channel answers, and which of
/// its models. An empty one means the default the user set for the capability.
/// A node names its model by the configuration's own identifier.
fn reference(model: &str) -> String {
    model.to_string()
}

/// A node that already says something. There is nothing to run for it, which is
/// what makes it upstream of a node that asks: only words for the ask to fold in.
fn saying(id: &str, content: &str) -> Value {
    let mut node = make_node(NodeKind::Text, "Brief".into(), 0.0, 0.0);
    node.id = id.to_string();
    node.data.content = Some(content.to_string());
    serde_json::to_value(&node).expect("a node is sent as it is stored")
}

/// A node that already shows something, filed in the project before any run.
fn holding(id: &str, title: &str, asset_id: &str) -> Value {
    let mut node = make_node(NodeKind::Image, title.into(), 0.0, 0.0);
    node.id = id.to_string();
    node.data.asset_id = Some(asset_id.to_string());
    serde_json::to_value(&node).expect("a node is sent as it is stored")
}

/// A node that asks a provider for something, built the way the editor builds
/// one: the kind decides the capability, so the two can never disagree.
fn asking(
    id: &str,
    kind: NodeKind,
    title: &str,
    model: &str,
    prompt: &str,
    params: Option<Value>,
) -> Value {
    let capability = generation_capability_for(kind).expect("a generation node has a capability");
    let mut node = make_node(kind, title.into(), 0.0, 0.0);
    node.id = id.to_string();
    node.data.generation = Some(GenerationSpec {
        capability,
        mode: GenerationMode::Generate,
        model: model.into(),
        prompt: prompt.into(),
        input_mode: GenerationInputMode::Upstream,
        params,
        reference_node_ids: None,
        updated_at: now_iso(),
    });
    serde_json::to_value(&node).expect("a node is sent as it is stored")
}

fn edge(id: &str, source: (&str, &str), target: (&str, &str)) -> Value {
    json!({
        "id": id,
        "source": { "nodeId": source.0, "portId": source.1 },
        "target": { "nodeId": target.0, "portId": target.1 },
        "createdAt": "2026-01-01T00:00:00Z"
    })
}

fn files_in(root: &str, category: &str) -> usize {
    std::fs::read_dir(Path::new(root).join("assets").join(category))
        .map(|entries| entries.count())
        .unwrap_or(0)
}

/// Where the note of a job a provider is still running is kept.
fn jobs_dir(root: &str) -> PathBuf {
    Path::new(root).join("history").join("jobs")
}

fn job_note(root: &str, task_id: &str) -> PathBuf {
    jobs_dir(root).join(format!("{task_id}.json"))
}

/// Waits until a throwaway provider has been asked, so what follows happens
/// while the step is in the middle of a call rather than before it.
async fn until_asked(recorded: &Recorded) {
    until_calls(recorded, 1).await;
}

/// The same, for a test that has let more than one run reach a provider and
/// needs to know which one it is watching.
async fn until_calls(recorded: &Recorded, calls: usize) {
    for _ in 0..200 {
        if recorded.calls() >= calls {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!(
        "the provider was asked {} of {calls} times",
        recorded.calls()
    );
}

/// Waits until a step has written down the job it is waiting on, and says which
/// one. The shot itself is still running, and is going to stay that way.
async fn until_placed(harness: &Harness, run_id: &str) -> String {
    for _ in 0..200 {
        let run = harness.run(run_id).await;
        if let Some(task) = run["steps"][0]["taskId"].as_str() {
            return task.to_string();
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("run {run_id} never wrote down the job it was waiting on");
}

/// What a process that stopped in the middle of a shot leaves behind: a run
/// still in progress whose step names the job it was waiting on, and the note of
/// that job beside the run history.
///
/// Written rather than caused, because causing it means stopping a process. What
/// matters is what the next one makes of what it finds, and this is exactly what
/// it finds. Returns the run it can be followed by and the job it was waiting on.
async fn left_behind(harness: &Harness, root: &str, canvas_id: &str) -> (String, String) {
    left_behind_with(harness, root, canvas_id, None).await
}

/// The same, with the scenario the job was placed with written on its note:
/// what a poll reads to ask the sub-model that was asked the first time.
async fn left_behind_with(
    harness: &Harness,
    root: &str,
    canvas_id: &str,
    scene: Option<Scene>,
) -> (String, String) {
    let project_id = harness.document().await["moka"]["metadata"]["id"]
        .as_str()
        .expect("the document names its project")
        .to_string();
    let run_id = new_id();
    let task_id = new_id();
    let started = now_iso();
    let run = json!({
        "id": run_id,
        "projectId": project_id,
        "canvasId": canvas_id,
        "requestedNodeIds": ["n-shot"],
        "status": "running",
        "executorKey": "provider",
        // What the graph looked like when the run started. Read again rather
        // than trusted, so it says nothing about whether this can be picked up.
        "graphHash": "as-it-was",
        "parameters": { "n-shot": { "prompt": "a lantern drifting" } },
        "steps": [{
            "nodeId": "n-shot",
            "status": "running",
            "startedAt": started,
            "taskId": task_id,
            "taskCreatedAt": started,
        }],
        "cancelRequested": false,
        "createdAt": started,
        "updatedAt": started,
    });
    let runs = Path::new(root).join("history").join("runs");
    std::fs::create_dir_all(&runs).expect("the run history exists");
    std::fs::write(
        runs.join(format!("{run_id}.json")),
        serde_json::to_vec_pretty(&run).expect("a run is written as it is kept"),
    )
    .expect("the run is left behind");

    // The note is the reason the run above is worth picking up: without it there
    // is no way to ask after the job, and the sweep fails the run instead.
    let note = serde_json::to_value(AsyncTask {
        id: task_id.clone(),
        reference: JOB.to_string(),
        protocol: Protocol::new("openaiVideos"),
        capability: Capability::Video,
        model: reference(SHOOTER),
        scene,
        created_at: started,
        answer: None,
    })
    .expect("a job note is written as it is kept");
    std::fs::create_dir_all(jobs_dir(root)).expect("the job notes have a directory");
    std::fs::write(
        job_note(root, &task_id),
        serde_json::to_vec_pretty(&note).expect("a note is JSON"),
    )
    .expect("the note is left behind");
    (run_id, task_id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_generation_node_is_run_by_the_provider_and_its_answer_is_filed_in_the_project() {
    let harness = harness();
    let recorded = Recorded::default();
    let base_url = serve(answering(recorded.clone())).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;
    let (canvas_id, root) = harness.project("Poster").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "a paper lantern over a quiet lake", Some(json!({ "size": "1024x1024" }))) },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    assert_eq!(harness.run(&run_id).await["executorKey"], "provider");

    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "succeeded");
    let steps = finished["steps"].as_array().expect("a run has steps");
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0]["nodeId"], "n-poster");
    assert_eq!(steps[0]["status"], "succeeded");
    let assets = steps[0]["outputAssetIds"]
        .as_array()
        .expect("the answer was filed");
    assert_eq!(assets.len(), 1);
    // A caption a provider rewrote is worth keeping beside the step, so a reader
    // can compare it with what was asked for; it is not an asset of its own.
    assert_eq!(steps[0]["outputText"], json!(CAPTION));

    // What reached the provider is the spec's own words and parameters, sent
    // under the model the reference named and nothing else.
    assert_eq!(recorded.calls(), 1, "one step, one call");
    let sent = recorded.call(0);
    assert_eq!(sent["model"], json!(PAINTER));
    assert_eq!(sent["prompt"], json!("a paper lantern over a quiet lake"));
    assert_eq!(sent["size"], json!("1024x1024"));

    let images = harness.document().await["moka"]["resources"]["images"].clone();
    let entries = images.as_array().expect("the registry holds the answer");
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry["id"], assets[0], "the step names the asset it made");
    let path = entry["path"].as_str().expect("an asset has a path");
    assert!(path.starts_with("assets/images/"), "{path}");
    assert_eq!(entry["mime"], json!("image/png"));
    let probe = &entry["probe"];
    assert_eq!(probe["width"], json!(8), "read from the bytes, not assumed");
    assert_eq!(probe["height"], json!(6));
    // The bytes are the provider's own, not a copy of them re-encoded on the way
    // in: what a run made has to be what the run was given.
    assert_eq!(
        std::fs::read(Path::new(&root).join(path)).expect("the asset is on disk"),
        picture(8, 6)
    );

    let provenance = &entry["provenance"];
    assert_eq!(provenance["runId"], json!(run_id));
    assert_eq!(provenance["canvasId"], json!(canvas_id));
    assert_eq!(provenance["operationNodeId"], json!("n-poster"));
    assert!(
        provenance["inputAssetIds"].is_null(),
        "nothing travelled with this request"
    );
    let snapshot = &provenance["parameterSnapshot"];
    assert_eq!(snapshot["model"], json!(reference(PAINTER)));
    assert_eq!(snapshot["params"]["size"], json!("1024x1024"));
    // The snapshot is what a node was asked with, so it must never carry the
    // credential the model resolves to.
    assert!(!snapshot.to_string().contains(API_KEY));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_from_earlier_in_the_run_reaches_the_generation_below_it() {
    let harness = harness();
    let recorded = Recorded::default();
    let base_url = serve(answering(recorded.clone())).await;
    harness
        .configure(
            &base_url,
            &[(WRITER, Capability::Text), (PAINTER, Capability::Image)],
        )
        .await;
    let (canvas_id, root) = harness.project("Chain").await;
    harness
        .apply(json!([
            // An empty model is the default the user set for the capability, and
            // a reference is a model named by hand: a chain can mix the two.
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-script", NodeKind::Text, "Script", "", "Write one sentence.", None) },
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "Paint it as a poster.", None) },
            { "type": "addEdge", "canvasId": canvas_id,
              "edge": edge("e-1", ("n-script", "out"), ("n-poster", "prompt")) },
        ]))
        .await;

    // Only the poster was asked for; the script is pulled in because the poster
    // reads from it, and a run that skipped it would ask for a poster with
    // nothing to paint.
    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "succeeded");
    let steps = finished["steps"].as_array().expect("a run has steps");
    assert_eq!(steps.len(), 2, "the upstream node became a step of its own");
    assert_eq!(steps[0]["nodeId"], "n-script");
    assert_eq!(steps[0]["status"], "succeeded");
    assert_eq!(steps[0]["outputText"], json!(SENTENCE));
    assert_eq!(steps[1]["nodeId"], "n-poster");
    assert_eq!(steps[1]["status"], "succeeded");

    assert_eq!(recorded.calls(), 2, "one call per generation step");
    assert_eq!(
        recorded.call(0)["model"],
        json!(WRITER),
        "a node with no model of its own lands on the default for its capability"
    );
    let asked = recorded.call(1);
    assert_eq!(asked["model"], json!(PAINTER));
    let prompt = asked["prompt"]
        .as_str()
        .expect("a picture is asked for in words");
    assert!(prompt.starts_with("Paint it as a poster."), "{prompt}");
    // The document said nothing about the script when the run started: what
    // reaches this step is the answer the step above it made moments ago.
    assert!(prompt.contains(SENTENCE), "{prompt}");
    assert!(
        prompt.contains("[Text 1]"),
        "the block is labelled, so the prompt can point at it: {prompt}"
    );

    // Both answers were filed, each under the category its kind implies.
    let document = harness.document().await;
    let moka = &document["moka"];
    let texts = moka["resources"]["texts"].as_array().expect("a registry");
    assert_eq!(texts.len(), 1);
    let posters = moka["resources"]["images"].as_array().expect("a registry");
    assert_eq!(posters.len(), 1);
    assert_eq!(
        posters[0]["provenance"]["operationNodeId"],
        json!("n-poster"),
        "each asset names the node that asked for it"
    );
    assert!(
        posters[0]["provenance"]["inputAssetIds"].is_null(),
        "words folded into a prompt are not media that travelled"
    );

    // What the node says and what the project filed are one answer arrived at
    // twice: a reader of the canvas and a reader of the asset have to be reading
    // the same words, so neither may be a copy that drifted.
    let nodes = moka["canvas"][0]["nodes"]
        .as_array()
        .expect("a canvas has nodes");
    let script = node_by_id(nodes, "n-script");
    let filed = std::fs::read_to_string(
        Path::new(&root).join(texts[0]["path"].as_str().expect("an asset has a path")),
    )
    .expect("the answer is on disk");
    assert_eq!(script["data"]["content"], json!(filed));
    assert_eq!(script["data"]["content"], json!(SENTENCE));
}

/// A run reads an upstream answer that is already there rather than making a
/// second one.
///
/// The failure this rules out is a run of the node the user picked quietly
/// running the node above it too: a second copy of words nobody asked for was
/// paid for, and it landed beside the upstream node as a card whose origin the
/// user had to work out. An upstream node that already holds an answer is read;
/// one that has nothing yet is still made first, which the chain above covers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upstream_answer_that_is_already_there_is_read_rather_than_asked_again() {
    let harness = harness();
    let recorded = Recorded::default();
    let base_url = serve(answering(recorded.clone())).await;
    harness
        .configure(
            &base_url,
            &[(WRITER, Capability::Text), (PAINTER, Capability::Image)],
        )
        .await;
    let (canvas_id, _root) = harness.project("Kept").await;
    // The script node holds words an ask of its own already made: what the
    // editor leaves behind after a run, and the state the poster reads from.
    let mut script = asking(
        "n-script",
        NodeKind::Text,
        "Script",
        &reference(WRITER),
        "Write one sentence.",
        None,
    );
    script["data"]["content"] = json!(KEPT);
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": script },
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "Paint it as a poster.", None) },
            { "type": "addEdge", "canvasId": canvas_id,
              "edge": edge("e-1", ("n-script", "out"), ("n-poster", "prompt")) },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "succeeded");
    let steps = finished["steps"].as_array().expect("a run has steps");
    assert_eq!(
        steps.len(),
        2,
        "the upstream node is still carried by the run"
    );
    assert_eq!(steps[0]["nodeId"], "n-script");
    assert_eq!(steps[0]["status"], "succeeded");
    assert_eq!(
        steps[0]["outputText"],
        json!(KEPT),
        "what it handed down is what it already said, not a fresh answer"
    );
    assert!(
        steps[0]["outputAssetIds"].is_null(),
        "nothing was generated for it, so nothing was filed for it"
    );

    // One call, and it is the poster's: the answer already on the canvas cost
    // nothing, and what it says is what got painted.
    assert_eq!(
        recorded.calls(),
        1,
        "the node above was read rather than asked again"
    );
    let asked = recorded.call(0);
    assert_eq!(asked["model"], json!(PAINTER));
    let prompt = asked["prompt"]
        .as_str()
        .expect("a picture is asked for in words");
    assert!(prompt.starts_with("Paint it as a poster."), "{prompt}");
    assert!(prompt.contains(KEPT), "{prompt}");

    // Nothing was written beside the script, and nothing was made of it: a card
    // there would be a second copy of what the node already says.
    let document = harness.document().await;
    let nodes = document["moka"]["canvas"][0]["nodes"]
        .as_array()
        .expect("a canvas has nodes");
    assert_eq!(nodes.len(), 2, "no card was made for the node above");
    let edges = document["moka"]["canvas"][0]["edges"]
        .as_array()
        .expect("a canvas has edges");
    assert_eq!(edges.len(), 1, "and no edge was added to one");
    let script = node_by_id(nodes, "n-script");
    assert_eq!(script["data"]["content"], json!(KEPT));
    let poster = node_by_id(nodes, "n-poster");
    let images = document["moka"]["resources"]["images"]
        .as_array()
        .expect("a registry");
    assert_eq!(images.len(), 1, "the poster's own answer was filed");
    assert_eq!(poster["data"]["assetId"], images[0]["id"]);
    let texts = document["moka"]["resources"]["texts"]
        .as_array()
        .expect("a registry");
    assert_eq!(texts.len(), 0, "no text was made, so none was filed");
}

/// What the panel shows is what reaches the provider, read back from the far end.
///
/// Both are answered by the one resolver, so today this cannot disagree with
/// itself; the test is here for the day something resolves a second time. A panel
/// listing two references while the request carries one is the failure nobody can
/// see from either side alone — the panel looks right, the answer looks wrong,
/// and nothing in between says which of the two lied.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_the_panel_shows_is_what_reaches_the_provider() {
    let harness = harness();
    let recorded = Recorded::default();
    let base_url = serve(answering(recorded.clone())).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;
    let (canvas_id, _) = harness.project("Shown").await;
    // Two references rather than one, so that a request that dropped one is a
    // failure here instead of a list that happened to be the same length.
    let lantern = harness.upload("lantern.png", &picture(8, 6)).await;
    let stencil = harness.upload("stencil.png", &picture(6, 8)).await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id,
              "node": saying("n-brief", "A lantern over a quiet lake.") },
            { "type": "addNode", "canvasId": canvas_id,
              "node": holding("n-lantern", "Lantern", &lantern) },
            { "type": "addNode", "canvasId": canvas_id,
              "node": holding("n-stencil", "Stencil", &stencil) },
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "Paint it as a poster.", None) },
            { "type": "addEdge", "canvasId": canvas_id,
              "edge": edge("e-words", ("n-brief", "out"), ("n-poster", "prompt")) },
            { "type": "addEdge", "canvasId": canvas_id,
              "edge": edge("e-lantern", ("n-lantern", "out"), ("n-poster", "images")) },
            { "type": "addEdge", "canvasId": canvas_id,
              "edge": edge("e-stencil", ("n-stencil", "out"), ("n-poster", "images")) },
        ]))
        .await;

    let shown = harness.preview(&canvas_id, "n-poster").await;
    assert_eq!(
        shown["prompt"], "Paint it as a poster.\n\n[Text 1]\nA lantern over a quiet lake.",
        "the words a run sends, not the ones the node holds"
    );
    let listed = shown["inputs"].as_array().expect("references are listed");
    assert_eq!(listed.len(), 2);
    let names: Vec<&str> = listed
        .iter()
        .map(|one| one["name"].as_str().expect("a reference is named"))
        .collect();
    assert_eq!(
        names,
        ["lantern.png", "stencil.png"],
        "in the order the wires were drawn, which is the order they count for"
    );

    // Nothing above the poster asks for anything, so the run is one step and the
    // one call it makes is the call the preview was describing.
    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    assert_eq!(harness.settled(&run_id).await["status"], "succeeded");
    assert_eq!(recorded.calls(), 1, "one step, one call");

    assert_eq!(recorded.call(0)["prompt"], shown["prompt"]);
    assert_eq!(
        recorded.files(),
        names,
        "both references travelled, in the order they were listed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ask_answered_several_times_over_fills_the_node_and_gives_the_rest_a_card_each() {
    let harness = harness();
    let recorded = Recorded::default();
    let base_url = serve(painting(recorded.clone(), &[(8, 6), (9, 6), (10, 6)])).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;
    let (canvas_id, _root) = harness.project("Posters").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "a paper lantern over a quiet lake",
                Some(json!({ "size": "1024x1024", "count": 3 }))) },
        ]))
        .await;
    let before = revision(&harness.document().await);

    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "succeeded");
    assert_eq!(
        recorded.call(0)["n"],
        json!(3),
        "the count reached the provider"
    );

    let answers: Vec<String> = finished["steps"][0]["outputAssetIds"]
        .as_array()
        .expect("the answers were filed")
        .iter()
        .map(|id| id.as_str().expect("an asset has an id").to_string())
        .collect();
    assert_eq!(answers.len(), 3);
    assert_eq!(
        answers.iter().collect::<HashSet<&String>>().len(),
        3,
        "three answers, three assets of their own"
    );

    let document = harness.document().await;
    // Filing an answer moves the document once each, so three of them move it
    // three times. What the canvas is left holding — the node, its two cards and
    // the slots pointing at all three — is one write, so it moves once more.
    assert_eq!(revision(&document), before + 4);

    let nodes = document["moka"]["canvas"][0]["nodes"]
        .as_array()
        .expect("a canvas has nodes");
    assert_eq!(
        nodes.len(),
        3,
        "the node that asked, and a card for each answer past the first"
    );
    let poster = node_by_id(nodes, "n-poster");
    assert_eq!(
        poster["data"]["assetId"],
        json!(answers[0]),
        "the first answer is the node's own"
    );
    let slots = poster["data"]["resultSlots"]
        .as_array()
        .expect("results are recorded");
    assert_eq!(slots.len(), 3);
    for (index, slot) in slots.iter().enumerate() {
        assert_eq!(slot["status"], "succeeded");
        assert_eq!(
            slot["assetId"],
            json!(answers[index]),
            "every answer is still named"
        );
        assert_eq!(slot["isPrimary"], json!(index == 0));
    }
    assert_eq!(
        slots
            .iter()
            .map(|slot| slot["id"].clone())
            .collect::<Vec<Value>>(),
        vec![json!("result"), json!("result-2"), json!("result-3")],
        "an inspector lists them by these, so they cannot all be the same"
    );

    let cards = poster["data"]["resultNodeIds"]
        .as_array()
        .expect("the cards are recorded");
    assert_eq!(cards.len(), 2);
    let mut left = 280.0;
    for (index, card_id) in cards.iter().enumerate() {
        let card = node_by_id(nodes, card_id.as_str().expect("a card has an id"));
        assert_eq!(card["kind"], "image", "a card is the same kind of thing");
        assert_eq!(card["title"], json!(format!("Poster {}", index + 2)));
        assert_eq!(card["data"]["assetId"], json!(answers[index + 1]));
        assert!(
            card["data"].get("generation").is_none(),
            "a card holds an answer, it does not ask for one"
        );
        let card_slots = card["data"]["resultSlots"]
            .as_array()
            .expect("a card records what it holds");
        assert_eq!(card_slots.len(), 1);
        assert_eq!(card_slots[0]["assetId"], json!(answers[index + 1]));
        assert_eq!(card_slots[0]["isPrimary"], json!(true));
        let x = card["bounds"]["x"].as_f64().expect("a card is placed");
        assert!(
            x > left,
            "beside the node that asked, then beside each other: {x}"
        );
        assert_eq!(
            card["bounds"]["y"], poster["bounds"]["y"],
            "on the same line as it"
        );
        left = x + card["bounds"]["width"]
            .as_f64()
            .expect("a card has a width");
    }

    let entries = document["moka"]["resources"]["images"]
        .as_array()
        .expect("a registry");
    assert_eq!(entries.len(), 3);
    let widths: Vec<i64> = entries
        .iter()
        .map(|entry| {
            entry["probe"]["width"]
                .as_i64()
                .expect("a picture was measured")
        })
        .collect();
    assert_eq!(widths, vec![8, 9, 10], "three answers, three sets of bytes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn asking_a_node_that_already_has_an_answer_puts_the_next_one_beside_it() {
    let harness = harness();
    let recorded = Recorded::default();
    // One picture an ask, so the three asks below are three answers of their own
    // rather than one answer three times over.
    let base_url = serve(painting(recorded.clone(), &[(8, 6)])).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;
    let (canvas_id, _root) = harness.project("Compared").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "a paper lantern over a quiet lake",
                Some(json!({ "size": "1024x1024" }))) },
        ]))
        .await;

    // The first ask answers a node holding nothing, so it fills the node in and
    // needs no card to put anything on.
    let first = harness.start(&canvas_id, json!(["n-poster"])).await;
    assert_eq!(harness.settled(&first).await["status"], "succeeded");
    let document = harness.document().await;
    let nodes = document["moka"]["canvas"][0]["nodes"]
        .as_array()
        .expect("a canvas has nodes");
    assert_eq!(
        nodes.len(),
        1,
        "an answer the node had room for made no card"
    );
    let kept = node_by_id(nodes, "n-poster")["data"]["assetId"]
        .as_str()
        .expect("the node holds the answer")
        .to_string();

    // The second ask answers a node that is showing something, which keeps it:
    // the answer goes on a card beside it, and the canvas says where it came from.
    let second = harness.start(&canvas_id, json!(["n-poster"])).await;
    assert_eq!(harness.settled(&second).await["status"], "succeeded");
    let document = harness.document().await;
    let nodes = document["moka"]["canvas"][0]["nodes"]
        .as_array()
        .expect("a canvas has nodes");
    assert_eq!(
        nodes.len(),
        2,
        "the answer went beside the node rather than over it"
    );
    let poster = node_by_id(nodes, "n-poster");
    assert_eq!(
        poster["data"]["assetId"],
        json!(kept),
        "what the node showed is still what it shows"
    );
    let slots = poster["data"]["resultSlots"]
        .as_array()
        .expect("results are recorded");
    assert_eq!(slots.len(), 1);
    assert_eq!(
        slots[0]["isPrimary"],
        json!(false),
        "an answer the node is not showing is not its own"
    );
    let beside = slots[0]["assetId"]
        .as_str()
        .expect("the answer was filed")
        .to_string();
    assert_ne!(
        beside, kept,
        "and it is a second answer, not the first again"
    );

    let cards = poster["data"]["resultNodeIds"]
        .as_array()
        .expect("the card is recorded");
    assert_eq!(cards.len(), 1);
    let card_id = cards[0].as_str().expect("a card has an id");
    let card = node_by_id(nodes, card_id);
    assert_eq!(card["kind"], "image", "a card is the same kind of thing");
    assert_eq!(card["title"], json!("Poster 1"));
    assert_eq!(card["data"]["assetId"], json!(beside));
    assert!(
        card["data"].get("generation").is_none(),
        "a card holds an answer, it does not ask for one"
    );
    assert!(
        card["bounds"]["x"].as_f64().expect("a card is placed")
            > poster["bounds"]["x"].as_f64().expect("a node is placed"),
        "to the right of the node that asked"
    );
    assert_eq!(
        card["bounds"]["y"], poster["bounds"]["y"],
        "on the same line as it"
    );

    let edges = document["moka"]["canvas"][0]["edges"]
        .as_array()
        .expect("a canvas has edges");
    assert_eq!(
        edges.len(),
        1,
        "the card is joined back to what it came from"
    );
    assert_eq!(edges[0]["source"]["nodeId"], json!("n-poster"));
    assert_eq!(edges[0]["source"]["portId"], json!("out"));
    assert_eq!(edges[0]["target"]["nodeId"], json!(card_id));
    assert_eq!(
        edges[0]["target"]["portId"],
        json!("images"),
        "a picture goes in where pictures are read"
    );

    // Asking a third time finds the card the second ask made and writes into it,
    // which is how a canvas is not littered with one card per ask.
    let third = harness.start(&canvas_id, json!(["n-poster"])).await;
    assert_eq!(harness.settled(&third).await["status"], "succeeded");
    let document = harness.document().await;
    let nodes = document["moka"]["canvas"][0]["nodes"]
        .as_array()
        .expect("a canvas has nodes");
    assert_eq!(nodes.len(), 2, "and makes no second card beside it");
    let poster = node_by_id(nodes, "n-poster");
    assert_eq!(
        poster["data"]["assetId"],
        json!(kept),
        "the node is still showing what it was showing"
    );
    let slots = poster["data"]["resultSlots"]
        .as_array()
        .expect("results are recorded");
    assert_ne!(
        slots[0]["assetId"],
        json!(beside),
        "the card was written into with the newest answer"
    );
    assert_eq!(
        poster["data"]["resultNodeIds"]
            .as_array()
            .expect("the card is recorded"),
        cards,
        "and it is the same card"
    );
    assert_eq!(
        document["moka"]["canvas"][0]["edges"]
            .as_array()
            .expect("a canvas has edges")
            .len(),
        1,
        "an edge that is there is not added again"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancel_reaches_a_step_that_is_waiting_on_a_provider() {
    let harness = harness();
    let recorded = Recorded::default();
    let gate = Arc::new(Notify::new());
    let base_url = serve(hesitant(recorded.clone(), Arc::clone(&gate))).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;
    let (canvas_id, root) = harness.project("Cancelled").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "a paper lantern", None) },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    until_asked(&recorded).await;

    let cancelling = harness.cancel(&run_id).await;
    assert_eq!(cancelling["cancelRequested"], true);
    // Let the answer arrive. A cancel is checked around a call rather than
    // dropped into the middle of one, so this is what ends the wait.
    gate.notify_one();

    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "cancelled");
    assert_eq!(finished["cancelRequested"], true);
    assert!(
        finished["error"].is_null(),
        "a run nobody wants any more did not go wrong: {:?}",
        finished["error"]
    );
    let steps = finished["steps"].as_array().expect("a run has steps");
    assert_eq!(steps[0]["status"], "cancelled");
    assert!(
        steps[0]["outputAssetIds"].is_null(),
        "an answer that arrived after the cancel was not kept"
    );

    // Nothing was filed for a run that was called off, so there is no asset in
    // the panel with no node pointing at it.
    let resources = harness.document().await["moka"]["resources"].clone();
    assert!(resources["images"]
        .as_array()
        .expect("a registry")
        .is_empty());
    assert_eq!(files_in(&root, "images"), 0);
    assert_eq!(
        std::fs::read_dir(Path::new(&root).join("tmp"))
            .expect("the temporary directory exists")
            .count(),
        0,
        "the bytes that arrived on the way out were not left behind"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shot_is_written_down_the_moment_it_is_placed_and_not_when_it_answers() {
    let harness = harness();
    let recorded = Recorded::default();
    let finished = Arc::new(AtomicBool::new(false));
    let base_url = serve(shooting(recorded.clone(), Arc::clone(&finished))).await;
    harness
        .configure(&base_url, &[(SHOOTER, Capability::Video)])
        .await;
    let (canvas_id, root) = harness.project("Shot").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-shot", NodeKind::Video, "Shot", &reference(SHOOTER),
                "a lantern drifting over the lake", None) },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-shot"])).await;
    // The shot is still running and is going to stay that way, so what arrives
    // here is a step waiting on a job rather than a step that finished.
    let task_id = until_placed(&harness, &run_id).await;

    let running = harness.run(&run_id).await;
    assert_eq!(running["status"], "running");
    let step = &running["steps"][0];
    assert_eq!(
        step["status"], "running",
        "a job is waited out, not answered"
    );
    assert_eq!(step["taskId"], json!(task_id));
    assert!(
        step["taskCreatedAt"].is_string(),
        "so a reader can say how long it has been running"
    );
    // What the provider issued is credential-adjacent in some protocols, and a
    // run record is served to clients and carried into packages.
    assert!(
        !running.to_string().contains(JOB),
        "the provider's own handle is not this app's to hand out: {running}"
    );

    // The note beside the run history is the only place it is written, and it is
    // what makes the wait above survivable.
    let note: Value = serde_json::from_slice(
        &std::fs::read(job_note(&root, &task_id)).expect("the job was written down"),
    )
    .expect("the note is JSON");
    assert_eq!(note["reference"], json!(JOB));
    assert_eq!(
        note["model"],
        json!(reference(SHOOTER)),
        "so a poll cannot be pointed at a channel that never started the job"
    );
    assert_eq!(recorded.calls(), 1, "one step, one shot");

    // Calling it off stops the waiting here. The work out there has no way back,
    // and saying so is the difference between a cancel and a surprise on a bill.
    harness.cancel(&run_id).await;
    let cancelled = harness.settled(&run_id).await;
    assert_eq!(cancelled["status"], "cancelled");
    let error = cancelled["error"]
        .as_str()
        .expect("a run stopped mid-shot says what it cost");
    assert!(error.contains("billed"), "{error}");
    assert_eq!(cancelled["steps"][0]["status"], "cancelled");
    assert!(
        !job_note(&root, &task_id).exists(),
        "a run that has ended leaves nothing for a job to answer to"
    );
    assert!(
        harness.document().await["moka"]["resources"]["videos"]
            .as_array()
            .expect("a registry")
            .is_empty(),
        "and nothing was filed for it"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_left_waiting_on_a_shot_asks_after_the_same_one_when_the_project_reopens() {
    let harness = harness();
    let recorded = Recorded::default();
    let finished = Arc::new(AtomicBool::new(false));
    let base_url = serve(shooting(recorded.clone(), Arc::clone(&finished))).await;
    harness
        .configure(&base_url, &[(SHOOTER, Capability::Video)])
        .await;
    let (canvas_id, root) = harness.project("Resumed").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-shot", NodeKind::Video, "Shot", &reference(SHOOTER),
                "a lantern drifting over the lake", None) },
        ]))
        .await;
    let (run_id, task_id) = left_behind(&harness, &root, &canvas_id).await;

    // The shot finished while nobody here was watching, which is what makes the
    // difference between picking a run up again and paying for a second shot.
    finished.store(true, Ordering::SeqCst);
    harness.reopen(&root).await;

    let resumed = harness.settled(&run_id).await;
    assert_eq!(resumed["status"], "succeeded");
    assert!(
        resumed["error"].is_null(),
        "a run that was picked up again did not go wrong: {:?}",
        resumed["error"]
    );
    let step = &resumed["steps"][0];
    assert_eq!(step["nodeId"], "n-shot");
    assert_eq!(step["status"], "succeeded");
    assert_eq!(
        step["taskId"],
        json!(task_id),
        "the record still names the job it waited out"
    );

    // The whole point: a second shot would be a second bill for one answer.
    assert_eq!(recorded.calls(), 0, "nothing was placed again");
    assert!(recorded.looks() > 0, "the job was asked after");
    assert_eq!(
        recorded.last_look(),
        JOB,
        "by the handle the provider issued, read back off the note"
    );

    let assets: Vec<String> = step["outputAssetIds"]
        .as_array()
        .expect("the shot was filed")
        .iter()
        .map(|id| id.as_str().expect("an asset has an id").to_string())
        .collect();
    assert_eq!(assets.len(), 1, "one shot, one asset");

    let entries = harness.document().await["moka"]["resources"]["videos"].clone();
    let entries = entries.as_array().expect("the registry holds the shot");
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry["id"], json!(assets[0]));
    assert_eq!(entry["mime"], json!("video/mp4"));
    let path = entry["path"].as_str().expect("an asset has a path");
    assert!(path.starts_with("assets/videos/"), "{path}");
    assert_eq!(
        std::fs::read(Path::new(&root).join(path)).expect("the shot is on disk"),
        SHOT,
        "the bytes the provider sent, not a copy of them"
    );
    assert_eq!(
        entry["provenance"]["runId"],
        json!(run_id),
        "filed under the run that was waiting, not a new one"
    );
    assert_eq!(entry["provenance"]["operationNodeId"], json!("n-shot"));

    // The node holds what the run it was picked up from made.
    let nodes = harness.document().await["moka"]["canvas"][0]["nodes"]
        .as_array()
        .expect("a canvas has nodes")
        .clone();
    assert_eq!(
        node_by_id(&nodes, "n-shot")["data"]["assetId"],
        json!(assets[0])
    );

    assert!(
        !job_note(&root, &task_id).exists(),
        "a job that answered leaves nothing behind to be asked after again"
    );
    assert_eq!(files_in(&root, "videos"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_poll_after_a_restart_asks_the_address_the_scene_was_placed_at() {
    let harness = harness();
    let recorded = Recorded::default();
    let finished = Arc::new(AtomicBool::new(false));
    let base_url = serve(shooting_routed(recorded.clone(), Arc::clone(&finished))).await;
    harness.configure_routed(&base_url).await;
    let (canvas_id, root) = harness.project("Routed").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-shot", NodeKind::Video, "Shot", &reference(SHOOTER),
                "a lantern drifting over the lake", None) },
        ]))
        .await;
    // The job was placed for the reference scenario, which this configuration
    // routes through a sub-model at an address of its own.
    let (run_id, _task_id) =
        left_behind_with(&harness, &root, &canvas_id, Some(Scene::ReferenceToVideo)).await;

    finished.store(true, Ordering::SeqCst);
    harness.reopen(&root).await;

    let resumed = harness.settled(&run_id).await;
    assert_eq!(resumed["status"], "succeeded", "{:?}", resumed["error"]);
    assert_eq!(recorded.calls(), 0, "nothing was placed again");
    assert!(recorded.looks() > 0, "the job was asked after");
    assert_eq!(
        recorded.last_look(),
        format!("sub:{JOB}"),
        "a job placed at a sub-model's address is asked after there, off the note beside the run"
    );
}

// ---------------------------------------------------------------- what a run says

/// A display's reason to listen: the words of an answer as they arrive, before
/// the ending that tells it to stop reading — and the record behind them the
/// same as it would have been unheard.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listener_hears_a_runs_words_before_it_hears_the_ending() {
    let harness = harness();
    let recorded = Recorded::default();
    let gate = Arc::new(Notify::new());
    let base_url = serve(writing(
        recorded.clone(),
        Arc::clone(&gate),
        &["A paper ", "lantern ", "drifts over ", "a quiet lake."],
    ))
    .await;
    harness
        .configure(&base_url, &[(WRITER, Capability::Text)])
        .await;
    let (canvas_id, _root) = harness.project("Notes").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-words", NodeKind::Text, "Notes", &reference(WRITER),
                "say something about a lantern", None) },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-words"])).await;
    // Listening before the answer is let go, so what arrives arrives while the
    // run is going rather than being read off a record afterwards.
    until_asked(&recorded).await;
    let (status, headers, body) = follow(&harness, &run_id).await;
    gate.notify_one();
    let frames = said(body).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");

    let kinds: Vec<&str> = frames.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(
        kinds.first(),
        Some(&"progress"),
        "a step says how far it has got: {kinds:?}"
    );
    assert_eq!(
        kinds.last(),
        Some(&"done"),
        "and the ending is the last thing it says: {kinds:?}"
    );
    // The point of the whole arrangement: the words came before the ending, so
    // a listener that stops reading there has already seen them.
    let first_word = kinds
        .iter()
        .position(|kind| *kind == "delta")
        .unwrap_or_else(|| panic!("words were said: {kinds:?}"));
    assert!(first_word < kinds.len() - 1, "{kinds:?}");

    let said: String = frames
        .iter()
        .filter(|(kind, _)| kind == "delta")
        .map(|(_, body)| {
            body["text"]
                .as_str()
                .expect("a delta carries words")
                .to_string()
        })
        .collect();
    assert_eq!(said, SENTENCE, "nothing was lost on the way");

    // Named for the run, the node and the slot it is going to land in, so a
    // canvas can show the words where they will end up.
    let (_, words) = &frames[first_word];
    assert_eq!(words["runId"], json!(run_id));
    assert_eq!(words["nodeId"], "n-words");
    assert_eq!(words["slotId"], "result");

    let (_, done) = frames.last().expect("the stream ends");
    assert_eq!(done["status"], "succeeded");
    assert!(
        done.get("error").is_none(),
        "a run that went well says nothing"
    );

    // And the record is what it would have been unheard, because a stream only
    // ever hurries a display along.
    let finished = harness.run(&run_id).await;
    assert_eq!(finished["status"], "succeeded");
    assert_eq!(finished["steps"][0]["outputText"], json!(SENTENCE));
    assert_eq!(
        finished["steps"][0]["progress"],
        json!(1.0),
        "how far the step got is written down as well as said"
    );
}

/// A listener that joins after the fact is told where the run ended up rather
/// than left waiting on words that already went by.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_that_is_already_over_says_so_once_and_closes_its_stream() {
    let harness = harness();
    let base_url = serve(answering(Recorded::default())).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;
    let (canvas_id, _root) = harness.project("Poster").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "a paper lantern over a quiet lake", None) },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    assert_eq!(harness.settled(&run_id).await["status"], "succeeded");

    let (status, headers, body) = follow(&harness, &run_id).await;
    let frames = said(body).await;

    assert_eq!(
        status,
        StatusCode::OK,
        "the stream opens for a finished run"
    );
    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(frames.len(), 1, "{frames:?}");
    let (kind, done) = &frames[0];
    assert_eq!(kind, "done");
    assert_eq!(done["runId"], json!(run_id));
    assert_eq!(done["status"], "succeeded");
    assert!(done.get("error").is_none());
}

/// Following a run that is not there is a question the server can answer, not a
/// stream it can open: a listener reads the status before it has read anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_for_a_run_nobody_has_heard_of_is_a_problem_rather_than_a_stream() {
    let harness = harness();
    harness.project("Poster").await;

    let response = harness
        .app
        .clone()
        .oneshot(get_request("/api/v1/generate/stream?runId=no-such-run"))
        .await
        .expect("the request is served");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_ne!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream",
        "nothing was opened to be listened to"
    );
    assert_eq!(body_json(response).await["code"], "RUN_NOT_FOUND");
}

/// Two runs asked for at once, one ceiling, and what the second one looks like
/// from where a client sits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_past_the_ceiling_waits_with_its_own_record_still_saying_queued() {
    let harness = budgeted(|config| config.generate.max_concurrent_runs = 1);
    let recorded = Recorded::default();
    let held_picture = Arc::new(Notify::new());
    let held_words = Arc::new(Notify::new());
    let base_url = serve(
        hesitant(recorded.clone(), Arc::clone(&held_picture)).merge(writing(
            recorded.clone(),
            Arc::clone(&held_words),
            &[SENTENCE],
        )),
    )
    .await;
    harness
        .configure(
            &base_url,
            &[(PAINTER, Capability::Image), (WRITER, Capability::Text)],
        )
        .await;
    let (canvas_id, _root) = harness.project("Queue").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "a paper lantern over a quiet lake", None) },
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-copy", NodeKind::Text, "Copy", &reference(WRITER),
                "one line for the poster", None) },
        ]))
        .await;

    let driving = harness.start(&canvas_id, json!(["n-poster"])).await;
    until_asked(&recorded).await;
    let waiting = harness.start(&canvas_id, json!(["n-copy"])).await;

    // Waiting is something a client reads rather than something it is told:
    // the run past the ceiling has the same record it was given at the start.
    assert_eq!(harness.run(&driving).await["status"], "running");
    assert_eq!(harness.run(&waiting).await["status"], "queued");
    assert_eq!(
        recorded.calls(),
        1,
        "a run that has not reached a provider has not been paid for"
    );

    held_picture.notify_one();
    assert_eq!(harness.settled(&driving).await["status"], "succeeded");

    // Its place in the queue was the permit the first run was holding, and it
    // takes that place up on its own rather than being started again.
    until_calls(&recorded, 2).await;
    assert_eq!(harness.run(&waiting).await["status"], "running");
    held_words.notify_one();
    assert_eq!(harness.settled(&waiting).await["status"], "succeeded");
}

/// Nothing reaches a provider when the deployment says so, and a node that
/// would need one is refused where every other reason a node cannot run is.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_offline_deployment_never_offers_the_executor_that_would_reach_a_provider() {
    let harness = budgeted(|config| config.generate.offline = true);
    let recorded = Recorded::default();
    let base_url = serve(answering(recorded.clone())).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;

    // The list a client is told about and the list a run is checked against are
    // the same list, so they cannot disagree about what is switched off.
    let config = harness
        .send_json(get_request("/api/v1/config"), StatusCode::OK)
        .await;
    assert_eq!(
        config["capabilities"]["executors"],
        json!(["deterministic"]),
        "the one that reaches a provider is not offered"
    );

    let (canvas_id, _root) = harness.project("Offline").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "a paper lantern over a quiet lake", None) },
        ]))
        .await;

    // Refused before a run starts rather than failing inside one: a run that
    // cannot do the thing it was asked for is a question about the canvas, not
    // an outcome to be reported afterwards.
    let refused = harness
        .send_json(
            json_request(
                "POST",
                "/api/v1/projects/current/runs",
                json!({ "canvasId": canvas_id, "nodeIds": ["n-poster"] }),
            ),
            StatusCode::UNPROCESSABLE_ENTITY,
        )
        .await;
    assert_eq!(refused["code"], "RUN_VALIDATION_FAILED");
    let issues = refused["details"]["issues"]
        .as_array()
        .expect("a refusal says what is wrong");
    let codes: Vec<&str> = issues
        .iter()
        .map(|issue| issue["code"].as_str().expect("an issue has a code"))
        .collect();
    assert!(codes.contains(&"EXECUTOR_DISABLED"), "{codes:?}");
    assert_eq!(
        issues[0]["nodeId"],
        json!("n-poster"),
        "the refusal names the node it is about"
    );
    assert_eq!(recorded.calls(), 0, "nothing reached a provider");
    assert!(
        harness
            .send_json(get_request("/api/v1/projects/current/runs"), StatusCode::OK)
            .await
            .as_array()
            .expect("the run history is a list")
            .is_empty(),
        "a run that was refused is not a run that happened"
    );
}

/// An answer with more in it than a node can point at is refused whole rather
/// than trimmed: keeping the first two of three pictures would be a choice
/// about somebody's work that nothing here is entitled to make.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_with_more_pieces_than_a_node_can_hold_is_refused_and_filed_nowhere() {
    let harness = budgeted(|config| config.generate.max_output_items = 2);
    let recorded = Recorded::default();
    let base_url = serve(painting(recorded.clone(), &[(8, 6), (10, 4), (12, 9)])).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;
    let (canvas_id, root) = harness.project("Too many").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "three lanterns over a quiet lake", Some(json!({ "count": 3 }))) },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "failed");
    let steps = finished["steps"].as_array().expect("a run has steps");
    assert_eq!(steps[0]["status"], "failed");
    assert!(
        steps[0]["outputAssetIds"].is_null(),
        "nothing was kept from an answer that could not be"
    );
    // The reason names the ceiling that was passed, because the remedy is
    // either fewer pieces or a bigger budget and a caller has to be able to
    // tell which.
    let reason = steps[0]["error"].as_str().expect("a failure says why");
    assert!(reason.contains("too large to keep"), "{reason}");
    assert!(reason.contains("3 pieces"), "{reason}");

    assert_eq!(
        files_in(&root, "images"),
        0,
        "an answer that was refused left nothing on disk"
    );
    let images = harness.document().await["moka"]["resources"]["images"].clone();
    assert_eq!(
        images.as_array().expect("the registry is a list").len(),
        0,
        "and nothing in the project to point at"
    );
    assert_eq!(
        recorded.calls(),
        1,
        "the ceiling is not a reason to ask twice"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_generation_a_provider_refuses_leaves_the_node_saying_what_it_said_before() {
    let harness = harness();
    let recorded = Recorded::default();
    let base_url = serve(refusing(recorded.clone())).await;
    harness
        .configure(&base_url, &[(WRITER, Capability::Text)])
        .await;
    let (canvas_id, root) = harness.project("Kept").await;
    // The words are on the node from the start rather than written afterwards:
    // a data patch replaces the whole object, so adding them later would cost
    // the node the very spec the run is about to fail on.
    let mut script = asking(
        "n-script",
        NodeKind::Text,
        "Script",
        "",
        "Write one sentence.",
        None,
    );
    script["data"]["content"] = json!(KEPT);
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": script },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-script"])).await;
    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "failed");
    let steps = finished["steps"].as_array().expect("a run has steps");
    assert_eq!(steps[0]["status"], "failed");
    assert!(
        steps[0]["outputAssetIds"].is_null(),
        "a refusal made nothing to keep"
    );

    // A run that comes back empty-handed has no answer to write, and writing
    // nothing over what is already there would leave a user with less than they
    // started with.
    let document = harness.document().await;
    let nodes = document["moka"]["canvas"][0]["nodes"]
        .as_array()
        .expect("a canvas has nodes");
    let kept = node_by_id(nodes, "n-script");
    assert_eq!(kept["data"]["content"], json!(KEPT));
    assert!(
        kept["data"]["assetId"].is_null(),
        "and it points at nothing new"
    );
    assert_eq!(
        document["moka"]["resources"]["texts"]
            .as_array()
            .expect("a registry")
            .len(),
        0,
        "a failure filed nothing"
    );
    assert_eq!(files_in(&root, "texts"), 0, "and wrote nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn running_a_text_node_that_already_says_something_replaces_its_words_and_keeps_them() {
    let harness = harness();
    let recorded = Recorded::default();
    let base_url = serve(answering(recorded.clone())).await;
    harness
        .configure(&base_url, &[(WRITER, Capability::Text)])
        .await;
    let (canvas_id, _root) = harness.project("Replaced").await;
    // The words are on the node from the start: what is under test is a run
    // asked of a node that is already saying something of its own.
    let mut script = asking(
        "n-script",
        NodeKind::Text,
        "Script",
        &reference(WRITER),
        "Write one sentence.",
        None,
    );
    script["data"]["content"] = json!(KEPT);
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": script },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-script"])).await;
    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "succeeded");

    // Words are what a text node is made of, so the answer replaces what the
    // node said rather than being put on a copy of it beside: no card, no edge,
    // and what the node said stays reachable as a result of its own.
    let document = harness.document().await;
    let canvas = &document["moka"]["canvas"][0];
    let nodes = canvas["nodes"].as_array().expect("a canvas has nodes");
    assert_eq!(nodes.len(), 1, "a re-asked text node is not duplicated");
    assert_eq!(
        canvas["edges"]
            .as_array()
            .expect("a canvas has edges")
            .len(),
        0,
        "and nothing is joined back to it"
    );
    let script = node_by_id(nodes, "n-script");
    assert_eq!(script["data"]["content"], json!(SENTENCE));
    let slots = script["data"]["resultSlots"]
        .as_array()
        .expect("results are recorded");
    assert_eq!(slots.len(), 2);
    assert_eq!(slots[0]["text"], json!(KEPT));
    assert_eq!(slots[0]["isPrimary"], json!(false));
    assert_eq!(slots[1]["text"], json!(SENTENCE));
    assert_eq!(slots[1]["isPrimary"], json!(true));
    assert_eq!(
        slots[1]["assetId"], finished["steps"][0]["outputAssetIds"][0],
        "the answer is the one the run filed"
    );

    // The same ask answered the same way is one result asked twice: the second
    // run replaces the words again and the list does not grow.
    let second = harness.start(&canvas_id, json!(["n-script"])).await;
    assert_eq!(harness.settled(&second).await["status"], "succeeded");
    assert_eq!(recorded.calls(), 2, "the provider was asked again");
    let document = harness.document().await;
    let nodes = document["moka"]["canvas"][0]["nodes"]
        .as_array()
        .expect("a canvas has nodes");
    assert_eq!(nodes.len(), 1, "and the node is still the only one");
    let script = node_by_id(nodes, "n-script");
    assert_eq!(script["data"]["content"], json!(SENTENCE));
    let slots = script["data"]["resultSlots"]
        .as_array()
        .expect("results are recorded");
    assert_eq!(
        slots.len(),
        2,
        "the repeated answer replaced its own slot rather than joining the list again"
    );
    assert_eq!(slots[0]["text"], json!(KEPT));
    assert_eq!(slots[1]["isPrimary"], json!(true));
}
