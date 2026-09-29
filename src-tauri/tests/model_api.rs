//! The model endpoints over HTTP: what a client is shown, what a partial
//! edit leaves alone, and the places a credential is allowed to appear.
//!
//! The domain rules behind these routes are covered against the store itself;
//! what is checked here is the wire — the shape of a request, the status that
//! comes back, and the body limit that keeps a configuration write from being
//! mistaken for an upload.

use std::path::{Path, PathBuf};

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::Router;
use base64::Engine;
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::docs::MODELS_DOC;
use serde_json::{json, Value};
use tower::ServiceExt;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// The masked form of [`API_KEY`]: three characters, an ellipsis, four.
const MASKED_KEY: &str = "sk-…abcd";

struct Harness {
    app: Router,
    metadata: PathBuf,
}

/// Opens the app over a temporary directory that already holds a master key.
fn harness(root: &Path) -> Harness {
    let config = parse_test_config(root);
    let metadata = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    std::fs::create_dir_all(&metadata).expect("the metadata directory is created");
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(metadata.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let state = ApiState::new(config, RuntimeMode::Web, &metadata).expect("the store opens");
    Harness {
        app: moka_canvas::server::router(state),
        metadata,
    }
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

/// One text model configuration, which is the smallest thing that can be
/// stored, defaulted, and copied.
fn model_body(id: &str, api_key: Option<&str>) -> Value {
    let mut body = json!({
        "id": id,
        "category": "text",
        "protocol": "openaiChat",
        "url": "https://provider.test/v1/chat/completions",
        "model": format!("model-{id}"),
        "displayName": format!("Model {id}"),
        "enabled": true
    });
    if let Some(api_key) = api_key {
        body["apiKey"] = json!(api_key);
    }
    body
}

async fn put_model(app: &Router, body: Value) -> Value {
    let (status, view) = send(app, json_request("PUT", "/api/v1/models", body)).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    view
}

#[tokio::test]
async fn a_fresh_install_reports_an_empty_configuration() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    let (status, view) = send(&harness.app, plain_request("GET", "/api/v1/models")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["revision"], 0);
    assert_eq!(view["models"], json!([]));
    assert_eq!(
        view["defaults"],
        json!({
            "text": null,
            "image": null,
            "speech": null,
            "music": null,
            "video": null,
            "asr": null,
        })
    );
    assert_eq!(view["preferences"]["reasoningEffort"], "auto");
    // The harness wrote a master key file up front, so the tier is the file.
    assert_eq!(view["secretStorage"], "file");
}

#[tokio::test]
async fn a_credential_is_neither_returned_nor_left_in_the_configuration() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    let view = put_model(&harness.app, model_body("main", Some(API_KEY))).await;

    assert_eq!(view["models"][0]["apiKey"]["set"], true);
    assert_eq!(view["models"][0]["apiKey"]["masked"], MASKED_KEY);
    let rendered = view.to_string();
    assert!(!rendered.contains(API_KEY), "{rendered}");

    // Nor on disk, in the document the configuration lives in.
    let raw = std::fs::read(harness.metadata.join(MODELS_DOC)).unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains(API_KEY));
    assert_eq!(view["secretStorage"], "file");
}

#[tokio::test]
async fn a_models_scenario_rows_travel_through_the_wire_and_are_validated() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    let mut body = model_body("filmer", None);
    body["category"] = json!("video");
    body["protocol"] = json!("openaiVideos");
    body["url"] = json!("https://provider.test/v1/videos");
    body["scenes"] = json!(["textToVideo"]);
    body["subModels"] = json!([
        { "model": "happy-t2v", "scenes": ["imageToVideo"] },
        {
            "model": "happy-i2v",
            "url": "https://provider.test/v1/video/images",
            "scenes": ["firstLastFrame"]
        }
    ]);

    let view = put_model(&harness.app, body).await;
    let stored = &view["models"][0];
    assert_eq!(
        stored["scenes"],
        json!(["textToVideo"]),
        "the scenarios the configuration's own model answers"
    );
    assert_eq!(stored["subModels"][0]["model"], "happy-t2v");
    assert_eq!(
        stored["subModels"][0].get("url"),
        None,
        "a row with no address of its own writes none"
    );
    assert_eq!(
        stored["subModels"][1]["url"],
        "https://provider.test/v1/video/images"
    );

    // One scenario is answered by one claim, whether it is the configuration's
    // own or a row's, so a second claim is refused where it is configured.
    let mut clashing = model_body("filmer", None);
    clashing["category"] = json!("video");
    clashing["protocol"] = json!("openaiVideos");
    clashing["url"] = json!("https://provider.test/v1/videos");
    clashing["subModels"] = json!([
        { "model": "a", "scenes": ["imageToVideo"] },
        { "model": "b", "scenes": ["imageToVideo"] }
    ]);
    let (status, problem) = send(
        &harness.app,
        json_request("PUT", "/api/v1/models", clashing),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "VALIDATION_FAILED");

    let mut overlapping = model_body("filmer", None);
    overlapping["category"] = json!("video");
    overlapping["protocol"] = json!("openaiVideos");
    overlapping["url"] = json!("https://provider.test/v1/videos");
    overlapping["scenes"] = json!(["imageToVideo"]);
    overlapping["subModels"] = json!([{ "model": "a", "scenes": ["imageToVideo"] }]);
    let (status, problem) = send(
        &harness.app,
        json_request("PUT", "/api/v1/models", overlapping),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "VALIDATION_FAILED");
}

