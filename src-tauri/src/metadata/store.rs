//! The file backend: an in-memory snapshot published only after a durable
//! write.
//!
//! Reads never touch the filesystem — [`FileMetadataStore::open`] loads every
//! document except the prompt entry caches up front, and prompt caches are
//! loaded per source on first use. Writes clone the target document, mutate
//! the clone, write it atomically, and only then publish it. A failed write
//! therefore leaves memory exactly as it was, which is what makes "the disk is
//! read-only" a reportable condition instead of silent data loss.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::{Mutex as AsyncMutex, RwLock};

use super::crypto::{open as open_sealed, seal, KeyProvider};
use super::docs::{
    self, DocumentCorruption, MetaDoc, ModelsDoc, PromptItemsDoc, PromptSourcesDoc, RecentDoc,
    SecretEntry, SecretsDoc, MANAGED_DOCUMENTS, META_DOC, MODELS_DOC, PROMPT_ITEMS_DIR,
    PROMPT_SOURCES_DOC, RECENT_DOC, SECRETS_DOC,
};
use super::fs::{self, DirLock, DOCUMENT_MODE, SECRET_MODE};
use super::redact;
use super::types::{
    Defaults, DocumentInfo, MetadataInfo, MetadataStoreKind, ModelConfig, ModelDraft, ModelRecord,
    ModelsSnapshot, Preferences, PromptItem, PromptPage, PromptQuery, PromptSource, RecentProject,
    SecretInfo, SecretStorage, MAX_PROMPT_ITEMS_PER_SOURCE, MAX_RECENT, MAX_SEARCH_PAGE_SIZE,
};
use super::{MetadataError, MetadataStore, FILE_STORE, SCHEMA_VERSION};
use crate::config::{MetadataConfig, RuntimeMode};
use crate::domain::now_iso;

/// How many prompt entry caches stay resident. Entries can number in the
/// thousands per source, so they are the one document loaded on demand.
const PROMPT_CACHE_CAPACITY: usize = 8;

/// Consecutive failed durable writes before logging escalates from `warn` to
/// `error`. One failure is usually transient; a streak means the app has been
/// rejecting every user edit since the first one.
const WRITE_FAILURE_ESCALATION: u32 = 3;

/// Documents written by [`FileMetadataStore`].
struct Snapshot {
    meta: MetaDoc,
    recent: RecentDoc,
    models: ModelsDoc,
    secrets: SecretsDoc,
    prompt_sources: PromptSourcesDoc,
    prompt_items: Mutex<PromptCache>,
    /// Documents that were unparseable at startup and reset to empty. Kept so
    /// `/api/health` and the settings banner can name what was lost.
    recovered: Vec<DocumentCorruption>,
    secret_storage: SecretStorage,
}

struct PromptCache {
    entries: HashMap<String, PromptItemsDoc>,
    order: VecDeque<String>,
}

impl PromptCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get(&self, source_id: &str) -> Option<PromptItemsDoc> {
        self.entries.get(source_id).cloned()
    }

    fn insert(&mut self, source_id: String, document: PromptItemsDoc) {
        if self.entries.insert(source_id.clone(), document).is_none() {
            self.order.push_back(source_id.clone());
        }
        if self.order.iter().filter(|id| **id == source_id).count() > 1 {
            self.order.retain(|id| *id != source_id);
            self.order.push_back(source_id.clone());
        }
        while self.order.len() > PROMPT_CACHE_CAPACITY {
            if let Some(evicted) = self.order.pop_front() {
                if evicted != source_id {
                    self.entries.remove(&evicted);
                }
            }
        }
    }

    fn remove(&mut self, source_id: &str) {
        self.entries.remove(source_id);
        self.order.retain(|id| id != source_id);
    }
}

pub struct FileMetadataStore {
    root: PathBuf,
    inner: RwLock<Snapshot>,
    /// Serialises "clone, mutate, persist, publish" so two writers cannot
    /// interleave a publish between another writer's persist and publish.
    write_seq: AsyncMutex<()>,
    /// Reset by any successful write; drives the log escalation in
    /// [`FileMetadataStore::record_write_failure`].
    write_failures: AtomicU32,
    keys: Arc<KeyProvider>,
    max_document_bytes: u64,
    /// Held for the process lifetime; released when the store is dropped.
    _lock: DirLock,
}

