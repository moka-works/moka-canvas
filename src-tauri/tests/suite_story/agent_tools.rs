//! The tool contract end to end: a command is adopted by the document and can
//! be undone; an effect is refused without acknowledgement and leaves audit.

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, AppConfig, RuntimeMode};
use serde_json::{json, Value};
use std::path::Path;
use tower::ServiceExt;

fn open_state(config: AppConfig) -> ApiState {
    let root = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    ApiState::new(config, RuntimeMode::Web, &root).expect("the metadata store opens")
}

fn test_app(root: &Path) -> axum::Router {
    moka_canvas::server::router(open_state(parse_test_config(root)))
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

async fn create_project(app: &axum::Router, directory: &Path) {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({"directory": directory.to_string_lossy(), "name": "Tools"}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

async fn current(app: &axum::Router) -> Value {
    body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/projects/current")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await
}

async fn call_tool(app: &axum::Router, name: &str, body: Value) -> axum::http::Response<Body> {
    app.clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/agent/tools/{name}"),
            body,
        ))
        .await
        .unwrap()
}

#[tokio::test]
async fn a_command_tool_writes_the_document_and_can_be_undone() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;

    let opened = current(&app).await;
    let canvas_id = opened["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let revision = opened["moka"]["metadata"]["revision"].clone();

    let added = call_tool(
        &app,
        "canvas.add_node",
        json!({
            "actor": "ui",
            "input": {
                "canvasId": canvas_id,
                "kind": "text",
                "title": "Note",
                "text": "hello",
                "position": {"x": 10, "y": 20}
            }
        }),
    )
    .await;
    assert_eq!(added.status(), StatusCode::OK);
    let added = body_json(added).await;
    assert_eq!(added["ok"], true);
    assert_eq!(added["kind"], "command");
    assert_eq!(added["commands"][0]["type"], "addNode");
    assert!(added["changeSetId"].as_str().unwrap().starts_with("cs_"));
    assert_ne!(added["revision"], revision);

    let after = current(&app).await;
    assert_eq!(
        after["moka"]["canvas"][0]["nodes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        after["moka"]["canvas"][0]["nodes"][0]["data"]["content"],
        "hello"
    );

    let change_id = added["changeSetId"].as_str().unwrap().to_string();
    let undone = call_tool(
        &app,
        "project.self_check",
        json!({"actor": "ui", "input": {}}),
    )
    .await;
    assert_eq!(undone.status(), StatusCode::OK);

    let undo = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/agent/changes/{change_id}/undo"),
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(undo.status(), StatusCode::OK);
    let after_undo = current(&app).await;
    assert!(after_undo["moka"]["canvas"][0]["nodes"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_dry_run_plans_without_writing() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;
    let opened = current(&app).await;
    let canvas_id = opened["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let planned = call_tool(
        &app,
        "canvas.add_node",
        json!({
            "actor": "ui",
            "dryRun": true,
            "input": {"canvasId": canvas_id, "kind": "text", "title": "Draft"}
        }),
    )
    .await;
    assert_eq!(planned.status(), StatusCode::OK);
    let planned = body_json(planned).await;
    assert_eq!(planned["commands"][0]["type"], "addNode");
    assert!(planned.get("changeSetId").is_none());
    assert!(current(&app).await["moka"]["canvas"][0]["nodes"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_destroy_tool_without_acknowledgement_is_refused_before_anything_happens() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;
    let opened = current(&app).await;
    let canvas_id = opened["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let refused = call_tool(
        &app,
        "canvas.delete",
        json!({"actor": "ui", "input": {"canvasId": canvas_id, "confirm": "delete-canvas"}}),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    let refused = body_json(refused).await;
    assert_eq!(refused["code"], "AGENT_RISK_UNACKNOWLEDGED");
    assert_eq!(
        current(&app).await["moka"]["canvas"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn an_external_caller_cannot_see_or_run_an_app_tool() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;

    let catalog = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/agent/tools?surface=external")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    let names: Vec<&str> = catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(names.contains(&"canvas.add_node"));
    assert!(!names.contains(&"agent.ask"));

    let refused = call_tool(
        &app,
        "agent.ask",
        json!({"actor": "cli", "input": {"question": "which one?"}}),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::GONE);
    assert_eq!(body_json(refused).await["code"], "APP_ONLY_UNAVAILABLE");
}

#[tokio::test]
async fn the_catalog_hash_and_chat_scope_are_validated() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;

    let capabilities = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/agent/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    let hash = capabilities["catalogHash"].as_str().unwrap().to_string();
    assert!(hash.starts_with("sha256:"));

    let refused = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/agent/chat",
            json!({
                "catalogHash": "sha256:stale",
                "scope": {"room": "canvas"},
                "messages": [{"role": "user", "text": "hello"}]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::CONFLICT);
}
