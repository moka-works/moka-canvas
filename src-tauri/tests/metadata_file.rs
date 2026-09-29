//! Tests for the file backend specifically: the on-disk layout, permission
//! bits, the directory lock, and quarantine of a damaged document.
//!
//! Behaviour that any backend must provide lives in the contract suite, which
//! this file runs as-is against the file implementation.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use moka_canvas::config::{MetadataConfig, RuntimeMode};
use moka_canvas::metadata::contract::{run_metadata_suite, StoreFactory};
use moka_canvas::metadata::crypto::{KEY_ENV, MASTER_KEY_FILE};
use moka_canvas::metadata::docs::{MODELS_DOC, RECENT_DOC, SECRETS_DOC};
use moka_canvas::metadata::fs::{LOCK_FILE, SECRET_MODE, TMP_DIR};
use moka_canvas::metadata::{
    self, MetadataError, MetadataStore, ModelDraft, Protocol, RecentProject, SecretStorage,
};

const PLAINTEXT_KEY: &str = "sk-plaintext-value";

fn open(root: &Path) -> Result<Arc<dyn MetadataStore>, MetadataError> {
    metadata::open(root, &MetadataConfig::default(), RuntimeMode::Web)
        .map(|store| store as Arc<dyn MetadataStore>)
}

fn factory(root: PathBuf) -> StoreFactory {
    Arc::new(move || open(&root))
}

/// Server mode takes the master key from the environment or from this file.
/// The environment is shared across test threads, so the file is used.
fn seed_master_key(root: &Path) {
    std::fs::create_dir_all(root).expect("the metadata directory is created");
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(root.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
}

fn draft(id: &str) -> ModelDraft {
    ModelDraft {
        id: id.to_string(),
        category: moka_canvas::domain::Capability::Text,
        protocol: Protocol::new("openaiChat"),
        url: "https://provider.test/v1/chat/completions".to_string(),
        model: format!("model-{id}"),
        display_name: format!("Model {id}"),
        max_video_seconds: None,
        scenes: Vec::new(),
        sub_models: Vec::new(),
        enabled: true,
        expected_revision: None,
    }
}

fn recent(id: &str) -> RecentProject {
    RecentProject {
        id: id.to_string(),
        name: format!("Project {id}"),
        path: PathBuf::from(format!("/tmp/{id}")),
        last_opened: moka_canvas::domain::now_iso(),
    }
}

fn names_in(root: &Path) -> Vec<String> {
    std::fs::read_dir(root)
        .expect("the metadata directory is readable")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect()
}

#[tokio::test]
async fn the_file_backend_satisfies_the_contract_suite() {
    let root = tempfile::tempdir().unwrap();
    seed_master_key(root.path());
    let failures = run_metadata_suite(&factory(root.path().to_path_buf())).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn a_second_store_over_the_same_directory_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let _held = open(root.path()).expect("the first store opens");

    let error = open(root.path()).err().expect("the directory is locked");
    assert_eq!(error.code(), "METADATA_UNAVAILABLE");
    assert!(
        error.to_string().contains(&std::process::id().to_string()),
        "the error must name the holder: {error}"
    );
}

#[tokio::test]
async fn the_lock_names_its_holder_even_when_a_second_open_fails() {
    let root = tempfile::tempdir().unwrap();
    let held = open(root.path()).expect("the first store opens");
    // A refused open must not blank out the pid the diagnostic depends on.
    assert!(open(root.path()).is_err(), "the directory is locked");
    let recorded = std::fs::read_to_string(root.path().join(LOCK_FILE)).unwrap();
    assert_eq!(recorded.trim(), std::process::id().to_string());
    drop(held);
}

#[tokio::test]
async fn credentials_reach_the_disk_only_as_ciphertext() {
    let root = tempfile::tempdir().unwrap();
    seed_master_key(root.path());
    let store = open(root.path()).expect("the store opens");
    store.upsert_model(&draft("sealed")).await.unwrap();
    store.put_secret("sealed", PLAINTEXT_KEY).await.unwrap();

    for document in [SECRETS_DOC, MODELS_DOC] {
        let raw = std::fs::read(root.path().join(document)).unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(
            !text.contains(PLAINTEXT_KEY),
            "{document} holds the credential in plaintext: {text}"
        );
    }
    // The whole directory, not just the two documents above.
    for entry in names_in(root.path()) {
        if let Ok(raw) = std::fs::read(root.path().join(&entry)) {
            assert!(
                !String::from_utf8_lossy(&raw).contains(PLAINTEXT_KEY),
                "{entry} holds the credential in plaintext"
            );
        }
    }

    drop(store);
    let reopened = open(root.path()).expect("the store reopens");
    assert_eq!(
        reopened.get_secret("sealed").await.unwrap().as_deref(),
        Some(PLAINTEXT_KEY)
    );
    let state = reopened.secret_state("sealed").await.unwrap().unwrap();
    let masked = state
        .masked
        .as_deref()
        .expect("a stored credential reports a masked form");
    assert!(!masked.contains(PLAINTEXT_KEY), "{state:?}");
}

#[cfg(unix)]
#[tokio::test]
async fn the_credential_document_is_private() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    seed_master_key(root.path());
    let store = open(root.path()).expect("the store opens");
    store.upsert_model(&draft("sealed")).await.unwrap();
    store.put_secret("sealed", PLAINTEXT_KEY).await.unwrap();

    let mode = std::fs::metadata(root.path().join(SECRETS_DOC))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, SECRET_MODE);
    let dir_mode = std::fs::metadata(root.path()).unwrap().permissions().mode();
    assert_eq!(dir_mode & 0o777, 0o700);
}