#[tokio::test]
async fn an_edit_that_does_not_carry_a_credential_keeps_the_stored_one() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("main", Some(API_KEY))).await;

    // A rename arrives with an empty key field, as every form edit does.
    let mut rename = model_body("main", None);
    rename["displayName"] = json!("Renamed");
    rename["apiKey"] = json!("");
    let view = put_model(&harness.app, rename).await;

    assert_eq!(view["models"][0]["displayName"], "Renamed");
    assert_eq!(
        view["models"][0]["apiKey"]["masked"], MASKED_KEY,
        "an unrelated edit must not cost the key"
    );
}

#[tokio::test]
async fn clearing_a_credential_is_an_explicit_call() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("main", Some(API_KEY))).await;

    let (status, view) = send(
        &harness.app,
        json_request("POST", "/api/v1/models/main/key", json!({ "apiKey": null })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["models"][0]["apiKey"]["set"], false);
}

#[tokio::test]
async fn a_partial_default_edit_leaves_the_other_categories_alone() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("writer", None)).await;
    let mut painter = model_body("painter", None);
    painter["category"] = json!("image");
    painter["protocol"] = json!("openaiImages");
    painter["url"] = json!("https://provider.test/v1/images/generations");
    put_model(&harness.app, painter).await;

    let (status, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/defaults",
            json!({ "text": "writer" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["defaults"]["text"], "writer");

    let (status, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/defaults",
            json!({ "image": "painter" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["defaults"]["text"], "writer", "untouched");
    assert_eq!(view["defaults"]["image"], "painter");

    // And null clears one without touching the others.
    let (status, view) = send(
        &harness.app,
        json_request("PATCH", "/api/v1/models/defaults", json!({ "image": null })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["defaults"]["text"], "writer");
    assert_eq!(view["defaults"]["image"], Value::Null);
}

#[tokio::test]
async fn a_default_has_to_name_a_model_that_serves_the_category() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("writer", None)).await;

    let (status, problem) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/defaults",
            json!({ "image": "writer" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(problem["code"], "MODEL_CAPABILITY_MISMATCH");
    assert_eq!(problem["details"]["reference"], "writer");
    assert_eq!(problem["details"]["requested"], "image");
    assert_eq!(problem["details"]["actual"], "text");

    let (status, problem) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/defaults",
            json!({ "text": "ghost" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "PROVIDER_NOT_CONFIGURED");
}

#[tokio::test]
async fn deleting_a_default_model_clears_the_default_it_held() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    let mut painter = model_body("painter", Some(API_KEY));
    painter["category"] = json!("image");
    painter["protocol"] = json!("openaiImages");
    painter["url"] = json!("https://provider.test/v1/images/generations");
    put_model(&harness.app, painter).await;
    let (_, patched) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/defaults",
            json!({ "image": "painter" }),
        ),
    )
    .await;

    // The removal is not refused for the default it holds: the default goes
    // with the model, and the capability falls back to the first model that
    // can serve it. The revision the client last read is what says so.
    let revision = patched["revision"].as_u64().unwrap();
    let (status, view) = send(
        &harness.app,
        plain_request(
            "DELETE",
            &format!("/api/v1/models/painter?revision={revision}"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["models"], json!([]));
    assert_eq!(view["defaults"]["image"], json!(null));
}

#[tokio::test]
async fn a_write_against_a_stale_revision_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    let view = put_model(&harness.app, model_body("main", None)).await;
    assert!(view["revision"].as_u64().unwrap() > 0);

    let mut stale = model_body("main", None);
    stale["displayName"] = json!("Stale");
    stale["expectedRevision"] = json!(0);
    let (status, problem) = send(&harness.app, json_request("PUT", "/api/v1/models", stale)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(problem["code"], "METADATA_CONFLICT");

    let (_, view) = send(&harness.app, plain_request("GET", "/api/v1/models")).await;
    assert_eq!(view["models"][0]["displayName"], "Model main");
}

#[tokio::test]
async fn a_partial_preference_edit_keeps_the_rest() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let (status, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/preferences",
            json!({ "systemPrompt": "Keep it short" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["preferences"]["systemPrompt"], "Keep it short");
    assert_eq!(view["preferences"]["reasoningEffort"], "auto");
    assert_eq!(view["preferences"]["image"]["count"], 1);

    // A group is replaced whole; what sits beside it is not.
    let (_, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/preferences",
            json!({
                "image": {
                    "size": "16:9",
                    "quality": "high",
                    "background": "transparent",
                    "count": 4
                }
            }),
        ),
    )
    .await;
    assert_eq!(view["preferences"]["image"]["size"], "16:9");
    assert_eq!(view["preferences"]["image"]["count"], 4);
    assert_eq!(view["preferences"]["systemPrompt"], "Keep it short");
    assert_eq!(view["preferences"]["video"]["seconds"], 6);
    // The story room's own group arrives with the document's defaults and moves
    // whole, the way every other group does.
    assert_eq!(view["preferences"]["story"]["splitChars"], 12_000);
    assert_eq!(view["preferences"]["story"]["readChars"], 8_000);

    let (_, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/preferences",
            json!({ "story": { "splitChars": 4_000, "readChars": 2_000 } }),
        ),
    )
    .await;
    assert_eq!(view["preferences"]["story"]["splitChars"], 4_000);
    assert_eq!(view["preferences"]["story"]["readChars"], 2_000);
    assert_eq!(view["preferences"]["image"]["size"], "16:9");
}

#[tokio::test]
async fn a_preference_outside_its_bounds_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let (status, problem) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/preferences",
            json!({
                "image": { "size": "1:1", "quality": "auto", "background": "", "count": 99 }
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(problem["code"], "VALIDATION_FAILED");

    // A telling cut finer than a scene is not a telling, and one carrying more
    // than the instructions leave room for would not survive the job's own
    // ceiling on what a piece may ask.
    for story in [
        json!({ "splitChars": 900, "readChars": 8_000 }),
        json!({ "splitChars": 12_000, "readChars": 20_000 }),
    ] {
        let (status, problem) = send(
            &harness.app,
            json_request(
                "PATCH",
                "/api/v1/models/preferences",
                json!({ "story": story }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(problem["code"], "VALIDATION_FAILED");
    }

    let (_, view) = send(&harness.app, plain_request("GET", "/api/v1/models")).await;
    assert_eq!(view["preferences"]["image"]["count"], 1);
    assert_eq!(view["preferences"]["story"]["splitChars"], 12_000);
}

#[tokio::test]
async fn a_configuration_write_is_capped_well_below_an_upload() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let mut body = model_body("main", None);
    body["displayName"] = json!("n".repeat(2 * 1024 * 1024));
    let (status, problem) = send(&harness.app, json_request("PUT", "/api/v1/models", body)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(problem["code"], "PAYLOAD_TOO_LARGE");
}

#[tokio::test]
async fn the_model_routes_refuse_an_identifier_that_is_not_there() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    for (method, uri) in [("DELETE", "/api/v1/models/nope")] {
        let (status, problem) = send(&harness.app, plain_request(method, uri)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}");
        assert_eq!(problem["code"], "NOT_FOUND", "{method} {uri}");
    }

    let (status, problem) = send(
        &harness.app,
        json_request(
            "POST",
            "/api/v1/models/nope/key",
            json!({ "apiKey": API_KEY }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(problem["code"], "NOT_FOUND");
}

#[tokio::test]
async fn a_creation_can_carry_the_key_of_the_model_it_copies() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("main", Some(API_KEY))).await;

    // The client never sees a stored key, so a copy names the configuration
    // to take it from instead of sending it. The identifier is the copy's
    // own: the client picks it, the way it picks any new model's.
    let mut body = model_body("main_copy", None);
    body["copyKeyFrom"] = json!("main");
    let (status, view) = send(&harness.app, json_request("PUT", "/api/v1/models", body)).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["models"].as_array().unwrap().len(), 2);
    let copy = view["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["id"] == "main_copy")
        .expect("the copy is in the view");
    assert_eq!(copy["url"], "https://provider.test/v1/chat/completions");
    assert_eq!(copy["apiKey"]["masked"], MASKED_KEY, "the key came along");

    // An edit of an existing model ignores the field: the key it has is the
    // key it keeps, whatever source the request names.
    let mut body = model_body("main_copy", None);
    body["displayName"] = json!("Renamed copy");
    body["copyKeyFrom"] = json!("ghost");
    let (status, view) = send(&harness.app, json_request("PUT", "/api/v1/models", body)).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    let edited = view["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["id"] == "main_copy")
        .expect("the edit is in the view");
    assert_eq!(edited["displayName"], "Renamed copy");
    assert_eq!(edited["apiKey"]["masked"], MASKED_KEY);
}

#[tokio::test]
async fn a_protocol_the_category_does_not_offer_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let mut body = model_body("shot", None);
    body["category"] = json!("video");
    // The chat protocol is not on the video category's list.
    let (status, problem) = send(&harness.app, json_request("PUT", "/api/v1/models", body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "VALIDATION_FAILED");

    let (_, view) = send(&harness.app, plain_request("GET", "/api/v1/models")).await;
    assert_eq!(view["models"], json!([]), "nothing was stored");
}
