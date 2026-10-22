//! What instruction the assistant's model step carries over HTTP.
//!
//! A global system prompt frames content generation. The assistant is framed by
//! an instruction of its own — persona, tools, protocol — and that instruction
//! has to reach the provider as the request's own `system` rather than as a
//! message of the conversation, because the gateway fills `system` from the
//! preference whenever the request states none. The step is checked against the
//! wire body a throwaway provider is handed, not against the code that builds
//! it.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::{to_bytes, Body, Bytes};
use axum::http::{header, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use base64::Engine;
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use moka_canvas::domain::Capability;
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{Defaults, ModelDraft, Preferences, Protocol};
use moka_canvas::project::CreateProject;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

const API_KEY: &str = "sk-agent-1234567890abcd";
const HOUSE_STYLE: &str = "HOUSE STYLE: every line must rhyme.";

struct Harness {
    app: Router,
    state: ApiState,
    /// Keeps the tree the store was opened in alive for the whole test.
    _tmp: TempDir,
}

/// The one models tree this test binary deploys the built-in converters into.
///
/// The converter root is also a process-wide pointer that startup sets once,
/// and the cases here run side by side; a tree per case would leave each one
/// racing the other's deployment. One tree, deployed under a lock before any
/// case asks a provider anything, is both what a started server has and what
/// makes the cases independent of their order.
async fn models_root() -> &'static Path {
    static MODELS: OnceLock<std::path::PathBuf> = OnceLock::new();
    static DEPLOY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = DEPLOY.lock().await;
    let root = MODELS.get_or_init(|| {
        TempDir::new()
            .expect("a converter directory")
            .keep()
            .join("models")
    });
    moka_canvas::converter::deploy::ensure_deployed(root)
        .await
        .expect("the built-in scripts deploy");
    root
}

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
    let store = moka_canvas::metadata::open(&metadata, &config.metadata, RuntimeMode::Web)
        .expect("the metadata store opens");
    let models = models_root().await;
    let nodes = models
        .parent()
        .expect("the models tree has a parent")
        .join("nodes");
    let state =
        ApiState::with_metadata(config, RuntimeMode::Web, store, models.to_path_buf(), nodes);
    let (_store, _opened) = state
        .store
        .create_project(
            &tmp.path().join("project"),
            CreateProject {
                name: "Assistant".into(),
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

/// The bodies a throwaway provider was sent, in the order it was asked.
#[derive(Clone, Default)]
struct Asked(Arc<Mutex<Vec<Value>>>);

impl Asked {
    fn keep(&self, body: &Bytes) {
        let body: Value = serde_json::from_slice(body).expect("the provider body is JSON");
        self.0
            .lock()
            .expect("the record is not poisoned")
            .push(body);
    }

    fn last(&self) -> Value {
        self.0
            .lock()
            .expect("the record is not poisoned")
            .last()
            .cloned()
            .expect("the provider was asked")
    }
}

/// Starts a throwaway provider speaking the OpenAI chat protocol and returns
/// the address a model URL is built on.
async fn serve(asked: Asked) -> String {
    let routes = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let asked = asked.clone();
            async move {
                asked.keep(&body);
                // One door serves both shapes: the assistant reads its answer
                // in pieces, a plain generation takes it whole.
                let streaming = serde_json::from_slice::<Value>(&body)
                    .map(|body| body["stream"] == true)
                    .unwrap_or(false);
                if streaming {
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        "data: {\"choices\":[{\"delta\":{\"content\":\"Done.\"},\"finish_reason\":\"stop\"}]}\n\n\
                         data: [DONE]\n\n",
                    )
                        .into_response()
                } else {
                    axum::Json(json!({
                        "choices": [{"message": {"content": "A lantern, lit."}}],
                    }))
                    .into_response()
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let address = listener.local_addr().expect("the socket has an address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, routes).await;
    });
    format!("http://{address}")
}

/// Points the app at the throwaway provider the way Settings does, with a
/// global system prompt set for generation.
async fn configured(harness: &Harness, base_url: &str) {
    harness
        .state
        .models
        .upsert(ModelDraft {
            id: "gpt-agent".into(),
            category: Capability::Text,
            protocol: Protocol::new("openaiChat"),
            url: format!("{base_url}/v1/chat/completions"),
            model: "gpt-agent".into(),
            display_name: "gpt-agent".into(),
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
        .set_key("gpt-agent", Some(API_KEY))
        .await
        .expect("the credential is stored");
    harness
        .state
        .models
        .set_defaults(
            &Defaults {
                text: Some("gpt-agent".into()),
                ..Defaults::default()
            },
            None,
        )
        .await
        .expect("the defaults are stored");
    harness
        .state
        .models
        .set_preferences(
            &Preferences {
                system_prompt: HOUSE_STYLE.into(),
                ..Preferences::default()
            },
            None,
        )
        .await
        .expect("the preferences are stored");
}

async fn get_json(app: &Router, uri: &str) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .body(Body::empty())
                .expect("the request is built"),
        )
        .await
        .expect("the request is served");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body is read");
    serde_json::from_slice(&bytes).expect("the body is JSON")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_assistant_step_keeps_its_own_instruction_and_not_the_house_style() {
    let harness = harness().await;
    let asked = Asked::default();
    let base_url = serve(asked.clone()).await;
    configured(&harness, &base_url).await;

    let capabilities = get_json(&harness.app, "/api/v1/agent/capabilities").await;
    let catalog_hash = capabilities["catalogHash"]
        .as_str()
        .expect("the catalog hash is reported")
        .to_string();

    let response = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agent/chat")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "catalogHash": catalog_hash,
                        "scope": {"room": "canvas"},
                        "messages": [{"role": "user", "text": "hello"}],
                    }))
                    .expect("the request encodes"),
                ))
                .expect("the request is built"),
        )
        .await
        .expect("the step is served");
    assert_eq!(response.status(), StatusCode::OK);
    let stream = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the stream is read");
    let stream = String::from_utf8_lossy(&stream);
    assert!(
        stream.contains("event: done"),
        "the step should reach the provider and finish: {stream}"
    );

    let body = asked.last();
    let messages = body["messages"]
        .as_array()
        .unwrap_or_else(|| panic!("the provider is sent messages: {body}"));
    let systems: Vec<&Value> = messages
        .iter()
        .filter(|message| message["role"] == "system")
        .collect();
    assert_eq!(
        systems.len(),
        1,
        "one instruction, from the assistant itself: {messages:?}"
    );
    let instruction = systems[0]["content"]
        .as_str()
        .unwrap_or_else(|| panic!("the instruction is words: {messages:?}"));
    assert!(
        instruction.contains("You are the assistant inside Moka Canvas"),
        "the assistant's own instruction must survive: {instruction}"
    );
    assert!(
        !instruction.contains(HOUSE_STYLE),
        "the global prompt belongs to generation, not to the assistant: {instruction}"
    );
    assert_eq!(
        messages.last().map(|message| message["role"].as_str()),
        Some(Some("user"))
    );
    assert!(
        body["tools"]
            .as_array()
            .map(|tools| !tools.is_empty())
            .unwrap_or(false),
        "a converter with native tools is offered them: {body}"
    );
}

/// The preference still frames a written answer: the assistant keeping its own
/// instruction is not the preference being dropped everywhere.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_written_answer_is_still_framed_by_the_house_style() {
    let harness = harness().await;
    let asked = Asked::default();
    let base_url = serve(asked.clone()).await;
    configured(&harness, &base_url).await;

    let response = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/generate/text")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "capability": "text",
                        "prompt": "write a line",
                    }))
                    .expect("the request encodes"),
                ))
                .expect("the request is built"),
        )
        .await
        .expect("the generation is served");
    let status = response.status();
    let refused = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body is read");
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&refused)
    );

    let body = asked.last();
    let messages = body["messages"]
        .as_array()
        .unwrap_or_else(|| panic!("the provider is sent messages: {body}"));
    let systems: Vec<&Value> = messages
        .iter()
        .filter(|message| message["role"] == "system")
        .collect();
    assert_eq!(
        systems.len(),
        1,
        "the preference frames the ask: {messages:?}"
    );
    assert_eq!(systems[0]["content"], HOUSE_STYLE);
}
