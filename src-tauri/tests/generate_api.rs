//! The generation endpoints over HTTP.
//!
//! The rules behind them — which model a request lands on, what is worth
//! waiting out, how a stream is aggregated — are covered against the gateway
//! itself. What is checked here is the wire: the shape of an answer, the
//! status a failure arrives with, the frames a stream is made of, and the body
//! limit that keeps a prompt from being mistaken for an upload.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{to_bytes, Body, Bytes};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use moka_canvas::domain::Capability;
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{Defaults, ModelDraft, Protocol};
use moka_canvas::project::CreateProject;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

struct Harness {
    app: Router,
    state: ApiState,
    /// Keeps the tree the store was opened in alive for the whole test.
    _tmp: TempDir,
}

/// Opens the app over a temporary directory that already holds a master key.
/// Server mode would create one on the first credential stored, but a
/// generation cannot be placed without a credential to send, so the tier is
/// fixed here rather than left incidental.
async fn harness() -> Harness {
    let tmp = TempDir::new().expect("a temporary directory");
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
    // A request that generates belongs to a project — the inputs it names are
    // read from the open document and the handle it is polled with is noted
    // there — so the harness opens one the way the launcher does.
    let (_store, _opened) = state
        .store
        .create_project(
            &tmp.path().join("project"),
            CreateProject {
                name: "Generations".into(),
                first_canvas_name: None,
            },
        )
        .await
        .expect("the project scaffolds");
    let app = moka_canvas::server::router(state.clone());
    Harness {
        app,
        state,
        _tmp: tmp,
    }
}

/// Points the app at throwaway models and makes them the defaults, which is
/// what Settings does before a generation can be placed at all. One model
/// configuration per entry, addressed at the endpoint its category speaks on
/// the throwaway provider. Every category is served by a converter script, so
/// the scripts are deployed first.
async fn configured(harness: &Harness, base_url: &str, models: &[(&str, Capability)]) {
    deploy_scripts().await;
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
            Capability::Asr => (
                Protocol::from_wire_name("bailianAsr"),
                "/v1/services/audio/asr/transcription",
            ),
        };
        harness
            .state
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
        harness
            .state
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
    harness
        .state
        .models
        .set_defaults(&defaults, None)
        .await
        .expect("the defaults are stored");
}

/// Starts a throwaway provider and returns the address a model URL is built on.
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

/// How many times a throwaway provider was asked, so a test can tell a
/// refusal from a request that never left.
#[derive(Clone, Default)]
struct Watch(Arc<AtomicUsize>);

impl Watch {
    fn note(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }

    fn times(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

/// A generation request for one endpoint.
///
/// The capability in the payload wins over the endpoint's own, so a test can
/// send a body that disagrees with the address it sends it to.
fn generation(capability: &str, payload: Value) -> Request<Body> {
    let mut body = payload.as_object().cloned().unwrap_or_default();
    body.entry("capability")
        .or_insert_with(|| Value::String(capability.into()));
    json_request(
        "POST",
        &format!("/api/v1/generate/{capability}"),
        Value::Object(body),
    )
}

fn json_request(method: &str, uri: &str, payload: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap()
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("the request is served");
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body is read");
    (status, headers, body.to_vec())
}

async fn send_json(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let (status, _, body) = send(app, request).await;
    (
        status,
        serde_json::from_slice(&body).unwrap_or_else(|_| {
            json!({
                "unparsed": String::from_utf8_lossy(&body),
            })
        }),
    )
}

/// A problem body's code, which is what tells a client how to recover.
fn code(body: &Value) -> &str {
    body["code"].as_str().expect("a problem carries a code")
}

fn encoded(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([40, 90, 160]),
    ))
    .write_to(
        &mut std::io::Cursor::new(&mut bytes),
        image::ImageFormat::Png,
    )
    .expect("the format encodes");
    bytes
}

/// An endpoint a test routes only to find out whether it was asked. The answer
/// type is declared so that reaching it can be a bare panic.
async fn not_for_a_shot() -> Response {
    panic!("a picture was asked for, not a shot")
}

/// A written answer, in the pieces the endpoint that produces it sends.
fn events(chunks: &[&str]) -> Response {
    let mut body = String::new();
    for chunk in chunks {
        body.push_str(&format!(
            "data: {{\"type\":\"response.output_text.delta\",\"delta\":{chunk}}}\n\n"
        ));
    }
    // The totals arrive with the event that closes the answer rather than with
    // any of the pieces.
    body.push_str(
        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}}\n\n",
    );
    body.push_str("data: [DONE]\n\n");
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

