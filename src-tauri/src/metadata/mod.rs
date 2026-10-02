//! Application-level metadata: recent projects, model configurations, encrypted
//! credentials, global preferences, and the prompt library cache.
//!
//! [`MetadataStore`] is the only way in or out. Callers receive domain types
//! and never a path, a file handle, or a JSON document, so a future database
//! backend can be dropped in without touching them. Today the single
//! implementation is [`store::FileMetadataStore`], which keeps an in-memory
//! snapshot and publishes it only after a durable write.
//!
//! Metadata lives in the operating system's application data directory, never
//! in a project directory: a project must stay copyable as a whole folder.

pub mod contract;
pub mod crypto;
pub mod docs;
pub mod fs;
pub mod paths;
pub mod redact;
pub mod store;
pub mod types;

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use thiserror::Error;

pub use types::{
    Defaults, DocumentInfo, ImagePreferences, MetadataInfo, MetadataStoreKind, ModelConfig,
    ModelDraft, ModelRecord, ModelsSnapshot, MusicPreferences, Preferences, PromptItem, PromptPage,
    PromptQuery, PromptSource, Protocol, RecentProject, Scene, SecretInfo, SecretStorage,
    SpeechPreferences, StoryPreferences, SubModel, VideoPreferences, MAX_PROMPT_ITEMS_PER_SOURCE,
    MAX_RECENT, MAX_SEARCH_PAGE_SIZE,
};

use crate::config::{MetadataConfig, RuntimeMode};

/// The only implemented backend.
pub const FILE_STORE: &str = "file";

/// The one document format version this build reads, recorded in `meta.json`.
///
/// There are no upgrades between versions: a directory stamped otherwise is
/// refused at startup with the directory and the schema it holds named, and
/// starting fresh means setting the directory aside.
pub const SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Error)]
pub enum MetadataError {
    #[error("metadata store is unavailable: {0}")]
    Unavailable(String),
    #[error("metadata could not be written: {0}")]
    WriteFailed(String),
    #[error(
        "the metadata directory {} was written by schema version {found}; \
         this build reads version {expected} and does not migrate, \
         so set it aside to start fresh",
        dir.display()
    )]
    SchemaUnsupported {
        dir: std::path::PathBuf,
        found: u32,
        expected: u32,
    },
    #[error(
        "{document} changed underneath this request (expected revision {expected}, found {actual})"
    )]
    Conflict {
        document: &'static str,
        expected: u64,
        actual: u64,
    },
    #[error("no master key protects stored credentials: {0}")]
    KeyMissing(String),
    #[error("stored credential could not be read: {0}")]
    SecretUnreadable(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl MetadataError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::Unavailable(message.into())
    }

    pub fn write_failed(message: impl Into<String>) -> Self {
        Self::WriteFailed(message.into())
    }

    pub fn schema_unsupported(dir: &Path, found: u32, expected: u32) -> Self {
        Self::SchemaUnsupported {
            dir: dir.to_path_buf(),
            found,
            expected,
        }
    }

    pub fn key_missing(message: impl Into<String>) -> Self {
        Self::KeyMissing(message.into())
    }

    pub fn secret_unreadable(message: impl Into<String>) -> Self {
        Self::SecretUnreadable(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub fn conflict(document: &'static str, expected: u64, actual: u64) -> Self {
        Self::Conflict {
            document,
            expected,
            actual,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Conflict { .. } => "METADATA_CONFLICT",
            Self::WriteFailed(_) => "METADATA_WRITE_FAILED",
            Self::SchemaUnsupported { .. } => "METADATA_SCHEMA_UNSUPPORTED",
            Self::KeyMissing(_) => "CONFIG_METADATA_KEY_MISSING",
            Self::Unavailable(_) | Self::SecretUnreadable(_) => "METADATA_UNAVAILABLE",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Invalid(_) => "VALIDATION_FAILED",
            Self::Io(_) => "INTERNAL",
        }
    }

    /// True when retrying the same request could plausibly succeed, which is
    /// the case for everything rooted in the filesystem rather than the
    /// request itself.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Unavailable(_) | Self::WriteFailed(_) | Self::Io(_) | Self::SecretUnreadable(_)
        )
    }
}

