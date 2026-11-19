//! Tool planners against a real document: the cutting room, the story room,
//! and the shelf's effect path.

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
            json!({"directory": directory.to_string_lossy(), "name": "Workflows"}),
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

async fn call(app: &axum::Router, name: &str, input: Value) -> Value {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/agent/tools/{name}"),
            json!({"actor": "ui", "acknowledgeRisk": true, "input": input}),
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = body_json(response).await;
    assert_eq!(status, StatusCode::OK, "{name}: {body}");
    body
}

#[tokio::test]
async fn a_cutting_room_plan_creates_splits_and_joins_clips() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;

    let created = call(&app, "timeline.create", json!({"name": "Cut"})).await;
    let timeline_id = created["data"]["timelineId"].as_str().unwrap().to_string();
    assert_eq!(created["commands"][0]["type"], "addTimeline");

    let added = call(
        &app,
        "clip.add",
        json!({
            "timelineId": timeline_id,
            "kind": "text",
            "startMs": 0,
            "durationMs": 3000,
            "text": {"content": "The lake"}
        }),
    )
    .await;
    let clip_id = added["data"]["clipId"].as_str().unwrap().to_string();

    let split = call(
        &app,
        "clip.split",
        json!({
            "timelineId": timeline_id,
            "clipIds": [clip_id],
            "atMs": 1000
        }),
    )
    .await;
    assert_eq!(split["commands"][0]["type"], "removeClips");
    assert_eq!(split["commands"][1]["type"], "addClips");

    let opened = current(&app).await;
    let timeline = &opened["moka"]["timelines"][0];
    assert_eq!(timeline["clips"].as_array().unwrap().len(), 2);
    let left = &timeline["clips"][0];
    let right = &timeline["clips"][1];
    assert_eq!(left["durationMs"], 1000);
    assert_eq!(right["startMs"], 1000);
    assert_eq!(right["durationMs"], 2000);

    let left_id = left["id"].as_str().unwrap().to_string();
    let transition = call(
        &app,
        "clip.add_transition",
        json!({
            "timelineId": timeline_id,
            "afterClipId": left_id,
            "kind": "crossfade",
            "durationMs": 500
        }),
    )
    .await;
    let transition_id = transition["data"]["transitionId"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "clip.update_transition",
        json!({
            "timelineId": timeline_id,
            "transitionId": transition_id,
            "kind": "dipToBlack",
            "durationMs": 700
        }),
    )
    .await;
    let opened = current(&app).await;
    assert_eq!(
        opened["moka"]["timelines"][0]["transitions"][0]["durationMs"],
        700
    );
    assert_eq!(
        opened["moka"]["timelines"][0]["transitions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let trimmed = call(
        &app,
        "clip.trim",
        json!({
            "timelineId": timeline_id,
            "edits": [{"clipId": right["id"], "durationMs": 1500}]
        }),
    )
    .await;
    assert_eq!(trimmed["kind"], "command");
    let opened = current(&app).await;
    assert_eq!(
        opened["moka"]["timelines"][0]["clips"][1]["durationMs"],
        1500
    );
}

#[tokio::test]
async fn a_story_is_filled_step_by_step_and_confirmed_only_when_ready() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;

    let created = call(
        &app,
        "story.create",
        json!({"name": "Lake", "brief": {"idea": "A keeper waits for the ice."}}),
    )
    .await;
    let story_id = created["data"]["storyId"].as_str().unwrap().to_string();

    call(
        &app,
        "story.replace_chapters",
        json!({
            "storyId": story_id,
            "confirm": "replace-chapters",
            "chapters": [{"title": "Before the freeze", "synopsis": "The lake closes.", "targetDurationMs": 60000}]
        }),
    )
    .await;
    call(
        &app,
        "story.add_element",
        json!({
            "storyId": story_id,
            "element": {"kind": "character", "name": "Ahe", "description": "The keeper."}
        }),
    )
    .await;

    let opened = current(&app).await;
    let chapter_id = opened["moka"]["stories"][0]["chapters"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.replace_acts",
        json!({
            "storyId": story_id,
            "chapterId": chapter_id,
            "confirm": "replace-acts",
            "acts": [{"title": "The shore", "summary": "Ahe walks out."}]
        }),
    )
    .await;
    let opened = current(&app).await;
    let act_id = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let added = call(
        &app,
        "story.add_keyframe",
        json!({
            "storyId": story_id,
            "chapterId": chapter_id,
            "actId": act_id,
            "keyframe": {
                "title": "Ahe at the edge",
                "content": "The ice answers.",
                "durationMs": 4000,
                "dialogue": [{"speaker": "Ahe", "text": "Quiet."}]
            }
        }),
    )
    .await;
    assert!(added["data"]["keyframes"].as_i64().unwrap() >= 1);

    for step in ["idea", "outline", "elements", "storyboard"] {
        let confirmed = call(
            &app,
            "story.confirm_step",
            json!({"storyId": story_id, "step": step}),
        )
        .await;
        assert_eq!(confirmed["kind"], "command", "{step}");
    }
    let progress = call(&app, "story.progress", json!({"storyId": story_id})).await;
    assert_eq!(progress["data"]["ready"]["storyboard"], true);
    assert_eq!(progress["data"]["confirmed"].as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn an_effect_is_idempotent_and_only_audited() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;

    // A real picture on disk, imported through the external path tool.
    let picture = temp.path().join("lake.png");
    let image = image::RgbaImage::from_pixel(16, 16, image::Rgba([30, 90, 160, 255]));
    image.save(&picture).unwrap();

    let imported = call(
        &app,
        "asset.import_path",
        json!({"paths": [picture.to_string_lossy()], "tags": ["lake"]}),
    )
    .await;
    assert!(imported["auditId"].as_str().unwrap().starts_with("au_"));
    assert!(imported.get("changeSetId").is_none());
    let asset_id = imported["assetsAdded"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let audited = call(
        &app,
        "asset.update",
        json!({"assetId": asset_id, "patch": {"note": "Third act"}}),
    )
    .await;
    assert!(audited["auditId"].is_string());

    let listed = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/agent/audit")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(listed["audit"].as_array().unwrap().len(), 2);

    let audit_id = audited["auditId"].as_str().unwrap().to_string();
    let undo = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/agent/changes/{audit_id}/undo"),
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(undo.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(undo).await["code"], "NOT_UNDOABLE");

    let deleted = call(
        &app,
        "asset.delete",
        json!({"assetIds": [asset_id], "confirm": "delete-assets"}),
    )
    .await;
    assert_eq!(deleted["assetsRemoved"], json!([asset_id]));
    let opened = current(&app).await;
    assert!(opened["moka"]["resources"]["images"]
        .as_array()
        .unwrap()
        .is_empty());
}