fn written(answer: &str) -> Response {
    Json(json!({
        "output_text": answer,
        "usage": { "input_tokens": 4, "output_tokens": 2 },
    }))
    .into_response()
}

// -------------------------------------------------------------------- text

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_text_answer_comes_back_as_one_document() {
    let harness = harness().await;
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(|| async { written("a whole answer") }),
    ))
    .await;
    configured(&harness, &base_url, &[("gpt-5.5", Capability::Text)]).await;

    let (status, body) = send_json(
        &harness.app,
        generation("text", json!({ "prompt": "say something" })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "succeeded");
    assert_eq!(body["text"], "a whole answer");
    assert_eq!(body["outputs"], json!([]), "nothing was made to look at");
    assert_eq!(body["usage"]["inputTokens"], 4);
    assert_eq!(body["usage"]["outputTokens"], 2);
    assert!(body.get("task").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_streamed_answer_arrives_in_pieces_and_ends_with_the_whole_thing() {
    let harness = harness().await;
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(|| async { events(&["\"Hel\"", "\"lo\""]) }),
    ))
    .await;
    configured(&harness, &base_url, &[("gpt-5.5", Capability::Text)]).await;

    let (status, headers, body) = send(
        &harness.app,
        generation(
            "text",
            json!({ "prompt": "say something", "params": { "stream": true } }),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");

    let stream = String::from_utf8(body).expect("the frames are text");
    let deltas: Vec<&str> = stream
        .split("event: delta\ndata: ")
        .skip(1)
        .map(|frame| frame.split('\n').next().expect("a frame ends"))
        .collect();
    assert_eq!(deltas.len(), 2, "both pieces reached the caller: {stream}");
    assert_eq!(
        serde_json::from_str::<Value>(deltas[0]).expect("a frame is json")["text"],
        "Hel"
    );

    // The last frame carries the aggregate, because what is stored is the
    // whole answer rather than the pieces it was shown as.
    let done = stream
        .split("event: done\ndata: ")
        .nth(1)
        .expect("the stream ends with a done frame");
    let done: Value =
        serde_json::from_str(done.split("\n\n").next().expect("the frame ends")).expect("json");
    assert_eq!(done["status"], "succeeded");
    assert_eq!(done["text"], "Hello");
    assert_eq!(done["usage"]["outputTokens"], 2);
    assert!(done.get("error").is_none());
}

/// A caller that asked for a stream reads one shape whatever happens, so a
/// request that could not even be placed explains itself in the closing frame
/// rather than as a status the reader has already moved past.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_that_could_not_be_placed_still_ends_with_an_explanation() {
    let harness = harness().await;

    let (status, headers, body) = send(
        &harness.app,
        generation(
            "text",
            json!({ "prompt": "say something", "params": { "stream": true } }),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "the stream opened before it failed");
    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
    let stream = String::from_utf8(body).expect("the frames are text");
    assert!(!stream.contains("event: delta"), "nothing was shown");
    let done = stream
        .split("event: done\ndata: ")
        .nth(1)
        .expect("the stream still ends properly");
    let done: Value =
        serde_json::from_str(done.split("\n\n").next().expect("the frame ends")).expect("json");
    assert_eq!(done["error"]["code"], "PROVIDER_NOT_CONFIGURED");
    assert_eq!(done["error"]["retryable"], false);
}

// ------------------------------------------------------------------- image

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_picture_comes_back_encoded_beside_its_mime_type() {
    let harness = harness().await;
    let picture = encoded(4, 3);
    let answering = picture.clone();
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move || {
            let picture = answering.clone();
            async move {
                Json(json!({
                    "data": [{
                        "b64_json": base64::engine::general_purpose::STANDARD.encode(&picture),
                    }],
                }))
            }
        }),
    ))
    .await;
    configured(
        &harness,
        &base_url,
        &[("an-image-model", Capability::Image)],
    )
    .await;

    let (status, body) = send_json(
        &harness.app,
        generation("image", json!({ "prompt": "a red cube" })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let output = &body["outputs"][0];
    assert_eq!(output["kind"], "image");
    assert_eq!(output["mime"], "image/png");
    assert_eq!(output["width"], 4);
    assert_eq!(output["height"], 3);
    assert_eq!(output["bytes"], picture.len() as u64);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(output["data"].as_str().expect("the bytes are encoded"))
            .expect("the encoding reads back"),
        picture,
        "what came back is what the provider made"
    );
    assert!(body["text"].is_null());
}

