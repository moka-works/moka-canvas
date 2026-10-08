//! The gateway against a provider standing on localhost and a project on disk.
//!
//! The rules that need no provider — how parameters merge, which failures are
//! worth waiting out, how long to wait — are unit-tested beside the code. What
//! needs a real socket and a real store is the wiring: that a generation
//! reaches the channel it was resolved to, that a retry really asks again,
//! that a job handle really comes back, and that nothing is sent when the
//! configuration cannot place the call.

use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use moka_canvas::config::{parse_test_config, GenerateConfig, RuntimeMode};
use moka_canvas::domain::Capability;
use moka_canvas::generate::models::ModelRepo;
use moka_canvas::generate::{
    Cancel, DeltaSink, Gateway, GenerateInput, GenerateRequest, InputRole, TaskState,
};
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{
    self, Defaults, ImagePreferences, MetadataStore, ModelDraft, Preferences, Protocol, Scene,
    SubModel,
};
use moka_canvas::project::store::{FsProjectStore, ProjectRegistry};
use moka_canvas::project::{CreateProject, ProjectStore, StagedAsset};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::ReadBuf;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// What reached the throwaway provider, so a test can assert on the requests
/// as well as on the answers.
#[derive(Clone, Default)]
struct Watch {
    asked: Arc<AtomicUsize>,
    bodies: Arc<Mutex<Vec<Value>>>,
}

impl Watch {
    fn note(&self, body: Option<Bytes>) {
        self.asked.fetch_add(1, Ordering::SeqCst);
        let Some(body) = body else { return };
        if let Ok(value) = serde_json::from_slice::<Value>(&body) {
            self.bodies.lock().expect("not poisoned").push(value);
        }
    }

    fn times(&self) -> usize {
        self.asked.load(Ordering::SeqCst)
    }

    fn body(&self, index: usize) -> Value {
        self.bodies.lock().expect("not poisoned")[index].clone()
    }
}

/// Starts a throwaway provider and returns the address a channel would be
/// configured with.
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

/// A gateway over a real project and a real metadata store.
struct Rig {
    gateway: Arc<Gateway>,
    models: Arc<ModelRepo>,
    assets: Arc<FsProjectStore>,
    project: PathBuf,
    /// Keeps the tree both stores were opened in alive for the whole test.
    _tmp: TempDir,
}

impl Rig {
    /// Adds model configurations with stored credentials, the way Settings
    /// would. Each model carries its own full endpoint address, built from the
    /// throwaway provider's base and the endpoint shape its protocol speaks.
    async fn serving(&self, base_url: &str, models: Vec<TestModel>) {
        for entry in models {
            let protocol = entry
                .protocol
                .unwrap_or_else(|| default_protocol(entry.capability));
            let id = entry.id.clone();
            self.models
                .upsert(ModelDraft {
                    id: id.clone(),
                    category: entry.capability,
                    protocol: protocol.clone(),
                    url: endpoint_of(base_url, protocol, &id),
                    model: id.clone(),
                    display_name: id.clone(),
                    max_video_seconds: None,
                    scenes: Vec::new(),
                    sub_models: Vec::new(),
                    enabled: true,
                    expected_revision: None,
                })
                .await
                .expect("the model is stored");
            self.models
                .set_key(&id, Some(API_KEY))
                .await
                .expect("the credential is stored");
        }
    }

    /// Makes one model the answer for a capability, the way Settings would.
    async fn default(&self, capability: Capability, reference: &str) {
        let mut defaults = Defaults::default();
        match capability {
            Capability::Text => defaults.text = Some(reference.into()),
            Capability::Image => defaults.image = Some(reference.into()),
            Capability::Speech => defaults.speech = Some(reference.into()),
            Capability::Music => defaults.music = Some(reference.into()),
            Capability::Video => defaults.video = Some(reference.into()),
            Capability::Asr => defaults.asr = Some(reference.into()),
        }
        self.models
            .set_defaults(&defaults, None)
            .await
            .expect("the default resolves");
    }

    async fn prefer(&self, preferences: Preferences) {
        self.models
            .set_preferences(&preferences, None)
            .await
            .expect("the preferences are stored");
    }

    /// Stores bytes the way an upload would and returns the asset's identifier.
    async fn upload(&self, name: &str, mime: &str, bytes: &[u8]) -> String {
        let staging = self.project.join("tmp").join(format!("staged-{name}"));
        std::fs::write(&staging, bytes).expect("the staging directory exists");
        self.assets
            .add_asset(StagedAsset {
                name: name.into(),
                tmp_path: staging,
                declared_mime: Some(mime.into()),
                category_hint: None,
                provenance: None,
            })
            .await
            .expect("the asset is accepted")
            .entry
            .id
    }
}

async fn rig() -> Rig {
    rig_under_text_budget(GenerateConfig::default().text_timeout_seconds).await
}

