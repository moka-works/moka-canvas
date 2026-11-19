//! What a node will send, asked before anything is sent.
//!
//! The resolver has tests of its own over a document in memory; what is checked
//! here is the route that hands it to the editor. That the answer carries the
//! prompt as a run will send it and each reference with what the project
//! recorded about it, that a reference whose file has gone says so rather than
//! arriving looking like any other, that a mention naming a node the canvas has
//! never heard of is reported, that text too long to send is reported by how
//! much, and that a node with nothing to generate, a node that is not there, and
//! no project at all each get their own refusal.

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use moka_canvas::domain::commands::make_node;
use moka_canvas::domain::{
    now_iso, Capability, GenerationInputMode, GenerationMode, GenerationSpec, NodeKind,
};
use serde_json::{json, Value};
use std::path::Path;
use tower::ServiceExt;

fn test_app(root: &Path) -> axum::Router {
    let config = parse_test_config(root);
    let metadata = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    let state =
        ApiState::new(config, RuntimeMode::Web, &metadata).expect("the metadata store opens");
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

fn multipart_request(uri: &str, filename: &str, bytes: &[u8]) -> Request<Body> {
    let boundary = "X-MOKA-PREVIEW-TEST";
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

fn make_test_png() -> Vec<u8> {
    let mut png = image::RgbaImage::new(8, 8);
    for pixel in png.pixels_mut() {
        *pixel = image::Rgba([40, 200, 120, 255]);
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

/// Uploads one picture and answers with the id the project filed it under.
async fn upload_png(app: &axum::Router) -> String {
    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            "lantern.png",
            &make_test_png(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    body_json(response).await["entry"]["id"]
        .as_str()
        .expect("an uploaded asset is answered with its id")
        .to_string()
}

async fn create_project(app: &axum::Router, directory: &Path, name: &str) -> Value {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({ "directory": directory.to_string_lossy(), "name": name }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    body_json(response).await
}

fn node(kind: NodeKind, id: &str) -> moka_canvas::domain::WorkflowNode {
    let mut made = make_node(kind, id.to_string(), 0.0, 0.0);
    made.id = id.to_string();
    made
}

fn text_node(id: &str, content: &str) -> Value {
    let mut made = node(NodeKind::Text, id);
    made.data.content = Some(content.to_string());
    serde_json::to_value(&made).expect("a node is sent as it is stored")
}

fn image_node(id: &str, asset_id: &str) -> Value {
    let mut made = node(NodeKind::Image, id);
    made.data.asset_id = Some(asset_id.to_string());
    serde_json::to_value(&made).expect("a node is sent as it is stored")
}

/// The node being previewed: an image node with a generation of its own.
fn asking(id: &str, mode: GenerationInputMode, prompt: &str, references: Value) -> Value {
    let mut made = node(NodeKind::Image, id);
    made.data.generation = Some(GenerationSpec {
        capability: Capability::Image,
        mode: GenerationMode::Generate,
        model: String::new(),
        prompt: prompt.to_string(),
        input_mode: mode,
        params: None,
        reference_node_ids: if references.is_null() {
            None
        } else {
            Some(
                references
                    .as_array()
                    .expect("references arrive as a list")
                    .iter()
                    .map(|one| one.as_str().expect("each reference is an id").to_string())
                    .collect(),
            )
        },
        updated_at: now_iso(),
    });
    serde_json::to_value(&made).expect("a node is sent as it is stored")
}

fn edge(id: &str, source: (&str, &str), target: (&str, &str)) -> Value {
    json!({
        "id": id,
        "source": { "nodeId": source.0, "portId": source.1 },
        "target": { "nodeId": target.0, "portId": target.1 },
        "createdAt": "2026-01-01T00:00:00Z"
    })
}

async fn apply(app: &axum::Router, commands: Value) -> Value {
    let current = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let revision = body_json(current).await["moka"]["metadata"]["revision"]
        .as_i64()
        .unwrap();
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({ "expectedRevision": revision, "commands": commands }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

async fn preview(app: &axum::Router, canvas_id: &str, node_id: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/generate/preview",
            json!({ "canvasId": canvas_id, "nodeId": node_id }),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, body_json(response).await)
}

/// Opens a project under the server's own temporary tree and answers with its
/// first canvas and the directory it was filed in.
async fn opened(app: &axum::Router, root: &Path, name: &str) -> (String, String) {
    let created = create_project(app, &root.join("projects"), name).await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .expect("a new project answers with its first canvas")
        .to_string();
    let project_root = created["root"]
        .as_str()
        .expect("a new project answers with where it was filed")
        .to_string();
    (canvas_id, project_root)
}

#[tokio::test]
async fn a_preview_answers_with_the_prompt_a_run_will_send() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let (canvas_id, _) = opened(&app, temp.path(), "Preview").await;
    let asset_id = upload_png(&app).await;

    apply(
        &app,
        json!([
            { "type": "addNode", "canvasId": canvas_id, "node": text_node("n-brief", "A lantern over a lake.") },
            { "type": "addNode", "canvasId": canvas_id, "node": image_node("n-subject", &asset_id) },
            { "type": "addNode", "canvasId": canvas_id, "node": asking("n-poster", GenerationInputMode::Upstream, "Paint a poster.", Value::Null) },
            { "type": "addEdge", "canvasId": canvas_id, "edge": edge("e-text", ("n-brief", "out"), ("n-poster", "prompt")) },
            { "type": "addEdge", "canvasId": canvas_id, "edge": edge("e-image", ("n-subject", "out"), ("n-poster", "images")) }
        ]),
    )
    .await;

    let (status, body) = preview(&app, &canvas_id, "n-poster").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["prompt"], "Paint a poster.\n\n[Text 1]\nA lantern over a lake.",
        "the words a run sends, not the ones the node holds"
    );
    assert_eq!(body["truncatedChars"], 0);
    assert_eq!(body["unresolved"], json!([]));

    let inputs = body["inputs"].as_array().expect("references are listed");
    assert_eq!(inputs.len(), 1);
    let one = &inputs[0];
    assert_eq!(one["role"], "reference");
    assert_eq!(one["assetId"], asset_id);
    assert_eq!(one["nodeId"], "n-subject", "which card the reference is");
    assert_eq!(one["mime"], "image/png", "measured at upload, not declared");
    assert_eq!(one["width"], 8);
    assert_eq!(one["height"], 8);
    assert_eq!(one["missing"], false);
    assert!(one["bytes"].as_i64().unwrap_or_default() > 0);
}

/// A file that has gone is the one case a preview has to say out loud: the
/// reference still looks like any other on the canvas, and a run trips over it.
#[tokio::test]
async fn a_reference_whose_file_has_gone_says_so() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let (canvas_id, project_root) = opened(&app, temp.path(), "Gone").await;
    let asset_id = upload_png(&app).await;

    apply(
        &app,
        json!([
            { "type": "addNode", "canvasId": canvas_id, "node": image_node("n-subject", &asset_id) },
            { "type": "addNode", "canvasId": canvas_id, "node": asking("n-poster", GenerationInputMode::Upstream, "Paint from it.", Value::Null) },
            { "type": "addEdge", "canvasId": canvas_id, "edge": edge("e-image", ("n-subject", "out"), ("n-poster", "images")) }
        ]),
    )
    .await;

    let current = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let path = body_json(current).await["moka"]["resources"]["images"][0]["path"]
        .as_str()
        .expect("a filed asset records where it went")
        .to_string();
    std::fs::remove_file(Path::new(&project_root).join(&path))
        .expect("the file is removed from under it");

    let (status, body) = preview(&app, &canvas_id, "n-poster").await;
    assert_eq!(status, StatusCode::OK);
    let inputs = body["inputs"].as_array().expect("references are listed");
    assert_eq!(
        inputs.len(),
        1,
        "listed, because dropping it silently is the bug"
    );
    assert_eq!(inputs[0]["missing"], true);
    assert_eq!(
        inputs[0]["nodeId"], "n-subject",
        "and still attributed to its card"
    );
}

#[tokio::test]
async fn a_mention_naming_a_node_that_is_not_there_is_reported() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let (canvas_id, _) = opened(&app, temp.path(), "Dangling").await;

    apply(
        &app,
        json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster",
                GenerationInputMode::Mentions,
                "Paint @[node:n-deleted] in the style of @[node:n-gone] too.",
                Value::Null,
            ) }
        ]),
    )
    .await;

    let (status, body) = preview(&app, &canvas_id, "n-poster").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["unresolved"], json!(["n-deleted", "n-gone"]));
    assert!(body["inputs"].as_array().expect("a list").is_empty());
}