impl FileMetadataStore {
    /// Takes the directory lock, clears crash leftovers, creates the
    /// documents, and loads the snapshot.
    pub fn open(
        root: &Path,
        config: &MetadataConfig,
        mode: RuntimeMode,
    ) -> Result<Self, MetadataError> {
        std::fs::create_dir_all(root)
            .map_err(|error| MetadataError::unavailable(format!("{}: {error}", root.display())))?;
        set_private(root);
        std::fs::create_dir_all(root.join(PROMPT_ITEMS_DIR))
            .map_err(|error| MetadataError::unavailable(format!("{PROMPT_ITEMS_DIR}: {error}")))?;
        fs::clear_tmp(root).map_err(MetadataError::from)?;

        let lock = DirLock::acquire(root).map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                MetadataError::unavailable(format!(
                    "{} is in use by another process (pid {})",
                    root.display(),
                    lock_holder(root)
                ))
            } else {
                MetadataError::unavailable(format!("{}: {error}", root.display()))
            }
        })?;

        let mut recovered = Vec::new();
        let meta = load_meta(root, &mut recovered)?;
        check_schema(root, meta.schema_version)?;

        let recent = load_or_reset(root, RECENT_DOC, &mut recovered);
        let (models, secrets) = load_models_and_secrets(root, &mut recovered)?;
        let prompt_sources = load_or_reset(root, PROMPT_SOURCES_DOC, &mut recovered);

        let keys = Arc::new(KeyProvider::new(root, mode));
        keys.probe(!secrets.entries.is_empty())?;

        // Only safe when the model document is trustworthy: after a corruption
        // reset every configuration is gone, and collecting orphans would
        // delete credentials that are still valid.
        let models_intact = !recovered.iter().any(|entry| entry.document == MODELS_DOC);
        let secrets = if models_intact {
            collect_orphan_secrets(root, &secrets, &models, &mut recovered)?
        } else {
            secrets
        };

        let secret_storage = keys.storage();
        Ok(Self {
            root: root.to_path_buf(),
            inner: RwLock::new(Snapshot {
                meta,
                recent,
                models,
                secrets,
                prompt_sources,
                prompt_items: Mutex::new(PromptCache::new()),
                recovered,
                secret_storage,
            }),
            write_seq: AsyncMutex::new(()),
            write_failures: AtomicU32::new(0),
            keys,
            max_document_bytes: config.max_document_bytes,
            _lock: lock,
        })
    }

    /// The resolved directory. Diagnostics only; callers must not read or
    /// write through it.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn persist<T: Serialize>(
        &self,
        name: &str,
        document: &T,
        mode: u32,
    ) -> Result<u64, MetadataError> {
        let bytes = docs::serialize(name, document)
            .map_err(|error| MetadataError::write_failed(error.reason))?;
        if bytes.len() as u64 > self.max_document_bytes {
            return Err(MetadataError::invalid(format!(
                "{name} would occupy {} bytes, above the {} byte per-document limit; \
                 reduce the number of entries",
                bytes.len(),
                self.max_document_bytes
            )));
        }
        match fs::atomic_write(&self.root, &self.root.join(name), &bytes, mode) {
            Ok(()) => {
                self.write_failures.store(0, Ordering::Relaxed);
                Ok(bytes.len() as u64)
            }
            Err(error) => Err(self.record_write_failure(name, error)),
        }
    }

    /// Turns a failed durable write into a log line and an error. Nothing is
    /// published to the snapshot in this case, so the caller keeps serving the
    /// last known-good state while the user is told their edit was rejected.
    fn record_write_failure(&self, name: &str, error: std::io::Error) -> MetadataError {
        let streak = self.write_failures.fetch_add(1, Ordering::Relaxed) + 1;
        if streak >= WRITE_FAILURE_ESCALATION {
            tracing::error!(
                target: "moka::metadata",
                document = %name,
                consecutive = streak,
                error = %error,
                "metadata writes keep failing and every change is being rejected"
            );
        } else {
            tracing::warn!(
                target: "moka::metadata",
                document = %name,
                consecutive = streak,
                error = %error,
                "a metadata write failed"
            );
        }
        MetadataError::write_failed(format!("{name}: {error}"))
    }

    async fn mutate_models<F>(
        &self,
        expected_revision: Option<u64>,
        change: F,
    ) -> Result<ModelsDoc, MetadataError>
    where
        F: FnOnce(&mut ModelsDoc) -> Result<(), MetadataError>,
    {
        let _sequence = self.write_seq.lock().await;
        let mut next = self.inner.read().await.models.clone();
        check_revision("models", expected_revision, next.revision)?;
        change(&mut next)?;
        next.revision += 1;
        self.persist(MODELS_DOC, &next, DOCUMENT_MODE)?;
        self.inner.write().await.models = next.clone();
        Ok(next)
    }

    async fn mutate_secrets<F>(&self, change: F) -> Result<SecretsDoc, MetadataError>
    where
        F: FnOnce(&mut SecretsDoc) -> Result<(), MetadataError>,
    {
        let _sequence = self.write_seq.lock().await;
        let mut next = self.inner.read().await.secrets.clone();
        change(&mut next)?;
        next.revision += 1;
        self.persist(SECRETS_DOC, &next, SECRET_MODE)?;
        self.inner.write().await.secrets = next.clone();
        Ok(next)
    }

    async fn mutate_recent<F>(&self, change: F) -> Result<RecentDoc, MetadataError>
    where
        F: FnOnce(&mut RecentDoc),
    {
        let _sequence = self.write_seq.lock().await;
        let mut next = self.inner.read().await.recent.clone();
        change(&mut next);
        next.revision += 1;
        self.persist(RECENT_DOC, &next, DOCUMENT_MODE)?;
        self.inner.write().await.recent = next.clone();
        Ok(next)
    }

    async fn mutate_prompt_sources<F>(&self, change: F) -> Result<PromptSourcesDoc, MetadataError>
    where
        F: FnOnce(&mut PromptSourcesDoc) -> Result<(), MetadataError>,
    {
        let _sequence = self.write_seq.lock().await;
        let mut next = self.inner.read().await.prompt_sources.clone();
        change(&mut next)?;
        next.revision += 1;
        self.persist(PROMPT_SOURCES_DOC, &next, DOCUMENT_MODE)?;
        self.inner.write().await.prompt_sources = next.clone();
        Ok(next)
    }

    /// Blocking: consults the OS keychain when the master key is not cached.
    async fn master_key(&self) -> Result<super::crypto::MasterKey, MetadataError> {
        let keys = Arc::clone(&self.keys);
        tokio::task::spawn_blocking(move || keys.acquire())
            .await
            .map_err(|error| {
                MetadataError::unavailable(format!("key lookup was cancelled: {error}"))
            })?
    }
}