/// The same rig under a text budget of its own: what that budget measures for a
/// streamed answer is silence, and a test watching one cannot wait two minutes
/// for a silence to be long enough.
async fn rig_under_text_budget(text_timeout_seconds: u64) -> Rig {
    deploy_scripts().await;
    let tmp = TempDir::new().expect("a temporary directory");
    let mut config = parse_test_config(tmp.path());
    // A test waits out its own retries, so a backoff that started at a second
    // would make a single one take three.
    config.generate = GenerateConfig {
        retry_base_ms: 1,
        text_timeout_seconds,
        ..GenerateConfig::default()
    };
    let budgets = config.generate.clone();
    let metadata_config = config.metadata.clone();
    let config = Arc::new(config);

    let root = metadata_config
        .dir
        .clone()
        .expect("the test configuration names a directory");
    std::fs::create_dir_all(&root).expect("the metadata directory is created");
    // Server mode reads the master key from a file rather than a keychain, and
    // the environment is shared across test threads so it is not used.
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(root.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let metadata = metadata::open(&root, &metadata_config, RuntimeMode::Web)
        .map(|store| store as Arc<dyn MetadataStore>)
        .expect("the store opens");

    let models = Arc::new(ModelRepo::new(metadata));
    let registry = ProjectRegistry::new(Arc::clone(&config));
    let project = tmp.path().join("demo-project");
    let (assets, _opened) = registry
        .create_project(
            &project,
            CreateProject {
                name: "Demo".into(),
                first_canvas_name: None,
            },
        )
        .await
        .expect("the project scaffolds");

    let gateway = Arc::new(Gateway::new(
        Arc::clone(&models),
        budgets,
        // No cutter: a request that names a window is refused here, and a test
        // that transcribes places its own.
        None,
    ));
    Rig {
        gateway,
        models,
        assets,
        project,
        _tmp: tmp,
    }
}

/// One model a test configures. The protocol is optional: a category has a
/// default shape, and a test that serves a different endpoint names it.
struct TestModel {
    id: String,
    capability: Capability,
    protocol: Option<Protocol>,
}

fn model(id: &str, capability: Capability) -> TestModel {
    TestModel {
        id: id.into(),
        capability,
        protocol: None,
    }
}

fn model_via(id: &str, capability: Capability, protocol: Protocol) -> TestModel {
    TestModel {
        id: id.into(),
        capability,
        protocol: Some(protocol),
    }
}

fn default_protocol(capability: Capability) -> Protocol {
    match capability {
        Capability::Text => Protocol::new("openaiChat"),
        Capability::Image => Protocol::new("openaiImages"),
        Capability::Speech => Protocol::new("openaiSpeech"),
        Capability::Music => Protocol::new("bailianMusic"),
        Capability::Video => Protocol::new("openaiVideos"),
        // A test that wants a recognition model places a converter script of
        // its own; this is only what such a call stands in as here.
        Capability::Asr => Protocol::new("bailianAsr"),
    }
}

/// The complete endpoint address a protocol speaks at, on a throwaway
/// provider's base address.
fn endpoint_of(base_url: &str, protocol: Protocol, model_id: &str) -> String {
    match protocol.wire_name() {
        "openaiChat" => format!("{base_url}/v1/chat/completions"),
        "openaiResponses" => format!("{base_url}/v1/responses"),
        "openaiImages" => format!("{base_url}/v1/images/generations"),
        "openaiSpeech" => format!("{base_url}/v1/audio/speech"),
        "openaiVideos" => format!("{base_url}/v1/videos"),
        "gemini" => format!("{base_url}/v1beta/models/{model_id}:generateContent"),
        "geminiVideo" => format!("{base_url}/v1beta/models/{model_id}:predictLongRunning"),
        // Every converter script's address is the model's own, so the arm for
        // scripts needs no knowledge of any particular platform.
        _ => format!("{base_url}/v1/lua/{model_id}"),
    }
}

fn request(capability: Capability, prompt: &str, params: Value) -> GenerateRequest {
    GenerateRequest {
        capability,
        prompt: prompt.into(),
        params: params.as_object().cloned().unwrap_or_default(),
        ..GenerateRequest::default()
    }
}

/// A text answer as the newer of the two endpoints this protocol has sends it.
fn answer(text: &str) -> Json<Value> {
    Json(json!({
        "output_text": text,
        "usage": { "input_tokens": 4, "output_tokens": 2 },
    }))
}

fn events(chunks: &[&str]) -> Response {
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        events_body(chunks),
    )
        .into_response()
}

/// The same events as a bare body, for a test that sends them on a schedule of
/// its own rather than all at once.
fn events_body(chunks: &[&str]) -> String {
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
    body
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

// ------------------------------------------------------------------ placing

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_generation_goes_to_the_default_model_when_the_request_names_none() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                answer("A lantern, lit.")
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::new("openaiResponses"),
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let result = rig
        .gateway
        .text(
            &rig.assets,
            // No model of its own, which is what a node with nothing picked
            // looks like.
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives");

    assert_eq!(result.text.as_deref(), Some("A lantern, lit."));
    assert_eq!(watched.times(), 1);
    assert_eq!(watched.body(0)["model"], "gpt-5.5");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parameter_the_caller_set_reaches_the_provider_over_the_global_one() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                Json(json!({ "data": [] }))
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("gpt-image-2", Capability::Image)])
        .await;
    rig.default(Capability::Image, "gpt-image-2").await;
    rig.prefer(Preferences {
        image: ImagePreferences {
            size: "1024x1024".into(),
            quality: "high".into(),
            ..ImagePreferences::default()
        },
        ..Preferences::default()
    })
    .await;

    // Both calls fail on the empty answer below; what matters is what reached
    // the provider on the way.
    let _ = rig
        .gateway
        .image(
            &rig.assets,
            request(Capability::Image, "a cat", json!({ "size": "512x512" })),
            &Cancel::new(),
        )
        .await;
    let _ = rig
        .gateway
        .image(
            &rig.assets,
            request(Capability::Image, "a cat", json!({})),
            &Cancel::new(),
        )
        .await;

    assert_eq!(watched.times(), 2);
    assert_eq!(
        watched.body(0)["size"],
        "512x512",
        "what the caller said wins over what the user set globally"
    );
    assert_eq!(
        watched.body(1)["size"],
        "1024x1024",
        "and the global one fills the gap it left"
    );
    assert_eq!(watched.body(1)["quality"], "high");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_capability_is_asked_at_the_address_that_serves_it() {
    let text_watched = Watch::default();
    let text_answering = text_watched.clone();
    let text_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = text_answering.clone();
            async move {
                watched.note(Some(body));
                answer("A lantern, lit.")
            }
        }),
    ))
    .await;

    let image_watched = Watch::default();
    let image_answering = image_watched.clone();
    let image_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| {
            let watched = image_answering.clone();
            async move {
                watched.note(Some(body));
                Json(json!({ "data": [{ "b64_json": base64(&encoded(3, 2)) }] }))
            }
        }),
    ))
    .await;

    // One configuration per model, each addressed at the endpoint that
    // serves its own category: there is no shared channel address any more.
    let rig = rig().await;
    rig.serving(
        &text_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::new("openaiResponses"),
        )],
    )
    .await;
    rig.serving(&image_url, vec![model("gpt-image-2", Capability::Image)])
        .await;

    let mut generation = request(Capability::Image, "a cat", json!({}));
    generation.model = "gpt-image-2".into();
    let picture = rig
        .gateway
        .image(&rig.assets, generation, &Cancel::new())
        .await
        .expect("the image request is placed where images live");

    assert_eq!(picture.items.len(), 1);
    assert_eq!(
        image_watched.times(),
        1,
        "the image model was asked at the address it was configured with"
    );
    assert_eq!(
        text_watched.times(),
        0,
        "the text model's address never saw the image call"
    );

    let mut generation = request(Capability::Text, "describe a lantern", json!({}));
    generation.model = "gpt-5.5".into();
    let words = rig
        .gateway
        .text(
            &rig.assets,
            generation,
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect("the text request stays on its own address");

    assert_eq!(words.text.as_deref(), Some("A lantern, lit."));
    assert_eq!(text_watched.times(), 1);
    assert_eq!(
        image_watched.times(),
        1,
        "and the text model did not reach for the image address"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reference_is_read_out_of_the_project_and_sent_along() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(
        Router::new()
            .route("/v1/images/generations", post(not_for_an_edit))
            .route(
                "/v1/images/edits",
                post(move |multipart: axum::extract::Multipart| {
                    let watched = answering.clone();
                    async move {
                        watched.note(None);
                        let mut multipart = multipart;
                        while let Some(field) = multipart.next_field().await.expect("a field reads")
                        {
                            let _ = field.bytes().await.expect("the field is read");
                        }
                        Json(json!({ "data": [{ "b64_json": base64(&encoded(3, 2)) }] }))
                    }
                }),
            ),
    )
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("gpt-image-2", Capability::Image)])
        .await;
    rig.default(Capability::Image, "gpt-image-2").await;
    let asset = rig.upload("cat.png", "image/png", &encoded(4, 3)).await;

    let mut generation = request(Capability::Image, "a cat, older", json!({}));
    generation.inputs = vec![GenerateInput {
        role: InputRole::Reference,
        asset_id: asset,
        window: None,
    }];
    let result = rig
        .gateway
        .image(&rig.assets, generation, &Cancel::new())
        .await
        .expect("the edit arrives");

    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].mime, "image/png");
    assert_eq!(
        (result.items[0].width, result.items[0].height),
        (Some(3), Some(2))
    );
    assert_eq!(watched.times(), 1, "the reference made this an edit");
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// An endpoint a test routes only to find out whether it was asked. The answer
/// type is declared so that reaching it can be a bare panic.
async fn not_for_an_edit() -> Response {
    panic!("a reference must turn this into an edit")
}