/// The address a request was sent to decides what it asks for. A body that
/// names another capability is a client that has mixed up its own state, and
/// honouring it would ask an image model for a shot.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_endpoint_decides_the_capability_rather_than_the_body() {
    let watched = Watch::default();
    let counting = watched.clone();
    let harness = harness().await;
    let picture = encoded(2, 2);
    let answering = picture.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/v1/images/generations",
                post(move || {
                    let counting = counting.clone();
                    let picture = answering.clone();
                    async move {
                        counting.note();
                        Json(json!({
                            "data": [{
                                "b64_json":
                                    base64::engine::general_purpose::STANDARD.encode(&picture),
                            }],
                        }))
                    }
                }),
            )
            .route("/v1/videos", post(not_for_a_shot)),
    )
    .await;
    configured(
        &harness,
        &base_url,
        &[
            ("an-image-model", Capability::Image),
            ("a-video-model", Capability::Video),
        ],
    )
    .await;

    let (status, body) = send_json(
        &harness.app,
        generation(
            "image",
            json!({ "capability": "video", "prompt": "a red cube" }),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["outputs"][0]["kind"], "image");
    assert_eq!(watched.times(), 1, "the image endpoint answered it");
}

// ------------------------------------------------------------------- audio

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn speech_comes_back_as_sound_rather_than_as_text() {
    let harness = harness().await;
    let base_url = serve(Router::new().route(
        "/v1/audio/speech",
        post(|| async {
            (
                [(header::CONTENT_TYPE, "audio/mpeg")],
                b"mp3-bytes".to_vec(),
            )
        }),
    ))
    .await;
    configured(
        &harness,
        &base_url,
        &[("a-voice-model", Capability::Speech)],
    )
    .await;

    // The voice is part of the ask: a speech converter this build deploys is
    // asked for one, and a voiceless ask is refused before it leaves.
    let (status, body) = send_json(
        &harness.app,
        generation(
            "speech",
            json!({ "prompt": "read this aloud", "params": { "voice": "alloy" } }),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["outputs"][0]["kind"], "speech");
    assert_eq!(body["outputs"][0]["mime"], "audio/mpeg");
    assert_eq!(body["outputs"][0]["bytes"], 9);
    assert!(body["text"].is_null(), "the sound is the answer");
}

// ------------------------------------------------------------------- video

/// A job that answers on the third look, so both a wait and an ending are
/// exercised by one test.
async fn video_provider(watched: Watch, outcome: &str) -> String {
    let started = watched.clone();
    let polled = watched.clone();
    let collected = watched.clone();
    let outcome = outcome.to_string();
    serve(
        Router::new()
            .route(
                "/v1/videos",
                post(move |body: Bytes| {
                    let started = started.clone();
                    async move {
                        started.note();
                        assert_eq!(
                            serde_json::from_slice::<Value>(&body).expect("a body")["seconds"],
                            6
                        );
                        Json(json!({ "id": "job-1", "status": "queued" }))
                    }
                }),
            )
            .route(
                "/v1/videos/{id}",
                get(move || {
                    let polled = polled.clone();
                    let outcome = outcome.clone();
                    async move {
                        let first = polled.times() == 1;
                        polled.note();
                        if outcome == "failed" && !first {
                            return Json(json!({
                                "id": "job-1",
                                "status": "failed",
                                "error": { "message": "the shot was refused" },
                            }));
                        }
                        let status = if first { "in_progress" } else { "completed" };
                        Json(json!({ "id": "job-1", "status": status }))
                    }
                }),
            )
            .route(
                "/v1/videos/{id}/content",
                get(move || {
                    let collected = collected.clone();
                    async move {
                        collected.note();
                        ([(header::CONTENT_TYPE, "video/mp4")], b"mp4-bytes".to_vec())
                    }
                }),
            ),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shot_comes_back_as_a_handle_and_is_polled_until_it_ends() {
    let watched = Watch::default();
    let harness = harness().await;
    let base_url = video_provider(watched.clone(), "completed").await;
    configured(&harness, &base_url, &[("a-video-model", Capability::Video)]).await;

    let (status, body) = send_json(
        &harness.app,
        generation(
            "video",
            json!({ "prompt": "a slow pan", "params": { "seconds": 6 } }),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "pending");
    assert_eq!(body["outputs"], json!([]), "nothing has been made yet");
    let task = &body["task"];
    let id = task["id"]
        .as_str()
        .expect("a handle comes back")
        .to_string();
    assert!(!id.is_empty());
    assert_eq!(task["capability"], "video");
    assert_eq!(task["model"], "a-video-model");
    assert!(task["createdAt"].as_str().is_some());
    assert!(
        task.get("retryAfterMs").is_none(),
        "starting a job carries no wait"
    );

    let poll = Request::builder()
        .uri(format!("/api/v1/generate/tasks/{id}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&harness.app, poll).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "pending", "the job is still running");
    assert_eq!(body["task"]["id"], id);

    let poll = Request::builder()
        .uri(format!("/api/v1/generate/tasks/{id}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&harness.app, poll).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "succeeded");
    assert_eq!(body["outputs"][0]["kind"], "video");
    assert_eq!(body["outputs"][0]["mime"], "video/mp4");
    assert!(
        body.get("task").is_none(),
        "a finished job carries no handle"
    );

    // The handle is done with once the job has answered, so a caller that
    // polls it again is told plainly rather than handed the same shot twice.
    let poll = Request::builder()
        .uri(format!("/api/v1/generate/tasks/{id}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&harness.app, poll).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code(&body), "TASK_NOT_FOUND");
    assert_eq!(
        watched.times(),
        4,
        "the job was started, looked at twice, and collected"
    );
}

/// A job that ended badly is reported the way any other provider failure is,
/// because a client reads one shape either way and the code says whether
/// waiting could fix it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_that_failed_is_reported_when_it_is_polled() {
    let watched = Watch::default();
    let harness = harness().await;
    let base_url = video_provider(watched, "failed").await;
    configured(&harness, &base_url, &[("a-video-model", Capability::Video)]).await;

    let (_, body) = send_json(
        &harness.app,
        generation(
            "video",
            json!({ "prompt": "a slow pan", "params": { "seconds": 6 } }),
        ),
    )
    .await;
    let id = body["task"]["id"].as_str().expect("a handle").to_string();

    // The first look is still running; the second is where the job reports.
    let poll = || {
        Request::builder()
            .uri(format!("/api/v1/generate/tasks/{id}"))
            .body(Body::empty())
            .unwrap()
    };
    let (status, _) = send_json(&harness.app, poll()).await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send_json(&harness.app, poll()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "PROVIDER_BAD_REQUEST");
    assert!(
        body["message"]
            .as_str()
            .expect("a message")
            .contains("the shot was refused"),
        "the provider's own explanation survives: {body}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handle_this_server_never_issued_is_missing() {
    let harness = harness().await;
    let request = Request::builder()
        .uri("/api/v1/generate/tasks/not-a-handle")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_json(&harness.app, request).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code(&body), "TASK_NOT_FOUND");
}

// ----------------------------------------------------------------- failures

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_capability_with_no_model_behind_it_is_a_configuration_problem() {
    let harness = harness().await;

    let (status, body) = send_json(
        &harness.app,
        generation("text", json!({ "prompt": "say something" })),
    )
    .await;

    // A 4xx rather than a 5xx: the remedy is in Settings, and waiting will not
    // produce a model.
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(code(&body), "PROVIDER_NOT_CONFIGURED");
    // Which capability has nothing behind it, so a client can open Settings on
    // the tab that would fix it — and nothing to retry, since waiting will not
    // produce a model.
    assert_eq!(body["details"]["capability"], json!("text"));
    assert_eq!(body["details"]["retryable"], json!(null));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_that_carried_nothing_is_reported_rather_than_stored() {
    let harness = harness().await;
    let base_url =
        serve(Router::new().route("/v1/responses", post(|| async { written("   ") }))).await;
    configured(&harness, &base_url, &[("gpt-5.5", Capability::Text)]).await;

    let (status, body) = send_json(
        &harness.app,
        generation("text", json!({ "prompt": "say something" })),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(code(&body), "PROVIDER_NO_OUTPUT");
}

/// A generation names assets already in the project instead of carrying them,
/// so its body gets the ceiling a configuration write gets rather than the one
/// an upload needs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prompt_too_large_for_a_generation_is_refused() {
    let harness = harness().await;
    let oversized = "x".repeat(1024 * 1024 + 1);

    let (status, body) = send_json(
        &harness.app,
        generation("text", json!({ "prompt": oversized })),
    )
    .await;

    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(code(&body), "PAYLOAD_TOO_LARGE");
}

/// Both ways a body can be wrong arrive as a validation problem rather than as
/// something internal, but with the status the extractor gave them: one that
/// stops mid-token could not be read at all, while one that parses and asks for
/// the wrong type was read and cannot be used.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_that_cannot_be_read_is_a_validation_problem() {
    let harness = harness().await;

    let truncated = Request::builder()
        .method("POST")
        .uri("/api/v1/generate/text")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{\"prompt\":"))
        .unwrap();
    let (status, body) = send_json(&harness.app, truncated).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "VALIDATION_FAILED");

    let mistyped = Request::builder()
        .method("POST")
        .uri("/api/v1/generate/text")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            "{\"capability\":\"text\",\"inputs\":\"not-a-list\"}",
        ))
        .unwrap();
    let (status, body) = send_json(&harness.app, mistyped).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(code(&body), "VALIDATION_FAILED");
}

/// A provider that quotes a credential back is the realistic way one could
/// leave this process, so the failure is answered with its message but with the
/// key replaced by the masked form.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_provider_credential_never_appears_in_an_answer() {
    let harness = harness().await;
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(|| async {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": { "message": format!("invalid api key {API_KEY}") },
                })),
            )
        }),
    ))
    .await;
    configured(&harness, &base_url, &[("gpt-5.5", Capability::Text)]).await;

    let (status, body) = send_json(
        &harness.app,
        generation("text", json!({ "prompt": "say something" })),
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code(&body), "PROVIDER_AUTH");
    let reported = serde_json::to_string(&body).expect("the body encodes");
    assert!(
        !reported.contains(API_KEY),
        "the stored credential must not be quoted back: {reported}"
    );
    // The explanation still arrives, so a caller can act on it.
    let message = body["message"].as_str().expect("the body explains itself");
    assert!(
        message.contains("invalid api key"),
        "the provider's own explanation should survive: {message}"
    );
    assert!(
        message.contains("abcd"),
        "the tail of the masked form tells the user which key failed: {message}"
    );
}

