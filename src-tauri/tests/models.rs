//! Model configuration over the real file store: what the client is shown,
//! what a write refuses, and what survives a restart.
//!
//! The rules that need no storage — identifier shape — are covered next to
//! the code they belong to.

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use moka_canvas::config::{MetadataConfig, RuntimeMode};
use moka_canvas::domain::Capability;
use moka_canvas::generate::models::ModelRepo;
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{self, Defaults, MetadataStore, ModelDraft, Protocol};

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// Opens a store in server mode, where the master key comes from a file
/// rather than the keychain. The environment is shared across test threads,
/// so it is deliberately not used.
fn repo(root: &Path) -> ModelRepo {
    std::fs::create_dir_all(root).expect("the metadata directory is created");
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(root.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let store = metadata::open(root, &MetadataConfig::default(), RuntimeMode::Web)
        .map(|store| store as Arc<dyn MetadataStore>)
        .expect("the store opens");
    ModelRepo::new(store)
}

/// One model configuration. The URL carries a trailing slash, so every test
/// also proves the value is normalised on the way in.
fn draft(id: &str, category: Capability) -> ModelDraft {
    let (protocol, url) = match category {
        Capability::Text => (
            Protocol::new("openaiChat"),
            "https://provider.test/v1/chat/completions/",
        ),
        Capability::Image => (
            Protocol::new("openaiImages"),
            "https://provider.test/v1/images/generations/",
        ),
        Capability::Speech => (
            Protocol::new("openaiSpeech"),
            "https://provider.test/v1/audio/speech/",
        ),
        Capability::Music => (
            Protocol::new("bailianMusic"),
            "https://provider.test/api/v1/services/audio/music/generation/",
        ),
        Capability::Video => (
            Protocol::new("openaiVideos"),
            "https://provider.test/v1/videos/",
        ),
        // Recognition is served by a converter script alone; what one is
        // asked at is that script's business rather than this suite's.
        Capability::Asr => (
            Protocol::new("bailianAsr"),
            "https://provider.test/v1/transcription/",
        ),
    };
    ModelDraft {
        id: id.to_string(),
        category,
        protocol,
        url: url.to_string(),
        model: format!("model-{id}"),
        display_name: format!("Model {id}"),
        max_video_seconds: None,
        scenes: Vec::new(),
        sub_models: Vec::new(),
        enabled: true,
        expected_revision: None,
    }
}

fn image_default(reference: &str) -> Defaults {
    Defaults {
        image: Some(reference.to_string()),
        ..Default::default()
    }
}

#[tokio::test]
async fn a_stored_key_is_disclosed_only_as_its_masked_form() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("painter", Capability::Image))
        .await
        .unwrap();

    let stored = repo.set_key("painter", Some(API_KEY)).await.unwrap();
    assert!(stored.set);
    assert_eq!(stored.masked.as_deref(), Some("sk-…abcd"));

    let rendered = serde_json::to_string(&repo.view().await.unwrap()).unwrap();
    assert!(
        !rendered.contains(API_KEY),
        "the response must not carry the key"
    );
    assert!(rendered.contains("sk-…abcd"));
    assert_eq!(repo.credential("painter").await.unwrap(), API_KEY);

    // An empty value clears, so the client never distinguishes blank from gone.
    let cleared = repo.set_key("painter", Some("   ")).await.unwrap();
    assert!(!cleared.set);
    // A model that is there and holds nothing is its own trouble rather than
    // "no model is configured": the repair is one key, not a whole model.
    let gone = repo.credential("painter").await.unwrap_err();
    assert_eq!(gone.code(), "PROVIDER_KEY_MISSING");
    assert_eq!(
        gone.details(),
        Some(serde_json::json!({ "model": "painter" }))
    );
}

#[tokio::test]
async fn a_key_cannot_be_stored_for_a_model_that_does_not_exist() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let error = repo.set_key("ghost", Some(API_KEY)).await.unwrap_err();
    assert_eq!(error.code(), "NOT_FOUND");
}

#[tokio::test]
async fn deleting_a_default_model_clears_the_default() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("painter", Capability::Image))
        .await
        .unwrap();
    repo.set_key("painter", Some(API_KEY)).await.unwrap();
    repo.set_defaults(&image_default("painter"), None)
        .await
        .unwrap();

    // The removal carries the default away with it rather than being refused
    // for it: a capability with no stored default falls back to the first
    // model that can serve.
    repo.delete("painter", None).await.unwrap();
    let view = repo.view().await.unwrap();
    assert!(view.models.is_empty());
    assert_eq!(view.defaults.image, None);
    assert_eq!(
        repo.credential("painter").await.unwrap_err().code(),
        "PROVIDER_KEY_MISSING"
    );
}

#[tokio::test]
async fn a_default_has_to_name_a_model_that_can_do_the_job() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("painter", Capability::Image))
        .await
        .unwrap();

    let missing = repo
        .set_defaults(&image_default("writer"), None)
        .await
        .unwrap_err();
    assert_eq!(missing.code(), "PROVIDER_NOT_CONFIGURED");

    // The same model, asked of a category it does not serve.
    let mismatched = Defaults {
        text: Some("painter".to_string()),
        ..Default::default()
    };
    let error = repo.set_defaults(&mismatched, None).await.unwrap_err();
    assert_eq!(error.code(), "MODEL_CAPABILITY_MISMATCH");

    assert_eq!(
        repo.view().await.unwrap().defaults,
        Defaults::default(),
        "a refused default must not be written"
    );
}

