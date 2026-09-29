//! Backend-agnostic contract tests for [`MetadataStore`].
//!
//! These run against the trait only: no file names, no paths, no private
//! fields. A database backend must pass this same suite unchanged before it
//! can be called a drop-in replacement, which is the entire reason the
//! abstraction exists.
//!
//! Checks that are genuinely about the file layout — permission bits, the
//! directory lock, quarantine of a damaged document — live in
//! `tests/metadata_file.rs` instead.

use std::sync::Arc;

use super::types::{
    Defaults, ModelDraft, Preferences, PromptItem, PromptQuery, PromptSource, Protocol,
    RecentProject, VideoPreferences, MAX_RECENT, MAX_SEARCH_PAGE_SIZE,
};
use super::{MetadataError, MetadataStore, MetadataStoreKind};
use crate::domain::Capability;

/// Opens a fresh store over the same empty storage location.
pub type StoreFactory =
    Arc<dyn Fn() -> Result<Arc<dyn MetadataStore>, MetadataError> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractFailure {
    pub check: &'static str,
    pub detail: String,
}

/// Runs every check and returns all failures, so one run reports the whole
/// picture instead of stopping at the first.
pub async fn run_metadata_suite(open: &StoreFactory) -> Vec<ContractFailure> {
    let mut failures = Vec::new();
    let owned = match open() {
        Ok(store) => store,
        Err(error) => {
            return vec![ContractFailure {
                check: "open",
                detail: error.to_string(),
            }]
        }
    };
    let store = &*owned;

    record(
        &mut failures,
        "recent_round_trip",
        recent_round_trip(store).await,
    );
    record(
        &mut failures,
        "recent_dedupes_by_path",
        recent_dedupes_by_path(store).await,
    );
    record(
        &mut failures,
        "recent_truncates",
        recent_truncates(store).await,
    );
    record(&mut failures, "recent_removal", recent_removal(store).await);
    record(
        &mut failures,
        "model_is_written_whole",
        model_is_written_whole(store).await,
    );
    record(
        &mut failures,
        "upsert_replaces_the_whole_model",
        upsert_replaces_the_whole_model(store).await,
    );
    record(
        &mut failures,
        "revision_conflict",
        revision_conflict(store).await,
    );
    record(
        &mut failures,
        "defaults_and_preferences",
        defaults_and_preferences(store).await,
    );
    record(
        &mut failures,
        "secret_round_trip",
        secret_round_trip(store).await,
    );
    record(
        &mut failures,
        "secret_state_hides_the_value",
        secret_state_hides_the_value(store).await,
    );
    record(
        &mut failures,
        "delete_secret_keeps_model",
        delete_secret_keeps_model(store).await,
    );
    record(
        &mut failures,
        "delete_model_clears_secret",
        delete_model_clears_secret(store).await,
    );
    record(
        &mut failures,
        "prompt_items_and_search",
        prompt_items_and_search(store).await,
    );
    record(
        &mut failures,
        "search_page_size_is_capped",
        search_page_size_is_capped(store).await,
    );
    record(
        &mut failures,
        "source_deletion_drops_items",
        source_deletion_drops_items(store).await,
    );
    record(
        &mut failures,
        "info_reports_the_backend",
        info_reports_the_backend(store).await,
    );
    record(
        &mut failures,
        "over_limit_documents_are_rejected",
        over_limit_documents_are_rejected(store).await,
    );

    // Reopening exercises load idempotency: a backend that writes something
    // it cannot read back fails here. The backend holds its location lock for
    // the store's lifetime, so the shared store has to go before these checks
    // can take the same location again.
    drop(owned);
    record(
        &mut failures,
        "reopen_preserves_content",
        reopen_preserves_content(open).await,
    );
    record(
        &mut failures,
        "reopen_is_idempotent",
        reopen_is_idempotent(open).await,
    );

    failures
}

fn record(failures: &mut Vec<ContractFailure>, check: &'static str, result: Result<(), String>) {
    if let Err(detail) = result {
        failures.push(ContractFailure { check, detail });
    }
}

