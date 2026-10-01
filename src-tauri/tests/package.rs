use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use base64::Engine;
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, AppConfig, RuntimeMode};
use moka_canvas::domain::{
    derive_ports, AssetProvenance, AssistantMessage, AssistantRole, AssistantSession,
    DocumentCommand, MokaFile, NodeData, NodeKind, Rect, WorkflowNode, PACKAGE_MANIFEST_VERSION,
};
use moka_canvas::metadata::{crypto, docs};
use moka_canvas::project::codec::decode_moka_file;
use moka_canvas::project::store::{FsProjectStore, ProjectRegistry};
use moka_canvas::project::{CreateProject, PackageScope, ProjectStore, StagedAsset};
use serde_json::{json, Value};
use sha2::Digest;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower::ServiceExt;

fn test_app(root: &Path) -> axum::Router {
    moka_canvas::server::router(open_state(parse_test_config(root)))
}

fn test_app_with(root: &Path, tweak: impl FnOnce(&mut AppConfig)) -> axum::Router {
    let mut config = parse_test_config(root);
    tweak(&mut config);
    moka_canvas::server::router(open_state(config))
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

fn multipart_request(uri: &str, file_field: (&str, &[u8])) -> Request<Body> {
    let boundary = "X-MOKA-TEST-BOUNDARY";
    let (filename, bytes) = file_field;
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

async fn export_open_project(app: &axum::Router, payload: Value) -> Value {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/export",
            payload,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

async fn try_import(app: &axum::Router, archive: &Path, directory: &Path) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/import",
            json!({
                "archivePath": archive.to_string_lossy(),
                "directory": directory.to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = body_json(response).await;
    (status, body)
}

fn read_zip_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
    let file = std::fs::File::open(path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        if entry.is_dir() {
            continue;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        entries.push((entry.name().replace('\\', "/"), bytes));
    }
    entries
}

fn write_zip(path: &Path, entries: &[(String, Vec<u8>)]) {
    let file = std::fs::File::create(path).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        writer.start_file(name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
}

/// A failed import must not leave a target directory or staging tree behind.
fn assert_import_left_no_trace(directory: &Path, target_name: &str) {
    assert!(
        !directory.join(target_name).exists(),
        "target directory must not exist after a rejected import"
    );
    if directory.exists() {
        for entry in std::fs::read_dir(directory).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(
                !name.starts_with(".moka-import-"),
                "staging directory leaked: {name}"
            );
        }
    }
}

/// Builds a valid exported package of a project holding one image asset.
async fn stage_valid_package(root: &Path) -> (axum::Router, PathBuf) {
    let app = test_app(root);
    create_project(&app, &root.join("projects"), "Pack").await;
    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &make_test_png()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let asked = root.join("staged.mokapkg.zip");
    let report = export_open_project(&app, json!({ "destination": asked.to_string_lossy() })).await;
    let destination = PathBuf::from(report["destination"].as_str().unwrap());
    assert!(destination.is_file());
    (app, destination)
}

#[tokio::test]
async fn import_rejects_a_non_zip_file() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let archive = temp.path().join("not-a-package.zip");
    std::fs::write(&archive, b"this is not a zip archive").unwrap();

    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &archive, &imports).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "PACKAGE_INVALID");
    assert_import_left_no_trace(&imports, "not-a-package");
}

#[tokio::test]
async fn import_rejects_entries_that_escape_the_target() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());

    for (label, evil_name) in [("dotdot", "../evil.txt"), ("absolute", "/abs/evil.txt")] {
        let archive = temp.path().join(format!("slip-{label}.zip"));
        write_zip(
            &archive,
            &[
                (evil_name.to_string(), b"pwned".to_vec()),
                ("canvas.moka".to_string(), b"placeholder".to_vec()),
            ],
        );
        let imports = temp.path().join(format!("imports-{label}"));
        let (status, body) = try_import(&app, &archive, &imports).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{label} entry must be rejected"
        );
        assert_eq!(body["code"], "PACKAGE_INVALID");
        assert!(
            !temp.path().join("evil.txt").exists(),
            "zip-slip entry must not be written outside the target"
        );
        assert!(
            !Path::new("/abs/evil.txt").exists(),
            "absolute entry must not be written"
        );
        assert_import_left_no_trace(&imports, &format!("slip-{label}"));
    }
}

