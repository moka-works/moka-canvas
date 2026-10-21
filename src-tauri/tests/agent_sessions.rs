//! Conversations live beside the document: these tests hold that boundary.

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

async fn create_project(app: &axum::Router, directory: &Path, name: &str) {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({"directory": directory.to_string_lossy(), "name": name}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

fn message(id: &str, role: &str, text: &str) -> Value {
    json!({
        "id": id,
        "role": role,
        "text": text,
        "createdAt": "2026-10-21T09:00:00Z",
    })
}

#[tokio::test]
async fn a_session_is_kept_beside_the_document_and_never_moves_its_revision() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project, "Lake").await;

    let before = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let revision = body_json(before).await["moka"]["metadata"]["revision"].clone();

    let created = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/agent/sessions",
            json!({"title": "湖边", "scope": {"room": "canvas"}}),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let session = body_json(created).await["session"].clone();
    let id = session["id"].as_str().unwrap().to_string();

    let appended = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/agent/sessions/{id}/messages"),
            message("m_1", "user", "把这段剪到 20 秒"),
        ))
        .await
        .unwrap();
    assert_eq!(appended.status(), StatusCode::OK);

    let after = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let after = body_json(after).await;
    assert_eq!(
        after["moka"]["metadata"]["revision"], revision,
        "a chat does not move the document"
    );

    let read = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/agent/sessions/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let read = body_json(read).await;
    assert_eq!(read["session"]["messages"][0]["text"], "把这段剪到 20 秒");
    assert!(std::path::Path::new(&format!(
        "{}/agent/sessions/{id}.json",
        project.to_string_lossy()
    ))
    .exists());
}

#[tokio::test]
async fn sessions_are_listed_searched_renamed_and_deleted() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project, "Lake").await;

    let first = body_json(
        app.clone()
            .oneshot(json_request(
                "POST",
                "/api/v1/agent/sessions",
                json!({"title": "First"}),
            ))
            .await
            .unwrap(),
    )
    .await["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    app.clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/agent/sessions/{first}/messages"),
            message("m_1", "user", "please add a crossfade to the lake"),
        ))
        .await
        .unwrap();
    let second = body_json(
        app.clone()
            .oneshot(json_request(
                "POST",
                "/api/v1/agent/sessions",
                json!({"title": "Second"}),
            ))
            .await
            .unwrap(),
    )
    .await["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let listed = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/agent/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(listed["sessions"].as_array().unwrap().len(), 2);

    let searched = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/agent/sessions?q=crossfade")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(searched["sessions"].as_array().unwrap().len(), 1);
    assert!(searched["sessions"][0]["snippet"]
        .as_str()
        .unwrap()
        .contains("crossfade"));

    let renamed = app
        .clone()
        .oneshot(json_request(
            "PATCH",
            &format!("/api/v1/agent/sessions/{second}"),
            json!({"title": "Renamed"}),
        ))
        .await
        .unwrap();
    assert_eq!(body_json(renamed).await["session"]["title"], "Renamed");

    let deleted = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/agent/sessions/delete",
            json!({"ids": [first, second]}),
        ))
        .await
        .unwrap();
    assert_eq!(body_json(deleted).await["deleted"], 2);

    let missing = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/agent/sessions/{first}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_retried_message_is_not_written_twice() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project, "Lake").await;
    let id = body_json(
        app.clone()
            .oneshot(json_request(
                "POST",
                "/api/v1/agent/sessions",
                json!({"title": "Retry"}),
            ))
            .await
            .unwrap(),
    )
    .await["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    for _ in 0..2 {
        let response = app
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/v1/agent/sessions/{id}/messages"),
                message("m_1", "user", "hello"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let read = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/agent/sessions/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(read["session"]["messages"].as_array().unwrap().len(), 1);
}
