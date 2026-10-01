//! A protocol added by hand, with nothing changed but a directory.
//!
//! The models tree is the whole definition of a protocol: a `model.json`
//! naming a script beside it, under the capability directory it serves. What
//! this file guards is that claim end to end — a directory nobody wrote a line
//! of Rust or TypeScript for is offered by the settings, accepted when a model
//! is configured to speak it, and answered by a provider when such a model
//! generates, with the credential travelling exactly where the document said.

use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body, Bytes};
use axum::http::{header, Request, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use moka_canvas::converter::deploy::ensure_deployed;
use moka_canvas::domain::Capability;
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{self, Defaults, MetadataStore, ModelDraft, Protocol};
use moka_canvas::project::CreateProject;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// The protocol this file invents: a name, a document and a script, and
/// nothing else about it anywhere in the program.
const ID: &str = "helloWire";

/// The document, written the way somebody adding a protocol to their own
/// machine would: the name it goes by per language, where its credential
/// rides, and what it declares about itself.
fn document() -> Value {
    json!({
        "displayName": "Hello Wire · greeting",
        "labels": { "zh": "你好线 · 问候" },
        "urlExample": "https://provider.test/v1/greeting",
        "script": "hello-wire.lua",
        "order": 5,
        "auth": { "header": "x-hello-key", "scheme": "" },
        "features": { "mask": false },
        "version": 1
    })
}

/// The script, whose wire shape is one nothing in this program has heard of.
const SCRIPT: &str = r#"
function build_request(call, req, inputs)
    return {
        method = "POST",
        url = call.url,
        headers = {["Content-Type"] = "application/json"},
        body = json.encode({ask = req.prompt, capability = req.capability}),
    }
end

function parse_response(status, headers, body)
    local payload = json.decode(body)
    return {text = payload.greeting, usage = {input_tokens = 1, output_tokens = 2}}
end
"#;

struct Harness {
    app: Router,
    state: ApiState,
    /// Keeps the tree the store was opened in alive for the whole test.
    _tmp: TempDir,
}

/// The models tree every test in this binary reads, set up once.
///
/// The program reads one root, so it is a directory that outlives every test
/// here: the built-in converters are deployed into it, and the hand-written
/// converter is placed beside them before the deploy runs — which is also the
/// check that a deploy leaves a directory it does not know exactly as it found
/// it. A root that went away with its test would leave the other test reading a
/// directory that no longer exists.
async fn models_root() -> &'static Path {
    static ROOT: tokio::sync::OnceCell<&'static Path> = tokio::sync::OnceCell::const_new();
    ROOT.get_or_init(|| async {
        let dir = std::env::temp_dir().join(format!("moka-converters-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.join("models");

        // A protocol nobody wrote any code for: a directory, a document, a
        // script.
        let converter = root.join("text").join(ID);
        std::fs::create_dir_all(&converter).expect("the converter directory is created");
        std::fs::write(converter.join("model.json"), document().to_string())
            .expect("the document is written");
        std::fs::write(converter.join("hello-wire.lua"), SCRIPT).expect("the script is written");

        // Starting the program: the built-in converters fill in around the
        // reader's own directory.
        ensure_deployed(&root)
            .await
            .expect("the built-in converters deploy");

        let root: &'static Path = Box::leak(root.into_boxed_path());
        root
    })
    .await
}

/// Opens the app over a temporary directory that already holds a master key,
/// with the models tree the tests share handed to it the way a deployment's
/// own root would be.
async fn harness() -> Harness {
    let tmp = TempDir::new().expect("a temporary directory");
    let config = parse_test_config(tmp.path());
    let metadata_dir = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    std::fs::create_dir_all(&metadata_dir).expect("the metadata directory is created");
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [7u8; 32]);
    std::fs::write(metadata_dir.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let store = metadata::open(&metadata_dir, &config.metadata, RuntimeMode::Web)
        .map(|store| store as Arc<dyn MetadataStore>)
        .expect("the store opens");

    let state = ApiState::with_metadata(
        config,
        RuntimeMode::Web,
        store,
        models_root().await.to_path_buf(),
    );
    // A generation belongs to a project, so the harness opens one the way the
    // launcher does before anything generates.
    let (_store, _opened) = state
        .store
        .create_project(
            &tmp.path().join("project"),
            CreateProject {
                name: "Converters".into(),
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

/// One request as the provider saw it.
struct Arrival {
    key: Option<String>,
    asked: Value,
}

/// What the provider was handed, the last time it was asked.
#[derive(Clone, Default)]
struct Witness(Arc<Mutex<Option<Arrival>>>);

impl Witness {
    fn note(&self, headers: &axum::http::HeaderMap, body: &Bytes) {
        let key = headers
            .get("x-hello-key")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let asked = serde_json::from_slice(body).expect("the body is JSON");
        *self.0.lock().expect("not poisoned") = Some(Arrival { key, asked });
    }

    fn seen(self) -> Arrival {
        self.0
            .lock()
            .expect("not poisoned")
            .take()
            .expect("the provider was asked")
    }
}

async fn send_json(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("the request is served");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body is read");
    (
        status,
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| json!({ "unparsed": String::from_utf8_lossy(&body) })),
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

/// A document written by hand is a protocol the whole program treats as one of
/// its own: listed where the settings read the list, accepted when a model is
/// configured to speak it, and answered by a provider when it generates — with
/// the credential in the header its document named rather than in the one this
/// program would have chosen.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_converter_dropped_into_the_models_tree_becomes_a_usable_protocol() {
    let harness = harness().await;

    // What the settings read: the document's own names, place and features
    // came along with it.
    let (status, body) = send_json(
        &harness.app,
        Request::builder()
            .uri("/api/v1/converter/protocols")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let offered = &body["protocols"]["text"][ID];
    assert_eq!(offered["displayName"], "Hello Wire · greeting");
    assert_eq!(offered["labels"]["zh"], "你好线 · 问候");
    assert_eq!(offered["urlExample"], "https://provider.test/v1/greeting");
    assert_eq!(offered["order"], 5);
    assert_eq!(offered["features"]["mask"], false);
    // The script the document names is what the host will run, from the
    // directory the document sits in.
    assert_eq!(offered["script"], format!("text/{ID}/hello-wire.lua"));

    // A provider that answers the invented shape, and says who called.
    let witness = Witness::default();
    let answering = witness.clone();
    let base_url = serve(Router::new().route(
        "/v1/greeting",
        post(move |headers: axum::http::HeaderMap, body: Bytes| {
            let answering = answering.clone();
            async move {
                answering.note(&headers, &body);
                Json(json!({ "greeting": "hello, wire" }))
            }
        }),
    ))
    .await;

    // A model configured to speak the invented protocol, at the address its
    // document gives an example of.
    harness
        .state
        .models
        .upsert(ModelDraft {
            id: "greeter".into(),
            category: Capability::Text,
            protocol: Protocol::new(ID),
            url: format!("{base_url}/v1/greeting"),
            model: "hello-1".into(),
            display_name: "Greeter".into(),
            max_video_seconds: None,
            scenes: Vec::new(),
            sub_models: Vec::new(),
            enabled: true,
            expected_revision: None,
        })
        .await
        .expect("a model may speak a converter the tree holds");
    harness
        .state
        .models
        .set_key("greeter", Some(API_KEY))
        .await
        .expect("the credential is stored");
    harness
        .state
        .models
        .set_defaults(
            &Defaults {
                text: Some("greeter".into()),
                ..Defaults::default()
            },
            None,
        )
        .await
        .expect("the default is stored");

    // A generation through it, over HTTP, answered by the provider.
    let (status, body) = send_json(
        &harness.app,
        json_request(
            "POST",
            "/api/v1/generate/text",
            json!({ "capability": "text", "prompt": "say hello" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "succeeded");
    assert_eq!(body["text"], "hello, wire");
    assert_eq!(body["usage"]["inputTokens"], 1);
    assert_eq!(body["usage"]["outputTokens"], 2);

    // The credential rode in the header the document named, and the question
    // the script asked is the question the provider was handed.
    let arrival = witness.seen();
    assert_eq!(arrival.key.as_deref(), Some(API_KEY));
    assert_eq!(arrival.asked["ask"], "say hello");
    assert_eq!(arrival.asked["capability"], "text");
}

/// The other half of the same claim: a protocol is not a name the program
/// knows, so a name with no directory behind it is refused where a model is
/// configured rather than at the first generation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_protocol_with_no_directory_behind_it_is_refused_where_it_is_configured() {
    let harness = harness().await;

    let error = harness
        .state
        .models
        .upsert(ModelDraft {
            id: "nothing".into(),
            category: Capability::Text,
            protocol: Protocol::new("wandProtocol"),
            url: "https://provider.test/v1/wand".into(),
            model: "wand".into(),
            display_name: "Wand".into(),
            max_video_seconds: None,
            scenes: Vec::new(),
            sub_models: Vec::new(),
            enabled: true,
            expected_revision: None,
        })
        .await
        .expect_err("no converter answers to that name");

    assert_eq!(error.code(), "VALIDATION_FAILED");
    assert!(error.to_string().contains("wandProtocol"), "{error}");
}