#[tokio::test]
async fn import_rejects_entries_that_fail_manifest_verification() {
    let temp = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(temp.path()).await;

    let mut entries = read_zip_entries(&valid);
    let asset = entries
        .iter_mut()
        .find(|(name, _)| name.starts_with("assets/"))
        .expect("package holds an asset");
    asset.1.extend_from_slice(b"tampered");

    let tampered = temp.path().join("tampered.zip");
    write_zip(&tampered, &entries);

    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &tampered, &imports).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "PACKAGE_INVALID");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("failed verification"),
        "unexpected message: {}",
        body["message"]
    );
    assert_import_left_no_trace(&imports, "tampered");
}

#[tokio::test]
async fn import_rejects_a_package_without_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(temp.path()).await;

    let entries: Vec<(String, Vec<u8>)> = read_zip_entries(&valid)
        .into_iter()
        .filter(|(name, _)| name != "moka-package.json")
        .collect();
    let no_manifest = temp.path().join("no-manifest.zip");
    write_zip(&no_manifest, &entries);

    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &no_manifest, &imports).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "PACKAGE_INVALID");
    assert!(
        body["message"].as_str().unwrap().contains("manifest"),
        "unexpected message: {}",
        body["message"]
    );
    assert_import_left_no_trace(&imports, "no-manifest");
}

#[tokio::test]
async fn import_rejects_an_unsupported_format_version() {
    let temp = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(temp.path()).await;

    let mut entries = read_zip_entries(&valid);
    let manifest = entries
        .iter_mut()
        .find(|(name, _)| name == "moka-package.json")
        .expect("package holds a manifest");
    let mut parsed: Value = serde_json::from_slice(&manifest.1).unwrap();
    parsed["formatVersion"] = json!(999);
    manifest.1 = serde_json::to_vec_pretty(&parsed).unwrap();

    let future = temp.path().join("future.zip");
    write_zip(&future, &entries);

    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &future, &imports).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "MOKA_VERSION_UNSUPPORTED");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains(&format!("this build reads 1 to {PACKAGE_MANIFEST_VERSION}")),
        "a refusal says what would have been taken: {}",
        body["message"]
    );
    assert_import_left_no_trace(&imports, "future");
}

#[tokio::test]
async fn import_rejects_packages_beyond_the_configured_limits() {
    let source = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(source.path()).await;
    drop(app);

    // Entry-count limit.
    let temp = tempfile::tempdir().unwrap();
    let app = test_app_with(temp.path(), |config| {
        config.limits.max_package_entries = 1;
    });
    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &valid, &imports).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["code"], "PAYLOAD_TOO_LARGE");
    assert_import_left_no_trace(&imports, valid.file_stem().unwrap().to_str().unwrap());

    // Byte limit: every real entry exceeds a 64-byte ceiling.
    let temp = tempfile::tempdir().unwrap();
    let app = test_app_with(temp.path(), |config| {
        config.limits.max_package_bytes = 64;
    });
    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &valid, &imports).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["code"], "PAYLOAD_TOO_LARGE");
    assert_import_left_no_trace(&imports, valid.file_stem().unwrap().to_str().unwrap());
}

#[tokio::test]
async fn import_conflicts_when_the_target_directory_is_not_empty() {
    let temp = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(temp.path()).await;

    let imports = temp.path().join("imports");
    std::fs::create_dir_all(&imports).unwrap();
    let (status, _) = try_import(&app, &valid, &imports).await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, body) = try_import(&app, &valid, &imports).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "CONFLICT");
}