#[tokio::test]
async fn a_first_credential_in_server_mode_creates_a_file_held_master_key() {
    if std::env::var(KEY_ENV).is_ok() {
        // The developer's shell exports a master key; nothing to assert.
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let store = open(root.path()).expect("the store opens with no credentials stored");
    store.upsert_model(&draft("unkeyed")).await.unwrap();

    // Storing must not be refused just because nobody exported a key: the
    // alternative is a server where the API key field can never be filled in.
    store
        .put_secret("unkeyed", PLAINTEXT_KEY)
        .await
        .expect("the credential is stored against a newly created key");

    let path = root.path().join(MASTER_KEY_FILE);
    let encoded = std::fs::read_to_string(&path).expect("the master key is on disk");
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .expect("base64")
            .len(),
        32
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, SECRET_MODE);
    }

    // The tier is reported rather than looking like an exported key.
    assert_eq!(store.info().await.secret_storage, SecretStorage::File);

    // And the next process over the same directory opens what this one sealed.
    drop(store);
    let reloaded = open(root.path()).expect("the store reopens");
    assert_eq!(
        reloaded.get_secret("unkeyed").await.unwrap().as_deref(),
        Some(PLAINTEXT_KEY)
    );
}

#[tokio::test]
async fn stored_credentials_without_any_master_key_refuse_startup() {
    if std::env::var(KEY_ENV).is_ok() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    seed_master_key(root.path());
    let store = open(root.path()).expect("the store opens");
    store.upsert_model(&draft("keyed")).await.unwrap();
    store.put_secret("keyed", PLAINTEXT_KEY).await.unwrap();
    drop(store);

    // Losing the key is not a state to start up in: every generation request
    // would fail with an authentication error while the model looked
    // configured. The message has to name both places the key could come from.
    std::fs::remove_file(root.path().join(MASTER_KEY_FILE)).unwrap();
    let error = open(root.path())
        .err()
        .expect("a directory holding ciphertext with no key must not open");
    assert_eq!(error.code(), "CONFIG_METADATA_KEY_MISSING");
    let message = error.to_string();
    assert!(message.contains(KEY_ENV), "{message}");
    assert!(message.contains(MASTER_KEY_FILE), "{message}");
}