// ------------------------------------------------------------------ failing

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_channel_that_asked_to_be_waited_for_is_asked_again_after_that_wait() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                let asked_first = watched.times() == 0;
                watched.note(Some(body));
                if asked_first {
                    return (
                        StatusCode::TOO_MANY_REQUESTS,
                        // One second, against a backoff configured to start at
                        // one millisecond: only a wait taken from this header
                        // makes the elapsed assertion below meaningful.
                        [(header::RETRY_AFTER, "1")],
                        Json(json!({ "error": { "message": "slow down" } })),
                    )
                        .into_response();
                }
                answer("A lantern, lit.").into_response()
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::new("openaiResponses"),
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let started = Instant::now();
    let result = rig
        .gateway
        .text(
            &rig.assets,
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect("the second attempt answers");

    assert_eq!(result.text.as_deref(), Some("A lantern, lit."));
    assert_eq!(watched.times(), 2, "a busy channel is worth asking again");
    assert!(
        started.elapsed() >= Duration::from_secs(1),
        "and the wait it asked for is the one that was kept"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_credential_the_provider_rejected_is_reported_once() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": { "message": "incorrect API key" } })),
                )
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::new("openaiResponses"),
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let error = rig
        .gateway
        .text(
            &rig.assets,
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect_err("the key is wrong");

    assert_eq!(error.code(), "PROVIDER_AUTH");
    // Wrong is not late: asking again with the same key only repeats it, and
    // each repeat is another line in somebody's usage bill.
    assert_eq!(watched.times(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_that_carried_nothing_is_reported_rather_than_stored() {
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(|| async { Json(json!({ "data": [] })) }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("gpt-image-2", Capability::Image)])
        .await;
    rig.default(Capability::Image, "gpt-image-2").await;

    let error = rig
        .gateway
        .image(
            &rig.assets,
            request(Capability::Image, "a cat", json!({})),
            &Cancel::new(),
        )
        .await
        .expect_err("there is nothing to store");

    assert_eq!(error.code(), "PROVIDER_NO_OUTPUT");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_that_generates_something_else_is_refused_before_anything_is_sent() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                Json(json!({ "data": [] }))
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("gpt-image-2", Capability::Image)])
        .await;

    // The endpoint says text, and the only model named is one that makes
    // pictures: answering would produce an asset no text node can hold.
    let mut generation = request(Capability::Text, "describe a lantern", json!({}));
    generation.model = "gpt-image-2".into();
    let error = rig
        .gateway
        .text(
            &rig.assets,
            generation,
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect_err("the capability does not match");

    assert_eq!(error.code(), "MODEL_CAPABILITY_MISMATCH");
    assert_eq!(watched.times(), 0, "nothing was sent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_with_no_stored_key_is_reported_before_anything_is_sent() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                answer("A lantern, lit.")
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.models
        .upsert(ModelDraft {
            id: "gpt-5.5".into(),
            category: Capability::Text,
            protocol: Protocol::new("openaiResponses"),
            url: format!("{base_url}/v1/responses"),
            model: "gpt-5.5".into(),
            display_name: "GPT-5.5".into(),
            max_video_seconds: None,
            scenes: Vec::new(),
            sub_models: Vec::new(),
            enabled: true,
            expected_revision: None,
        })
        .await
        .expect("the model is stored");
    rig.default(Capability::Text, "gpt-5.5").await;

    let error = rig
        .gateway
        .text(
            &rig.assets,
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect_err("there is no credential to send");

    // The model is configured and holds no key: a client says that in the
    // reader's own language, and names which model from these details.
    assert_eq!(error.code(), "PROVIDER_KEY_MISSING");
    let details = error.details().expect("which model, behind the message");
    assert_eq!(details["model"], json!("gpt-5.5"));
    assert_eq!(watched.times(), 0, "nothing was sent without a key");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_speech_model_that_needs_a_voice_is_refused_without_one() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/audio/speech",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                (
                    [(header::CONTENT_TYPE, "audio/mpeg")],
                    b"mp3-bytes".to_vec(),
                )
            }
        }),
    ))
    .await;

    let rig = rig().await;
    // The default speech protocol of this file is the OpenAI-shaped one, whose
    // converter declares that its asks need a voice.
    rig.serving(&base_url, vec![model("a-voice-model", Capability::Speech)])
        .await;
    rig.default(Capability::Speech, "a-voice-model").await;

    let error = rig
        .gateway
        .speech(
            &rig.assets,
            request(Capability::Speech, "read this aloud", json!({})),
            &Cancel::new(),
        )
        .await
        .expect_err("the converter is asked for a voice and none was sent");
    assert_eq!(error.code(), "MODEL_VOICE_REQUIRED");
    let details = error.details().expect("which model, behind the message");
    assert_eq!(details["model"], json!("a-voice-model"));
    assert_eq!(watched.times(), 0, "nothing was sent to the provider");

    // The same ask with a voice goes through, which is what the refusal is
    // sparing: an engine error that names neither the setting nor its home.
    let answer = rig
        .gateway
        .speech(
            &rig.assets,
            request(
                Capability::Speech,
                "read this aloud",
                json!({ "voice": "alloy" }),
            ),
            &Cancel::new(),
        )
        .await
        .expect("a voiced ask is placed");
    assert_eq!(answer.items[0].bytes, b"mp3-bytes");
    assert_eq!(watched.times(), 1, "the voiced ask reached the provider");
}

