use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, AppConfig, RuntimeMode};
use moka_canvas::domain::commands::make_node;
use moka_canvas::domain::NodeKind;
use serde_json::{json, Value};
use std::path::Path;
use tower::ServiceExt;

fn test_app(root: &Path) -> axum::Router {
    moka_canvas::server::router(open_state(parse_test_config(root)))
}

fn open_state(config: AppConfig) -> ApiState {
    let root = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    ApiState::new(config, RuntimeMode::Web, &root).expect("the metadata store opens")
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

fn multipart_request(
    uri: &str,
    file_field: (&str, &[u8]),
    text_fields: &[(&str, &str)],
) -> Request<Body> {
    let boundary = "X-MOKA-TEST-BOUNDARY";
    let mut body = Vec::new();
    for (name, value) in text_fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    let (filename, bytes) = file_field;
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
    let mut png = image::RgbaImage::new(64, 64);
    for pixel in png.pixels_mut() {
        *pixel = image::Rgba([200, 120, 60, 255]);
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

#[tokio::test]
async fn config_is_sanitized() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let raw = String::from_utf8(bytes.to_vec()).unwrap();
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(body["productName"], "Moka Canvas");
    assert_eq!(body["capabilities"]["mode"], "web");
    assert!(body["capabilities"]["assetCategories"].is_array());
    assert!(body["limits"]["maxNodesPerCanvas"].is_number());
    // Server internals and filesystem paths must never leak.
    assert!(!raw.contains("maxDocumentBytes"));
    assert!(!raw.contains("staticDir"));
    assert!(!raw.contains("bind"));
    assert!(!raw.contains(temp.path().to_string_lossy().as_ref()));
}

#[tokio::test]
async fn current_project_is_a_problem_when_nothing_is_open() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/problem+json"
    );
    let body = body_json(response).await;
    assert_eq!(body["code"], "PROJECT_NOT_OPEN");
    assert_eq!(body["status"], 409);
}

#[tokio::test]
async fn self_check_status_follows_the_read_behind_the_open() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let projects_dir = temp.path().join("checked");
    let created = create_project(&app, &projects_dir, "Checked").await;
    let root = created["root"].as_str().unwrap().to_string();

    // Nothing is filed yet, so there is nothing to read and the check is done
    // before anyone can ask about it.
    assert_eq!(created["selfCheckVerified"], true);

    // A picture gives the read behind an open something to do.
    let uploaded = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("still.png", &make_test_png()),
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(uploaded.status(), StatusCode::CREATED);

    let reopened = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/open",
            json!({ "path": root }),
        ))
        .await
        .unwrap();
    let opened = body_json(reopened).await;
    assert_eq!(opened["selfCheckVerified"], false);
    assert_eq!(opened["selfCheck"]["ok"], true);

    // The route answers with the check as it stands, and says when it is done.
    let mut verified = false;
    for _ in 0..200 {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/projects/current/self-check")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["report"]["ok"], true);
        if body["verified"] == true {
            verified = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(verified, "the file check never finished");
}

#[tokio::test]
async fn self_check_status_is_a_problem_when_nothing_is_open() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current/self-check")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(response).await["code"], "PROJECT_NOT_OPEN");
}

#[tokio::test]
async fn create_open_and_recent_flow() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let projects_dir = temp.path().join("projects");

    let created = create_project(&app, &projects_dir, "My Film").await;
    assert_eq!(created["moka"]["metadata"]["name"], "My Film");
    // The chosen folder was not there yet, so the project stands in it rather
    // than in a subfolder of its own.
    assert_eq!(
        created["root"].as_str().unwrap(),
        projects_dir.to_str().unwrap()
    );
    assert_eq!(created["selfCheck"]["ok"], true);
    let root = created["root"].as_str().unwrap().to_string();
    assert!(Path::new(&root).join("canvas.moka").is_file());

    // The created project is now current.
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
    assert_eq!(response.status(), StatusCode::OK);
    let current = body_json(response).await;
    assert_eq!(current["root"], json!(root));

    // Recent registry picked it up and can forget it again.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/recent-projects")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let recent = body_json(response).await;
    assert_eq!(recent.as_array().unwrap().len(), 1);
    let recent_id = recent[0]["id"].as_str().unwrap().to_string();
    assert_eq!(recent[0]["name"], "My Film");

    // Reopening by path is idempotent and keeps one recent entry.
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

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/recent-projects/{recent_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/recent-projects")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body_json(response).await.as_array().unwrap().len(), 0);
}