fn recent(id: &str, path: &str) -> RecentProject {
    RecentProject {
        id: id.to_string(),
        name: format!("Project {id}"),
        path: std::path::PathBuf::from(path),
        last_opened: crate::domain::now_iso(),
    }
}

fn draft(id: &str, category: Capability) -> ModelDraft {
    ModelDraft {
        id: id.to_string(),
        category,
        protocol: Protocol::from_wire_name("openaiChat"),
        url: "https://provider.example/v1/chat/completions".to_string(),
        model: format!("model-{id}"),
        display_name: format!("Model {id}"),
        max_video_seconds: None,
        scenes: Vec::new(),
        sub_models: Vec::new(),
        enabled: true,
        expected_revision: None,
    }
}

async fn describe<T, F>(label: &str, future: F) -> Result<T, String>
where
    T: std::fmt::Debug,
    F: std::future::Future<Output = Result<T, MetadataError>>,
{
    future.await.map_err(|error| format!("{label}: {error}"))
}

async fn recent_round_trip(store: &dyn MetadataStore) -> Result<(), String> {
    describe("upsert", store.upsert_recent(&recent("a", "/tmp/a"))).await?;
    let listed = describe("list", store.list_recent()).await?;
    if listed.len() != 1 {
        return Err(format!("expected one entry, found {}", listed.len()));
    }
    if listed[0].name != "Project a" {
        return Err(format!("unexpected name {:?}", listed[0].name));
    }
    Ok(())
}

async fn recent_dedupes_by_path(store: &dyn MetadataStore) -> Result<(), String> {
    describe("first", store.upsert_recent(&recent("a", "/tmp/shared"))).await?;
    describe("second", store.upsert_recent(&recent("b", "/tmp/shared"))).await?;
    let listed = describe("list", store.list_recent()).await?;
    let matches = listed
        .iter()
        .filter(|entry| entry.path.as_path() == std::path::Path::new("/tmp/shared"))
        .count();
    if matches != 1 {
        return Err(format!("one path produced {matches} entries"));
    }
    if listed.first().map(|entry| entry.id.as_str()) != Some("b") {
        return Err("the most recent entry is not first".to_string());
    }
    Ok(())
}

async fn recent_truncates(store: &dyn MetadataStore) -> Result<(), String> {
    for index in 0..(MAX_RECENT + 2) {
        let entry = recent(&format!("t{index}"), &format!("/tmp/truncate/{index}"));
        describe("upsert", store.upsert_recent(&entry)).await?;
    }
    let listed = describe("list", store.list_recent()).await?;
    if listed.len() > MAX_RECENT {
        return Err(format!("list grew to {} entries", listed.len()));
    }
    Ok(())
}

async fn recent_removal(store: &dyn MetadataStore) -> Result<(), String> {
    describe("upsert", store.upsert_recent(&recent("gone", "/tmp/gone"))).await?;
    describe("remove", store.remove_recent("gone")).await?;
    let listed = describe("list", store.list_recent()).await?;
    if listed.iter().any(|entry| entry.id == "gone") {
        return Err("removed entry is still listed".to_string());
    }
    // Removing something absent is not an error.
    describe("remove again", store.remove_recent("never-existed")).await?;
    Ok(())
}

async fn model_is_written_whole(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert",
        store.upsert_model(&draft("whole", Capability::Text)),
    )
    .await?;
    let snapshot = describe("snapshot", store.models_snapshot()).await?;
    let model = snapshot
        .models
        .iter()
        .find(|model| model.id == "whole")
        .ok_or("model missing from the snapshot")?;
    if model.url.is_empty() || model.model.is_empty() || model.display_name.is_empty() {
        return Err("model fields were partially written".to_string());
    }
    if !model.enabled || model.category != Capability::Text {
        return Err(format!("model fields were written wrong: {model:?}"));
    }
    Ok(())
}