/// A converter script for a speech model that copies its voice from a
/// recording: the reference's filename stands in for the name a plain voice
/// would have travelled as, so a test can say which piece of sound was asked
/// for. The answer is read back the way the OpenAI-shaped converter reads it,
/// since it is the same kind of answer.
const CLONE_SPEECH: &str = r#"
local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function reference_filename(inputs)
  for _, input in ipairs(inputs or {}) do
    if input.role == "reference" then
      return input.filename
    end
  end
  return nil
end

function build_request(call, req, inputs)
  local body = {model = call.model, input = req.prompt or ""}
  local recorded = reference_filename(inputs)
  if recorded then
    body.voice = "ref:" .. recorded
  elseif type(req.params.voice) == "string" and trimmed(req.params.voice) ~= "" then
    body.voice = req.params.voice
  end
  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

function parse_response(status, headers, body)
  local announced = headers["content-type"]
  local claimed = nil
  if type(announced) == "string" then
    claimed = trimmed(announced:match("^[^;]+") or announced)
    if claimed == "" then
      claimed = nil
    end
  end
  return {items = {{raw = true, mime = claimed}}}
end
"#;

/// A converter that declares `needsReferenceAudio` is asked for a recording
/// and none was sent: refused before a credential is fetched or a provider is
/// bothered, and a name — even one the machine prefers — does not stand in
/// for it. With the recording attached the ask travels, and what reaches the
/// converter is the recording's own name.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_speech_model_that_copies_a_recording_is_refused_without_one() {
    deploy_scripts().await;
    place_script(
        "speech",
        "cloneSpeech",
        CLONE_SPEECH,
        Some(json!({ "needsReferenceAudio": true })),
    )
    .await;

    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/lua/cloner",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                ([(header::CONTENT_TYPE, "audio/wav")], recorded())
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "cloner",
            Capability::Speech,
            Protocol::from_wire_name("cloneSpeech"),
        )],
    )
    .await;
    rig.default(Capability::Speech, "cloner").await;

    let error = rig
        .gateway
        .speech(
            &rig.assets,
            request(Capability::Speech, "read this aloud", json!({})),
            &Cancel::new(),
        )
        .await
        .expect_err("the converter copies a voice and no recording was sent");
    assert_eq!(error.code(), "MODEL_REFERENCE_AUDIO_REQUIRED");
    let details = error.details().expect("which model, behind the message");
    assert_eq!(details["model"], json!("cloner"));
    assert_eq!(watched.times(), 0, "nothing was sent to the provider");

    // A voice the machine prefers is still just a name, and a name is not the
    // recording this converter reads: the refusal stands.
    let error = rig
        .gateway
        .speech(
            &rig.assets,
            request(
                Capability::Speech,
                "read this aloud",
                json!({ "voice": "alloy" }),
            ),
            &Cancel::new(),
        )
        .await
        .expect_err("a name does not stand in for the recording");
    assert_eq!(error.code(), "MODEL_REFERENCE_AUDIO_REQUIRED");
    assert_eq!(watched.times(), 0, "the named ask did not travel either");

    // The recording that was missing, attached as the reference it is: the
    // ask travels, and the converter reads the recording's own name off it —
    // which is the piece of evidence the whole path exists to carry.
    let asset_id = rig.upload("voice.wav", "audio/wav", &recorded()).await;
    let mut with_recording = request(Capability::Speech, "read this aloud", json!({}));
    with_recording.inputs = vec![GenerateInput {
        role: InputRole::Reference,
        asset_id,
        window: None,
    }];
    let answer = rig
        .gateway
        .speech(&rig.assets, with_recording, &Cancel::new())
        .await
        .expect("a recorded ask is placed");
    assert!(!answer.items.is_empty(), "the recording came back");
    assert_eq!(watched.times(), 1, "the recorded ask reached the provider");
    assert_eq!(watched.body(0)["voice"], json!("ref:voice.wav"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_generation_never_reaches_the_provider() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                answer("A lantern, lit.")
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::new("openaiResponses"),
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let cancel = Cancel::new();
    cancel.cancel();
    let error = rig
        .gateway
        .text(
            &rig.assets,
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &cancel,
        )
        .await
        .expect_err("the caller already left");

    assert_eq!(error.code(), "GENERATION_CANCELLED");
    assert_eq!(watched.times(), 0);
}

// ---------------------------------------------------------------- streaming

/// A body that says what it has to say in pieces, waiting between them: what a
/// gateway's answer looks like when the model behind it is thinking as it goes.
struct Dribble {
    pieces: Vec<Vec<u8>>,
    gap: Duration,
    stall: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

impl Dribble {
    /// The body's own events, waiting between one and the next: each piece is
    /// what a provider would push over the wire at once.
    fn new(body: String, gap: Duration) -> Self {
        Self {
            pieces: body
                .split_inclusive("\n\n")
                .map(|event| event.as_bytes().to_vec())
                .collect(),
            gap,
            stall: None,
        }
    }
}

impl tokio::io::AsyncRead for Dribble {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.pieces.is_empty() {
            return Poll::Ready(Ok(()));
        }
        let gap = self.gap;
        let stall = self
            .stall
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(gap)));
        if stall.as_mut().poll(cx).is_pending() {
            return Poll::Pending;
        }
        self.stall = None;
        let piece = self.pieces.remove(0);
        buf.put_slice(&piece);
        Poll::Ready(Ok(()))
    }
}

/// A body that opens, says nothing, and never ends: a channel that has gone
/// quiet rather than one that refuses.
struct Quiet {
    opening: Option<Vec<u8>>,
}