// ------------------------------------------------------------- recognition

/// Deploys the built-in converter scripts, which is also what points the
/// process-wide converter root at them. Every category is served by a script,
/// and a script is only found through that root. The root is set once per
/// process, so the directory is leaked to outlive the test and later calls
/// find the deploy already done.
async fn deploy_scripts() {
    if moka_canvas::converter::converter_root().is_some() {
        return;
    }
    let converter = TempDir::new().expect("a converter directory");
    let path: &'static std::path::Path = Box::leak(converter.keep().into_boxed_path());
    moka_canvas::converter::deploy::ensure_deployed(path)
        .await
        .expect("the built-in scripts deploy");
}

/// A recognition request that carries no recording is refused by the script
/// rather than by the route: nothing about the wire knows what a transcription
/// endpoint wants, which is why the category is served by a converter at all.
///
/// What this pins is that the endpoint reaches that script, and that the
/// script's own words come back as the problem rather than as something the
/// transport invented.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recognition_without_a_recording_is_refused_by_its_script() {
    deploy_scripts().await;
    let harness = harness().await;
    // Routed but never reached: the refusal happens before anything is sent,
    // because there is nothing to send.
    let base_url = serve(Router::new().route("/anything", get(|| async { StatusCode::OK }))).await;
    configured(&harness, &base_url, &[("a-asr-model", Capability::Asr)]).await;

    let (status, body) = send_json(
        &harness.app,
        generation("asr", json!({ "params": { "language": "zh" } })),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "PROVIDER_BAD_REQUEST");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("no recording"),
        "{body}"
    );
}

/// A recording is what recognition is asked about, and one the project cannot
/// hand over stops the request here: nothing leaves this process, and nothing
/// is asked of a provider, for audio nobody can read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recognition_naming_a_recording_that_cannot_be_read_never_leaves() {
    deploy_scripts().await;
    let harness = harness().await;
    let watched = Watch::default();
    let seen = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/services/audio/asr/transcription",
        post(move || {
            let seen = seen.clone();
            async move {
                seen.note();
                Json(json!({ "output": { "task_id": "trans-1" } }))
            }
        }),
    ))
    .await;
    configured(&harness, &base_url, &[("a-asr-model", Capability::Asr)]).await;

    let (status, body) = send_json(
        &harness.app,
        generation(
            "asr",
            json!({ "inputs": [{ "role": "controlAudio", "assetId": "asset-that-is-not-here" }] }),
        ),
    )
    .await;

    // The recording is not in the open project, so the request stops where it
    // stands — the same refusal every other route gives for an asset that is
    // not there.
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code(&body), "NOT_FOUND");
    assert_eq!(watched.times(), 0, "the provider was never asked");
}
