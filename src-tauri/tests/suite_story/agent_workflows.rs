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
    let (status, body) = call_raw(app, name, input).await;
    assert_eq!(status, StatusCode::OK, "{name}: {body}");
    body
}

async fn call_raw(app: &axum::Router, name: &str, input: Value) -> (StatusCode, Value) {
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
    (status, body)
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

    for step in ["idea", "outline", "elements"] {
        let confirmed = call(
            &app,
            "story.confirm_step",
            json!({"storyId": story_id, "step": step}),
        )
        .await;
        assert_eq!(confirmed["kind"], "command", "{step}");
    }
    let progress = call(&app, "story.progress", json!({"storyId": story_id})).await;
    // A board is not ready on shots alone: every shot needs a picture before
    // the step can be settled, the same rule the room reads.
    assert_eq!(progress["data"]["ready"]["storyboard"], false);
    assert!(progress["data"]["gaps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|gap| gap["kind"] == "framesMissing"));
    let opened = current(&app).await;
    assert_eq!(
        opened["moka"]["stories"][0]["chapters"][0]["outlineLocked"], true,
        "confirming the outline locks it, as the room does"
    );
}

#[tokio::test]
async fn a_story_read_can_be_scoped_and_whole() {
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
            "chapters": [
                {"title": "Before the freeze", "synopsis": "The lake closes.", "targetDurationMs": 60000},
                {"title": "Under the ice", "synopsis": "The keeper listens.", "targetDurationMs": 60000}
            ]
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
    let chapters = opened["moka"]["stories"][0]["chapters"].as_array().unwrap();
    let first_chapter = chapters[0]["id"].as_str().unwrap().to_string();
    let second_chapter = chapters[1]["id"].as_str().unwrap().to_string();
    let long_text = "湖".repeat(2_500);
    call(
        &app,
        "story.update_chapter",
        json!({
            "storyId": story_id,
            "chapterId": first_chapter,
            "patch": {"synopsis": long_text.clone()}
        }),
    )
    .await;
    call(
        &app,
        "story.add_act",
        json!({"storyId": story_id, "chapterId": first_chapter, "title": "The shore", "summary": "Ahe walks out."}),
    )
    .await;
    call(
        &app,
        "story.add_act",
        json!({"storyId": story_id, "chapterId": second_chapter, "title": "The dark", "summary": "Ahe listens."}),
    )
    .await;

    let opened = current(&app).await;
    let first_act = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let second_act = opened["moka"]["stories"][0]["chapters"][1]["acts"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.add_keyframe",
        json!({
            "storyId": story_id,
            "chapterId": first_chapter,
            "actId": first_act,
            "keyframe": {"title": "Edge", "content": "Ahe at the edge.", "durationMs": 4000}
        }),
    )
    .await;
    call(
        &app,
        "story.add_keyframe",
        json!({
            "storyId": story_id,
            "chapterId": second_chapter,
            "actId": second_act,
            "keyframe": {"title": "Listen", "content": "Ahe listens under the ice.", "durationMs": 3000}
        }),
    )
    .await;

    let opened = current(&app).await;
    let first_keyframe = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["keyframes"][0]
        ["id"]
        .as_str()
        .unwrap()
        .to_string();
    let element_id = opened["moka"]["stories"][0]["elements"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let picture = temp.path().join("lake.png");
    image::RgbaImage::from_pixel(16, 16, image::Rgba([30, 90, 160, 255]))
        .save(&picture)
        .unwrap();
    let imported = call(
        &app,
        "asset.import_path",
        json!({"paths": [picture.to_string_lossy()]}),
    )
    .await;
    let asset_id = imported["assetsAdded"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.set_slot",
        json!({
            "storyId": story_id,
            "target": {"kind": "element", "elementId": element_id, "view": "main"},
            "action": "append",
            "assetIds": [asset_id.clone()]
        }),
    )
    .await;
    call(
        &app,
        "story.set_slot",
        json!({
            "storyId": story_id,
            "target": {
                "kind": "keyframe",
                "chapterId": first_chapter,
                "actId": first_act,
                "keyframeId": first_keyframe
            },
            "action": "append",
            "assetIds": [asset_id.clone()]
        }),
    )
    .await;

    let scoped = call(
        &app,
        "story.get",
        json!({
            "storyId": story_id,
            "chapterId": second_chapter,
            "fullText": true,
            "include": ["chapters", "storyboard", "elements"]
        }),
    )
    .await;
    assert_eq!(scoped["data"]["chapters"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["data"]["chapters"][0]["id"], second_chapter);
    assert_eq!(scoped["data"]["acts"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["data"]["acts"][0]["chapterId"], second_chapter);
    assert_eq!(scoped["data"]["keyframes"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["data"]["keyframes"][0]["chapterId"], second_chapter);
    assert_eq!(scoped["data"]["keyframes"][0]["art"]["takes"], 0);
    assert_eq!(
        scoped["data"]["elements"][0]["currentMain"],
        json!([asset_id])
    );

    let whole = call(
        &app,
        "story.get",
        json!({
            "storyId": story_id,
            "chapterId": first_chapter,
            "fullText": true,
            "include": ["chapters"]
        }),
    )
    .await;
    assert_eq!(whole["data"]["chapters"][0]["synopsis"], long_text);
    assert_eq!(whole["data"]["chapters"][0]["synopsisTruncated"], false);
    assert_eq!(whole["data"]["chapters"][0]["synopsisLength"], 2_500);

    let shortened = call(
        &app,
        "story.get",
        json!({"storyId": story_id, "chapterId": first_chapter, "include": ["chapters"]}),
    )
    .await;
    assert_eq!(shortened["data"]["chapters"][0]["synopsisTruncated"], true);
    assert_eq!(shortened["data"]["chapters"][0]["synopsisLength"], 2_500);
    assert_eq!(
        shortened["data"]["chapters"][0]["synopsis"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        2_001
    );

    let one_act = call(
        &app,
        "story.get",
        json!({
            "storyId": story_id,
            "actId": second_act,
            "include": ["storyboard"]
        }),
    )
    .await;
    assert_eq!(one_act["data"]["acts"].as_array().unwrap().len(), 1);
    assert_eq!(one_act["data"]["acts"][0]["id"], second_act);
    assert_eq!(one_act["data"]["keyframes"].as_array().unwrap().len(), 1);
    assert_eq!(one_act["data"]["keyframes"][0]["actId"], second_act);

    let slots = call(
        &app,
        "story.get",
        json!({
            "storyId": story_id,
            "chapterId": first_chapter,
            "include": ["slots"]
        }),
    )
    .await;
    let slots = slots["data"]["slots"].as_array().unwrap();
    assert!(slots.iter().any(|slot| {
        slot["kind"] == "keyframeArt"
            && slot["keyframeId"] == first_keyframe
            && slot["slot"]["current"] == json!([asset_id])
    }));
}

#[tokio::test]
async fn a_story_batch_can_be_planned_from_the_document() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;

    let created = call(
        &app,
        "story.create",
        json!({"name": "Lake", "brief": {"idea": "A keeper waits for the ice.", "genre": "drama", "style": "cold realism"}}),
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
    let element_id = opened["moka"]["stories"][0]["elements"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.add_act",
        json!({"storyId": story_id, "chapterId": chapter_id, "title": "The shore", "summary": "Ahe walks out."}),
    )
    .await;
    let opened = current(&app).await;
    let act_id = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.add_keyframe",
        json!({
            "storyId": story_id,
            "chapterId": chapter_id,
            "actId": act_id,
            "keyframe": {
                "title": "Edge",
                "content": "`Ahe` at the edge.",
                "durationMs": 4000,
                "dialogue": [{"speaker": "Ahe", "text": "Quiet."}]
            }
        }),
    )
    .await;
    let opened = current(&app).await;
    let keyframe_id = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["keyframes"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.update_act",
        json!({
            "storyId": story_id,
            "chapterId": chapter_id,
            "actId": act_id,
            "patch": {"sound": {"music": "low strings", "sfx": "wind", "ambience": "lake"}}
        }),
    )
    .await;

    let picture = temp.path().join("lake.png");
    image::RgbaImage::from_pixel(16, 16, image::Rgba([30, 90, 160, 255]))
        .save(&picture)
        .unwrap();
    let imported = call(
        &app,
        "asset.import_path",
        json!({"paths": [picture.to_string_lossy()]}),
    )
    .await;
    let asset_id = imported["assetsAdded"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.set_slot",
        json!({
            "storyId": story_id,
            "target": {"kind": "element", "elementId": element_id, "view": "main"},
            "action": "append",
            "assetIds": [asset_id.clone()]
        }),
    )
    .await;
    call(
        &app,
        "story.set_slot",
        json!({
            "storyId": story_id,
            "target": {"kind": "keyframe", "chapterId": chapter_id, "actId": act_id, "keyframeId": keyframe_id},
            "action": "append",
            "assetIds": [asset_id.clone()]
        }),
    )
    .await;

    let board = call(
        &app,
        "story.plan_job",
        json!({
            "storyId": story_id,
            "kind": "storyboard",
            "chapterId": chapter_id,
            "model": "scribe",
            "videoModel": "video-1"
        }),
    )
    .await;
    assert_eq!(board["data"]["waves"][0]["model"], "scribe");
    let item = &board["data"]["waves"][0]["items"][0];
    assert_eq!(item["target"]["kind"], "storyboard");
    assert_eq!(item["capability"], "text");
    let prompt = item["prompt"].as_str().unwrap();
    assert!(prompt.contains("The lake closes."));
    assert!(prompt.contains("Ahe (character) — The keeper."));

    let art = call(
        &app,
        "story.plan_job",
        json!({"storyId": story_id, "kind": "keyframeArt", "chapterId": chapter_id}),
    )
    .await;
    assert_eq!(art["data"]["items"].as_array().unwrap().len(), 0);

    let art = call(
        &app,
        "story.plan_job",
        json!({
            "storyId": story_id,
            "kind": "keyframeArt",
            "chapterId": chapter_id,
            "includeExisting": true
        }),
    )
    .await;
    let item = &art["data"]["items"][0];
    assert_eq!(item["target"]["kind"], "keyframeArt");
    assert_eq!(item["inputs"][0]["assetId"], asset_id);
    assert!(
        item["prompt"]
            .as_str()
            .unwrap()
            .contains("1. Ahe — The keeper."),
        "{}",
        item["prompt"]
    );

    let clips = call(
        &app,
        "story.plan_job",
        json!({"storyId": story_id, "kind": "actVideo", "chapterId": chapter_id, "model": "video-1"}),
    )
    .await;
    let item = &clips["data"]["items"][0];
    assert_eq!(item["target"]["kind"], "actVideo");
    assert_eq!(item["inputs"][0]["role"], "reference");
    assert!(
        item["prompt"]
            .as_str()
            .unwrap()
            .contains("At 0s, camera static: Ahe at the edge."),
        "{}",
        item["prompt"]
    );

    let shots = call(
        &app,
        "story.plan_job",
        json!({"storyId": story_id, "kind": "keyframeVideo", "chapterId": chapter_id}),
    )
    .await;
    let item = &shots["data"]["items"][0];
    assert_eq!(item["target"]["kind"], "keyframeVideo");
    assert!(item["prompt"]
        .as_str()
        .unwrap()
        .contains("The shot, from \"Edge\""));

    let lines = call(
        &app,
        "story.plan_job",
        json!({"storyId": story_id, "kind": "lineVoice", "chapterId": chapter_id}),
    )
    .await;
    let item = &lines["data"]["items"][0];
    assert_eq!(item["target"]["kind"], "lineVoice");
    assert_eq!(item["prompt"], "Quiet.");
    assert_eq!(item["capability"], "speech");

    let music = call(
        &app,
        "story.plan_job",
        json!({"storyId": story_id, "kind": "music", "chapterId": chapter_id}),
    )
    .await;
    let item = &music["data"]["items"][0];
    assert_eq!(item["target"]["kind"], "music");
    assert!(item["prompt"].as_str().unwrap().contains("low strings"));

    let forms = call(
        &app,
        "story.plan_job",
        json!({
            "storyId": story_id,
            "kind": "elementArt",
            "chapterId": chapter_id,
            "elementIds": [element_id],
            "views": ["turnaround"]
        }),
    )
    .await;
    let item = &forms["data"]["items"][0];
    assert_eq!(item["target"]["kind"], "elementArt");
    assert_eq!(item["target"]["view"], "turnaround");
    assert_eq!(item["inputs"][0]["assetId"], asset_id);
}

#[tokio::test]
async fn a_board_and_its_dubbing_can_be_reviewed() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;

    let created = call(
        &app,
        "story.create",
        json!({"name": "Lake", "brief": {"idea": "A keeper waits."}}),
    )
    .await;
    let story_id = created["data"]["storyId"].as_str().unwrap().to_string();
    call(
        &app,
        "story.replace_chapters",
        json!({
            "storyId": story_id,
            "confirm": "replace-chapters",
            "chapters": [{"title": "Before the freeze", "synopsis": "The lake closes.", "targetDurationMs": 4000}]
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
        "story.add_act",
        json!({"storyId": story_id, "chapterId": chapter_id, "title": "The shore", "summary": "Ahe walks out."}),
    )
    .await;
    let opened = current(&app).await;
    let act_id = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.add_keyframe",
        json!({
            "storyId": story_id,
            "chapterId": chapter_id,
            "actId": act_id,
            "keyframe": {
                "title": "Edge",
                "content": "Ahe at the edge.",
                "durationMs": 4000,
                "dialogue": [{"speaker": "Ahe", "text": "Quiet."}]
            }
        }),
    )
    .await;
    call(
        &app,
        "story.update_act",
        json!({
            "storyId": story_id,
            "chapterId": chapter_id,
            "actId": act_id,
            "patch": {"sound": {"music": "low strings", "sfx": "", "ambience": ""}}
        }),
    )
    .await;
    let opened = current(&app).await;
    let keyframe_id = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["keyframes"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let line_id = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["keyframes"][0]
        ["dialogue"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let report = call(
        &app,
        "story.board_report",
        json!({"storyId": story_id, "chapterId": chapter_id}),
    )
    .await;
    assert_eq!(report["data"]["totals"]["shots"], 1);
    assert_eq!(report["data"]["totals"]["missingArt"], 1);
    assert_eq!(report["data"]["totals"]["missingActVideo"], 1);
    assert_eq!(report["data"]["totals"]["missingVoice"], 1);
    assert_eq!(report["data"]["totals"]["missingMusic"], 1);

    let audio = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/beep.wav"));
    let audio_path = temp.path().join("line.wav");
    std::fs::write(&audio_path, audio).unwrap();
    let imported = call(
        &app,
        "asset.import_path",
        json!({"paths": [audio_path.to_string_lossy()]}),
    )
    .await;
    let audio_id = imported["assetsAdded"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.set_slot",
        json!({
            "storyId": story_id,
            "target": {
                "kind": "lineVoice",
                "chapterId": chapter_id,
                "actId": act_id,
                "keyframeId": keyframe_id,
                "lineId": line_id
            },
            "action": "append",
            "assetIds": [audio_id]
        }),
    )
    .await;

    let board = call(
        &app,
        "story.board_report",
        json!({"storyId": story_id, "chapterId": chapter_id}),
    )
    .await;
    assert_eq!(board["data"]["totals"]["missingVoice"], 0);

    let dubbing = call(
        &app,
        "story.dubbing_report",
        json!({"storyId": story_id, "chapterId": chapter_id}),
    )
    .await;
    assert_eq!(dubbing["data"]["totals"]["lines"], 1);
    assert_eq!(dubbing["data"]["totals"]["missing"], 0);
    assert!(dubbing["data"]["lines"][0]["textMs"].as_i64().unwrap() > 0);
    assert_eq!(dubbing["data"]["lines"][0]["shotMs"], 4000);
    assert_eq!(dubbing["data"]["lines"][0]["fits"], true);
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

#[tokio::test]
async fn a_narrator_voice_is_written_through_the_story_voice_tool() {
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
        "story.update_voice",
        json!({
            "storyId": story_id,
            "target": {"kind": "narrator"},
            "voice": {"model": "speech-1", "voice": "alloy", "rate": 1.0}
        }),
    )
    .await;
    let read = call(&app, "story.get", json!({"storyId": story_id})).await;
    assert_eq!(read["data"]["story"]["narrator"]["voice"], "alloy");
}

#[tokio::test]
async fn a_story_batch_is_refused_before_a_provider_is_asked() {
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
    let (status, body) = call_raw(
        &app,
        "story.start_job",
        json!({
            "storyId": story_id,
            "kind": "storyboard",
            "items": [{
                "id": "bad",
                "target": {"kind": "outline"},
                "capability": "text",
                "prompt": "Write the board."
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "VALIDATION_FAILED");
    assert!(!body["details"]["issues"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_chapter_and_its_acts_can_be_restructured() {
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
    let first = call(
        &app,
        "story.add_chapter",
        json!({"storyId": story_id, "chapter": {"title": "One", "synopsis": "Ice."}}),
    )
    .await;
    let first_id = first["data"]["chapterId"].as_str().unwrap().to_string();
    let second = call(
        &app,
        "story.add_chapter",
        json!({"storyId": story_id, "chapter": {"title": "Two", "synopsis": "Thaw."}}),
    )
    .await;
    let second_id = second["data"]["chapterId"].as_str().unwrap().to_string();
    call(
        &app,
        "story.move_chapter",
        json!({"storyId": story_id, "chapterId": second_id, "toIndex": 0}),
    )
    .await;
    call(
        &app,
        "story.update_chapter",
        json!({"storyId": story_id, "chapterId": first_id, "patch": {"outlineLocked": true}}),
    )
    .await;
    let added = call(
        &app,
        "story.add_act",
        json!({
            "storyId": story_id,
            "chapterId": first_id,
            "act": {
                "title": "Bridge",
                "transition": {"prompt": "Snow crosses the lens.", "durationMs": 1500}
            }
        }),
    )
    .await;
    assert_eq!(added["data"]["acts"], 1);
    let opened = current(&app).await;
    let chapter = &opened["moka"]["stories"][0]["chapters"][0];
    assert_eq!(chapter["id"], second_id);
    let chapters = opened["moka"]["stories"][0]["chapters"].as_array().unwrap();
    let one = chapters
        .iter()
        .find(|held| held["id"] == first_id.as_str())
        .unwrap();
    assert_eq!(one["outlineLocked"], true);
    assert_eq!(one["acts"][0]["transition"]["durationMs"], 1500);
    call(
        &app,
        "story.remove_chapter",
        json!({"storyId": story_id, "chapterId": second_id, "confirm": "remove"}),
    )
    .await;
    let opened = current(&app).await;
    assert_eq!(
        opened["moka"]["stories"][0]["chapters"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn a_board_can_be_checked_and_revised_after_the_outline_moves() {
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
            "confirm": "replace",
            "chapters": [{"title": "One", "synopsis": "The lake closes."}]
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
            "confirm": "replace",
            "acts": [{"title": "Shore", "summary": "Ahe walks out.", "keyframes": [{
                "title": "Edge", "content": "Ahe at the edge.", "durationMs": 4000
            }]}]
        }),
    )
    .await;
    let continuity = call(
        &app,
        "story.plan_job",
        json!({"storyId": story_id, "kind": "continuity", "chapterId": chapter_id}),
    )
    .await;
    assert_eq!(
        continuity["data"]["items"][0]["target"]["kind"],
        "continuity"
    );
    assert!(continuity["data"]["items"][0]["prompt"]
        .as_str()
        .unwrap()
        .contains("Ahe at the edge."));

    call(
        &app,
        "story.update_chapter",
        json!({
            "storyId": story_id,
            "chapterId": chapter_id,
            "patch": {"synopsis": "The lake opens again."}
        }),
    )
    .await;
    let revision = call(
        &app,
        "story.plan_job",
        json!({"storyId": story_id, "kind": "outlineRevision", "chapterId": chapter_id}),
    )
    .await;
    let item = &revision["data"]["items"][0];
    assert_eq!(item["target"]["kind"], "outlineRevision");
    assert!(item["prompt"]
        .as_str()
        .unwrap()
        .contains("The lake opens again."));
}

#[tokio::test]
async fn a_story_is_imported_as_a_wired_canvas_and_its_prompts_can_be_written() {
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
            "confirm": "replace",
            "chapters": [{"title": "One", "synopsis": "The lake closes."}]
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
        "story.add_act",
        json!({"storyId": story_id, "chapterId": chapter_id, "title": "Shore"}),
    )
    .await;
    let opened = current(&app).await;
    let act_id = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &app,
        "story.add_keyframe",
        json!({
            "storyId": story_id, "chapterId": chapter_id, "actId": act_id,
            "keyframe": {"title": "Edge", "content": "Ahe at the edge."}
        }),
    )
    .await;
    let opened = current(&app).await;
    let keyframe_id = opened["moka"]["stories"][0]["chapters"][0]["acts"][0]["keyframes"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let imported = call(
        &app,
        "story.import_canvas",
        json!({"storyId": story_id, "name": "Lake cards"}),
    )
    .await;
    assert!(imported["data"]["nodes"].as_u64().unwrap() >= 4);
    assert!(imported["data"]["edges"].as_u64().unwrap() >= 3);

    let ask = format!("keyframe:{chapter_id}:{act_id}:{keyframe_id}");
    call(
        &app,
        "story.set_prompt",
        json!({
            "storyId": story_id,
            "kind": "image",
            "prompts": {ask.clone(): {"prompt": "Ahe, painted in one flat colour.", "auto": "Ahe at the edge."}}
        }),
    )
    .await;
    let read = call(&app, "story.get", json!({"storyId": story_id})).await;
    assert_eq!(
        read["data"]["story"]["imagePromptOverrides"][&ask]["prompt"],
        "Ahe, painted in one flat colour."
    );
}

#[tokio::test]
async fn a_turnaround_sheet_can_be_filed_for_a_character_made_without_its_place() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let app = test_app(temp.path());
    create_project(&app, &project).await;

    let created = call(
        &app,
        "story.create",
        json!({"name": "Lake", "brief": {"idea": "A keeper waits."}}),
    )
    .await;
    let story_id = created["data"]["storyId"].as_str().unwrap().to_string();
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
    let element_id = opened["moka"]["stories"][0]["elements"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        opened["moka"]["stories"][0]["elements"][0]
            .get("turnaround")
            .is_none(),
        "the hand-added character starts without a four-view place"
    );

    let main_picture = temp.path().join("main.png");
    let sheet = temp.path().join("sheet.png");
    image::RgbaImage::from_pixel(16, 16, image::Rgba([30, 90, 160, 255]))
        .save(&main_picture)
        .unwrap();
    image::RgbaImage::from_pixel(16, 16, image::Rgba([160, 90, 30, 255]))
        .save(&sheet)
        .unwrap();
    let imported = call(
        &app,
        "asset.import_path",
        json!({"paths": [main_picture.to_string_lossy(), sheet.to_string_lossy()]}),
    )
    .await;
    let main_asset = imported["assetsAdded"][0]["id"].as_str().unwrap().to_string();
    let sheet_asset = imported["assetsAdded"][1]["id"].as_str().unwrap().to_string();

    for (view, asset) in [("main", &main_asset), ("turnaround", &sheet_asset)] {
        call(
            &app,
            "story.set_slot",
            json!({
                "storyId": story_id,
                "target": {"kind": "element", "elementId": element_id, "view": view},
                "action": "append",
                "assetIds": [asset]
            }),
        )
        .await;
    }

    let after = current(&app).await;
    let element = &after["moka"]["stories"][0]["elements"][0];
    let main_takes = element["main"]["takes"].as_array().unwrap();
    assert_eq!(main_takes.len(), 1);
    assert_eq!(main_takes[0]["assetIds"][0], main_asset);
    let takes = element["turnaround"]["takes"].as_array().unwrap();
    assert_eq!(
        takes.len(),
        1,
        "the sheet's place holds only the sheet, not a copy of the main picture"
    );
    assert_eq!(takes[0]["assetIds"][0], sheet_asset);
}