impl tokio::io::AsyncRead for Quiet {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.opening.take() {
            // One piece, so the answer's own headers are on the wire before the
            // silence begins: a body that never says anything is a refusal at
            // the opening, which is a different thing from a stream that stops.
            Some(piece) => {
                buf.put_slice(&piece);
                Poll::Ready(Ok(()))
            }
            None => Poll::Pending,
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_that_keeps_producing_outlives_the_budget_meant_for_the_whole() {
    let body = events_body(&["\"A \"", "\"lantern.\""]);
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move || {
            let body = body.clone();
            async move {
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(tokio_util::io::ReaderStream::new(Dribble::new(
                        body,
                        Duration::from_millis(300),
                    ))),
                )
                    .into_response()
            }
        }),
    ))
    .await;

    // A budget of a second, an answer that takes several: what the budget
    // measures is the silence between pieces, and there is none.
    let rig = rig_under_text_budget(1).await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::new("openaiResponses"),
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let result = rig
        .gateway
        .text(
            &rig.assets,
            request(
                Capability::Text,
                "describe a lantern",
                json!({ "stream": true }),
            ),
            &DeltaSink::unwatched(),
            &Cancel::new(),
        )
        .await
        .expect("a stream that is still producing is not cut off");

    assert_eq!(result.text.as_deref(), Some("A lantern."));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_that_goes_quiet_is_given_up_on() {
    let opening =
        String::from("data: {\"type\":\"response.output_text.delta\",\"delta\":\"A \"}\n\n");
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move || {
            let opening = opening.clone();
            async move {
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(tokio_util::io::ReaderStream::new(Quiet {
                        opening: Some(opening.into_bytes()),
                    })),
                )
                    .into_response()
            }
        }),
    ))
    .await;

    let rig = rig_under_text_budget(1).await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::new("openaiResponses"),
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let error = rig
        .gateway
        .text(
            &rig.assets,
            request(
                Capability::Text,
                "describe a lantern",
                json!({ "stream": true }),
            ),
            &DeltaSink::unwatched(),
            &Cancel::new(),
        )
        .await
        .expect_err("a channel that went quiet is a failure");

    assert_eq!(error.code(), "PROVIDER_TIMEOUT");
    assert!(error.to_string().contains("quiet"), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_streamed_answer_reaches_the_caller_as_it_arrives_and_comes_back_whole() {
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(|| async { events(&["\"A \"", "\"lantern.\""]) }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::new("openaiResponses"),
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let seen = Arc::new(Mutex::new(String::new()));
    let collected = Arc::clone(&seen);
    let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
        collected
            .lock()
            .expect("the sink is not held across a call")
            .push_str(chunk);
    }));

    let result = rig
        .gateway
        .text(
            &rig.assets,
            request(
                Capability::Text,
                "describe a lantern",
                json!({ "stream": true }),
            ),
            &sink,
            &Cancel::new(),
        )
        .await
        .expect("the stream is read to its end");

    assert_eq!(
        seen.lock()
            .expect("the sink is not held across a call")
            .as_str(),
        "A lantern.",
        "every piece reached the caller while it was arriving"
    );
    // Streaming only makes the wait visible: what gets stored is the aggregate.
    assert_eq!(result.text.as_deref(), Some("A lantern."));
    assert_eq!(result.usage.and_then(|usage| usage.output_tokens), Some(2));
}

/// Reads out one event and then fails, the way a provider that drops the
/// connection mid-answer does.
struct Abandoned {
    pending: Vec<u8>,
    stall: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

impl Abandoned {
    fn new(body: String) -> Self {
        Self {
            pending: body.into_bytes(),
            stall: None,
        }
    }
}

impl tokio::io::AsyncRead for Abandoned {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if !self.pending.is_empty() {
            let take = buf.remaining().min(self.pending.len());
            buf.put_slice(&self.pending[..take]);
            self.pending.drain(..take);
            return Poll::Ready(Ok(()));
        }
        // Paused before failing, so the piece already produced has time to
        // leave the machine: a body that ends in the same instant it begins
        // takes what it sent with it.
        let stall = self
            .stall
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(Duration::from_millis(50))));
        if stall.as_mut().poll(cx).is_pending() {
            return Poll::Pending;
        }
        Poll::Ready(Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "the provider dropped the connection",
        )))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_after_something_was_streamed_is_not_asked_again() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                // One piece reaches the caller, and then the connection goes:
                // a retry would put the same words on screen a second time.
                let pending = String::from(
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"A \"}\n\n\
                     data: {\"type\":\"response.output_text.delt",
                );
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(tokio_util::io::ReaderStream::new(Abandoned::new(pending))),
                )
                    .into_response()
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::new("openaiResponses"),
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let seen = Arc::new(Mutex::new(String::new()));
    let collected = Arc::clone(&seen);
    let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
        collected
            .lock()
            .expect("the sink is not held across a call")
            .push_str(chunk);
    }));

    let error = rig
        .gateway
        .text(
            &rig.assets,
            request(
                Capability::Text,
                "describe a lantern",
                json!({ "stream": true }),
            ),
            &sink,
            &Cancel::new(),
        )
        .await
        .expect_err("the connection went mid-answer");

    assert_eq!(
        seen.lock()
            .expect("the sink is not held across a call")
            .as_str(),
        "A ",
        "the caller had already seen something"
    );
    assert_eq!(error.code(), "PROVIDER_UNAVAILABLE", "{error}");
    assert_eq!(
        watched.times(),
        1,
        "an answer already on screen is not repeated behind it"
    );
}

// -------------------------------------------------------------------- video

/// A provider that starts a job, answers one poll with work still to do, and
/// the next with the finished bytes.
async fn video_provider(watched: Watch) -> String {
    let started = watched.clone();
    let polled = watched.clone();
    let collected = watched.clone();
    serve(
        Router::new()
            .route(
                "/v1/videos",
                post(move |body: Bytes| {
                    let watched = started.clone();
                    async move {
                        watched.note(Some(body));
                        Json(json!({ "id": "job-1", "status": "queued" }))
                    }
                }),
            )
            .route(
                "/v1/videos/{id}",
                get(move || {
                    let watched = polled.clone();
                    async move {
                        let first = watched.times() == 1;
                        watched.note(None);
                        let status = if first { "in_progress" } else { "completed" };
                        Json(json!({ "id": "job-1", "status": status }))
                    }
                }),
            )
            .route(
                "/v1/videos/{id}/content",
                get(move || {
                    let watched = collected.clone();
                    async move {
                        watched.note(None);
                        ([(header::CONTENT_TYPE, "video/mp4")], b"mp4-bytes".to_vec())
                    }
                }),
            ),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shot_is_started_polled_and_then_the_handle_is_done_with() {
    let watched = Watch::default();
    let base_url = video_provider(watched.clone()).await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("a-video-model", Capability::Video)])
        .await;
    rig.default(Capability::Video, "a-video-model").await;

    let task = rig
        .gateway
        .video(
            &rig.assets,
            request(Capability::Video, "a slow pan", json!({ "seconds": 6 })),
            &Cancel::new(),
        )
        .await
        .expect("the job starts");

    assert!(!task.id.is_empty());
    assert_eq!(task.capability, Capability::Video);
    assert_eq!(
        rig.gateway.tasks().len(),
        1,
        "the handle is tracked at once"
    );
    assert_eq!(watched.body(0)["seconds"], 6);

    let cancel = Cancel::new();
    match rig
        .gateway
        .poll(&rig.assets, &task.id, &cancel)
        .await
        .expect("a look")
    {
        TaskState::Pending { retry_after_ms } => {
            assert!(retry_after_ms > 0, "another look is worth waiting for")
        }
        other => panic!("expected a job still running, got {other:?}"),
    }
    assert_eq!(rig.gateway.tasks().len(), 1, "a running job stays tracked");

    match rig
        .gateway
        .poll(&rig.assets, &task.id, &cancel)
        .await
        .expect("the job is collected")
    {
        TaskState::Succeeded(result) => {
            assert_eq!(result.items.len(), 1);
            assert_eq!(result.items[0].mime, "video/mp4");
            assert_eq!(result.items[0].bytes, b"mp4-bytes");
        }
        other => panic!("expected the finished shot, got {other:?}"),
    }

    // A job that answered will not answer again, so its handle is dropped
    // rather than kept until it grows old.
    assert!(rig.gateway.tasks().is_empty());
    let error = rig
        .gateway
        .poll(&rig.assets, &task.id, &cancel)
        .await
        .expect_err("the handle is done with");
    assert_eq!(error.code(), "TASK_NOT_FOUND");
}

