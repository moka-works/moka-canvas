//! The interface-preference endpoints: a whole read, a partial write that
//! leaves other windows' fields alone, removal by `null`, and a reset.

use std::path::Path;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::Router;
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use serde_json::{json, Value};
use tower::ServiceExt;

fn harness(root: &Path) -> Router {
    let config = parse_test_config(root);
    let metadata = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    std::fs::create_dir_all(&metadata).expect("the metadata directory is created");
    let state = ApiState::new(config, RuntimeMode::Web, &metadata).expect("the store opens");
    moka_canvas::server::router(state)
}

fn json_request(method: &str, uri: &str, payload: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap()
}

fn plain_request(method: &str, uri: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("the request is served");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the response body is readable");
    let body = serde_json::from_slice(&bytes).expect("the response body is JSON");
    (status, body)
}

#[tokio::test]
async fn a_fresh_machine_reads_the_documented_defaults() {
    let root = tempfile::tempdir().unwrap();
    let app = harness(root.path());

    let (status, body) = send(&app, plain_request("GET", "/api/v1/ui-prefs")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["locale"], "system");
    assert_eq!(body["canvasTheme"], "graphite");
    assert_eq!(body["clipSnap"], true);
    assert_eq!(body["storyParallel"], 3);
    assert_eq!(body["panelFolds"], json!({ "left": false, "right": false }));
}

#[tokio::test]
async fn the_story_room_count_stays_within_what_the_room_can_use() {
    let root = tempfile::tempdir().unwrap();
    let app = harness(root.path());

    let (status, high) = send(
        &app,
        json_request("PATCH", "/api/v1/ui-prefs", json!({ "storyParallel": 99 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(high["storyParallel"], 8);

    let (status, low) = send(
        &app,
        json_request("PATCH", "/api/v1/ui-prefs", json!({ "storyParallel": 0 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(low["storyParallel"], 1);
}

#[tokio::test]
async fn a_partial_write_keeps_what_it_does_not_name() {
    let root = tempfile::tempdir().unwrap();
    let app = harness(root.path());

    let (status, first) = send(
        &app,
        json_request(
            "PATCH",
            "/api/v1/ui-prefs",
            json!({
                "locale": "zh",
                "clipTimelines": { "p1": "tl-1" },
                "storyPlaces": {
                    "p1": { "storyId": "s1", "step": "outline" }
                }
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["locale"], "zh");
    assert_eq!(first["clipTimelines"]["p1"], "tl-1");

    // Another window changes only the palette.
    let (status, second) = send(
        &app,
        json_request(
            "PATCH",
            "/api/v1/ui-prefs",
            json!({ "canvasTheme": "paper" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["canvasTheme"], "paper");
    assert_eq!(second["locale"], "zh");
    assert_eq!(second["clipTimelines"]["p1"], "tl-1");
    assert_eq!(second["storyPlaces"]["p1"]["storyId"], "s1");

    // A null entry removes just that row.
    let (status, third) = send(
        &app,
        json_request(
            "PATCH",
            "/api/v1/ui-prefs",
            json!({ "clipTimelines": { "p1": null } }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(third["clipTimelines"].get("p1").is_none(), "{third}");
    assert_eq!(third["storyPlaces"]["p1"]["step"], "outline");

    let (_, reread) = send(&app, plain_request("GET", "/api/v1/ui-prefs")).await;
    assert_eq!(reread, third);
}

#[tokio::test]
async fn a_reset_returns_the_defaults() {
    let root = tempfile::tempdir().unwrap();
    let app = harness(root.path());

    send(
        &app,
        json_request(
            "PATCH",
            "/api/v1/ui-prefs",
            json!({ "locale": "en", "stageSplit": 0.3 }),
        ),
    )
    .await;

    let (status, body) = send(&app, plain_request("DELETE", "/api/v1/ui-prefs")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["locale"], "system");
    assert_eq!(body["stageSplit"], 0.6);
}