async fn upsert_replaces_the_whole_model(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert",
        store.upsert_model(&draft("replaced", Capability::Text)),
    )
    .await?;
    let mut changed = draft("replaced", Capability::Image);
    changed.url = "https://provider.example/v1/images/generations".to_string();
    changed.protocol = Protocol::from_wire_name("openaiImages");
    changed.display_name = "Renamed".to_string();
    describe("upsert again", store.upsert_model(&changed)).await?;
    let snapshot = describe("snapshot", store.models_snapshot()).await?;
    let models: Vec<_> = snapshot
        .models
        .iter()
        .filter(|model| model.id == "replaced")
        .collect();
    if models.len() != 1 {
        return Err(format!(
            "upsert duplicated the model: {} entries",
            models.len()
        ));
    }
    if models[0].category != Capability::Image
        || models[0].protocol != Protocol::from_wire_name("openaiImages")
        || models[0].display_name != "Renamed"
    {
        return Err(format!(
            "upsert merged instead of replacing: {:?}",
            models[0]
        ));
    }
    Ok(())
}

async fn revision_conflict(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert",
        store.upsert_model(&draft("locked", Capability::Text)),
    )
    .await?;
    let snapshot = describe("snapshot", store.models_snapshot()).await?;
    let stale = snapshot.revision.saturating_sub(1);
    if stale == snapshot.revision {
        return Err("revision did not advance after a write".to_string());
    }
    let mut conflicting = draft("locked", Capability::Text);
    conflicting.expected_revision = Some(stale);
    let error = match store.upsert_model(&conflicting).await {
        Ok(_) => return Err("a stale revision was accepted".to_string()),
        Err(error) => error,
    };
    if error.code() != "METADATA_CONFLICT" {
        return Err(format!("expected METADATA_CONFLICT, got {}", error.code()));
    }
    // The current revision is accepted.
    let mut current = draft("locked", Capability::Text);
    current.expected_revision = Some(snapshot.revision);
    describe("upsert at current revision", store.upsert_model(&current)).await?;

    let stale_defaults = Defaults {
        text: Some("locked".to_string()),
        ..Default::default()
    };
    let error = store
        .set_defaults(&stale_defaults, Some(stale))
        .await
        .unwrap_err();
    if error.code() != "METADATA_CONFLICT" {
        return Err(format!(
            "defaults ignored the revision, got {}",
            error.code()
        ));
    }
    Ok(())
}

async fn defaults_and_preferences(store: &dyn MetadataStore) -> Result<(), String> {
    let defaults = Defaults {
        text: Some("locked".to_string()),
        image: Some("other-image".to_string()),
        speech: None,
        music: Some("composes".to_string()),
        video: None,
        asr: Some("hears-audio".to_string()),
    };
    describe("set defaults", store.set_defaults(&defaults, None)).await?;
    let preferences = Preferences {
        system_prompt: "be brief".to_string(),
        video: VideoPreferences {
            seconds: 12,
            ..Default::default()
        },
        ..Default::default()
    };
    describe("set preferences", store.set_preferences(&preferences, None)).await?;

    let snapshot = describe("snapshot", store.models_snapshot()).await?;
    if snapshot.defaults != defaults {
        return Err(format!("defaults did not persist: {:?}", snapshot.defaults));
    }
    if snapshot.preferences != preferences {
        return Err("preferences did not persist".to_string());
    }
    Ok(())
}

async fn secret_round_trip(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert",
        store.upsert_model(&draft("secreted", Capability::Text)),
    )
    .await?;
    describe("put", store.put_secret("secreted", "sk-round-trip-value")).await?;
    let recovered = describe("get", store.get_secret("secreted")).await?;
    if recovered.as_deref() != Some("sk-round-trip-value") {
        return Err(format!("credential did not round-trip: {recovered:?}"));
    }
    // Rotating replaces rather than appending.
    describe("rotate", store.put_secret("secreted", "sk-second-value")).await?;
    let recovered = describe("get after rotation", store.get_secret("secreted")).await?;
    if recovered.as_deref() != Some("sk-second-value") {
        return Err("rotation did not replace the previous credential".to_string());
    }
    let absent = describe("get unknown", store.get_secret("never-stored")).await?;
    if absent.is_some() {
        return Err("an unknown model reported a credential".to_string());
    }
    Ok(())
}