/// The same request, with the project it is about said in the header.
fn named(mut request: Request<Body>, project: &str) -> Request<Body> {
    request.headers_mut().insert(
        "x-moka-project",
        project.parse().expect("a project id fits in a header"),
    );
    request
}

/// The answer the current-project route gives about the project a request
/// names, in either form: a header, the query, or neither.
async fn current_of(
    app: &axum::Router,
    via_header: Option<&str>,
    via_query: Option<&str>,
) -> Value {
    let uri = match via_query {
        Some(id) => format!("/api/v1/projects/current?project={id}"),
        None => "/api/v1/projects/current".to_string(),
    };
    let mut request = Request::builder().uri(uri);
    if let Some(id) = via_header {
        request = request.header("x-moka-project", id);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

/// A request says which project it is about, and the answer is about that one.
///
/// Two windows on one server each keep a project of their own, and "the
/// current project" is a single slot they would otherwise fight over: a
/// request names its project in the header, and an address that cannot carry
/// one — a picture a tag asks for, a stream an `EventSource` reads — names the
/// same project in the query.
#[tokio::test]
async fn one_server_answers_about_the_project_each_request_names() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());

    let first = create_project(&app, &temp.path().join("first"), "First").await;
    let first_id = first["moka"]["metadata"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let first_root = first["root"].as_str().unwrap().to_string();
    let second = create_project(&app, &temp.path().join("second"), "Second").await;
    let second_id = second["moka"]["metadata"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let second_root = second["root"].as_str().unwrap().to_string();

    // Each window files a picture of its own. The first goes in named by a
    // header while the second project is the one that was opened last, so a
    // server that ignored the name would file it into the wrong project.
    let png = make_test_png();
    let response = app
        .clone()
        .oneshot(named(
            multipart_request("/api/v1/projects/current/assets", ("first.png", &png), &[]),
            &first_id,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let first_asset = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let shelved = current_of(&app, Some(&first_id), None).await;
    assert_eq!(
        shelved["moka"]["resources"]["images"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let untouched = current_of(&app, None, None).await;
    assert_eq!(untouched["moka"]["metadata"]["id"], json!(second_id));
    assert!(
        untouched["moka"]["resources"]["images"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{untouched}"
    );

    // The second files by naming itself in the query, the way anything that
    // cannot set a header has to.
    let response = app
        .clone()
        .oneshot(multipart_request(
            &format!("/api/v1/projects/current/assets?project={second_id}"),
            ("second.png", &png),
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    // A request that names nothing is about the project opened last.
    let answered = current_of(&app, None, None).await;
    assert_eq!(answered["root"], json!(second_root));
    assert_eq!(answered["moka"]["metadata"]["name"], "Second");
    assert_eq!(
        answered["moka"]["resources"]["images"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // A header names the first project, and so does the query.
    let answered = current_of(&app, Some(&first_id), None).await;
    assert_eq!(answered["root"], json!(first_root));
    assert_eq!(answered["moka"]["metadata"]["name"], "First");
    let answered = current_of(&app, None, Some(&first_id)).await;
    assert_eq!(answered["root"], json!(first_root));

    // Both at once: a client that can set a header speaks with one voice even
    // when the address beside it still carries the parameter.
    let answered = current_of(&app, Some(&first_id), Some(&second_id)).await;
    assert_eq!(answered["root"], json!(first_root));

    // A project nobody holds open is refused in either form.
    let unknown = "0192b7d4-0000-7000-8000-0000000000ff";
    for request in [
        Request::builder()
            .uri(format!("/api/v1/projects/current?project={unknown}"))
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .uri("/api/v1/projects/current")
            .header("x-moka-project", unknown)
            .body(Body::empty())
            .unwrap(),
    ] {
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response
                .headers()
                .get("x-error-code")
                .and_then(|value| value.to_str().ok()),
            Some("PROJECT_NOT_OPEN")
        );
    }

    // The picture is served out of the project the address names: a tag asking
    // for a picture sends no header of its own.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/projects/current/assets/{first_asset}?project={first_id}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[..], &png[..]);

    // The same address without the name is about the current project, which
    // never held that picture.
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/assets/{first_asset}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_folder_that_holds_something_needs_consent_before_a_project_goes_in() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let folder = temp.path().join("films");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("notes.txt"), "a reader's own file").unwrap();

    // Refused while nobody has said where the work is meant to land, and the
    // folder is left exactly as it was.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({ "directory": folder.to_string_lossy(), "name": "My Film" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "TARGET_DIRECTORY_NOT_EMPTY");
    let written = std::fs::read_dir(&folder).unwrap().count();
    assert_eq!(written, 1, "only the reader's own file is still there");

    // Agreed: the project goes into a subfolder of its own, and the reader's
    // file stands where it was.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({
                "directory": folder.to_string_lossy(),
                "name": "My Film",
                "useSubdirectory": true,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let created = body_json(response).await;
    assert!(created["root"].as_str().unwrap().ends_with("my-film"));
    assert!(folder.join("notes.txt").is_file());
    assert!(folder.join("my-film").join("canvas.moka").is_file());
}

#[tokio::test]
async fn a_chinese_name_names_its_subfolder_in_chinese() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let folder = temp.path().join("films");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("kept.txt"), "kept").unwrap();

    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({
                "directory": folder.to_string_lossy(),
                "name": "中文项目",
                "useSubdirectory": true,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let created = body_json(response).await;
    // The words of the name, not the "asset" the slug used to fall back to
    // when every character of it was outside ASCII.
    assert!(created["root"].as_str().unwrap().ends_with("中文项目"));
    assert!(folder.join("中文项目").join("canvas.moka").is_file());
}

#[tokio::test]
async fn a_folder_holding_nothing_but_the_systems_own_note_counts_as_empty() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let folder = temp.path().join("films");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join(".DS_Store"), "").unwrap();

    let created = create_project(&app, &folder, "My Film").await;
    assert_eq!(created["root"].as_str().unwrap(), folder.to_str().unwrap());
}

#[tokio::test]
async fn commands_apply_and_revision_conflicts_surface() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Cmd").await;
    let canvas_id = created["moka"]["canvas"][0]["id"].as_str().unwrap();
    let revision = created["moka"]["metadata"]["revision"].as_i64().unwrap();

    let rename = json!({
        "expectedRevision": revision,
        "commands": [
            { "type": "renameCanvas", "canvasId": canvas_id, "name": "Storyboard" }
        ]
    });
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            rename.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let saved = body_json(response).await;
    assert_eq!(saved["revision"], revision + 1);

    // Replaying with the stale revision is a 409 conflict.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            rename,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "REVISION_CONFLICT");

    // An invalid command is rejected with a problem body.
    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision + 1,
                "commands": [
                    { "type": "renameCanvas", "canvasId": "missing", "name": "Nope" }
                ]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "CANVAS_NOT_FOUND");
}

#[tokio::test]
async fn saving_the_project_s_own_words_refreshes_the_card_the_launcher_shows() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "My Film").await;
    let revision = created["moka"]["metadata"]["revision"].as_i64().unwrap();

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/recent-projects")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let recent = body_json(response).await;
    assert_eq!(recent[0]["name"], "My Film");

    // A save that carried the project's own words is written down again in the
    // recent list, which otherwise hears of a project only when one is opened.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision,
                "commands": [{
                    "type": "updateProjectMetadata",
                    "name": "Autumn campaign",
                    "description": "A launch teaser"
                }]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/recent-projects")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let recent = body_json(response).await;
    assert_eq!(recent[0]["name"], "Autumn campaign");
}

#[tokio::test]
async fn canvas_settings_change_a_part_and_keep_the_rest() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "View").await;
    let canvas_id = created["moka"]["canvas"][0]["id"].as_str().unwrap();
    let revision = created["moka"]["metadata"]["revision"].as_i64().unwrap();

    // Only the background is named, so the minimap preference stays where it was.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision,
                "commands": [
                    {
                        "type": "setCanvasSettings",
                        "canvasId": canvas_id,
                        "settings": { "background": "blank" }
                    }
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
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let current = body_json(response).await;
    let settings = &current["moka"]["canvas"][0]["settings"];
    assert_eq!(settings["background"], "blank");
    assert_eq!(settings["showMinimap"], true);
    assert_eq!(settings["snapToGrid"], true);

    // A background nothing recognises is refused before it reaches the document.
    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision + 1,
                "commands": [
                    {
                        "type": "setCanvasSettings",
                        "canvasId": canvas_id,
                        "settings": { "background": "stripes" }
                    }
                ]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "VALIDATION_FAILED");
}

#[tokio::test]
async fn a_picture_is_served_small_from_the_project_s_own_cache() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Thumbs").await;
    let root = created["root"].as_str().unwrap().to_string();

    let uploaded = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &make_test_png()),
            &[],
        ))
        .await
        .unwrap();
    let asset_id = body_json(uploaded).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let uri = format!("/api/v1/projects/current/assets/{asset_id}");

    // Asked for at a width, a picture is answered as a drawing of that size.
    let small = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("{uri}?w=32"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(small.status(), StatusCode::OK);
    assert_eq!(
        small.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/jpeg"
    );
    let drawn = to_bytes(small.into_body(), usize::MAX).await.unwrap();
    let picture = image::load_from_memory(&drawn).unwrap();
    assert_eq!((picture.width(), picture.height()), (32, 32));

    // It is kept beside the project, and asking again reads it rather than
    // drawing it again.
    let cache = std::path::Path::new(&root).join("cache/thumbs");
    let kept: Vec<std::path::PathBuf> = std::fs::read_dir(&cache)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    let stamp = std::fs::metadata(&kept[0]).unwrap().modified().unwrap();
    app.clone()
        .oneshot(
            Request::builder()
                .uri(format!("{uri}?w=32"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(&kept[0]).unwrap().modified().unwrap(),
        stamp
    );

    // The width is read as the ceiling and the floor it is, and a picture is
    // never made larger than it is: a request past either is answered with what
    // was really drawn.
    for (asked, drawn) in [("1", 32), ("100000", 64)] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("{uri}?w={asked}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), drawn);
    }

    // A width on something that is not a picture is ignored: the file is served
    // as it always is.
    let text = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("notes.txt", b"a line of words"),
            &[],
        ))
        .await
        .unwrap();
    let text_id = body_json(text).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let served = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/assets/{text_id}?w=32"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(served.status(), StatusCode::OK);
    assert_eq!(
        served.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/plain"
    );
}

