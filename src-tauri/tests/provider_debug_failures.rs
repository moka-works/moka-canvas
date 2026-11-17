//! Recording a provider call that failed.
//!
//! The recorder's own tests cover what it writes for a generation that
//! succeeded. What they cannot cover is the failure a reader actually opens
//! the folder for: the status a provider refused with, its own words in the
//! body, and — when nothing answered at all — the reason under reqwest's
//! outermost line, which is where a proxy or connection failure says what it
//! was. Both are proven here against real sockets.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::Bytes;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use moka_canvas::config::GenerateConfig;
use moka_canvas::domain::Capability;
use moka_canvas::generate::adapters::{for_protocol, ModelCall};
use moka_canvas::generate::models::ResolvedModel;
use moka_canvas::generate::{Cancel, GenerateRequest};
use moka_canvas::metadata::Protocol;
use serde_json::{json, Value};

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

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

/// An address nothing listens on: a port that was free a moment ago.
fn closed_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port is free");
    let address = listener.local_addr().expect("the socket has an address");
    drop(listener);
    format!("http://{address}")
}

fn channel(name: &str, url: String) -> ModelCall {
    let resolved = ResolvedModel {
        config_id: format!("{name}-config"),
        model: "model-1".into(),
        display_name: "A model".into(),
        category: Capability::Text,
        protocol: Protocol::new("openaiResponses"),
        url,
        scene: None,
    };
    ModelCall::new(&resolved, API_KEY.to_string(), GenerateConfig::default())
        .expect("a client builds")
}

fn generation() -> GenerateRequest {
    GenerateRequest {
        capability: Capability::Text,
        prompt: "describe a lantern".into(),
        ..GenerateRequest::default()
    }
}

async fn record_into(dir: &Path) -> PathBuf {
    moka_canvas::generate::debug::init_in(dir)
        .expect("recording starts")
        .expect("recording is on");
    dir.to_path_buf()
}

/// Deploys the built-in converter scripts, which is also what points the
/// process-wide converter root at them.
async fn deploy_scripts() {
    if moka_canvas::converter::converter_root().is_some() {
        return;
    }
    let converter = tempfile::tempdir().expect("a converter directory");
    let path: &'static std::path::Path = Box::leak(converter.keep().into_boxed_path());
    moka_canvas::converter::deploy::ensure_deployed(path)
        .await
        .expect("the built-in scripts deploy");
}

fn directories(root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect::<Vec<PathBuf>>()
        })
        .unwrap_or_default();
    dirs.sort();
    dirs
}

/// Waits for the writer to catch up: recordings are written by a task of their
/// own, so a test has to wait for the files rather than assume they landed.
async fn settled<F>(root: &Path, ready: F) -> Vec<PathBuf>
where
    F: Fn(&[PathBuf]) -> bool,
{
    for _ in 0..600 {
        let dirs = directories(root);
        if ready(&dirs) {
            return dirs;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the recordings never settled: {:?}", directories(root));
}

fn read_json(root: &Path, name: &str) -> Value {
    let bytes = std::fs::read(root.join(name)).unwrap_or_else(|_| panic!("{name} is there"));
    serde_json::from_slice(&bytes).expect("the file is JSON")
}

fn calls(root: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(root.join("calls.jsonl")).expect("the calls are there");
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("one JSON line"))
        .collect()
}

/// The directory whose one call line has this config in it.
fn of<'a>(dirs: &'a [PathBuf], name: &str) -> &'a PathBuf {
    dirs.iter()
        .find(|dir| {
            dir.file_name()
                .and_then(|file| file.to_str())
                .is_some_and(|file| file.contains(name))
        })
        .unwrap_or_else(|| panic!("no directory of {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_record_says_the_status_the_body_and_the_reason_underneath() {
    deploy_scripts().await;
    let temp = tempfile::tempdir().expect("a directory to record into");
    let root = record_into(temp.path()).await;

    // A provider that refuses with an explanation of its own.
    let refusing = serve(Router::new().route(
        "/v1/responses",
        post(|_body: Bytes| async {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": { "message": "the studio is closed" },
                })),
            )
        }),
    ))
    .await;
    let refusal = channel("refusing", format!("{refusing}/v1/responses"));
    let error = for_protocol(Protocol::new("openaiResponses"))
        .generate(&refusal, &generation(), &[], &Cancel::new())
        .await
        .expect_err("the provider refused");
    assert_eq!(error.code(), "PROVIDER_UNAVAILABLE");
    let said = error.to_string();
    assert!(said.contains("status 503"), "{said}");
    assert!(said.contains("the studio is closed"), "{said}");

    // A provider that is not there at all: nothing answers, so the reason is
    // the transport's own, one layer under reqwest's first line.
    let unreachable = channel("unreachable", format!("{}/v1/responses", closed_address()));
    let error = for_protocol(Protocol::new("openaiResponses"))
        .generate(&unreachable, &generation(), &[], &Cancel::new())
        .await
        .expect_err("nothing answered");
    assert_eq!(error.code(), "PROVIDER_UNAVAILABLE");
    let said = error.to_string();
    assert!(said.contains("error sending request for url"), "{said}");
    assert!(
        said.contains("client error (Connect)"),
        "the reason under the outer line should survive: {said}"
    );

    let dirs = settled(&root, |dirs| {
        dirs.len() >= 2
            && dirs
                .iter()
                .all(|dir| dir.join("response.json").exists() && dir.join("calls.jsonl").exists())
    })
    .await;

    // The refusal: the status it gave, and its own words in the body.
    let refused = of(&dirs, "refusing-config");
    let line = &calls(refused)[0];
    assert_eq!(line["status"], 503);
    assert_eq!(line["response"]["error"]["message"], "the studio is closed");
    let response = read_json(refused, "response.json");
    assert_eq!(response["ok"], false);
    let message = response["error"]["message"]
        .as_str()
        .expect("a message is recorded");
    assert!(message.contains("status 503"), "{message}");
    assert!(message.contains("the studio is closed"), "{message}");

    // The silence: no status to record, and the whole chain as the reason.
    let missing = of(&dirs, "unreachable-config");
    let line = &calls(missing)[0];
    assert!(line["status"].is_null(), "{line}");
    let recorded = line["error"].as_str().expect("the reason is recorded");
    assert!(
        recorded.contains("error sending request for url"),
        "{recorded}"
    );
    assert!(
        recorded.contains("client error (Connect)"),
        "the proxy/connection reason should be recorded: {recorded}"
    );
    let response = read_json(missing, "response.json");
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "PROVIDER_UNAVAILABLE");
    let message = response["error"]["message"]
        .as_str()
        .expect("a message is recorded");
    assert!(
        message.contains("client error (Connect)"),
        "the reason under the outer line should reach the record: {message}"
    );
}