/// A provider that films only where a sub-model's own address points: a job
/// placed or polled at the configuration's address finds nothing there.
async fn sub_model_provider(watched: Watch) -> String {
    let started = watched.clone();
    let polled = watched.clone();
    let collected = watched.clone();
    serve(
        Router::new()
            .route(
                "/v1/video-images",
                post(move |body: Bytes| {
                    let watched = started.clone();
                    async move {
                        watched.note(Some(body));
                        Json(json!({ "id": "job-sub", "status": "queued" }))
                    }
                }),
            )
            .route(
                "/v1/video-images/{id}",
                get(move || {
                    let watched = polled.clone();
                    async move {
                        watched.note(None);
                        Json(json!({ "id": "job-sub", "status": "completed" }))
                    }
                }),
            )
            .route(
                "/v1/video-images/{id}/content",
                get(move || {
                    let watched = collected.clone();
                    async move {
                        watched.note(None);
                        ([(header::CONTENT_TYPE, "video/mp4")], b"mp4-bytes".to_vec())
                    }
                }),
            ),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shot_is_placed_with_the_sub_model_its_scene_names() {
    let watched = Watch::default();
    let base_url = sub_model_provider(watched.clone()).await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("a-video-model", Capability::Video)])
        .await;
    rig.default(Capability::Video, "a-video-model").await;

    // The configuration routes one scenario through a sub-model of its own: a
    // name the provider knows, at an address of its own.
    let stored = rig
        .models
        .model("a-video-model")
        .await
        .expect("the configuration is stored");
    rig.models
        .upsert(ModelDraft {
            id: stored.id.clone(),
            category: Capability::Video,
            protocol: stored.protocol.clone(),
            url: stored.url.clone(),
            model: stored.model.clone(),
            display_name: stored.display_name.clone(),
            max_video_seconds: None,
            scenes: Vec::new(),
            sub_models: vec![SubModel {
                model: "happy-ref".into(),
                url: Some(format!("{base_url}/v1/video-images")),
                scenes: vec![Scene::ReferenceToVideo],
            }],
            enabled: true,
            expected_revision: None,
        })
        .await
        .expect("the routing is stored");

    // A shot carrying pictures meant as references is that scenario, and the
    // job goes to the sub-model's name and address — neither of which the
    // configuration itself answers at.
    let picture = rig.upload("cat.png", "image/png", &encoded(4, 3)).await;
    let mut asked = request(
        Capability::Video,
        "a slow pan",
        json!({ "mode": "reference" }),
    );
    asked.inputs = vec![GenerateInput {
        role: InputRole::Reference,
        asset_id: picture,
        window: None,
    }];
    let task = rig
        .gateway
        .video(&rig.assets, asked, &Cancel::new())
        .await
        .expect("the job starts at the sub-model's address");

    assert_eq!(task.scene, Some(Scene::ReferenceToVideo));
    assert_eq!(
        watched.body(0)["model"],
        "happy-ref",
        "the provider is asked for the sub-model's own name"
    );

    // The poll asks the same address the job was placed at: a job is a
    // provider's, and only the one that issued the handle can answer for it.
    match rig
        .gateway
        .poll(&rig.assets, &task.id, &Cancel::new())
        .await
        .expect("the poll finds the job")
    {
        TaskState::Succeeded(result) => {
            assert_eq!(result.items[0].bytes, b"mp4-bytes");
        }
        other => panic!("expected the finished shot, got {other:?}"),
    }

    // A scenario the routing does not answer for is refused before anything is
    // sent, and the client is told which one to configure.
    let error = rig
        .gateway
        .video(
            &rig.assets,
            request(Capability::Video, "words alone", json!({})),
            &Cancel::new(),
        )
        .await
        .expect_err("the text-to-video scene is not routed");
    assert_eq!(error.code(), "MODEL_SCENE_UNCONFIGURED");
    let details = error.details().expect("details");
    assert_eq!(details["scene"], "textToVideo");
    assert_eq!(
        details["reference"], "a-video-model",
        "the fix is in this configuration's settings"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handle_the_gateway_never_issued_is_missing() {
    let rig = rig().await;
    let error = rig
        .gateway
        .poll(&rig.assets, "a-handle-from-nowhere", &Cancel::new())
        .await
        .expect_err("nothing is tracked under it");
    assert_eq!(error.code(), "TASK_NOT_FOUND");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_the_provider_has_forgotten_ends_the_tracking() {
    let base_url = serve(Router::new().route(
        "/v1/videos",
        post(|| async { Json(json!({ "id": "job-1", "status": "queued" })) }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("a-video-model", Capability::Video)])
        .await;
    rig.default(Capability::Video, "a-video-model").await;

    let task = rig
        .gateway
        .video(
            &rig.assets,
            request(Capability::Video, "a slow pan", json!({})),
            &Cancel::new(),
        )
        .await
        .expect("the job starts");

    // Only the start endpoint is routed, so a poll answers 404 and the job is
    // one this provider no longer knows.
    let error = rig
        .gateway
        .poll(&rig.assets, &task.id, &Cancel::new())
        .await
        .expect_err("the job is gone");
    assert_eq!(error.code(), "TASK_EXPIRED");
    assert!(
        rig.gateway.tasks().is_empty(),
        "a job the provider forgot cannot answer again"
    );
}

/// Starts a throwaway provider whose routes know the address they are served
/// on, which a protocol that hands out links of its own needs.
async fn serve_aware(build: impl FnOnce(String) -> Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let address = listener.local_addr().expect("the socket has an address");
    let base = format!("http://{address}");
    let routes = build(base.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, routes).await;
    });
    base
}

/// The credential a request carried, if any: what the rule about which hosts
/// may see the key is read in.
fn auth_of(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .map(|value| value.to_str().unwrap_or_default().to_string())
}

/// Deploys the built-in converter scripts, which is also what points the
/// process-wide converter root at them. Every protocol is served by a script,
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

/// A few milliseconds of silence, as a RIFF header says it is: a recording the
/// store will recognise as audio rather than as bytes nobody knows.
fn recorded() -> Vec<u8> {
    let samples = vec![0u8; 32];
    let mut bytes = Vec::with_capacity(44 + samples.len());
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&((36 + samples.len()) as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&16_000u32.to_le_bytes());
    bytes.extend_from_slice(&32_000u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&samples);
    bytes
}

/// A recording read back as words, over the whole conversation the upstream
/// protocol needs: where to put the file, the file, the job, and the document
/// behind it.
///
/// The legs are checked as well as the answer. A chain that answered with a
/// subtitle file without ever uploading anything would pass a test that read
/// only the text, and the rule about credentials — sent to the address somebody
/// configured, never to a host the provider names later — is only visible in
/// what each leg received.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recognition_script_runs_its_whole_conversation_and_answers_with_words() {
    deploy_scripts().await;

    let policy = Watch::default();
    let submit = Watch::default();
    let job = Watch::default();
    let document = Watch::default();
    // What reached the upload host, and the credential it arrived with.
    let uploads: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let submits: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));

    let heard = Arc::clone(&uploads);
    // The host itself, which is where the protocol puts the file: the policy
    // names a host and a key, not a path.
    let bucket_url = serve(Router::new().route(
        "/",
        post(move |headers: axum::http::HeaderMap| {
            let heard = Arc::clone(&heard);
            async move {
                heard.lock().expect("not poisoned").push(auth_of(&headers));
                StatusCode::OK
            }
        }),
    ))
    .await;

    let heard = Arc::clone(&submits);
    let seen = submit.clone();
    let answering = policy.clone();
    let asking = job.clone();
    let reading = document.clone();
    let base_url = serve_aware(move |base| {
        Router::new()
            .route(
                "/api/v1/uploads",
                get(move || {
                    let seen = answering.clone();
                    let host = bucket_url.clone();
                    async move {
                        seen.note(None);
                        Json(json!({ "data": {
                            "policy": "a-policy",
                            "signature": "a-signature",
                            "upload_dir": "dashscope-instant/2026/09/22/abc",
                            "upload_host": host,
                            "oss_access_key_id": "an-access-key",
                            "x_oss_object_acl": "private",
                            "x_oss_forbid_overwrite": "true",
                        }}))
                    }
                }),
            )
            .route(
                "/v1/lua/listener",
                post(
                    move |headers: axum::http::HeaderMap, body: Bytes| {
                        let seen = seen.clone();
                        let heard = Arc::clone(&heard);
                        async move {
                            seen.note(Some(body));
                            heard.lock().expect("not poisoned").push(auth_of(&headers));
                            Json(json!({ "output": { "task_id": "trans-1" } }))
                        }
                    },
                ),
            )
            .route(
                "/api/v1/tasks/trans-1",
                get(move || {
                    let seen = asking.clone();
                    let base = base.clone();
                    async move {
                        seen.note(None);
                        Json(json!({ "output": {
                            "task_status": "SUCCEEDED",
                            "results": [{ "transcription_url": format!("{base}/transcript") }],
                        }}))
                    }
                }),
            )
            .route(
                "/transcript",
                get(move || {
                    let seen = reading.clone();
                    async move {
                        seen.note(None);
                        Json(json!({ "transcripts": [{ "sentences": [
                            { "begin_time": 100, "end_time": 3820, "text": "a lantern over the lake" },
                            { "begin_time": 4000, "end_time": 5200, "text": "and the rowing stopped" },
                        ]}]}))
                    }
                }),
            )
    })
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "listener",
            Capability::Asr,
            Protocol::from_wire_name("bailianAsr"),
        )],
    )
    .await;
    rig.default(Capability::Asr, "listener").await;
    let recording = rig.upload("take-1.wav", "audio/wav", &recorded()).await;

    let request = GenerateRequest {
        capability: Capability::Asr,
        inputs: vec![GenerateInput {
            role: InputRole::ControlAudio,
            asset_id: recording,
            window: None,
        }],
        params: json!({ "language": "zh" })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        ..GenerateRequest::default()
    };
    let cancel = Cancel::new();
    let task = rig
        .gateway
        .transcribe(&rig.assets, request, &cancel)
        .await
        .expect("the reading starts");
    assert_eq!(task.capability, Capability::Asr);
    assert_eq!(task.model, "listener");

    let state = rig
        .gateway
        .poll(&rig.assets, &task.id, &cancel)
        .await
        .expect("the job is tracked");
    let TaskState::Succeeded(result) = state else {
        panic!("expected the finished reading, got {state:?}");
    };
    // The words come back as a subtitle document: times measured from the
    // beginning of the audio that was sent. Where that audio sits on a
    // timeline is the caller's business, not the script's.
    assert_eq!(
        result.text.as_deref(),
        Some(
            "1\n00:00:00,100 --> 00:00:03,820\na lantern over the lake\n\n\
             2\n00:00:04,000 --> 00:00:05,200\nand the rowing stopped"
        )
    );
    assert!(result.items.is_empty(), "a reading is words, not a file");

    // Every leg of the conversation was reached, once.
    assert_eq!(policy.times(), 1, "the upload policy was asked for");
    assert_eq!(submit.times(), 1, "the job was submitted");
    assert_eq!(job.times(), 1, "the job was looked at");
    assert_eq!(document.times(), 1, "the transcript was read");
    // The file went to the host the provider named, and the submission names
    // the location of its own copy rather than a link anybody could follow.
    assert_eq!(uploads.lock().expect("not poisoned").len(), 1);
    let submitted = &submit.body(0);
    assert_eq!(submitted["model"], "listener");
    assert_eq!(submitted["parameters"]["language_hints"][0], "zh");
    assert_eq!(
        submitted["input"]["file_urls"][0],
        "oss://dashscope-instant/2026/09/22/abc/take-1.wav"
    );
    // The credential goes where it was configured to and nowhere else: the
    // upload host is the provider's own storage, and a key sent there would
    // travel to a machine nobody chose.
    assert_eq!(
        *submits.lock().expect("not poisoned").first().unwrap(),
        Some(format!("Bearer {API_KEY}"))
    );
    assert_eq!(uploads.lock().expect("not poisoned")[0], None);
}