#[tokio::test]
async fn a_damaged_document_is_quarantined_without_taking_the_others_down() {
    let root = tempfile::tempdir().unwrap();
    seed_master_key(root.path());
    let seeded = open(root.path()).expect("the store opens");
    seeded.upsert_model(&draft("kept")).await.unwrap();
    drop(seeded);

    std::fs::write(
        root.path().join(RECENT_DOC),
        br#"{"revision":1,"items":[trunc"#,
    )
    .unwrap();
    let store = open(root.path()).expect("a damaged document must not block startup");

    let info = store.info().await;
    assert!(
        info.documents
            .iter()
            .any(|document| document.name == RECENT_DOC && document.corrupt),
        "the reset must be reported: {info:?}"
    );
    let snapshot = store.models_snapshot().await.unwrap();
    assert!(
        snapshot.models.iter().any(|model| model.id == "kept"),
        "an unrelated document must survive"
    );
    let quarantined: Vec<String> = names_in(root.path())
        .into_iter()
        .filter(|name| name.contains(".corrupt."))
        .collect();
    assert_eq!(quarantined.len(), 1, "{quarantined:?}");
    assert!(quarantined[0].starts_with("recent-projects.corrupt."));
}

#[tokio::test]
async fn startup_clears_crash_leftovers() {
    let root = tempfile::tempdir().unwrap();
    seed_master_key(root.path());
    let leftover = root.path().join(TMP_DIR).join("models.json.99.123");
    std::fs::create_dir_all(leftover.parent().unwrap()).unwrap();
    std::fs::write(&leftover, b"half written").unwrap();

    let store = open(root.path()).expect("the store opens");
    let remaining = std::fs::read_dir(root.path().join(TMP_DIR))
        .unwrap()
        .count();
    assert_eq!(remaining, 0, "scratch files from a crash must be cleared");

    // Clearing them must not have cost the store its write ability.
    store
        .probe_write()
        .await
        .expect("the directory is writable");
}

#[tokio::test]
async fn a_previous_recent_project_file_outside_the_directory_is_ignored() {
    let root = tempfile::tempdir().unwrap();
    // Stands in for the application-data directory that used to hold the
    // recent-project list next to the metadata directory.
    let legacy = root.path().join("recent-projects.json");
    std::fs::write(
        &legacy,
        br#"{"entries":[{"id":"old","name":"Old Film","path":"/tmp/old"}]}"#,
    )
    .unwrap();
    let before = std::fs::read(&legacy).unwrap();

    let dir = root.path().join("metadata");
    seed_master_key(&dir);
    let store = open(&dir).expect("the store opens");
    assert!(
        store.list_recent().await.unwrap().is_empty(),
        "the list starts empty after an upgrade"
    );

    store.upsert_recent(&recent("new")).await.unwrap();
    let listed = store.list_recent().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "new");

    assert_eq!(std::fs::read(&legacy).unwrap(), before, "never rewritten");
    let stored = std::fs::read(dir.join(RECENT_DOC)).unwrap();
    assert!(
        !String::from_utf8_lossy(&stored).contains("Old Film"),
        "the superseded list must not be imported"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn an_unwritable_directory_rejects_every_write_and_publishes_nothing() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let store = open(root.path()).expect("the store opens");
    store.upsert_recent(&recent("kept")).await.unwrap();

    // Every write starts in the scratch area, so making it unwritable stands in
    // for a full disk or a permissions change part-way through a session.
    let scratch = root.path().join(TMP_DIR);
    let writable = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(&scratch, std::fs::Permissions::from_mode(0o500)).unwrap();

    // Three in a row: the streak that escalates the log from a warning to an
    // error, because by then every user edit is being rejected.
    for _ in 0..3 {
        let error = store.upsert_recent(&recent("rejected")).await.unwrap_err();
        assert_eq!(error.code(), "METADATA_WRITE_FAILED");
    }

    std::fs::set_permissions(&scratch, writable.clone()).unwrap();

    let listed = store.list_recent().await.unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        ["kept"],
        "a rejected write must not reach the in-memory snapshot"
    );

    store.upsert_recent(&recent("after")).await.unwrap();
    assert!(
        store
            .list_recent()
            .await
            .unwrap()
            .iter()
            .any(|entry| entry.id == "after"),
        "the store recovers on its own once the disk accepts writes again"
    );
}
