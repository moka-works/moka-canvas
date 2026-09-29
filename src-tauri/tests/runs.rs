use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, AppConfig, RuntimeMode};
use serde_json::{json, Value};
use std::path::Path;
use tower::ServiceExt;

fn test_app(root: &Path) -> axum::Router {
    test_app_with(parse_test_config(root))
}

fn test_app_with(config: AppConfig) -> axum::Router {
    let root = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    let state = ApiState::new(config, RuntimeMode::Web, &root).expect("the metadata store opens");
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

async fn create_project(app: &axum::Router, directory: &Path, name: &str) -> Value {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({
                "directory": directory.to_string_lossy(),
                "name": name,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    body_json(response).await
}

fn text_node(id: &str, content: &str) -> Value {
    json!({
        "id": id,
        "kind": "text",
        "title": "Script",
        "bounds": { "x": 0.0, "y": 0.0, "width": 280.0, "height": 200.0 },
        "zIndex": 0,
        "ports": [
            { "id": "out", "direction": "output", "dataTypes": ["text"], "required": false, "cardinality": "one", "label": "Text" }
        ],
        "data": { "content": content },
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    })
}

fn image_node(id: &str, asset_id: &str) -> Value {
    json!({
        "id": id,
        "kind": "image",
        "title": "Still",
        "bounds": { "x": 0.0, "y": 320.0, "width": 280.0, "height": 200.0 },
        "zIndex": 0,
        "ports": [
            { "id": "out", "direction": "output", "dataTypes": ["image"], "required": false, "cardinality": "one", "label": "Image" }
        ],
        "data": { "assetId": asset_id },
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    })
}

fn operation_node(id: &str, parameters: Value) -> Value {
    json!({
        "id": id,
        "kind": "operation",
        "title": "Join",
        "bounds": { "x": 420.0, "y": 0.0, "width": 300.0, "height": 220.0 },
        "zIndex": 0,
        "ports": [
            { "id": "text", "direction": "input", "dataTypes": ["text"], "required": false, "cardinality": "many", "label": "Text" },
            { "id": "images", "direction": "input", "dataTypes": ["image"], "required": false, "cardinality": "many", "label": "Images" },
            { "id": "audio", "direction": "input", "dataTypes": ["audio"], "required": false, "cardinality": "one", "label": "Audio" },
            { "id": "video", "direction": "input", "dataTypes": ["video"], "required": false, "cardinality": "one", "label": "Video" },
            { "id": "out", "direction": "output", "dataTypes": ["text", "image", "audio", "video"], "required": false, "cardinality": "many", "label": "Result" }
        ],
        "data": {
            "operationType": "deterministic.text",
            "parameters": parameters,
            "executorKey": "deterministic",
            "resultSlots": [],
            "resultNodeIds": []
        },
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    })
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

/// Builds text → operation (joined) and returns the canvas id.
async fn build_text_flow(app: &axum::Router, canvas_id: &str, op_params: Value) {
    apply(
        app,
        json!([
            { "type": "addNode", "canvasId": canvas_id, "node": text_node("n-text", "A lantern floats over a quiet lake.") },
            { "type": "addNode", "canvasId": canvas_id, "node": operation_node("n-op", op_params) },
            { "type": "addEdge", "canvasId": canvas_id, "edge": edge("e-1", ("n-text", "out"), ("n-op", "text")) }
        ]),
    )
    .await;
}

async fn start_run(
    app: &axum::Router,
    canvas_id: &str,
    node_ids: Value,
) -> axum::http::Response<Body> {
    app.clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/runs",
            json!({ "canvasId": canvas_id, "nodeIds": node_ids }),
        ))
        .await
        .unwrap()
}

async fn run_state(app: &axum::Router, run_id: &str) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/runs/{run_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

async fn wait_for_terminal(app: &axum::Router, run_id: &str) -> Value {
    for _ in 0..200 {
        let run = run_state(app, run_id).await;
        let status = run["status"].as_str().unwrap();
        if status != "queued" && status != "running" {
            return run;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("run {run_id} did not reach a terminal state");
}

#[tokio::test]
async fn valid_run_succeeds_and_survives_a_restart() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Runs").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let root = created["root"].as_str().unwrap().to_string();
    build_text_flow(&app, &canvas_id, json!({})).await;

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let run = body_json(response).await;
    let run_id = run["id"].as_str().unwrap().to_string();
    assert_eq!(run["status"], "queued");
    assert_eq!(run["executorKey"], "deterministic");
    assert!(!run["graphHash"].as_str().unwrap().is_empty());

    let finished = wait_for_terminal(&app, &run_id).await;
    assert_eq!(finished["status"], "succeeded");
    let steps = finished["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0]["nodeId"], "n-text");
    assert_eq!(steps[0]["status"], "succeeded");
    assert_eq!(
        steps[0]["outputText"],
        json!("A lantern floats over a quiet lake.")
    );
    assert_eq!(steps[1]["nodeId"], "n-op");
    assert_eq!(steps[1]["status"], "succeeded");
    assert_eq!(
        steps[1]["outputText"],
        json!("A lantern floats over a quiet lake.")
    );

    // The run record is a durable file inside the project.
    let record_path = Path::new(&root)
        .join("history")
        .join("runs")
        .join(format!("{run_id}.json"));
    assert!(record_path.is_file());

    // The result slot was promoted into the document.
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
    let doc = body_json(current).await;
    let nodes = doc["moka"]["canvas"][0]["nodes"].as_array().unwrap();
    let op = nodes.iter().find(|node| node["id"] == "n-op").unwrap();
    let slots = op["data"]["resultSlots"].as_array().unwrap();
    assert_eq!(slots.len(), 1, "one answer, one slot");
    assert_eq!(slots[0]["status"], "succeeded");
    assert_eq!(
        slots[0]["text"],
        json!("A lantern floats over a quiet lake.")
    );
    assert_eq!(slots[0]["isPrimary"], true);
    assert_eq!(
        op["data"]["resultNodeIds"].as_array().unwrap().len(),
        0,
        "one answer needs no card beside the node that made it"
    );
    // An operation node has no words of its own: what it made travels in the
    // slot, and the document carries a content key on a text node only.
    assert!(op["data"].get("content").is_none(), "{}", op["data"]);

    // The node the answer came from was only read, so a run left nothing on it.
    let text = nodes.iter().find(|node| node["id"] == "n-text").unwrap();
    assert!(
        text["data"].get("resultSlots").is_none(),
        "{}",
        text["data"]
    );

    // A brand-new server over the same project sees the finished run. The
    // metadata directory is locked per process, so the restart has to be real.
    drop(app);
    let reopened_app = test_app(temp.path());
    let response = reopened_app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/open",
            json!({ "path": root }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = reopened_app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/runs/{run_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["status"], "succeeded");
}

#[tokio::test]
async fn invalid_runs_are_rejected_with_all_issues() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Invalid").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    apply(
        &app,
        json!([
            { "type": "addNode", "canvasId": canvas_id, "node": text_node("n-text", "hello") },
            { "type": "addNode", "canvasId": canvas_id, "node": operation_node("n-op", json!({})) }
        ]),
    )
    .await;

    // Missing node, non-executable node, and an unresolved required input.
    let response = start_run(&app, &canvas_id, json!(["nope"])).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "RUN_VALIDATION_FAILED");
    let codes: Vec<&str> = problem["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"NODE_NOT_FOUND"));

    let response = start_run(&app, &canvas_id, json!(["n-text"])).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    let codes: Vec<&str> = problem["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"NOT_EXECUTABLE"));

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    let codes: Vec<&str> = problem["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"PORT_UNRESOLVED"));

    // Nothing was persisted for rejected runs.
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body_json(response).await.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn unknown_parameters_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Params").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    build_text_flow(&app, &canvas_id, json!({ "bogus": true })).await;

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    let codes: Vec<&str> = problem["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"PARAM_INVALID"));
}

#[tokio::test]
async fn disabled_executor_blocks_the_run() {
    let temp = tempfile::tempdir().unwrap();
    let mut config = parse_test_config(temp.path());
    config.workflow.enabled_executors = Vec::new();
    let app = test_app_with(config);
    let created = create_project(&app, &temp.path().join("projects"), "Disabled").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    build_text_flow(&app, &canvas_id, json!({})).await;

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    let codes: Vec<&str> = problem["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"EXECUTOR_DISABLED"));
}

#[tokio::test]
async fn missing_asset_blocks_the_run() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let (canvas_id, root, entry_path) = project_with_one_picture(&app, temp.path()).await;

    // Delete the underlying file: the registry entry stays, the bytes are gone.
    std::fs::remove_file(Path::new(&root).join(&entry_path)).unwrap();

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    let codes: Vec<&str> = problem["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"ASSET_NOT_READY"));
}

/// The size an entry recorded is what a run reads before it starts: a file of
/// another length is not the material the node was placed with.
#[tokio::test]
async fn a_run_refuses_an_asset_whose_length_moved() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let (canvas_id, root, entry_path) = project_with_one_picture(&app, temp.path()).await;

    std::fs::write(
        Path::new(&root).join(&entry_path),
        b"not the picture that was filed",
    )
    .unwrap();

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    let codes: Vec<&str> = problem["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"ASSET_NOT_READY"));
}

/// A file rewritten in place kept its length, and a run is not where that is
/// found out: reading every asset a run is about to use is what the project's
/// own check does behind the room, and doing it again here would put gigabytes
/// of video between a reader and the Run button.
#[tokio::test]
async fn a_run_does_not_read_an_asset_that_kept_its_length() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let (canvas_id, root, entry_path) = project_with_one_picture(&app, temp.path()).await;

    let mut edited = make_test_png();
    let middle = edited.len() / 2;
    edited[middle] ^= 0xff;
    std::fs::write(Path::new(&root).join(&entry_path), &edited).unwrap();

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let run_id = body_json(response).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let finished = wait_for_terminal(&app, &run_id).await;
    assert_eq!(finished["status"], "succeeded");
}

/// A project holding one picture on a canvas with a join above it, which is
/// what the run tests about assets all begin from.
async fn project_with_one_picture(app: &axum::Router, home: &Path) -> (String, String, String) {
    let created = create_project(app, &home.join("projects"), "Unready").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let root = created["root"].as_str().unwrap().to_string();

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            "still.png",
            &make_test_png(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let asset_id = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    apply(
        app,
        json!([
            { "type": "addNode", "canvasId": canvas_id, "node": text_node("n-text", "caption") },
            { "type": "addNode", "canvasId": canvas_id, "node": image_node("n-img", &asset_id) },
            { "type": "addNode", "canvasId": canvas_id, "node": operation_node("n-op", json!({})) },
            { "type": "addEdge", "canvasId": canvas_id, "edge": edge("e-1", ("n-text", "out"), ("n-op", "text")) },
            { "type": "addEdge", "canvasId": canvas_id, "edge": edge("e-2", ("n-img", "out"), ("n-op", "images")) }
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
    let doc = body_json(current).await;
    let entry_path = doc["moka"]["resources"]["images"][0]["path"]
        .as_str()
        .unwrap()
        .to_string();
    (canvas_id, root, entry_path)
}

#[tokio::test]
async fn cancel_stops_a_running_run() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Cancel").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    build_text_flow(&app, &canvas_id, json!({ "delayMs": 8000 })).await;

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let run_id = body_json(response).await["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Wait until the op step is actually executing.
    let mut saw_running = false;
    for _ in 0..100 {
        let run = run_state(&app, &run_id).await;
        if run["status"] == "running" {
            saw_running = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(saw_running);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/projects/current/runs/{run_id}/cancel"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["cancelRequested"], true);

    let finished = wait_for_terminal(&app, &run_id).await;
    assert_eq!(finished["status"], "cancelled");
    assert_eq!(finished["cancelRequested"], true);
    let steps = finished["steps"].as_array().unwrap();
    assert_eq!(steps[0]["nodeId"], "n-text");
    assert_eq!(steps[0]["status"], "succeeded");
    assert_eq!(steps[1]["nodeId"], "n-op");
    assert_eq!(steps[1]["status"], "cancelled");

    // Cancellation produced no output, so no result slot is written.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let doc = body_json(response).await;
    let nodes = doc["moka"]["canvas"][0]["nodes"].as_array().unwrap();
    let op = nodes.iter().find(|node| node["id"] == "n-op").unwrap();
    assert_eq!(op["data"]["resultSlots"].as_array().unwrap().len(), 0);

    // Cancelling a finished run is a conflict.
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/projects/current/runs/{run_id}/cancel"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(response).await["code"], "RUN_NOT_CANCELLABLE");
}

#[tokio::test]
async fn failed_run_retries_as_a_new_linked_run() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Retry").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    build_text_flow(&app, &canvas_id, json!({ "failWith": "boom" })).await;

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let failed_id = body_json(response).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let failed = wait_for_terminal(&app, &failed_id).await;
    assert_eq!(failed["status"], "failed");
    assert!(failed["error"].as_str().unwrap().contains("boom"));
    // The run and the step that stopped it both say what kind of trouble it
    // was, which is what a client says again in the reader's own language.
    assert_eq!(failed["errorCode"], json!("STEP_FAILED"));
    let steps = failed["steps"].as_array().unwrap();
    let stopped = steps
        .iter()
        .find(|step| step["status"] == json!("failed"))
        .expect("the step that stopped the run");
    assert_eq!(stopped["errorCode"], json!("STEP_FAILED"));

    // The failure also landed on the node's result slot.
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
    let doc = body_json(current).await;
    let nodes = doc["moka"]["canvas"][0]["nodes"].as_array().unwrap();
    let op = nodes.iter().find(|node| node["id"] == "n-op").unwrap();
    let slots = op["data"]["resultSlots"].as_array().unwrap();
    assert_eq!(slots.len(), 1);
    assert_eq!(slots[0]["status"], "failed");
    assert!(
        slots[0]["error"].as_str().unwrap().contains("boom"),
        "{}",
        slots[0]
    );
    assert!(slots[0]["text"].is_null(), "a failure made nothing to show");
    // A failed attempt files nothing and takes nothing away: the node upstream
    // still holds the words it was written with.
    assert!(op["data"].get("assetId").is_none(), "{}", op["data"]);
    let text = nodes.iter().find(|node| node["id"] == "n-text").unwrap();
    assert_eq!(
        text["data"]["content"],
        json!("A lantern floats over a quiet lake.")
    );

    // Fix the parameters, then retry: a new run linked to the failed one.
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
    let doc = body_json(current).await;
    let revision = doc["moka"]["metadata"]["revision"].as_i64().unwrap();
    let nodes = doc["moka"]["canvas"][0]["nodes"].as_array().unwrap();
    let op = nodes.iter().find(|node| node["id"] == "n-op").unwrap();
    let mut data = op["data"].clone();
    data["parameters"] = json!({});
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision,
                "commands": [
                    { "type": "updateNode", "canvasId": canvas_id, "nodeId": "n-op", "patch": { "data": data } }
                ]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/projects/current/runs/{failed_id}/retry"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let retry = body_json(response).await;
    assert_eq!(retry["retryOfRunId"], json!(failed_id));
    let retry_id = retry["id"].as_str().unwrap().to_string();
    let retried = wait_for_terminal(&app, &retry_id).await;
    assert_eq!(retried["status"], "succeeded");

    // A succeeded run cannot be retried.
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/projects/current/runs/{retry_id}/retry"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(response).await["code"], "RUN_NOT_RETRYABLE");
}

#[tokio::test]
async fn interrupted_runs_are_failed_on_open() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Sweep").await;
    let root = created["root"].as_str().unwrap().to_string();

    // Simulate a run record orphaned by a dead process.
    let orphan = json!({
        "id": "0192b7d4-7f2a-7c53-9d21-5a4b3c2d1e0f",
        "projectId": created["moka"]["metadata"]["id"],
        "canvasId": created["moka"]["canvas"][0]["id"],
        "requestedNodeIds": ["n-op"],
        "status": "running",
        "executorKey": "deterministic",
        "graphHash": "abc",
        "parameters": {},
        "steps": [
            { "nodeId": "n-op", "status": "running" }
        ],
        "cancelRequested": false,
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    });
    let runs_dir = Path::new(&root).join("history").join("runs");
    std::fs::create_dir_all(&runs_dir).unwrap();
    std::fs::write(
        runs_dir.join("0192b7d4-7f2a-7c53-9d21-5a4b3c2d1e0f.json"),
        serde_json::to_vec_pretty(&orphan).unwrap(),
    )
    .unwrap();

    // Reopening sweeps the orphan into a failed record.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/open",
            json!({ "path": root }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let swept = run_state(&app, "0192b7d4-7f2a-7c53-9d21-5a4b3c2d1e0f").await;
    assert_eq!(swept["status"], "failed");
    assert!(swept["error"].as_str().unwrap().contains("stopped"));
    assert_eq!(swept["steps"][0]["status"], "failed");
}

#[tokio::test]
async fn unknown_run_is_not_found() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Missing").await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current/runs/0192b7d4-0000-7000-8000-000000000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // Path-traversal shaped ids never reach the filesystem.
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current/runs/..%2F..%2Fcanvas")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// A step that waits on an upstream job records the handle and how far along it
/// is; a step that was waited out leaves the handle out of the file rather than
/// writing a null, and so does a step whose executor never said how far it got.
///
/// The second half matters more than the first. `list_runs` skips a record it
/// cannot parse, so a shape only a newer build understands would not error — it
/// would quietly drop that run from the history.
#[tokio::test]
async fn a_step_records_the_job_it_is_waiting_on() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Runs").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let root = created["root"].as_str().unwrap().to_string();
    build_text_flow(&app, &canvas_id, json!({})).await;

    let response = start_run(&app, &canvas_id, json!(["n-op"])).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let run_id = body_json(response).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for_terminal(&app, &run_id).await;

    let record_path = Path::new(&root)
        .join("history")
        .join("runs")
        .join(format!("{run_id}.json"));
    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&record_path).unwrap()).unwrap();
    for step in written["steps"].as_array().unwrap() {
        assert!(
            step.get("taskId").is_none(),
            "a step nobody gave a job to names none: {step}"
        );
        // How far a step got is a fraction or nothing at all: an executor that
        // never said leaves the key out, and a null would be a third shape for
        // a build reading this file to make sense of.
        assert!(
            step.get("progress")
                .is_none_or(|reached| reached.is_number()),
            "how far a step got is a fraction or absent: {step}"
        );
    }

    // The same file, edited to look like a step still waiting on a shot.
    let mut resumed = written;
    let step = &mut resumed["steps"].as_array_mut().unwrap()[1];
    step["status"] = json!("running");
    step["taskId"] = json!("0197c8a2-1111-7222-8333-444444444444");
    step["taskCreatedAt"] = json!("2026-09-09T10:00:00Z");
    step["progress"] = json!(0.25);
    std::fs::write(&record_path, serde_json::to_vec(&resumed).unwrap()).unwrap();

    let read = run_state(&app, &run_id).await;
    assert_eq!(
        read["steps"][1]["taskId"],
        json!("0197c8a2-1111-7222-8333-444444444444")
    );
    assert_eq!(
        read["steps"][1]["taskCreatedAt"],
        json!("2026-09-09T10:00:00Z")
    );
    assert_eq!(read["steps"][1]["progress"], json!(0.25));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let listed = body_json(response).await;
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|run| run["id"] == json!(run_id)),
        "a record carrying the newer fields is still listed: {listed}"
    );
}