async fn secret_state_hides_the_value(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert",
        store.upsert_model(&draft("masked", Capability::Text)),
    )
    .await?;
    describe("put", store.put_secret("masked", "sk-abcdefgh123456")).await?;
    let state = describe("state", store.secret_state("masked"))
        .await?
        .ok_or("no state reported for a stored credential")?;
    if !state.set {
        return Err("state reports the credential as unset".to_string());
    }
    let masked = state.masked.unwrap_or_default();
    if masked.contains("sk-abcdefgh123456") {
        return Err("the disclosed value is the credential itself".to_string());
    }
    if masked.is_empty() {
        return Err("no masked value was reported".to_string());
    }
    let fingerprint = state.fingerprint.unwrap_or_default();
    if fingerprint.len() != 8 || fingerprint.contains("sk-") {
        return Err(format!("unexpected fingerprint {fingerprint:?}"));
    }
    if state.rotated_at.is_none() {
        return Err("no rotation time was reported".to_string());
    }
    Ok(())
}

async fn delete_secret_keeps_model(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert",
        store.upsert_model(&draft("keyless", Capability::Text)),
    )
    .await?;
    describe("put", store.put_secret("keyless", "sk-temporary")).await?;
    describe("delete secret", store.delete_secret("keyless")).await?;
    let state = describe("state", store.secret_state("keyless")).await?;
    if state.is_some() {
        return Err("credential survived deletion".to_string());
    }
    let snapshot = describe("snapshot", store.models_snapshot()).await?;
    if !snapshot.models.iter().any(|model| model.id == "keyless") {
        return Err("deleting the credential also deleted the model".to_string());
    }
    Ok(())
}

async fn delete_model_clears_secret(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert",
        store.upsert_model(&draft("doomed", Capability::Text)),
    )
    .await?;
    describe("put", store.put_secret("doomed", "sk-doomed")).await?;
    describe("delete", store.delete_model("doomed", None)).await?;
    let snapshot = describe("snapshot", store.models_snapshot()).await?;
    if snapshot.models.iter().any(|model| model.id == "doomed") {
        return Err("model survived deletion".to_string());
    }
    let state = describe("state", store.secret_state("doomed")).await?;
    if state.is_some() {
        return Err("credential outlived its model".to_string());
    }
    Ok(())
}

fn prompt_source(id: &str) -> PromptSource {
    PromptSource {
        id: id.to_string(),
        name: format!("Source {id}"),
        url: format!("https://prompts.example/{id}.json"),
        enabled: true,
        ..PromptSource::default()
    }
}

fn prompt_item(id: &str, source_id: &str, title: &str, tags: &[&str]) -> PromptItem {
    PromptItem {
        id: id.to_string(),
        source_id: source_id.to_string(),
        title: title.to_string(),
        prompt: format!("Prompt body for {title}"),
        url: Some(format!("https://prompts.example/{id}")),
        tags: tags.iter().map(|tag| tag.to_string()).collect(),
        ..PromptItem::default()
    }
}