/// The single read/write interface for application metadata.
///
/// Portability constraints that any backend must satisfy — see
/// [`contract`] for the tests that enforce them:
///
/// 1. Atomicity is per method. There is no cross-method transaction; an
///    operation that must change two documents is one method.
/// 2. There is no general key/value escape hatch. `defaults` and
///    `preferences` are domain fields, not opaque JSON.
/// 3. Methods return domain types. No path, file handle, or document value
///    crosses this boundary, except the diagnostic [`MetadataInfo`].
/// 4. A write that reaches storage and fails says so. Nothing is allowed to
///    update memory and swallow the disk error.
#[async_trait]
pub trait MetadataStore: Send + Sync {
    /// Recent projects, most recently opened first.
    async fn list_recent(&self) -> Result<Vec<RecentProject>, MetadataError>;

    /// Inserts or replaces by path, keeping the list at [`MAX_RECENT`].
    async fn upsert_recent(&self, project: &RecentProject) -> Result<(), MetadataError>;

    async fn remove_recent(&self, id: &str) -> Result<(), MetadataError>;

    /// Model configuration without any credential.
    async fn models_snapshot(&self) -> Result<ModelsSnapshot, MetadataError>;

    /// Replaces one whole model configuration, so a partially updated model
    /// cannot exist.
    async fn upsert_model(&self, draft: &ModelDraft) -> Result<ModelRecord, MetadataError>;

    /// Removes a model configuration and its stored credential in one
    /// operation.
    async fn delete_model(
        &self,
        id: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), MetadataError>;

    async fn set_defaults(
        &self,
        defaults: &Defaults,
        expected_revision: Option<u64>,
    ) -> Result<(), MetadataError>;

    async fn set_preferences(
        &self,
        preferences: &Preferences,
        expected_revision: Option<u64>,
    ) -> Result<(), MetadataError>;

    /// Stores a credential, replacing any previous one for the model.
    async fn put_secret(&self, model_id: &str, key: &str) -> Result<SecretInfo, MetadataError>;

    /// The plaintext credential, fetched at the last moment before a request.
    async fn get_secret(&self, model_id: &str) -> Result<Option<String>, MetadataError>;

    /// Clears a credential but keeps the model configuration.
    async fn delete_secret(&self, model_id: &str) -> Result<(), MetadataError>;

    /// Disclosable state of a credential: masked value, fingerprint, and when
    /// it was last rotated.
    async fn secret_state(&self, model_id: &str) -> Result<Option<SecretInfo>, MetadataError>;

    /// Moves the master key protecting the stored credentials between the
    /// file tier and the OS keychain, and reports where it ended up. The
    /// credentials themselves are untouched: the key that opens them is the
    /// same key in either home.
    async fn set_secret_storage(
        &self,
        target: SecretStorage,
    ) -> Result<SecretStorage, MetadataError>;

    async fn list_prompt_sources(&self) -> Result<Vec<PromptSource>, MetadataError>;

    async fn upsert_prompt_source(&self, source: &PromptSource) -> Result<(), MetadataError>;

    /// Removes a source and its cached entries.
    async fn delete_prompt_source(&self, id: &str) -> Result<(), MetadataError>;

    /// Replaces a source's whole entry cache in one atomic write.
    async fn replace_prompt_items(
        &self,
        source_id: &str,
        items: &[PromptItem],
    ) -> Result<(), MetadataError>;

    /// Case-insensitive search across enabled sources, paginated.
    async fn search_prompts(&self, query: &PromptQuery) -> Result<PromptPage, MetadataError>;

    /// Runs the full write protocol against a scratch file. The readiness
    /// probe uses this so a read-only disk is reported instead of silently
    /// dropping later writes.
    async fn probe_write(&self) -> Result<(), MetadataError>;

    /// Diagnostics for `/api/health`. Paths are redacted.
    async fn info(&self) -> MetadataInfo;
}

/// Opens the metadata directory: takes the cross-process lock, clears crash
/// leftovers, creates the documents, and loads the snapshot.
///
/// Must complete before the HTTP server binds, so an unusable configuration
/// directory fails startup instead of degrading into an app that appears to
/// work but saves nothing.
pub fn open(
    root: &Path,
    config: &MetadataConfig,
    mode: RuntimeMode,
) -> Result<Arc<store::FileMetadataStore>, MetadataError> {
    store::FileMetadataStore::open(root, config, mode).map(Arc::new)
}