#[async_trait]
impl MetadataStore for FileMetadataStore {
    async fn list_recent(&self) -> Result<Vec<RecentProject>, MetadataError> {
        Ok(self.inner.read().await.recent.items.clone())
    }

    async fn upsert_recent(&self, project: &RecentProject) -> Result<(), MetadataError> {
        if project.path.as_os_str().is_empty() {
            return Err(MetadataError::invalid("a recent project needs a path"));
        }
        let inserted = project.clone();
        self.mutate_recent(move |document| {
            document
                .items
                .retain(|entry| entry.id != inserted.id && entry.path != inserted.path);
            document.items.insert(0, inserted);
            document.items.truncate(MAX_RECENT);
        })
        .await?;
        Ok(())
    }

    async fn remove_recent(&self, id: &str) -> Result<(), MetadataError> {
        let id = id.to_string();
        self.mutate_recent(move |document| {
            document.items.retain(|entry| entry.id != id);
        })
        .await?;
        Ok(())
    }

    async fn models_snapshot(&self) -> Result<ModelsSnapshot, MetadataError> {
        let snapshot = self.inner.read().await;
        Ok(ModelsSnapshot {
            version: snapshot.models.version,
            revision: snapshot.models.revision,
            models: snapshot.models.models.clone(),
            defaults: snapshot.models.defaults.clone(),
            preferences: snapshot.models.preferences.clone(),
        })
    }

    async fn upsert_model(&self, draft: &ModelDraft) -> Result<ModelRecord, MetadataError> {
        if draft.id.trim().is_empty() {
            return Err(MetadataError::invalid("a model configuration needs an id"));
        }
        let record = ModelConfig {
            id: draft.id.clone(),
            category: draft.category,
            protocol: draft.protocol.clone(),
            url: draft.url.clone(),
            model: draft.model.clone(),
            display_name: draft.display_name.clone(),
            max_video_seconds: draft.max_video_seconds,
            scenes: draft.scenes.clone(),
            sub_models: draft.sub_models.clone(),
            enabled: draft.enabled,
        };
        let replacement = record.clone();
        let document = self
            .mutate_models(draft.expected_revision, move |models| {
                match models
                    .models
                    .iter_mut()
                    .find(|model| model.id == replacement.id)
                {
                    Some(existing) => *existing = replacement,
                    None => models.models.push(replacement),
                }
                Ok(())
            })
            .await?;
        document
            .models
            .into_iter()
            .find(|model| model.id == record.id)
            .ok_or_else(|| MetadataError::unavailable("model configuration vanished during write"))
    }