#[tokio::test]
async fn resolution_follows_the_configured_default() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("painter", Capability::Image))
        .await
        .unwrap();
    repo.set_defaults(&image_default("painter"), None)
        .await
        .unwrap();

    let resolved = repo.resolve_default(Capability::Image).await.unwrap();
    assert_eq!(resolved.config_id, "painter");
    assert_eq!(resolved.model, "model-painter");
    assert_eq!(resolved.protocol, Protocol::new("openaiImages"));
    assert_eq!(resolved.url, "https://provider.test/v1/images/generations");

    let unset = repo.resolve_default(Capability::Video).await.unwrap_err();
    assert_eq!(unset.code(), "PROVIDER_NOT_CONFIGURED");
}

#[tokio::test]
async fn a_model_address_is_normalised_and_checked_on_the_way_in() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());

    let stored = repo.upsert(draft("main", Capability::Text)).await.unwrap();
    assert_eq!(stored.url, "https://provider.test/v1/chat/completions");

    let mut credentialed = draft("bad", Capability::Text);
    credentialed.url = "https://user:sk-secret@provider.test/v1/chat/completions".to_string();
    let error = repo.upsert(credentialed).await.unwrap_err();
    assert_eq!(error.code(), "VALIDATION_FAILED");
    assert!(!error.to_string().contains("sk-secret"));

    let mut unnameable = draft("worse", Capability::Text);
    unnameable.url = "provider.test/v1/chat/completions".to_string();
    assert_eq!(
        repo.upsert(unnameable).await.unwrap_err().code(),
        "VALIDATION_FAILED"
    );
}

#[tokio::test]
async fn a_protocol_the_category_does_not_offer_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());

    // A chat endpoint cannot serve a video model, whatever its address says.
    let mismatched = ModelDraft {
        protocol: Protocol::new("openaiChat"),
        ..draft("shot", Capability::Video)
    };
    let error = repo.upsert(mismatched).await.unwrap_err();
    assert_eq!(error.code(), "VALIDATION_FAILED");
    assert!(error.to_string().contains("video"), "{error}");
}

#[tokio::test]
async fn a_lua_protocol_the_converter_registry_offers_is_accepted() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());

    // Deploy the built-in scripts, which also points the process-wide
    // converter root at this directory. The root is set once and every test
    // in this binary shares it, so the directory is leaked to outlive the
    // test rather than pulled out from under a later one.
    let converter = tempfile::tempdir().unwrap();
    let path: &'static Path = Box::leak(converter.keep().into_boxed_path());
    moka_canvas::converter::deploy::ensure_deployed(path)
        .await
        .unwrap();

    // A video script the registry holds under `video` may serve a video
    // model, even though no built-in variant knows its name.
    let bailian = ModelDraft {
        protocol: Protocol::from_wire_name("bailianVideo"),
        ..draft("director", Capability::Video)
    };
    repo.upsert(bailian).await.unwrap();

    // A script that serves audio still cannot serve a video model.
    let mismatched = ModelDraft {
        protocol: Protocol::from_wire_name("bailianSpeech"),
        ..draft("voiceover", Capability::Video)
    };
    let error = repo.upsert(mismatched).await.unwrap_err();
    assert_eq!(error.code(), "VALIDATION_FAILED");
    // The refusal names the protocol by its wire name and lists what the
    // category does offer, the registry's scripts included.
    assert!(error.to_string().contains("bailianSpeech"), "{error}");
    assert!(error.to_string().contains("bailianVideo"), "{error}");

    // A name no script answers to is refused too.
    let invented = ModelDraft {
        protocol: Protocol::from_wire_name("wandProtocol"),
        ..draft("wand", Capability::Video)
    };
    assert_eq!(
        repo.upsert(invented).await.unwrap_err().code(),
        "VALIDATION_FAILED"
    );
}

#[tokio::test]
async fn recognition_is_served_by_its_script_and_by_nothing_else() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());

    // The registry's recognition script, on the same leaked directory the
    // other script test deploys to.
    let converter = tempfile::tempdir().unwrap();
    let path: &'static Path = Box::leak(converter.keep().into_boxed_path());
    moka_canvas::converter::deploy::ensure_deployed(path)
        .await
        .unwrap();

    // Recognition has no built-in protocol, so the script is the whole of
    // what a recognition model can be pointed at.
    let listener = ModelDraft {
        protocol: Protocol::from_wire_name("bailianAsr"),
        ..draft("listener", Capability::Asr)
    };
    repo.upsert(listener).await.unwrap();

    // A script is filed under one capability: the recognition one cannot
    // serve a shot.
    let mismatched = ModelDraft {
        protocol: Protocol::from_wire_name("bailianAsr"),
        ..draft("listener", Capability::Video)
    };
    let error = repo.upsert(mismatched).await.unwrap_err();
    assert_eq!(error.code(), "VALIDATION_FAILED");
    assert!(error.to_string().contains("bailianAsr"), "{error}");

    // And what recognition does offer is the script alone: a protocol built
    // for another category is refused rather than stored and never reached.
    let borrowed = ModelDraft {
        protocol: Protocol::new("openaiChat"),
        ..draft("borrowed", Capability::Asr)
    };
    assert_eq!(
        repo.upsert(borrowed).await.unwrap_err().code(),
        "VALIDATION_FAILED"
    );
}

#[tokio::test]
async fn a_write_against_a_stale_revision_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("main", Capability::Text)).await.unwrap();
    let revision = repo.view().await.unwrap().revision;

    repo.upsert(draft("spare", Capability::Text)).await.unwrap();

    let stale = ModelDraft {
        expected_revision: Some(revision),
        ..draft("third", Capability::Text)
    };
    assert_eq!(
        repo.upsert(stale).await.unwrap_err().code(),
        "METADATA_CONFLICT"
    );

    let current = ModelDraft {
        expected_revision: Some(repo.view().await.unwrap().revision),
        ..draft("third", Capability::Text)
    };
    repo.upsert(current).await.unwrap();
}