/// A converter script for a text model: it asks its own address with the
/// prompt and reads the words back, which is the whole shape of one.
const SCRIPTED: &str = r#"
function build_request(call, req, inputs)
    return {
        method = "POST",
        url = call.url,
        headers = {["Content-Type"] = "application/json"},
        body = json.encode({ model = call.model, prompt = req.prompt }),
    }
end

function parse_response(status, headers, body)
    local data = json.decode(body)
    return { text = data.text, items = {} }
end
"#;

/// A script answers whole, so a caller who is not reading the pieces is served
/// the answer and a caller who is reading them is told the protocol cannot
/// stream.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_script_backed_answer_is_served_whole_to_a_caller_who_is_not_reading_the_pieces() {
    deploy_scripts().await;
    place_script("text", "scriptedWords", SCRIPTED, None).await;

    let base_url = serve(Router::new().route(
        "/v1/lua/scripted",
        post(|| async { Json(json!({ "text": "A lantern." })) }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "scripted",
            Capability::Text,
            Protocol::from_wire_name("scriptedWords"),
        )],
    )
    .await;
    rig.default(Capability::Text, "scripted").await;

    // What a story job asks for: a stream nobody reads, for the length of it.
    let whole = rig
        .gateway
        .text(
            &rig.assets,
            request(
                Capability::Text,
                "describe a lantern",
                json!({ "stream": true }),
            ),
            &DeltaSink::unwatched(),
            &Cancel::new(),
        )
        .await
        .expect("a script answers whole");
    assert_eq!(whole.text.as_deref(), Some("A lantern."));

    // What a reader's own ask does: refused rather than answered at the end,
    // since the pieces were the whole point of the wait.
    let watching = DeltaSink::new(Arc::new(|_| {}));
    let error = rig
        .gateway
        .text(
            &rig.assets,
            request(
                Capability::Text,
                "describe a lantern",
                json!({ "stream": true }),
            ),
            &watching,
            &Cancel::new(),
        )
        .await
        .expect_err("a script cannot stream");
    assert!(error.to_string().contains("does not stream"), "{error}");
}