#[tokio::test]
async fn export_blocks_missing_assets_until_explicitly_allowed() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Gone").await;
    let root = PathBuf::from(created["root"].as_str().unwrap());

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("gone.png", &make_test_png()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let change = body_json(response).await;
    let asset_path = change["entry"]["path"].as_str().unwrap().to_string();
    std::fs::remove_file(root.join(&asset_path)).unwrap();

    // Default: refuse to export an incomplete project.
    let blocked = temp.path().join("blocked.mokapkg.zip");
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/export",
            json!({ "destination": blocked.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(response).await["code"], "ASSET_MISSING");

    // Explicit opt-in exports with the manifest flagged incomplete.
    let asked = temp.path().join("incomplete.mokapkg.zip");
    let report = export_open_project(
        &app,
        json!({
            "destination": asked.to_string_lossy(),
            "allowIncomplete": true,
        }),
    )
    .await;
    assert_eq!(report["incomplete"], true);
    let destination = PathBuf::from(report["destination"].as_str().unwrap());
    let entries = read_zip_entries(&destination);
    assert!(
        entries
            .iter()
            .all(|(name, _)| !name.starts_with("tmp/") && name != &asset_path),
        "temporary files and the missing asset must be excluded"
    );
    let manifest = entries
        .iter()
        .find(|(name, _)| name == "moka-package.json")
        .expect("export carries a manifest");
    let manifest: Value = serde_json::from_slice(&manifest.1).unwrap();
    assert_eq!(manifest["incomplete"], true);
}

fn manifest_of(entries: &[(String, Vec<u8>)]) -> Value {
    let (_, bytes) = entries
        .iter()
        .find(|(name, _)| name == "moka-package.json")
        .expect("a package carries a manifest");
    serde_json::from_slice(bytes).unwrap()
}

/// A run this machine made is a fact about this machine: the work is what a
/// package is for, and the record of having done it here travels only when
/// somebody asks for the whole thing.
#[tokio::test]
async fn a_run_record_travels_only_in_a_package_that_asked_for_it() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Ledger").await;
    let root = PathBuf::from(created["root"].as_str().unwrap());

    let record_name = "history/runs/0192b7d4-1111-7000-8000-000000000001.json";
    let record = root.join(record_name);
    std::fs::create_dir_all(record.parent().unwrap()).unwrap();
    let record_bytes = serde_json::to_vec_pretty(&json!({
        "id": "0192b7d4-1111-7000-8000-000000000001",
        "projectId": created["moka"]["metadata"]["id"],
        "canvasId": created["moka"]["canvas"][0]["id"],
        "requestedNodeIds": [],
        "status": "succeeded",
        "executorKey": "graph",
        "graphHash": "0".repeat(64),
        "parameters": { "model": "a-model" },
        "steps": [],
        "cancelRequested": false,
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:01Z",
    }))
    .unwrap();
    std::fs::write(&record, &record_bytes).unwrap();

    let work = temp.path().join("work.mokapkg.zip");
    export_open_project(&app, json!({ "destination": work.to_string_lossy() })).await;
    let entries = read_zip_entries(&work);
    assert!(
        entries.iter().all(|(name, _)| name != record_name),
        "a package of the work carries no record of the runs made here"
    );
    let manifest = manifest_of(&entries);
    assert_eq!(manifest["formatVersion"], 2);
    assert_eq!(manifest["personalHistory"], false);
    let runs = manifest["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["rule"] == "history/runs/**")
        .expect("the manifest names the rule that kept the runs out");
    assert_eq!(runs["files"], 1);
    assert_eq!(runs["bytes"], record_bytes.len() as u64);

    let backup = temp.path().join("backup.mokapkg.zip");
    export_open_project(
        &app,
        json!({
            "destination": backup.to_string_lossy(),
            "includePersonalHistory": true,
        }),
    )
    .await;
    let entries = read_zip_entries(&backup);
    assert!(
        entries
            .iter()
            .any(|(name, bytes)| name == record_name && *bytes == record_bytes),
        "a full backup carries the run record intact"
    );
    let manifest = manifest_of(&entries);
    assert_eq!(manifest["personalHistory"], true);
    assert!(
        manifest["skipped"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["rule"] != "history/runs/**"),
        "a rule that kept nothing out has nothing to say"
    );

    let imports = temp.path().join("imports");
    let (status, _) = try_import(&app, &work, &imports).await;
    assert_eq!(status, StatusCode::CREATED);
}

/// The run that made the fixture's asset.
const MADE_BY_RUN: &str = "0192b7d4-2222-7000-8000-000000000002";

/// The conversation that asked for it.
const ASKED_IN_SESSION: &str = "0192b7d4-2222-7000-8000-000000000003";

/// A project with an asset on a canvas and one on the shelf.
struct StagedProject {
    /// What opens packages, which is the registry's to do rather than the
    /// store's.
    registry: Arc<ProjectRegistry>,
    store: Arc<FsProjectStore>,
    root: PathBuf,
    /// The asset a run made, which a node holds.
    placed: String,
    /// The asset somebody brought in and never placed.
    shelf: String,
}

/// Built through the store rather than the API: how an asset came to be is not
/// a thing an upload can claim.
async fn stage_generated_project(root: &Path) -> StagedProject {
    let registry = Arc::new(ProjectRegistry::new(Arc::new(parse_test_config(root))));
    let (store, created) = registry
        .create_project(
            &root.join("projects"),
            CreateProject {
                name: "Made".to_string(),
                first_canvas_name: None,
            },
        )
        .await
        .unwrap();
    let project_root = created.root.clone();
    let canvas_id = created.moka.canvas[0].id.clone();

    let staged = root.join("staged.png");
    std::fs::write(&staged, make_test_png()).unwrap();
    let made = store
        .add_asset(StagedAsset {
            name: "made.png".to_string(),
            tmp_path: staged,
            declared_mime: None,
            category_hint: None,
            provenance: Some(AssetProvenance {
                run_id: Some(MADE_BY_RUN.to_string()),
                canvas_id: Some(canvas_id.clone()),
                operation_node_id: Some("node-1".to_string()),
                assistant_session_id: Some(ASKED_IN_SESSION.to_string()),
                story_job_id: None,
                story_id: None,
                input_asset_ids: None,
                parameter_snapshot: Some(json!({
                    "model": "a-model",
                    "prompt": "a lake at dusk",
                })),
                created_at: "2026-01-01T00:00:00Z".to_string(),
            }),
        })
        .await
        .unwrap();

    let staged = root.join("shelf.png");
    std::fs::write(&staged, make_test_png()).unwrap();
    let brought = store
        .add_asset(StagedAsset {
            name: "brought.png".to_string(),
            tmp_path: staged,
            declared_mime: None,
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap();

    let revision = store
        .current()
        .await
        .unwrap()
        .expect("a project is open")
        .moka
        .metadata
        .revision;
    let now = "2026-01-01T00:00:00Z".to_string();
    store
        .apply_commands(
            revision,
            vec![
                DocumentCommand::AddNode {
                    canvas_id: canvas_id.clone(),
                    node: WorkflowNode {
                        id: "node-1".to_string(),
                        kind: NodeKind::Image,
                        title: "Lake".to_string(),
                        bounds: Rect {
                            x: 0.0,
                            y: 0.0,
                            width: 280.0,
                            height: 200.0,
                        },
                        z_index: 0,
                        ports: derive_ports(NodeKind::Image),
                        data: NodeData {
                            asset_id: Some(made.entry.id.clone()),
                            ..NodeData::default()
                        },
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    },
                },
                DocumentCommand::AddSession {
                    canvas_id,
                    session: AssistantSession {
                        id: ASKED_IN_SESSION.to_string(),
                        title: "The lake at dusk".to_string(),
                        messages: vec![
                            AssistantMessage {
                                id: "message-asked".to_string(),
                                role: AssistantRole::User,
                                text: "Paint the lake at dusk".to_string(),
                                created_at: now.clone(),
                                references: None,
                                tool_calls: None,
                                failure: None,
                            },
                            AssistantMessage {
                                id: "message-answered".to_string(),
                                role: AssistantRole::Assistant,
                                text: "Here is the lake, at dusk.".to_string(),
                                created_at: now.clone(),
                                references: None,
                                tool_calls: None,
                                failure: None,
                            },
                        ],
                        created_at: now.clone(),
                        updated_at: now,
                    },
                    index: None,
                },
            ],
        )
        .await
        .unwrap();

    StagedProject {
        registry,
        store,
        root: project_root,
        placed: made.entry.id,
        shelf: brought.entry.id,
    }
}

fn document_in(archive: &Path) -> MokaFile {
    let (_, bytes) = read_zip_entries(archive)
        .into_iter()
        .find(|(name, _)| name == "canvas.moka")
        .expect("a package carries the document");
    decode_moka_file(&bytes).expect("the document a package carries must be readable")
}

fn provenance_of(document: &MokaFile, asset_id: &str) -> AssetProvenance {
    document
        .resources
        .find(asset_id)
        .expect("the asset is in the document")
        .provenance
        .clone()
        .expect("the asset knows how it was made")
}

/// The document a package carries is written rather than copied, so what it
/// says about an asset is what the receiver gets — and a package handed over
/// points at no run, because the record of it stayed where it was made.
#[tokio::test]
async fn a_package_of_the_work_forgets_the_run_but_keeps_the_asking() {
    let temp = tempfile::tempdir().unwrap();
    let staged = stage_generated_project(temp.path()).await;
    let asset_id = &staged.placed;

    let work = temp.path().join("work.mokapkg.zip");
    staged
        .store
        .export_package(&work, false, PackageScope::default())
        .await
        .unwrap();

    let provenance = provenance_of(&document_in(&work), asset_id);
    assert_eq!(
        provenance.run_id, None,
        "a package of the work points at no run: its record did not travel"
    );
    assert_eq!(
        provenance.operation_node_id.as_deref(),
        Some("node-1"),
        "which node asked still resolves inside the package"
    );
    assert_eq!(
        provenance.parameter_snapshot.as_ref().unwrap()["prompt"],
        "a lake at dusk",
        "how it was asked for is the reusable part and is kept"
    );

    // The manifest describes the bytes actually written, not the file on disk.
    let entries = read_zip_entries(&work);
    let (_, bytes) = entries
        .iter()
        .find(|(name, _)| name == "canvas.moka")
        .expect("the document is in the package");
    let manifest = manifest_of(&entries);
    let row = manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["path"] == "canvas.moka")
        .expect("the manifest lists the document");
    assert_eq!(row["bytes"], bytes.len() as u64);
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    assert_eq!(row["sha256"], hex::encode(hasher.finalize()));

    let held = staged
        .store
        .current()
        .await
        .unwrap()
        .expect("a project is open");
    assert_eq!(
        provenance_of(&held.moka, asset_id).run_id.as_deref(),
        Some(MADE_BY_RUN),
        "what this machine knows is not a package's to forget"
    );
    let on_disk =
        decode_moka_file(&std::fs::read(staged.root.join("canvas.moka")).unwrap()).unwrap();
    assert_eq!(
        provenance_of(&on_disk, asset_id).run_id.as_deref(),
        Some(MADE_BY_RUN),
        "making a package redacts a copy, not the project"
    );

    let backup = temp.path().join("backup.mokapkg.zip");
    staged
        .store
        .export_package(
            &backup,
            false,
            PackageScope {
                personal_history: true,
                ..PackageScope::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        provenance_of(&document_in(&backup), asset_id)
            .run_id
            .as_deref(),
        Some(MADE_BY_RUN),
        "a full backup carries the run with the work"
    );

    let (_imported, imported) = staged
        .registry
        .import_package(&work, &temp.path().join("imports").join("Made"))
        .await
        .unwrap();
    assert!(
        imported.self_check.issues.is_empty(),
        "the work package opens clean: {:?}",
        imported.self_check.issues
    );
    let provenance = provenance_of(&imported.moka, asset_id);
    assert_eq!(provenance.run_id, None);
    assert_eq!(provenance.operation_node_id.as_deref(), Some("node-1"));
}

/// A package asked to travel light leaves the shelf behind, and leaves it
/// behind whole: an entry whose file did not come opens as damage, and a file
/// nobody listed opens as nothing at all.
#[tokio::test]
async fn a_small_package_leaves_the_shelf_behind_entry_and_file_together() {
    let temp = tempfile::tempdir().unwrap();
    let staged = stage_generated_project(temp.path()).await;

    let whole = temp.path().join("whole.mokapkg.zip");
    staged
        .store
        .export_package(&whole, false, PackageScope::default())
        .await
        .unwrap();
    assert_eq!(
        document_in(&whole).resources.all().count(),
        2,
        "a package nobody asked to be small carries the shelf too"
    );

    let small = temp.path().join("small.mokapkg.zip");
    staged
        .store
        .export_package(
            &small,
            false,
            PackageScope {
                referenced_assets_only: true,
                ..PackageScope::default()
            },
        )
        .await
        .unwrap();

    let document = document_in(&small);
    let carried: Vec<&str> = document
        .resources
        .all()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(
        carried,
        vec![staged.placed.as_str()],
        "only what a canvas points at is listed"
    );

    let held = staged
        .store
        .current()
        .await
        .unwrap()
        .expect("a project is open");
    let placed_path = held
        .moka
        .resources
        .find(&staged.placed)
        .unwrap()
        .path
        .clone();
    let shelf_path = held
        .moka
        .resources
        .find(&staged.shelf)
        .unwrap()
        .path
        .clone();

    let entries = read_zip_entries(&small);
    let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    assert!(
        names.contains(&placed_path.as_str()),
        "the placed asset's file travels with its entry"
    );
    assert!(
        !names.contains(&shelf_path.as_str()),
        "and the shelf asset's file stayed behind with its entry"
    );

    let manifest = manifest_of(&entries);
    let row = manifest["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["rule"] == "assets no canvas points at")
        .expect("the manifest says what the shelf cost");
    assert_eq!(row["files"], 1);
    assert!(
        row["bytes"].as_u64().unwrap() > 0,
        "and how much room it freed"
    );

    let (_imported, imported) = staged
        .registry
        .import_package(&small, &temp.path().join("imports").join("Small"))
        .await
        .unwrap();
    assert!(
        imported.self_check.issues.is_empty(),
        "what arrives opens as whole: {:?}",
        imported.self_check.issues
    );
}

/// A record of a run, written where an export asked to carry everything will
/// find it: a run is something this machine did, and only a full backup says so.
fn write_run_record(root: &Path, run_id: &str) -> String {
    let name = format!("history/runs/{run_id}.json");
    let record = root.join(&name);
    std::fs::create_dir_all(record.parent().unwrap()).unwrap();
    std::fs::write(
        &record,
        serde_json::to_vec_pretty(&json!({
            "id": run_id,
            "status": "succeeded",
            "parameters": { "model": "a-model", "prompt": "a lake at dusk" },
        }))
        .unwrap(),
    )
    .unwrap();
    name
}

/// The same package as an older build would have written it: a version this one
/// still reads, and nothing said either way about the records of the runs.
///
/// The entries are left exactly as they were, so the hashes still describe what
/// arrived — the question of what is kept is a different one, and it is asked
/// only after that one is answered.
fn rewrite_as_older_package(package: &Path, destination: &Path) -> PathBuf {
    let mut entries = read_zip_entries(package);
    let mut manifest = manifest_of(&entries);
    manifest["formatVersion"] = json!(1);
    for field in ["personalHistory", "skipped"] {
        manifest.as_object_mut().unwrap().remove(field);
    }
    let (_, bytes) = entries
        .iter_mut()
        .find(|(name, _)| name == "moka-package.json")
        .expect("a package carries a manifest");
    *bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    write_zip(destination, &entries);
    destination.to_path_buf()
}

/// Turning an older package away would turn away work somebody has on disk, so
/// this build reads it. What it may keep is decided here rather than there: an
/// older manifest never said whether it carried the records of the runs, so it
/// is taken as a package of the work and cleaned to that rule on the way in.
#[tokio::test]
async fn an_older_package_is_cleaned_to_the_rule_this_build_keeps() {
    let temp = tempfile::tempdir().unwrap();
    let staged = stage_generated_project(temp.path()).await;
    let record_name = write_run_record(&staged.root, MADE_BY_RUN);

    let backup = temp.path().join("backup.mokapkg.zip");
    staged
        .store
        .export_package(
            &backup,
            false,
            PackageScope {
                personal_history: true,
                ..PackageScope::default()
            },
        )
        .await
        .unwrap();

    let older = rewrite_as_older_package(&backup, &temp.path().join("older.mokapkg.zip"));
    assert!(
        read_zip_entries(&older)
            .iter()
            .any(|(name, _)| name == &record_name),
        "the package the older build would have written carries the record"
    );

    let target = temp.path().join("imports").join("Older");
    let (_imported, imported) = staged
        .registry
        .import_package(&older, &target)
        .await
        .unwrap();
    assert!(
        imported.self_check.issues.is_empty(),
        "what arrives opens as whole: {:?}",
        imported.self_check.issues
    );

    assert!(
        !target.join("history/runs").exists(),
        "the record of a run made somewhere else does not stay"
    );
    let on_disk = decode_moka_file(&std::fs::read(target.join("canvas.moka")).unwrap()).unwrap();
    let provenance = provenance_of(&on_disk, &staged.placed);
    assert_eq!(
        provenance.run_id, None,
        "and the document stops pointing at one"
    );
    assert_eq!(
        provenance.parameter_snapshot.as_ref().unwrap()["prompt"],
        "a lake at dusk",
        "how it was asked for is the reusable part and survives the cleaning"
    );
    assert_eq!(
        provenance.operation_node_id.as_deref(),
        Some("node-1"),
        "asking the same way again is still built from what the document keeps"
    );
}

/// Cleaning answers to what the manifest says rather than to a guess about what
/// is inside: a package that says outright it carried the records of the runs is
/// believed, and keeps them.
#[tokio::test]
async fn a_package_that_says_it_carried_the_runs_keeps_them_through_an_import() {
    let temp = tempfile::tempdir().unwrap();
    let staged = stage_generated_project(temp.path()).await;
    let record_name = write_run_record(&staged.root, MADE_BY_RUN);

    let backup = temp.path().join("backup.mokapkg.zip");
    staged
        .store
        .export_package(
            &backup,
            false,
            PackageScope {
                personal_history: true,
                ..PackageScope::default()
            },
        )
        .await
        .unwrap();
    let entries = read_zip_entries(&backup);
    let (_, record_bytes) = entries
        .iter()
        .find(|(name, _)| name == &record_name)
        .expect("a full backup carries the run record")
        .clone();
    assert_eq!(manifest_of(&entries)["personalHistory"], true);

    let target = temp.path().join("imports").join("Backup");
    let (_imported, imported) = staged
        .registry
        .import_package(&backup, &target)
        .await
        .unwrap();
    assert!(
        imported.self_check.issues.is_empty(),
        "what arrives opens as whole: {:?}",
        imported.self_check.issues
    );
    assert_eq!(
        std::fs::read(target.join(&record_name)).unwrap(),
        record_bytes,
        "the record arrives as it was written"
    );
    assert_eq!(
        provenance_of(&imported.moka, &staged.placed)
            .run_id
            .as_deref(),
        Some(MADE_BY_RUN),
        "and the document still points at it"
    );
}

/// The credential a channel is configured with.
const CHANNEL_KEY: &str = "sk-test-1234567890abcd";

/// The address of the channel holding it.
const CHANNEL_ADDRESS: &str = "https://provider.test/v1";

/// Three runs this machine made, the first of them the one that made the
/// fixture's placed asset.
const RUNS: [&str; 3] = [
    MADE_BY_RUN,
    "0192b7d4-3333-7000-8000-000000000003",
    "0192b7d4-4444-7000-8000-000000000004",
];

/// What no package of any kind carries.
///
/// A credential, the address of the channel it belongs to, or the name of the
/// place this machine keeps them. The manifest is scanned for these too: it
/// states the rules it applied, which are paths, and naming a rule is not the
/// same as carrying the thing it kept out.
const CREDENTIALS: [&str; 5] = ["sk-", "apiKey", "cipher", "metadata.dir", CHANNEL_ADDRESS];

/// What a package of the work does not carry, and a full backup does.
///
/// The manifest is excepted, and only the manifest: it says outright which
/// rules kept what out, so it names `history/runs/**` and `**/secrets.json`
/// when it found them. That is the declaration a receiver is owed, and it says
/// nothing about anybody.
const PERSONAL: [&str; 4] = ["sessions", "runId", "secrets.json", "history/runs"];

/// Every needle that turns up in the bytes of the given entries.
fn found_in(entries: &[(String, Vec<u8>)], needles: &[&str]) -> Vec<String> {
    let mut hits = Vec::new();
    for (name, bytes) in entries {
        for needle in needles {
            if bytes
                .windows(needle.len())
                .any(|window| window == needle.as_bytes())
            {
                hits.push(format!("{name} carries {needle}"));
            }
        }
    }
    hits
}

/// The guarantee every rule above exists for, stated once against the bytes a
/// receiver gets rather than against the fields they were written from.
#[tokio::test]
async fn export_never_contains_personal_or_secret_data() {
    let temp = tempfile::tempdir().unwrap();

    // Server mode would create a master key on the first credential stored,
    // and this test stores a credential in order to prove it never travels.
    // The key is written here so the tier is fixed rather than incidental.
    let metadata = temp.path().join("metadata");
    std::fs::create_dir_all(&metadata).unwrap();
    std::fs::write(
        metadata.join(crypto::MASTER_KEY_FILE),
        base64::engine::general_purpose::STANDARD.encode([7u8; 32]),
    )
    .unwrap();

    let app = test_app(temp.path());

    // A model configured with a real credential, in the layer where
    // credentials live. The exporter never walks there, which is the structural
    // guarantee — but a guarantee nobody checks is only a claim.
    let response = app
        .clone()
        .oneshot(json_request(
            "PUT",
            "/api/v1/models",
            json!({
                "id": "painter",
                "category": "image",
                "protocol": "openaiImages",
                "url": format!("{CHANNEL_ADDRESS}/images/generations"),
                "model": "painter-1",
                "displayName": "Painter",
                "enabled": true,
                "apiKey": CHANNEL_KEY,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        metadata.join(docs::SECRETS_DOC).is_file(),
        "the credential is sealed in the metadata layer"
    );

    let staged = stage_generated_project(temp.path()).await;
    for run in RUNS {
        write_run_record(&staged.root, run);
    }

    // Documents that belong to the application rather than to any project, put
    // in the project tree anyway: a rule that only holds while nobody makes a
    // mistake is not a rule.
    for (name, body) in [
        (
            docs::SECRETS_DOC,
            json!({ "entries": { "painter": { "cipher": "sealed", "apiKey": CHANNEL_KEY } } }),
        ),
        (
            docs::MODELS_DOC,
            json!({ "models": [{ "id": "painter", "url": CHANNEL_ADDRESS }] }),
        ),
        (
            docs::META_DOC,
            json!({ "metadata.dir": "/Users/somebody/Library/Application Support/moka" }),
        ),
        (docs::RECENT_DOC, json!({ "recent": [] })),
        (docs::PROMPT_SOURCES_DOC, json!({ "sources": [] })),
    ] {
        let path = staged.root.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_vec_pretty(&body).unwrap()).unwrap();
    }
    std::fs::write(
        staged.root.join(crypto::MASTER_KEY_FILE),
        b"named like the key that seals credentials",
    )
    .unwrap();
    std::fs::create_dir_all(staged.root.join("history/jobs")).unwrap();
    std::fs::write(
        staged
            .root
            .join("history/jobs/0192b7d4-5555-7000-8000-000000000005.json"),
        b"{\"reference\":\"a handle only this machine could ask after\"}",
    )
    .unwrap();
    std::fs::write(staged.root.join("tmp/half-written.moka"), b"scratch").unwrap();
    std::fs::write(staged.root.join("canvas.corrupt.20260101.json"), b"{}").unwrap();
    std::fs::write(staged.root.join(".DS_Store"), b"junk").unwrap();

    let held = staged
        .store
        .current()
        .await
        .unwrap()
        .expect("a project is open");
    let mut expected: Vec<String> = held
        .moka
        .resources
        .all()
        .map(|entry| entry.path.clone())
        .collect();
    expected.push("canvas.moka".to_string());
    expected.push("moka-package.json".to_string());
    expected.sort();

    let work = temp.path().join("work.mokapkg.zip");
    staged
        .store
        .export_package(&work, false, PackageScope::default())
        .await
        .unwrap();
    let entries = read_zip_entries(&work);

    // Naming every entry is a stronger claim than looking for the ones that
    // must not be there: a log, a scratch file or a document this application
    // owns cannot be carried by a package whose contents are listed in full.
    let mut carried: Vec<String> = entries.iter().map(|(name, _)| name.clone()).collect();
    carried.sort();
    assert_eq!(
        carried, expected,
        "a package of the work carries the document, the assets and the manifest"
    );

    let hits = found_in(&entries, &CREDENTIALS);
    assert!(hits.is_empty(), "no package carries a credential: {hits:?}");

    let (manifest, payload): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|(name, _)| name == "moka-package.json");
    assert_eq!(manifest.len(), 1, "and it says so in one manifest");
    let mut needles: Vec<&str> = PERSONAL.to_vec();
    needles.extend(RUNS);
    let hits = found_in(&payload, &needles);
    assert!(
        hits.is_empty(),
        "a package of the work carries nothing about this machine: {hits:?}"
    );

    // A full backup is somebody's own choice to carry the record of what they
    // did here. It is not a choice to carry a credential, and the two questions
    // are answered separately.
    expected.extend(RUNS.iter().map(|run| format!("history/runs/{run}.json")));
    expected.sort();

    let backup = temp.path().join("backup.mokapkg.zip");
    staged
        .store
        .export_package(
            &backup,
            false,
            PackageScope {
                personal_history: true,
                ..PackageScope::default()
            },
        )
        .await
        .unwrap();
    let entries = read_zip_entries(&backup);
    let mut carried: Vec<String> = entries.iter().map(|(name, _)| name.clone()).collect();
    carried.sort();
    assert_eq!(
        carried, expected,
        "a full backup adds the records of the runs and nothing else"
    );
    let hits = found_in(&entries, &CREDENTIALS);
    assert!(
        hits.is_empty(),
        "not even a backup carries a credential: {hits:?}"
    );

    // The record of what was asked here is what a backup is for. Saying so keeps
    // the guarantee above honest: a needle that never turned up anywhere would
    // pass it without anything having been kept out.
    for needle in ["sessions", ASKED_IN_SESSION, "Paint the lake at dusk"] {
        assert!(
            !found_in(&entries, &[needle]).is_empty(),
            "a full backup carries {needle}"
        );
    }
}

/// Where packages are exported to is not part of what a package carries: the
/// second export of a project must not sweep the first one in.
#[tokio::test]
async fn an_earlier_export_is_not_swept_into_the_next_package() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Sweep").await;
    let root = PathBuf::from(created["root"].as_str().unwrap());

    // Both land in the project's own output folder, the place a save dialog
    // opens at — exactly where a package could sweep its predecessor in.
    let asked = root.join("output").join("first.mokapkg.zip");
    let first = export_open_project(&app, json!({ "destination": asked.to_string_lossy() })).await;
    let first_path = PathBuf::from(first["destination"].as_str().unwrap());
    assert!(first_path.is_file(), "the first package landed");

    let asked = root.join("output").join("second.mokapkg.zip");
    let second = export_open_project(&app, json!({ "destination": asked.to_string_lossy() })).await;
    let second_path = PathBuf::from(second["destination"].as_str().unwrap());
    let entries = read_zip_entries(&second_path);
    let carried: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    assert!(
        carried.iter().all(|name| !name.starts_with("output/")),
        "a package carries no exports: {carried:?}"
    );

    // And the manifest says what was left out, so a receiver can hold the
    // package against what it does not hold.
    let manifest: Value = serde_json::from_slice(
        &entries
            .iter()
            .find(|(name, _)| name == "moka-package.json")
            .expect("the manifest ships")
            .1,
    )
    .unwrap();
    let skipped = manifest["skipped"].as_array().expect("the skip rows");
    assert!(
        skipped
            .iter()
            .any(|row| row["rule"] == "output/**" && row["files"].as_u64().unwrap_or(0) >= 1),
        "the export left behind is named as a skip: {manifest}"
    );
}