async fn prompt_items_and_search(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert source",
        store.upsert_prompt_source(&prompt_source("lib")),
    )
    .await?;
    let items = vec![
        prompt_item("p1", "lib", "Harbour at dusk", &["landscape"]),
        prompt_item("p2", "lib", "Studio portrait", &["portrait"]),
        prompt_item("p3", "lib", "Mountain harbour", &["landscape"]),
    ];
    describe("replace items", store.replace_prompt_items("lib", &items)).await?;

    let all = describe("search all", store.search_prompts(&PromptQuery::default())).await?;
    if all.total < 3 {
        return Err(format!("expected at least 3 matches, got {}", all.total));
    }

    let filtered = describe(
        "search by text",
        store.search_prompts(&PromptQuery {
            q: Some("HARBOUR".to_string()),
            ..PromptQuery::default()
        }),
    )
    .await?;
    if filtered.total != 2 {
        return Err(format!(
            "text search matched {} items, expected 2",
            filtered.total
        ));
    }

    let by_tag = describe(
        "search by tag",
        store.search_prompts(&PromptQuery {
            tags: vec!["portrait".to_string()],
            ..PromptQuery::default()
        }),
    )
    .await?;
    if by_tag.total != 1 || by_tag.items[0].id != "p2" {
        return Err(format!("tag search returned {:?}", by_tag.items));
    }

    let by_source = describe(
        "search within a source",
        store.search_prompts(&PromptQuery {
            source: Some("lib".to_string()),
            ..PromptQuery::default()
        }),
    )
    .await?;
    if by_source.total != 3 {
        return Err(format!("source filter returned {}", by_source.total));
    }

    // Replacing the cache wholesale, not appending to it.
    describe(
        "replace again",
        store.replace_prompt_items("lib", &[prompt_item("p9", "lib", "Only one", &[])]),
    )
    .await?;
    let after = describe(
        "search after replace",
        store.search_prompts(&PromptQuery {
            source: Some("lib".to_string()),
            ..PromptQuery::default()
        }),
    )
    .await?;
    if after.total != 1 {
        return Err(format!("replacement left {} items", after.total));
    }
    Ok(())
}

async fn search_page_size_is_capped(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert source",
        store.upsert_prompt_source(&prompt_source("paged")),
    )
    .await?;
    let items: Vec<PromptItem> = (0..12)
        .map(|index| {
            prompt_item(
                &format!("pg{index}"),
                "paged",
                &format!("Item {index}"),
                &[],
            )
        })
        .collect();
    describe("replace items", store.replace_prompt_items("paged", &items)).await?;

    let page = describe(
        "first page",
        store.search_prompts(&PromptQuery {
            source: Some("paged".to_string()),
            page: 0,
            page_size: 5,
            ..Default::default()
        }),
    )
    .await?;
    if page.items.len() != 5 || page.total != 12 || page.page_size != 5 {
        return Err(format!("unexpected page shape: {page:?}"));
    }
    let second = describe(
        "second page",
        store.search_prompts(&PromptQuery {
            source: Some("paged".to_string()),
            page: 1,
            page_size: 5,
            ..Default::default()
        }),
    )
    .await?;
    if second.items.first().map(|item| item.id.as_str())
        == page.items.first().map(|item| item.id.as_str())
    {
        return Err("page 1 repeated page 0".to_string());
    }

    let oversized = describe(
        "oversized page",
        store.search_prompts(&PromptQuery {
            source: Some("paged".to_string()),
            page_size: MAX_SEARCH_PAGE_SIZE * 10,
            ..Default::default()
        }),
    )
    .await?;
    if oversized.page_size > MAX_SEARCH_PAGE_SIZE {
        return Err(format!("page size was not capped: {}", oversized.page_size));
    }
    Ok(())
}

async fn source_deletion_drops_items(store: &dyn MetadataStore) -> Result<(), String> {
    describe(
        "upsert source",
        store.upsert_prompt_source(&prompt_source("dropped")),
    )
    .await?;
    describe(
        "replace items",
        store.replace_prompt_items("dropped", &[prompt_item("d1", "dropped", "Dropped", &[])]),
    )
    .await?;
    describe("delete source", store.delete_prompt_source("dropped")).await?;

    let sources = describe("list sources", store.list_prompt_sources()).await?;
    if sources.iter().any(|source| source.id == "dropped") {
        return Err("source survived deletion".to_string());
    }
    let found = describe(
        "search deleted source",
        store.search_prompts(&PromptQuery {
            source: Some("dropped".to_string()),
            ..PromptQuery::default()
        }),
    )
    .await?;
    if found.total != 0 {
        return Err(format!(
            "cached items outlived their source: {}",
            found.total
        ));
    }
    Ok(())
}