#[tokio::test]
async fn asset_upload_stream_range_and_delete() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Assets").await;
    let png = make_test_png();

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &png),
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let change = body_json(response).await;
    assert!(change["revision"].is_number());
    let entry = &change["entry"];
    assert_eq!(entry["mime"], "image/png");
    assert_eq!(entry["probe"]["width"], 64);
    let asset_id = entry["id"].as_str().unwrap().to_string();

    // Full download.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/assets/{asset_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/png"
    );
    assert_eq!(
        response.headers().get(header::ACCEPT_RANGES).unwrap(),
        "bytes"
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[..], &png[..]);

    // Ranged download.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/assets/{asset_id}"))
                .header(header::RANGE, "bytes=0-9")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers().get(header::CONTENT_RANGE).unwrap(),
        &format!("bytes 0-9/{}", png.len())
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[..], &png[..10]);

    // Delete and confirm the asset is gone.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/projects/current/assets/{asset_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let deleted = body_json(response).await;
    assert!(deleted["revision"].is_number());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/assets/{asset_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_asset_takes_what_a_reader_says_about_it() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Shelf").await;
    let png = make_test_png();

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &png),
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let asset_id = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let shelf_uri = format!("/api/v1/projects/current/assets/{asset_id}");

    let response = app
        .clone()
        .oneshot(json_request(
            "PATCH",
            &shelf_uri,
            json!({
                "tags": ["lake", "dusk"],
                "note": "Kept for the opening shot.",
                "favorite": true,
                "keyword": "A lantern floats over a quiet lake at dusk.",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let change = body_json(response).await;
    let entry = &change["entry"];
    assert_eq!(entry["tags"][0], "lake");
    assert_eq!(entry["tags"][1], "dusk");
    assert_eq!(entry["note"], "Kept for the opening shot.");
    assert_eq!(entry["favorite"], true);
    assert_eq!(
        entry["keyword"],
        "A lantern floats over a quiet lake at dusk."
    );
    assert_eq!(entry["origin"], "brought");
    assert!(change["revision"].is_number());

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(shelf_uri.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[..], &png[..]);

    let response = app
        .clone()
        .oneshot(json_request(
            "PATCH",
            &shelf_uri,
            json!({ "note": "x".repeat(2001) }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "VALIDATION_FAILED");

    let response = app
        .oneshot(json_request(
            "PATCH",
            "/api/v1/projects/current/assets/no-such-asset",
            json!({ "note": "said of something not on the shelf" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_text_node_is_filed_once_and_its_words_come_back() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Filed").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let revision = created["moka"]["metadata"]["revision"].as_i64().unwrap();

    let mut node = make_node(NodeKind::Text, "Filed line".into(), 0.0, 0.0);
    node.data.content = Some("Filed from the document.".into());
    let node_id = node.id.clone();

    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision,
                "commands": [
                    {
                        "type": "addNode",
                        "canvasId": canvas_id.clone(),
                        "node": serde_json::to_value(&node).unwrap(),
                    }
                ]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let filed = json!({ "canvasId": canvas_id.clone(), "nodeId": node_id.clone() });
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/assets/from-node",
            filed.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = body_json(response).await;
    assert_eq!(body["created"], true);
    let entry = &body["entry"];
    assert_eq!(entry["origin"], "filed");
    assert_eq!(entry["favorite"], true);
    assert_eq!(entry["name"], "Filed line.md");
    assert_eq!(entry["mime"], "text/markdown");
    assert_eq!(entry["provenance"]["operationNodeId"], node_id);
    assert!(entry["path"].as_str().unwrap().starts_with("assets/texts/"));
    let asset_id = entry["id"].as_str().unwrap().to_string();

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/assets/{asset_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[..], b"Filed from the document.");

    // Filing the same words from the same node answers with the entry it made
    // the first time rather than a second copy of it.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/assets/from-node",
            filed,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let again = body_json(response).await;
    assert_eq!(again["created"], false);
    assert_eq!(again["entry"]["id"], asset_id);

    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/assets/from-node",
            json!({ "canvasId": canvas_id, "nodeId": "no-such-node" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(response).await["code"], "NOT_FOUND");
}

#[tokio::test]
async fn reveal_unknown_asset_is_not_found() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Reveal").await;

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/projects/current/assets/nope/reveal")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn export_then_import_roundtrip() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Pack").await;
    let png = make_test_png();
    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &png),
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    // A package goes where the request says, the way a save dialog decided it.
    let asked = temp.path().join("saves").join("Pack.mokapkg.zip");
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/export",
            json!({ "destination": asked.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let report = body_json(response).await;
    let destination = report["destination"].as_str().unwrap().to_string();
    assert_eq!(Path::new(&destination), asked);
    assert!(Path::new(&destination).is_file());
    assert!(report["entries"].as_u64().unwrap() >= 2);
    assert_eq!(report["incomplete"], false);

    let imports_dir = temp.path().join("imports");
    std::fs::create_dir_all(&imports_dir).unwrap();
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/import",
            json!({
                "archivePath": destination,
                "directory": imports_dir.to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let opened = body_json(response).await;
    assert_eq!(opened["moka"]["metadata"]["name"], "Pack");
    let imported_root = opened["root"].as_str().unwrap();
    assert!(Path::new(imported_root).join("canvas.moka").is_file());

    // Runs endpoint serves the (empty) run history of the open project.
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
    assert_eq!(body_json(response).await.as_array().unwrap().len(), 0);
}

/// A package nobody said where to put is refused: the destination is the
/// reader's own choice, and there is no place the server may invent for it.
#[tokio::test]
async fn an_export_without_a_destination_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Nowhere").await;

    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/export",
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "VALIDATION_FAILED");

    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/export",
            json!({ "destination": "   " }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "VALIDATION_FAILED");
}

#[tokio::test]
async fn malformed_json_is_a_problem() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/projects")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{not json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "VALIDATION_FAILED");
}

#[tokio::test]
async fn readiness_reports_metadata_and_config_checks() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["status"], "ready");
    assert_eq!(body["checks"]["config"], true);
    assert_eq!(body["checks"]["metadata"], true);
    assert_eq!(body["checks"]["projectDirectory"], true);
}

#[tokio::test]
async fn api_responses_carry_request_ids_and_problem_codes() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .expect("x-request-id header");
    assert_eq!(request_id.len(), 12);
    assert!(request_id.chars().all(|c| c.is_ascii_hexdigit()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.headers().get("x-request-id").unwrap().len(), 12);
    assert_eq!(
        response.headers().get("x-error-code").unwrap(),
        "PROJECT_NOT_OPEN"
    );
}

#[tokio::test]
async fn a_picture_tool_answers_with_what_it_filed_and_not_with_the_picture() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Tools").await;

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &make_test_png()),
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let subject = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({
                "tool": "crop",
                "assetId": subject,
                "params": { "region": { "x": 4, "y": 4, "width": 32, "height": 16 } },
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let report = body_json(response).await;
    assert!(report["revision"].is_number());
    let entries = report["entries"].as_array().expect("what was filed");
    assert_eq!(entries.len(), 1);
    let made = &entries[0];
    // Named the way an imported picture is: the registry reads an ending off a
    // name to decide how to store the file, so one without it would leave this
    // the only picture in the project whose name does not say what it is.
    assert_eq!(made["name"], "lake-32x16.png");
    assert_eq!(made["probe"]["width"], 32);
    assert_eq!(made["probe"]["height"], 16);
    // Nothing was asked of anybody, so there is no run behind this and nothing
    // for it to have come with.
    assert!(report.get("prompt").is_none());
    assert_eq!(made["provenance"]["runId"], Value::Null);
    assert_eq!(made["provenance"]["operationNodeId"], Value::Null);
    assert_eq!(made["provenance"]["inputAssetIds"], json!([subject]));
    assert_eq!(
        made["provenance"]["parameterSnapshot"]["tool"],
        json!("crop")
    );

    // The answer names the asset rather than carrying it, so the picture is
    // asked for the way any other asset in the project is.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/projects/current/assets/{}",
                    made["id"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/png"
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(!bytes.is_empty(), "the result is a picture, not a promise");
}

#[tokio::test]
async fn a_picture_tool_that_cannot_be_done_is_refused_as_a_problem() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Tools").await;

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &make_test_png()),
            &[],
        ))
        .await
        .unwrap();
    let picture = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("note.txt", b"a sentence, which has no picture in it"),
            &[],
        ))
        .await
        .unwrap();
    let words = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // A tool nobody has is not guessed at, and the refusal names what was asked
    // for so a reader can see which word was the problem.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({ "tool": "prettify", "assetId": picture }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response.headers().get("x-error-code").unwrap(),
        "VALIDATION_FAILED"
    );
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "VALIDATION_FAILED");
    assert!(
        problem["message"].as_str().unwrap().contains("prettify"),
        "{problem}"
    );

    // A field this tool does not have is refused rather than quietly dropped,
    // because dropping it would answer a different question and call it this one.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({
                "tool": "crop",
                "assetId": picture,
                "params": { "region": { "x": 0, "y": 0, "width": 8, "height": 8 }, "sharpen": true },
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body_json(response).await["code"],
        Value::String("VALIDATION_FAILED".into())
    );

    // A subject with no picture in it is a different refusal from a bad ask:
    // the ask was fine, the thing it was pointed at cannot be worked on.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({
                "tool": "crop",
                "assetId": words,
                "params": { "ratio": "1:1" },
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        response.headers().get("x-error-code").unwrap(),
        "UNSUPPORTED_MEDIA_TYPE"
    );

    // And a subject the project does not hold is simply not there.
    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({
                "tool": "crop",
                "assetId": "asset-nobody-has",
                "params": { "ratio": "1:1" },
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// A listing of one directory: what the web runtime's own file dialog is made
/// of, and the only thing about the filesystem this API says out loud.
#[tokio::test]
async fn the_filesystem_route_lists_the_folders_and_the_files_asked_for() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let somewhere = tempfile::tempdir().unwrap();
    std::fs::create_dir(somewhere.path().join("Pictures")).unwrap();
    std::fs::create_dir(somewhere.path().join(".config")).unwrap();
    std::fs::write(somewhere.path().join("launch.moka"), b"").unwrap();
    std::fs::write(somewhere.path().join("picture.png"), b"").unwrap();

    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", &somewhere.path().display().to_string())
        .append_pair("extensions", "moka, zip")
        .finish();
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/filesystem?{query}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;

    // The folders, and the one file of a kind that was asked for. A dot
    // directory and a file nobody asked about are not part of the answer.
    let entries = body["entries"]
        .as_array()
        .expect("a listing carries entries");
    let names: Vec<&str> = entries
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Pictures", "launch.moka"]);
    assert_eq!(entries[0]["kind"], "directory");
    assert_eq!(entries[1]["kind"], "file");
    assert_eq!(body["truncated"], false);
    // Both the directory listed and the way up out of it, so a dialog can say
    // where it is rather than keeping track of where it has been. Resolved,
    // which on a Mac is not the path a temporary directory was handed out as.
    assert!(body["parent"].as_str().is_some());
    let listed = std::fs::canonicalize(somewhere.path()).unwrap();
    assert_eq!(body["path"].as_str().unwrap(), listed.to_string_lossy());
    assert_eq!(
        entries[1]["path"].as_str().unwrap(),
        listed.join("launch.moka").to_string_lossy()
    );
}

/// What a listing refuses, in the shape a caller reads a refusal from.
#[tokio::test]
async fn a_path_that_is_not_a_directory_is_refused_as_a_problem() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let file = temp.path().join("a-file");
    std::fs::write(&file, b"").unwrap();

    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", &file.display().to_string())
        .finish();
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/filesystem?{query}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "VALIDATION_FAILED");
}