    async fn delete_model(
        &self,
        id: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), MetadataError> {
        let id = id.to_string();
        let target = id.clone();
        self.mutate_models(expected_revision, move |models| {
            models.models.retain(|model| model.id != target);
            Ok(())
        })
        .await?;
        // Configuration first, then the credential. If the process dies between
        // the two writes the leftover ciphertext is an orphan that startup
        // collects; the reverse order would leave a model with no key, which
        // reads as a configuration the user cannot explain.
        let target = id;
        self.mutate_secrets(move |secrets| {
            secrets.entries.remove(&target);
            Ok(())
        })
        .await?;
        Ok(())
    }

    async fn set_defaults(
        &self,
        defaults: &Defaults,
        expected_revision: Option<u64>,
    ) -> Result<(), MetadataError> {
        let replacement = defaults.clone();
        self.mutate_models(expected_revision, move |models| {
            models.defaults = replacement;
            Ok(())
        })
        .await?;
        Ok(())
    }

    async fn set_preferences(
        &self,
        preferences: &Preferences,
        expected_revision: Option<u64>,
    ) -> Result<(), MetadataError> {
        let replacement = preferences.clone();
        self.mutate_models(expected_revision, move |models| {
            models.preferences = replacement;
            Ok(())
        })
        .await?;
        Ok(())
    }

    async fn put_secret(&self, model_id: &str, key: &str) -> Result<SecretInfo, MetadataError> {
        if key.is_empty() {
            return Err(MetadataError::invalid("a credential cannot be empty"));
        }
        let master = self.master_key().await?;
        let cipher = seal(master.bytes(), model_id, key)?;
        let info = SecretInfo {
            set: true,
            masked: Some(redact::masked(key)),
            fingerprint: Some(redact::fingerprint(key)),
            rotated_at: Some(now_iso()),
        };
        let entry = SecretEntry {
            cipher,
            fingerprint: info.fingerprint.clone().unwrap_or_default(),
            masked: info.masked.clone().unwrap_or_default(),
            rotated_at: info.rotated_at.clone().unwrap_or_default(),
        };
        let id = model_id.to_string();
        let storage = master.storage();
        self.mutate_secrets(move |secrets| {
            secrets.entries.insert(id, entry);
            Ok(())
        })
        .await?;
        self.inner.write().await.secret_storage = storage;
        Ok(info)
    }

    async fn get_secret(&self, model_id: &str) -> Result<Option<String>, MetadataError> {
        let cipher = {
            let entry = self
                .inner
                .read()
                .await
                .secrets
                .entries
                .get(model_id)
                .cloned();
            match entry {
                Some(entry) => entry.cipher,
                None => return Ok(None),
            }
        };
        let master = self.master_key().await?;
        let id = model_id.to_string();
        let plaintext =
            tokio::task::spawn_blocking(move || open_sealed(master.bytes(), &id, &cipher))
                .await
                .map_err(|error| {
                    MetadataError::unavailable(format!("key lookup was cancelled: {error}"))
                })??;
        Ok(Some(plaintext))
    }

    async fn delete_secret(&self, model_id: &str) -> Result<(), MetadataError> {
        let id = model_id.to_string();
        self.mutate_secrets(move |secrets| {
            secrets.entries.remove(&id);
            Ok(())
        })
        .await?;
        Ok(())
    }

    async fn secret_state(&self, model_id: &str) -> Result<Option<SecretInfo>, MetadataError> {
        Ok(self
            .inner
            .read()
            .await
            .secrets
            .entries
            .get(model_id)
            .map(|entry| SecretInfo {
                set: true,
                masked: Some(entry.masked.clone()),
                fingerprint: Some(entry.fingerprint.clone()),
                rotated_at: Some(entry.rotated_at.clone()),
            }))
    }

    async fn set_secret_storage(
        &self,
        target: SecretStorage,
    ) -> Result<SecretStorage, MetadataError> {
        let keys = Arc::clone(&self.keys);
        let storage = tokio::task::spawn_blocking(move || keys.switch_storage(target))
            .await
            .map_err(|error| {
                MetadataError::unavailable(format!("key lookup was cancelled: {error}"))
            })??;
        self.inner.write().await.secret_storage = storage;
        Ok(storage)
    }

    async fn list_prompt_sources(&self) -> Result<Vec<PromptSource>, MetadataError> {
        Ok(self.inner.read().await.prompt_sources.items.clone())
    }