async fn info_reports_the_backend(store: &dyn MetadataStore) -> Result<(), String> {
    let info = store.info().await;
    if info.store != MetadataStoreKind::File {
        return Err(format!("unexpected backend {:?}", info.store));
    }
    if info.schema_version == 0 {
        return Err("schema version was not reported".to_string());
    }
    if info.documents.is_empty() {
        return Err("no documents were reported".to_string());
    }
    let root = info.root.to_string_lossy().to_string();
    if let Some(home) = std::env::var_os("HOME") {
        let home = home.to_string_lossy().to_string();
        if home.len() > 1 && root.contains(&home) {
            return Err(format!("diagnostics leaked the home directory: {root}"));
        }
    }
    Ok(())
}

async fn over_limit_documents_are_rejected(store: &dyn MetadataStore) -> Result<(), String> {
    // An identifier that would name a path outside the store's own layout must
    // be refused rather than written.
    let error = match store.replace_prompt_items("../../escape", &[]).await {
        Ok(()) => return Err("a path-escaping identifier was accepted".to_string()),
        Err(error) => error,
    };
    if error.code() != "VALIDATION_FAILED" {
        return Err(format!("expected VALIDATION_FAILED, got {}", error.code()));
    }
    let error = match store
        .upsert_prompt_source(&PromptSource {
            id: "no-url".to_string(),
            ..PromptSource::default()
        })
        .await
    {
        Ok(()) => return Err("a source without a url was accepted".to_string()),
        Err(error) => error,
    };
    if error.code() != "VALIDATION_FAILED" {
        return Err(format!("expected VALIDATION_FAILED, got {}", error.code()));
    }
    Ok(())
}

async fn reopen_preserves_content(open: &StoreFactory) -> Result<(), String> {
    let first = open().map_err(|error| format!("first open: {error}"))?;
    describe(
        "write before reopen",
        first.upsert_model(&draft("persisted", Capability::Image)),
    )
    .await?;
    describe(
        "secret before reopen",
        first.put_secret("persisted", "sk-persisted"),
    )
    .await?;
    describe(
        "recent before reopen",
        first.upsert_recent(&recent("persisted", "/tmp/persisted")),
    )
    .await?;
    drop(first);

    let second = open().map_err(|error| format!("reopen: {error}"))?;
    let snapshot = describe("snapshot after reopen", second.models_snapshot()).await?;
    let model = snapshot
        .models
        .iter()
        .find(|model| model.id == "persisted")
        .ok_or("model was not written durably")?;
    if model.category != Capability::Image {
        return Err("model fields were not written durably".to_string());
    }
    let secret = describe("secret after reopen", second.get_secret("persisted")).await?;
    if secret.as_deref() != Some("sk-persisted") {
        return Err("credential was not written durably".to_string());
    }
    let listed = describe("recent after reopen", second.list_recent()).await?;
    if !listed.iter().any(|entry| entry.id == "persisted") {
        return Err("recent entry was not written durably".to_string());
    }
    Ok(())
}

async fn reopen_is_idempotent(open: &StoreFactory) -> Result<(), String> {
    let first = open().map_err(|error| format!("first open: {error}"))?;
    describe(
        "seed",
        first.upsert_model(&draft("stable", Capability::Text)),
    )
    .await?;
    let seeded = describe("seeded snapshot", first.models_snapshot()).await?;
    drop(first);

    // Two further boots: reopening must not advance the revision or reshape
    // the document.
    for attempt in 0..2 {
        let reopened = open().map_err(|error| format!("reopen {attempt}: {error}"))?;
        let snapshot = describe("snapshot after reopen", reopened.models_snapshot()).await?;
        if snapshot.models != seeded.models {
            return Err(format!("reopen {attempt} changed the models"));
        }
        if snapshot.revision != seeded.revision {
            return Err(format!(
                "reopen {attempt} moved the revision from {} to {}",
                seeded.revision, snapshot.revision
            ));
        }
    }
    Ok(())
}