/// A router labelled as the desktop runtime. The metadata store is opened the
/// way the web runtime opens it, because what a listing is refused over is the
/// label and nothing about the store behind it.
fn desktop_test_app(root: &Path) -> axum::Router {
    let config = parse_test_config(root);
    let dir = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    let metadata = moka_canvas::metadata::open(&dir, &config.metadata, RuntimeMode::Web)
        .expect("the metadata store opens");
    let state = ApiState::with_metadata(config, RuntimeMode::Native, metadata, root.join("models"));
    moka_canvas::server::router(state)
}

/// The desktop runtime is not served a listing: it has the operating system's
/// own dialog, and a route nothing there calls would be a way of reading this
/// machine's directories that otherwise does not exist.
#[tokio::test]
async fn the_desktop_runtime_is_not_served_a_directory_listing() {
    let temp = tempfile::tempdir().unwrap();
    let somewhere = tempfile::tempdir().unwrap();
    std::fs::create_dir(somewhere.path().join("Pictures")).unwrap();

    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", &somewhere.path().display().to_string())
        .finish();
    let response = desktop_test_app(temp.path())
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/filesystem?{query}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(response).await["code"], "NOT_FOUND");
}

/// A save writes where the dialog said, in either runtime.
///
/// The listing is the web runtime's question because it has no dialog of its
/// own; a write is the other half of the same question in both runtimes, since
/// the window holding the bytes cannot put them on this machine's disk itself.
#[tokio::test]
async fn a_save_writes_where_it_was_told_in_either_runtime() {
    let web_home = tempfile::tempdir().unwrap();
    let desktop_home = tempfile::tempdir().unwrap();
    let somewhere = tempfile::tempdir().unwrap();
    let target = somewhere.path().join("Cut.mp4");

    for app in [
        test_app(web_home.path()),
        desktop_test_app(desktop_home.path()),
    ] {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", &target.display().to_string())
            .finish();
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/v1/filesystem/file?{query}"))
                    .body(Body::from("artifact"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["path"], target.to_string_lossy().as_ref());
        assert_eq!(body["bytes"], 8);
        assert_eq!(std::fs::read(&target).unwrap(), b"artifact");
    }
}

/// What a save refuses: a path with no root to resolve it against, a folder
/// that is not there, and a destination that is a folder itself.
#[tokio::test]
async fn a_save_refuses_a_path_it_cannot_write() {
    let home = tempfile::tempdir().unwrap();
    let app = test_app(home.path());
    let somewhere = tempfile::tempdir().unwrap();

    let cases = [
        (
            "relative/Cut.mp4".to_string(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
        ),
        (
            somewhere
                .path()
                .join("nowhere")
                .join("Cut.mp4")
                .display()
                .to_string(),
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
        ),
        (
            somewhere.path().display().to_string(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
        ),
    ];
    for (path, status, code) in cases {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", &path)
            .finish();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/v1/filesystem/file?{query}"))
                    .body(Body::from("artifact"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{path}");
        assert_eq!(body_json(response).await["code"], code, "{path}");
    }
}

/// A reveal of something that is not a file is refused before the platform's
/// file manager is asked anything.
#[tokio::test]
async fn a_reveal_of_something_that_is_not_there_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let app = test_app(home.path());
    let missing = home.path().join("nowhere").join("Cut.mp4");

    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/filesystem/reveal",
            json!({ "path": missing.display().to_string() }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "VALIDATION_FAILED");
}