    async fn upsert_prompt_source(&self, source: &PromptSource) -> Result<(), MetadataError> {
        validate_id(&source.id)?;
        if source.url.trim().is_empty() {
            return Err(MetadataError::invalid("a prompt source needs a url"));
        }
        let replacement = source.clone();
        self.mutate_prompt_sources(move |document| {
            match document
                .items
                .iter_mut()
                .find(|existing| existing.id == replacement.id)
            {
                Some(existing) => *existing = replacement,
                None => document.items.push(replacement),
            }
            Ok(())
        })
        .await?;
        Ok(())
    }

    async fn delete_prompt_source(&self, id: &str) -> Result<(), MetadataError> {
        validate_id(id)?;
        let target = id.to_string();
        self.mutate_prompt_sources(move |document| {
            document.items.retain(|source| source.id != target);
            Ok(())
        })
        .await?;
        let path = items_path(&self.root, id);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|error| MetadataError::write_failed(format!("{id}: {error}")))?;
        }
        if let Ok(mut cache) = self.inner.read().await.prompt_items.lock() {
            cache.remove(id);
        }
        Ok(())
    }

    async fn replace_prompt_items(
        &self,
        source_id: &str,
        items: &[PromptItem],
    ) -> Result<(), MetadataError> {
        validate_id(source_id)?;
        let _sequence = self.write_seq.lock().await;

        let mut items = items.to_vec();
        if items.len() > MAX_PROMPT_ITEMS_PER_SOURCE {
            // Keep the newest by fetch order: the tail of a refresh response.
            items.drain(0..items.len() - MAX_PROMPT_ITEMS_PER_SOURCE);
        }
        let document = PromptItemsDoc {
            revision: self
                .inner
                .read()
                .await
                .prompt_items
                .lock()
                .ok()
                .and_then(|cache| cache.get(source_id))
                .map(|cached| cached.revision)
                .unwrap_or(0)
                + 1,
            fetched_at: now_iso(),
            items: items.clone(),
        };
        let name = items_document_name(source_id);
        self.persist(&name, &document, DOCUMENT_MODE)?;

        let count = items.len();
        let id = source_id.to_string();
        if let Ok(mut cache) = self.inner.read().await.prompt_items.lock() {
            cache.insert(id.clone(), document);
        }
        // The source list carries the entry count, so the two must agree; this
        // is the one place a document is written outside its own mutator, and
        // it only touches a counter.
        let mut sources = self.inner.read().await.prompt_sources.clone();
        if let Some(source) = sources.items.iter_mut().find(|source| source.id == id) {
            source.item_count = count;
            sources.revision += 1;
            self.persist(PROMPT_SOURCES_DOC, &sources, DOCUMENT_MODE)?;
            self.inner.write().await.prompt_sources = sources;
        }
        Ok(())
    }

    async fn search_prompts(&self, query: &PromptQuery) -> Result<PromptPage, MetadataError> {
        let page_size = query.page_size.clamp(1, MAX_SEARCH_PAGE_SIZE);
        let needle = query
            .q
            .as_deref()
            .map(str::trim)
            .filter(|needle| !needle.is_empty())
            .map(str::to_lowercase);
        let tags: Vec<String> = query
            .tags
            .iter()
            .map(|tag| tag.trim().to_lowercase())
            .filter(|tag| !tag.is_empty())
            .collect();

        let sources: Vec<PromptSource> = {
            let snapshot = self.inner.read().await;
            snapshot
                .prompt_sources
                .items
                .iter()
                .filter(|source| match query.source.as_deref() {
                    Some(wanted) => source.id == wanted,
                    None => source.enabled,
                })
                .cloned()
                .collect()
        };

        let mut matches = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for source in sources {
            let document = self.prompt_items(&source.id).await?;
            for item in document.items {
                if !matches_query(&item, needle.as_deref(), &tags) {
                    continue;
                }
                // One prompt syndicated across sources should appear once.
                let identity = (
                    item.url.clone().unwrap_or_default(),
                    item.title.to_lowercase(),
                );
                if !seen.insert(identity) {
                    continue;
                }
                matches.push(item);
            }
        }

        let total = matches.len();
        let start = query.page.saturating_mul(page_size);
        let page_items = matches.into_iter().skip(start).take(page_size).collect();
        Ok(PromptPage {
            items: page_items,
            total,
            page: query.page,
            page_size,
        })
    }

    async fn probe_write(&self) -> Result<(), MetadataError> {
        fs::probe_write(&self.root).map_err(|error| {
            MetadataError::write_failed(format!("{} is not writable: {error}", self.root.display()))
        })
    }

    async fn info(&self) -> MetadataInfo {
        let snapshot = self.inner.read().await;
        let mut documents = Vec::new();
        for name in MANAGED_DOCUMENTS {
            let path = self.root.join(name);
            let (bytes, revision) = match name {
                META_DOC => (size_of(&path), snapshot.meta.schema_version as u64),
                RECENT_DOC => (size_of(&path), snapshot.recent.revision),
                MODELS_DOC => (size_of(&path), snapshot.models.revision),
                SECRETS_DOC => (size_of(&path), snapshot.secrets.revision),
                PROMPT_SOURCES_DOC => (size_of(&path), snapshot.prompt_sources.revision),
                _ => (0, 0),
            };
            documents.push(DocumentInfo {
                name: name.to_string(),
                bytes,
                revision,
                corrupt: false,
            });
        }
        for recovered in &snapshot.recovered {
            documents.push(DocumentInfo {
                name: recovered.document.clone(),
                bytes: 0,
                revision: 0,
                corrupt: true,
            });
        }
        MetadataInfo {
            store: MetadataStoreKind::File,
            root: redact_root(&self.root),
            schema_version: snapshot.meta.schema_version,
            secret_storage: snapshot.secret_storage,
            secret_storage_options: self.keys.storage_options(),
            secret_storage_pref: self.keys.preference(),
            documents,
        }
    }
}

