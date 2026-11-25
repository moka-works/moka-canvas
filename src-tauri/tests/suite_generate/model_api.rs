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
    harness_with_mode(root, RuntimeMode::Web)
}

fn harness_with_mode(root: &Path, mode: RuntimeMode) -> Harness {
    let config = parse_test_config(root);
    let metadata = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    std::fs::create_dir_all(&metadata).expect("the metadata directory is created");
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(metadata.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let state = ApiState::new(config, mode, &metadata).expect("the store opens");
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

const TRANSFER_PASSPHRASE: &str = "transfer-passphrase-1";

async fn export_configuration(
    harness: &Harness,
    destination: &Path,
    include_keys: bool,
    passphrase: Option<&str>,
) -> (StatusCode, Value) {
    let mut body = json!({
        "destination": destination.to_string_lossy(),
        "includeKeys": include_keys,
    });
    if let Some(passphrase) = passphrase {
        body["passphrase"] = json!(passphrase);
    }
    send(
        &harness.app,
        json_request("POST", "/api/v1/models/export", body),
    )
    .await
}

async fn preview_configuration(harness: &Harness, text: &str, mode: &str) -> (StatusCode, Value) {
    send(
        &harness.app,
        json_request(
            "POST",
            "/api/v1/models/import/preview",
            json!({ "text": text, "mode": mode }),
        ),
    )
    .await
}

async fn import_configuration(
    harness: &Harness,
    text: &str,
    mode: &str,
    include_keys: bool,
    passphrase: Option<&str>,
    digest: &str,
) -> (StatusCode, Value) {
    let mut body = json!({
        "text": text,
        "mode": mode,
        "includeKeys": include_keys,
        "expectedDigest": digest,
    });
    if let Some(passphrase) = passphrase {
        body["passphrase"] = json!(passphrase);
    }
    send(
        &harness.app,
        json_request("POST", "/api/v1/models/import", body),
    )
    .await
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
    assert_eq!(view["preferences"]["story"]["splitChars"], 500_000);

    let (_, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/preferences",
            json!({ "story": { "splitChars": 4_000 } }),
        ),
    )
    .await;
    assert_eq!(view["preferences"]["story"]["splitChars"], 4_000);
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

    // The batch ceiling may not fall outside the room's own floor or ceiling.
    for story in [
        json!({ "splitChars": 900 }),
        json!({ "splitChars": 1_000_001 }),
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
    assert_eq!(view["preferences"]["story"]["splitChars"], 500_000);
}

#[tokio::test]
async fn a_category_reorders_without_moving_the_others() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("alpha", None)).await;
    let mut painter = model_body("painter", None);
    painter["category"] = json!("image");
    painter["protocol"] = json!("openaiImages");
    painter["url"] = json!("https://provider.test/v1/images/generations");
    put_model(&harness.app, painter).await;
    put_model(&harness.app, model_body("beta", None)).await;
    put_model(&harness.app, model_body("gamma", None)).await;

    let (status, view) = send(
        &harness.app,
        json_request(
            "PUT",
            "/api/v1/models/order",
            json!({ "category": "text", "ids": ["gamma", "alpha", "beta"] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    // The image model keeps the slot it had: arranging one category never
    // rearranges another.
    assert_eq!(
        model_ids(&view),
        ["gamma", "painter", "alpha", "beta"],
        "the category is in the order it was given"
    );

    // And the order is the stored one, not a view the server just built.
    let (_, reloaded) = send(&harness.app, plain_request("GET", "/api/v1/models")).await;
    assert_eq!(model_ids(&reloaded), ["gamma", "painter", "alpha", "beta"]);
}

#[tokio::test]
async fn an_order_has_to_name_every_model_of_the_category_once() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("alpha", None)).await;
    put_model(&harness.app, model_body("beta", None)).await;
    let mut painter = model_body("painter", None);
    painter["category"] = json!("image");
    painter["protocol"] = json!("openaiImages");
    painter["url"] = json!("https://provider.test/v1/images/generations");
    put_model(&harness.app, painter).await;

    // One left out, one named twice, and one from another category are all
    // orders that would silently lose a model if they were taken.
    for ids in [
        json!(["alpha"]),
        json!(["alpha", "alpha"]),
        json!(["alpha", "painter"]),
    ] {
        let (status, problem) = send(
            &harness.app,
            json_request(
                "PUT",
                "/api/v1/models/order",
                json!({ "category": "text", "ids": ids }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
        assert_eq!(problem["code"], "VALIDATION_FAILED");
    }

    // The list the client read is what a rearrangement is checked against.
    let (status, problem) = send(
        &harness.app,
        json_request(
            "PUT",
            "/api/v1/models/order",
            json!({
                "category": "text",
                "ids": ["beta", "alpha"],
                "expectedRevision": 0,
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{problem}");
    assert_eq!(problem["code"], "METADATA_CONFLICT");
}

/// The identifiers of a view's models, in the order it presents them.
fn model_ids(view: &Value) -> Vec<&str> {
    view["models"]
        .as_array()
        .expect("the view holds a model list")
        .iter()
        .map(|model| model["id"].as_str().expect("every model has an id"))
        .collect()
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

#[tokio::test]
async fn an_export_carries_every_model_and_never_a_plaintext_key() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("writer", Some(API_KEY))).await;
    let mut painter = model_body("painter", Some(API_KEY));
    painter["category"] = json!("image");
    painter["protocol"] = json!("openaiImages");
    painter["url"] = json!("https://provider.test/v1/images/generations");
    put_model(&harness.app, painter).await;
    let (status, _) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/defaults",
            json!({ "text": "writer", "image": "painter" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/preferences",
            json!({ "systemPrompt": "be brief" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let destination = root.path().join("moka-settings.json");
    let (status, report) =
        export_configuration(&harness, &destination, true, Some(TRANSFER_PASSPHRASE)).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["models"], 2);
    assert_eq!(report["keys"], 2);

    let raw = std::fs::read(&destination).unwrap();
    let text = String::from_utf8(raw.clone()).unwrap();
    assert!(!text.contains(API_KEY), "a credential was written in clear");
    let document: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(document["format"], "moka-canvas.settings");
    assert_eq!(document["version"], 1);
    assert_eq!(document["models"].as_array().unwrap().len(), 2);
    assert_eq!(document["credentials"]["count"], 2);
    assert!(
        document["models"]
            .as_array()
            .unwrap()
            .iter()
            .all(|model| model.get("apiKey").is_none()),
        "a model document carried a key field"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&destination)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "an export is not owner-only");
    }
}

#[tokio::test]
async fn a_previewed_import_restores_models_preferences_and_sealed_keys() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("writer", Some(API_KEY))).await;
    let mut painter = model_body("painter", Some(API_KEY));
    painter["category"] = json!("image");
    painter["protocol"] = json!("openaiImages");
    painter["url"] = json!("https://provider.test/v1/images/generations");
    put_model(&harness.app, painter).await;
    send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/defaults",
            json!({ "text": "writer", "image": "painter" }),
        ),
    )
    .await;
    send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/models/preferences",
            json!({ "systemPrompt": "be brief" }),
        ),
    )
    .await;

    let destination = root.path().join("moka-settings.json");
    let (status, _) =
        export_configuration(&harness, &destination, true, Some(TRANSFER_PASSPHRASE)).await;
    assert_eq!(status, StatusCode::OK);
    let text = std::fs::read_to_string(&destination).unwrap();

    for id in ["writer", "painter"] {
        let (status, _) = send(
            &harness.app,
            plain_request("DELETE", &format!("/api/v1/models/{id}")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let (_, empty) = send(&harness.app, plain_request("GET", "/api/v1/models")).await;
    assert_eq!(empty["models"], json!([]));

    let (status, preview) = preview_configuration(&harness, &text, "merge").await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["models"], 2);
    assert_eq!(preview["added"], 2);
    assert_eq!(preview["conflicts"], json!([]));
    assert_eq!(preview["secrets"], 2);
    assert_eq!(preview["byCategory"]["text"], 1);
    assert_eq!(preview["byCategory"]["image"], 1);

    let digest = preview["digest"].as_str().unwrap();
    let (status, applied) = import_configuration(
        &harness,
        &text,
        "merge",
        true,
        Some(TRANSFER_PASSPHRASE),
        digest,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["report"]["added"], 2);
    assert_eq!(applied["report"]["keysStored"], 2);
    assert!(applied["report"]["keyFailure"].is_null());
    let models = applied["view"]["models"].as_array().unwrap();
    assert_eq!(models.len(), 2);
    assert!(models.iter().all(|model| model["apiKey"]["set"] == true));
    assert!(models
        .iter()
        .all(|model| model["apiKey"]["masked"] == MASKED_KEY));
    assert_eq!(applied["view"]["defaults"]["text"], "writer");
    assert_eq!(applied["view"]["defaults"]["image"], "painter");
    assert_eq!(applied["view"]["preferences"]["systemPrompt"], "be brief");

    // A wrong passphrase reaches no write, so the model deleted before the
    // attempt is still gone.
    send(
        &harness.app,
        plain_request("DELETE", "/api/v1/models/writer"),
    )
    .await;
    let (status, preview) = preview_configuration(&harness, &text, "merge").await;
    assert_eq!(status, StatusCode::OK);
    let digest = preview["digest"].as_str().unwrap();
    let (status, problem) = import_configuration(
        &harness,
        &text,
        "merge",
        true,
        Some("wrong-passphrase-1"),
        digest,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "SETTINGS_PASSPHRASE_INVALID");
    let (_, after) = send(&harness.app, plain_request("GET", "/api/v1/models")).await;
    assert!(
        !after["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"] == "writer"),
        "a wrong passphrase still wrote the configuration"
    );
}

#[tokio::test]
async fn a_changed_file_and_a_stale_revision_are_refused() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("writer", Some(API_KEY))).await;
    let destination = root.path().join("moka-settings.json");
    export_configuration(&harness, &destination, false, None).await;
    let text = std::fs::read_to_string(&destination).unwrap();
    let (status, preview) = preview_configuration(&harness, &text, "merge").await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let digest = preview["digest"].as_str().unwrap();

    let edited = format!("{text}\n");
    let (status, problem) =
        import_configuration(&harness, &edited, "merge", false, None, digest).await;
    assert_eq!(status, StatusCode::CONFLICT, "{problem}");
    assert_eq!(problem["code"], "SETTINGS_FILE_CHANGED");

    let (_, view) = send(&harness.app, plain_request("GET", "/api/v1/models")).await;
    let revision = view["revision"].as_u64().unwrap();
    put_model(&harness.app, model_body("other", None)).await;
    let (status, problem) = send(
        &harness.app,
        json_request(
            "POST",
            "/api/v1/models/import",
            json!({
                "text": text,
                "mode": "merge",
                "expectedDigest": digest,
                "expectedRevision": revision,
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{problem}");
    assert_eq!(problem["code"], "METADATA_CONFLICT");
}

#[tokio::test]
async fn replace_removes_local_only_models_and_their_keys() {
    let source_root = tempfile::tempdir().unwrap();
    let source = harness(source_root.path());
    put_model(&source.app, model_body("kept", Some(API_KEY))).await;
    let destination = source_root.path().join("source-settings.json");
    let (status, _) = export_configuration(&source, &destination, false, None).await;
    assert_eq!(status, StatusCode::OK);
    let text = std::fs::read_to_string(&destination).unwrap();

    let target_root = tempfile::tempdir().unwrap();
    let target = harness(target_root.path());
    put_model(&target.app, model_body("local", Some(API_KEY))).await;
    put_model(&target.app, model_body("kept", Some(API_KEY))).await;

    let (status, preview) = preview_configuration(&target, &text, "replace").await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["localOnly"].as_array().unwrap().len(), 1);
    let digest = preview["digest"].as_str().unwrap();
    let (status, applied) =
        import_configuration(&target, &text, "replace", false, None, digest).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["report"]["removed"], 1);
    assert_eq!(applied["report"]["keysRemoved"], 1);
    let models = applied["view"]["models"].as_array().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["id"], "kept");
    assert_eq!(
        models[0]["apiKey"]["masked"], MASKED_KEY,
        "a surviving model keeps the key it had when the file carries none"
    );
    let (_, empty) = send(&target.app, plain_request("GET", "/api/v1/models")).await;
    assert!(
        !empty["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"] == "local"),
        "replace kept a model the file did not name"
    );
}

#[tokio::test]
async fn the_import_validator_names_what_is_wrong() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_model(&harness.app, model_body("writer", None)).await;
    let mut painter = model_body("painter", None);
    painter["category"] = json!("image");
    painter["protocol"] = json!("openaiImages");
    painter["url"] = json!("https://provider.test/v1/images/generations");
    put_model(&harness.app, painter).await;
    let destination = root.path().join("moka-settings.json");
    export_configuration(&harness, &destination, false, None).await;
    let text = std::fs::read_to_string(&destination).unwrap();
    let valid: Value = serde_json::from_str(&text).unwrap();

    let mut newer = valid.clone();
    newer["version"] = json!(2);
    let (status, problem) = preview_configuration(&harness, &newer.to_string(), "merge").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "SETTINGS_VERSION_UNSUPPORTED");

    let mut keyed = valid.clone();
    keyed["models"][0]["apiKey"] = json!("sk-hand-edited");
    let (status, problem) = preview_configuration(&harness, &keyed.to_string(), "merge").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "SETTINGS_FILE_INVALID");
    assert!(problem["message"].as_str().unwrap().contains("apiKey"));

    let mut duplicated = valid.clone();
    let first = duplicated["models"][0].clone();
    duplicated["models"].as_array_mut().unwrap().push(first);
    let (status, problem) = preview_configuration(&harness, &duplicated.to_string(), "merge").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "SETTINGS_FILE_INVALID");

    let mut unknown = valid.clone();
    unknown["models"][0]["protocol"] = json!("notInstalled");
    let (status, problem) = preview_configuration(&harness, &unknown.to_string(), "merge").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "SETTINGS_MODEL_INVALID");
    assert_eq!(problem["details"]["model"], "writer");

    let mut wrong_default = valid.clone();
    wrong_default["defaults"]["text"] = json!("painter");
    let (status, problem) =
        preview_configuration(&harness, &wrong_default.to_string(), "merge").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "SETTINGS_DEFAULTS_INVALID");
    assert_eq!(problem["details"]["capability"], "text");

    let (status, problem) = send(
        &harness.app,
        json_request(
            "POST",
            "/api/v1/models/import/preview",
            json!({ "path": "/tmp/moka-settings.json", "mode": "merge" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "VALIDATION_FAILED");

    let oversized = "x".repeat(moka_canvas::generate::settings::MAX_FILE_BYTES + 1);
    let (status, problem) = preview_configuration(&harness, &oversized, "merge").await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{problem}");
    assert_eq!(problem["code"], "SETTINGS_FILE_TOO_LARGE");
}

#[tokio::test]
async fn a_desktop_may_import_a_file_by_path() {
    let source_root = tempfile::tempdir().unwrap();
    let source = harness(source_root.path());
    put_model(&source.app, model_body("writer", Some(API_KEY))).await;
    let destination = source_root.path().join("moka-settings.json");
    let (status, _) =
        export_configuration(&source, &destination, true, Some(TRANSFER_PASSPHRASE)).await;
    assert_eq!(status, StatusCode::OK);

    let target_root = tempfile::tempdir().unwrap();
    let target = harness_with_mode(target_root.path(), RuntimeMode::Native);
    let (status, preview) = send(
        &target.app,
        json_request(
            "POST",
            "/api/v1/models/import/preview",
            json!({ "path": destination.to_string_lossy(), "mode": "merge" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["models"], 1);
    let digest = preview["digest"].as_str().unwrap();
    let (status, applied) = send(
        &target.app,
        json_request(
            "POST",
            "/api/v1/models/import",
            json!({
                "path": destination.to_string_lossy(),
                "mode": "merge",
                "includeKeys": true,
                "passphrase": TRANSFER_PASSPHRASE,
                "expectedDigest": digest,
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["view"]["models"][0]["apiKey"]["masked"], MASKED_KEY);
}