/// A reference picked by hand is the mode where the order is the priority, so
/// the list has to come back in the order it was written.
#[tokio::test]
async fn a_reference_list_keeps_the_order_it_was_written_in() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let (canvas_id, _) = opened(&app, temp.path(), "Ordered").await;
    let first = upload_png(&app).await;
    let second = upload_png(&app).await;

    apply(
        &app,
        json!([
            { "type": "addNode", "canvasId": canvas_id, "node": image_node("n-first", &first) },
            { "type": "addNode", "canvasId": canvas_id, "node": image_node("n-second", &second) },
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster",
                GenerationInputMode::Manual,
                "Paint from these.",
                json!(["n-second", "n-first"]),
            ) }
        ]),
    )
    .await;

    let (status, body) = preview(&app, &canvas_id, "n-poster").await;
    assert_eq!(status, StatusCode::OK);
    let inputs = body["inputs"].as_array().expect("references are listed");
    let nodes: Vec<&str> = inputs
        .iter()
        .map(|one| {
            one["nodeId"]
                .as_str()
                .expect("each reference names its card")
        })
        .collect();
    assert_eq!(
        nodes,
        ["n-second", "n-first"],
        "the wiring is ignored, as chosen"
    );
}

#[tokio::test]
async fn text_too_long_to_send_is_reported_by_how_much() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let (canvas_id, _) = opened(&app, temp.path(), "Overlong").await;
    let long = "a".repeat(20_100);

    apply(
        &app,
        json!([
            { "type": "addNode", "canvasId": canvas_id, "node": text_node("n-brief", &long) },
            { "type": "addNode", "canvasId": canvas_id, "node": asking("n-poster", GenerationInputMode::Upstream, "Paint.", Value::Null) },
            { "type": "addEdge", "canvasId": canvas_id, "edge": edge("e-text", ("n-brief", "out"), ("n-poster", "prompt")) }
        ]),
    )
    .await;

    let (status, body) = preview(&app, &canvas_id, "n-poster").await;
    assert_eq!(status, StatusCode::OK);
    let prompt = body["prompt"].as_str().expect("a prompt");
    assert_eq!(prompt.chars().count(), 20_000, "the cap a run is held to");
    assert!(
        body["truncatedChars"].as_u64().unwrap_or_default() > 0,
        "and the amount taken off is said rather than left to guess"
    );
}

#[tokio::test]
async fn a_node_with_nothing_to_generate_is_refused_on_its_own_terms() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let (canvas_id, _) = opened(&app, temp.path(), "Refusals").await;
    apply(
        &app,
        json!([{ "type": "addNode", "canvasId": canvas_id, "node": text_node("n-brief", "A lantern.") }]),
    )
    .await;

    let (status, body) = preview(&app, &canvas_id, "n-brief").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "GENERATION_SPEC_MISSING");

    let (status, body) = preview(&app, &canvas_id, "n-nothing").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "NODE_NOT_FOUND");

    let (status, body) = preview(&app, "canvas-gone", "n-brief").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "CANVAS_NOT_FOUND");
}

#[tokio::test]
async fn a_preview_with_no_project_open_says_so() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());

    let (status, body) = preview(&app, "canvas-1", "n-poster").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "PROJECT_NOT_OPEN");
}