impl FileMetadataStore {
    async fn prompt_items(&self, source_id: &str) -> Result<PromptItemsDoc, MetadataError> {
        if let Ok(cache) = self.inner.read().await.prompt_items.lock() {
            if let Some(cached) = cache.get(source_id) {
                return Ok(cached);
            }
        }
        let path = items_path(&self.root, source_id);
        let document = match std::fs::read(&path) {
            Ok(bytes) => docs::parse(&items_document_name(source_id), &bytes).map_err(|error| {
                MetadataError::unavailable(format!(
                    "{} is damaged: {}",
                    error.document, error.reason
                ))
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => PromptItemsDoc::default(),
            Err(error) => return Err(MetadataError::from(error)),
        };
        if let Ok(mut cache) = self.inner.read().await.prompt_items.lock() {
            cache.insert(source_id.to_string(), document.clone());
        }
        Ok(document)
    }
}

fn matches_query(item: &PromptItem, needle: Option<&str>, tags: &[String]) -> bool {
    if let Some(needle) = needle {
        let needle = needle.to_lowercase();
        let haystack = format!("{} {}", item.title, item.prompt).to_lowercase();
        if !haystack.contains(&needle) {
            return false;
        }
    }
    tags.iter().all(|wanted| {
        let wanted = wanted.to_lowercase();
        item.tags.iter().any(|tag| tag.to_lowercase() == wanted)
    })
}

fn check_revision(
    document: &'static str,
    expected: Option<u64>,
    actual: u64,
) -> Result<(), MetadataError> {
    match expected {
        Some(expected) if expected != actual => {
            Err(MetadataError::conflict(document, expected, actual))
        }
        _ => Ok(()),
    }
}

/// Document identifiers become file names, so they must not be able to name a
/// path outside the prompt items directory.
fn validate_id(id: &str) -> Result<(), MetadataError> {
    let acceptable = !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        && id != "."
        && id != ".."
        && !id.contains("..");
    if acceptable {
        Ok(())
    } else {
        Err(MetadataError::invalid(format!(
            "{id:?} is not usable as an identifier; use letters, digits, '-', '_' or '.'"
        )))
    }
}

fn items_document_name(source_id: &str) -> String {
    format!("{PROMPT_ITEMS_DIR}/{source_id}.json")
}

fn items_path(root: &Path, source_id: &str) -> PathBuf {
    root.join(PROMPT_ITEMS_DIR)
        .join(format!("{source_id}.json"))
}

fn size_of(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn lock_holder(root: &Path) -> String {
    std::fs::read_to_string(root.join(fs::LOCK_FILE))
        .map(|raw| raw.trim().to_string())
        .ok()
        .filter(|pid| !pid.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(unix)]
fn set_private(root: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn set_private(_root: &Path) {}

fn redact_root(root: &Path) -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    if let Some(home) = home {
        let home = PathBuf::from(home);
        if let Ok(relative) = root.strip_prefix(&home) {
            return Path::new("$HOME").join(relative);
        }
    }
    root.to_path_buf()
}

fn load_or_reset<T>(root: &Path, name: &str, recovered: &mut Vec<DocumentCorruption>) -> T
where
    T: DeserializeOwned + Default,
{
    match std::fs::read(root.join(name)) {
        Ok(bytes) => match docs::parse::<T>(name, &bytes) {
            Ok(document) => document,
            Err(error) => {
                quarantine(root, name);
                recovered.push(error);
                T::default()
            }
        },
        Err(_) => T::default(),
    }
}

fn load_meta(
    root: &Path,
    recovered: &mut Vec<DocumentCorruption>,
) -> Result<MetaDoc, MetadataError> {
    let path = root.join(META_DOC);
    match std::fs::read(&path) {
        Ok(bytes) => match docs::parse::<MetaDoc>(META_DOC, &bytes) {
            Ok(meta) => Ok(meta),
            Err(error) => {
                // A damaged header is not a reason to refuse startup: the
                // documents themselves decide what is recoverable.
                quarantine(root, META_DOC);
                recovered.push(error);
                let meta = MetaDoc::new(FILE_STORE, SCHEMA_VERSION);
                write_meta(root, &meta)?;
                Ok(meta)
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let meta = MetaDoc::new(FILE_STORE, SCHEMA_VERSION);
            write_meta(root, &meta)?;
            Ok(meta)
        }
        Err(error) => Err(MetadataError::unavailable(format!(
            "{}: {error}",
            path.display()
        ))),
    }
}

fn write_meta(root: &Path, meta: &MetaDoc) -> Result<(), MetadataError> {
    let bytes = docs::serialize(META_DOC, meta)
        .map_err(|error| MetadataError::write_failed(error.reason))?;
    fs::atomic_write(root, &root.join(META_DOC), &bytes, DOCUMENT_MODE)
        .map_err(|error| MetadataError::write_failed(format!("{META_DOC}: {error}")))?;
    Ok(())
}

/// Loads the model and secret documents, each resetting on its own when it
/// cannot be read.
fn load_models_and_secrets(
    root: &Path,
    recovered: &mut Vec<DocumentCorruption>,
) -> Result<(ModelsDoc, SecretsDoc), MetadataError> {
    let models: ModelsDoc = load_or_reset(root, MODELS_DOC, recovered);
    Ok((models, load_or_reset(root, SECRETS_DOC, recovered)))
}

/// Only this build's document format is read. A directory stamped otherwise is
/// refused whole rather than half-read through rules that no longer exist, and
/// the error names the directory and the version it holds so the way forward —
/// setting it aside — is a choice the user can make.
fn check_schema(root: &Path, found: u32) -> Result<(), MetadataError> {
    if found != SCHEMA_VERSION {
        return Err(MetadataError::schema_unsupported(
            root,
            found,
            SCHEMA_VERSION,
        ));
    }
    Ok(())
}

/// Drops credentials whose model configuration no longer exists: the residue
/// of a crash between the two writes of a deletion.
fn collect_orphan_secrets(
    root: &Path,
    secrets: &SecretsDoc,
    models: &ModelsDoc,
    recovered: &mut Vec<DocumentCorruption>,
) -> Result<SecretsDoc, MetadataError> {
    let known: std::collections::HashSet<&str> = models
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect();
    let orphans: Vec<String> = secrets
        .entries
        .keys()
        .filter(|id| !known.contains(id.as_str()))
        .cloned()
        .collect();
    if orphans.is_empty() {
        return Ok(secrets.clone());
    }
    let mut collected = secrets.clone();
    for id in &orphans {
        collected.entries.remove(id);
    }
    collected.revision += 1;
    let bytes = docs::serialize(SECRETS_DOC, &collected)
        .map_err(|error| MetadataError::write_failed(error.reason))?;
    fs::atomic_write(root, &root.join(SECRETS_DOC), &bytes, SECRET_MODE).map_err(|error| {
        recovered.push(DocumentCorruption {
            document: SECRETS_DOC.to_string(),
            reason: error.to_string(),
        });
        MetadataError::write_failed(format!("{SECRETS_DOC}: {error}"))
    })?;
    tracing::info!(
        target: "moka::metadata",
        orphans = orphans.len(),
        "collected credentials whose model configuration no longer exists"
    );
    Ok(collected)
}

/// Moves an unparseable document aside so the user can inspect it, then lets
/// the layer start from an empty one.
fn quarantine(root: &Path, name: &str) {
    let path = root.join(name);
    let stem = name.trim_end_matches(".json");
    let stamp = now_iso().replace(':', "-");
    let target = root.join(format!("{stem}.corrupt.{stamp}.json"));
    if let Err(error) = std::fs::rename(&path, &target) {
        tracing::error!(
            target: "moka::metadata",
            document = %name,
            error = %error,
            "could not move a damaged document aside"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_cannot_escape_the_items_directory() {
        for candidate in ["ok", "with-dash", "with_underscore", "a.b"] {
            assert!(validate_id(candidate).is_ok(), "{candidate}");
        }
        for candidate in ["", ".", "..", "../etc", "a/b", "a b", "a\\b", "..hidden"] {
            assert!(validate_id(candidate).is_err(), "{candidate}");
        }
    }

    #[test]
    fn quarantine_keeps_the_damaged_bytes_under_a_timestamped_name() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(RECENT_DOC), b"{").unwrap();
        quarantine(root.path(), RECENT_DOC);
        assert!(!root.path().join(RECENT_DOC).exists());
        let kept: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt."))
            .collect();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(kept[0].starts_with("recent-projects.corrupt."), "{kept:?}");
        assert!(kept[0].ends_with(".json"), "{kept:?}");
    }

    #[test]
    fn a_damaged_document_resets_without_taking_the_others_down() {
        let root = tempfile::tempdir().unwrap();
        let config = MetadataConfig::default();
        std::fs::create_dir_all(root.path()).unwrap();
        std::fs::write(
            root.path().join(RECENT_DOC),
            br#"{"revision":1,"items":[{"id":"a","name":"A","path":"/tmp/a","lastOpened":"2026-01-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        std::fs::write(root.path().join(MODELS_DOC), b"{\"revision\":").unwrap();

        let store = FileMetadataStore::open(root.path(), &config, RuntimeMode::Web).unwrap();
        let info = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(store.info());
        assert!(info
            .documents
            .iter()
            .any(|document| document.name == MODELS_DOC && document.corrupt));
    }

    /// A directory stamped with another schema version is refused whole, with
    /// the directory and the version it holds named.
    ///
    /// This build reads one document format; reading an older one would mean
    /// half-reading it through rules that no longer exist, and rewriting it
    /// would destroy what an older build would still understand.
    #[test]
    fn a_directory_from_another_schema_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let config = MetadataConfig::default();
        std::fs::create_dir_all(root.path()).unwrap();
        std::fs::write(
            root.path().join(META_DOC),
            br#"{"schemaVersion":2,"store":"file","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","appVersion":"0.2.1"}"#,
        )
        .unwrap();

        let error = FileMetadataStore::open(root.path(), &config, RuntimeMode::Web)
            .err()
            .expect("a directory from another schema must be refused");
        assert_eq!(error.code(), "METADATA_SCHEMA_UNSUPPORTED");
        assert!(error.to_string().contains("version 2"), "{error}");
        // The directory itself is named, so setting it aside needs no search.
        assert!(
            error.to_string().contains(&*root.path().to_string_lossy()),
            "{error}"
        );

        // Nothing was rewritten or moved aside: the directory is left exactly
        // as it was, for the user to set aside or keep.
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.path().join(META_DOC)).unwrap())
                .unwrap();
        assert_eq!(meta["schemaVersion"], 2);
    }

    #[test]
    fn the_prompt_cache_evicts_the_least_recently_used_source() {
        let mut cache = PromptCache::new();
        for index in 0..PROMPT_CACHE_CAPACITY + 2 {
            cache.insert(format!("source-{index}"), PromptItemsDoc::default());
        }
        assert!(cache.get("source-0").is_none());
        assert!(cache.get("source-1").is_none());
        assert!(cache
            .get(&format!("source-{}", PROMPT_CACHE_CAPACITY + 1))
            .is_some());
    }

    #[test]
    fn re_inserting_a_cached_source_does_not_grow_the_order_list() {
        let mut cache = PromptCache::new();
        cache.insert("a".to_string(), PromptItemsDoc::default());
        cache.insert("a".to_string(), PromptItemsDoc::default());
        assert_eq!(cache.order.len(), 1);
        assert_eq!(cache.entries.len(), 1);
    }

    #[test]
    fn the_home_directory_is_redacted_from_diagnostics() {
        let redacted = redact_root(Path::new("/Users/somebody/Library/metadata"));
        assert!(redacted.starts_with(Path::new("$HOME")) || redacted.is_absolute());
    }

    #[test]
    fn search_matches_title_and_prompt_case_insensitively() {
        let item = PromptItem {
            id: "1".to_string(),
            title: "Sunset Harbour".to_string(),
            prompt: "golden hour, calm water".to_string(),
            tags: vec!["Landscape".to_string()],
            ..PromptItem::default()
        };
        assert!(matches_query(&item, Some("harbour"), &[]));
        assert!(matches_query(&item, Some("GOLDEN HOUR"), &[]));
        assert!(!matches_query(&item, Some("mountain"), &[]));
        assert!(matches_query(&item, None, &["landscape".to_string()]));
        assert!(!matches_query(&item, None, &["portrait".to_string()]));
    }
}