/// A build hook that names a reader it never wrote.
const ORPHANED: &str = r#"
function build_task_request(call, req, inputs)
    return {
        request = { method = "GET", url = call.url .. "/anything", headers = {} },
        handler = "never_written",
    }
end
"#;

/// A step that never ends: every reply asks for the same exchange again, and
/// carries the address it asks at, which is what `state` is for.
const ENDLESS: &str = r#"
function build_task_request(call, req, inputs)
    return {
        state = { url = call.url .. "/loop" },
        request = { method = "GET", url = call.url .. "/loop", headers = {} },
        handler = "again",
    }
end

function again(status, headers, body, state)
    return {
        state = state,
        next = {
            request = { method = "GET", url = state.url, headers = {} },
            handler = "again",
        },
    }
end
"#;

/// Writes a converter directory of the test's own into the models tree the
/// adapter reads, the way a converter somebody added by hand would be: a
/// script and the self-contained document that names it. What the document
/// declares as its features — what the asks behind it need — is the test's to
/// say; `None` declares nothing.
async fn place_script(capability: &str, protocol: &str, source: &str, features: Option<Value>) {
    let root = moka_canvas::converter::converter_root().expect("the scripts are deployed");
    let dir = root.join(capability).join(protocol);
    std::fs::create_dir_all(&dir).expect("the converter directory is created");
    let name = format!("{protocol}.lua");
    std::fs::write(dir.join(&name), source).expect("the script is written");
    let mut document = serde_json::json!({
        "displayName": protocol,
        "urlExample": "https://provider.test/transcription",
        "script": name,
    });
    if let Some(features) = features {
        document["features"] = features;
    }
    std::fs::write(
        dir.join("model.json"),
        serde_json::to_string_pretty(&document).unwrap(),
    )
    .expect("the document is written");
}

/// A script that names a handler it never wrote is refused before anything
/// leaves this process: an upload of tens of megabytes is a heavy way to
/// discover a typo.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_script_naming_a_handler_it_never_wrote_is_refused_before_anything_is_sent() {
    deploy_scripts().await;
    place_script("asr", "orphanHandlers", ORPHANED, None).await;

    let watched = Watch::default();
    let seen = watched.clone();
    let base_url = serve(Router::new().route(
        "/anything",
        get(move || {
            let seen = seen.clone();
            async move {
                seen.note(None);
                StatusCode::OK
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "orphan",
            Capability::Asr,
            Protocol::from_wire_name("orphanHandlers"),
        )],
    )
    .await;
    rig.default(Capability::Asr, "orphan").await;

    let error = rig
        .gateway
        .transcribe(
            &rig.assets,
            GenerateRequest {
                capability: Capability::Asr,
                ..GenerateRequest::default()
            },
            &Cancel::new(),
        )
        .await
        .expect_err("the handler is not there");
    assert!(error.to_string().contains("does not export"), "{error}");
    assert!(error.to_string().contains("never_written"), "{error}");
    assert_eq!(watched.times(), 0, "nothing was sent to the provider");
}

/// A step that keeps asking for one more exchange is stopped rather than run
/// forever, and the address it asked at travelled from one handler to the next
/// in `state` — a value nobody wrote down is a value nobody has.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_step_that_never_ends_is_stopped_at_the_ceiling() {
    deploy_scripts().await;
    place_script("asr", "endlessExchanges", ENDLESS, None).await;

    let watched = Watch::default();
    let seen = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/lua/endless/loop",
        get(move || {
            let seen = seen.clone();
            async move {
                seen.note(None);
                // An address the hook derived rather than one that was
                // configured, so the state it travelled in is the only reason
                // the second exchange reaches this provider at all.
                Json(json!({ "still": true }))
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "endless",
            Capability::Asr,
            Protocol::from_wire_name("endlessExchanges"),
        )],
    )
    .await;
    rig.default(Capability::Asr, "endless").await;

    let error = rig
        .gateway
        .transcribe(
            &rig.assets,
            GenerateRequest {
                capability: Capability::Asr,
                ..GenerateRequest::default()
            },
            &Cancel::new(),
        )
        .await
        .expect_err("the chain never ends");
    assert!(
        error.to_string().contains("more than 8 exchanges"),
        "{error}"
    );
    assert_eq!(watched.times(), 8, "one exchange per step and no more");
}
