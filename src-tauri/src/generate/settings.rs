//! Moving the whole configuration between machines.
//!
//! The document this module writes is `models.json` without its revision and
//! with credentials, when asked for, sealed under a passphrase. Everything the
//! form in Settings can edit travels: every model of every category, disabled
//! ones included, with their scenes, sub-models, and protocol parameters;
//! the per-capability defaults; and the generation preferences.
//!
//! An import is previewed before it is applied. The preview validates the same
//! document the apply will, reports what it would add, overwrite, or remove,
//! and digests the exact bytes so a file changed after the preview is refused
//! rather than applied under an old description.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::domain::{now_iso, Capability, IsoTimestamp};
use crate::metadata::portable::{self, SealedSecrets};
use crate::metadata::{
    Defaults, ImportedKey, ImportedSettings, MetadataError, ModelConfig, ModelDraft, Preferences,
};

use super::models::{validate_preferences, ModelRepo, ModelsView};

/// Marks a file as this program's configuration rather than any JSON.
pub const DOCUMENT_FORMAT: &str = "moka-canvas.settings";

/// The document version this build writes and reads.
pub const DOCUMENT_VERSION: u32 = 1;

/// The largest file this program will read. A configuration that exceeds it is
/// a mistake, and the ceiling keeps a preview from reading a disk image as one.
pub const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;

/// The most models one file may name. This is a protective bound, not a
/// product limit on how many models a machine may configure.
pub const MAX_MODELS: usize = 4_096;

/// The shortest passphrase an export accepts.
pub const MIN_PASSPHRASE_CHARS: usize = 12;

/// The longest passphrase accepted, in bytes. Beyond this the input is a file,
/// not something somebody is going to retype.
pub const MAX_PASSPHRASE_BYTES: usize = 4_096;

/// The exported configuration. Credentials are absent unless the reader asked
/// for them and set a passphrase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDocument {
    pub format: String,
    pub version: u32,
    pub app_version: String,
    pub exported_at: IsoTimestamp,
    pub models: Vec<ModelConfig>,
    pub defaults: Defaults,
    pub preferences: Preferences,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<SealedSecrets>,
}

/// How an import treats what is already configured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// Same identifiers take the file's configuration; local-only models stay.
    Merge,
    /// Only the file's models remain; the others and their credentials go.
    Replace,
}

/// One model, told apart well enough for a preview list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub id: String,
    pub display_name: String,
    pub category: Capability,
}

/// What a preview found, before anything is written.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPreview {
    /// SHA-256 of the exact bytes previewed; an apply carries it back so a
    /// file edited in between is refused.
    pub digest: String,
    /// The configuration revision the preview looked at. The apply carries it
    /// back so a change made after the preview is refused rather than silently
    /// overwritten, without trusting the revision the window opened with.
    pub revision: u64,
    pub format: String,
    pub version: u32,
    pub app_version: String,
    pub exported_at: IsoTimestamp,
    pub models: usize,
    /// Models the file adds, and existing ones it would overwrite.
    pub added: usize,
    pub conflicts: Vec<ModelSummary>,
    /// Models configured here that the file does not name. A replace import
    /// drops these and their credentials.
    pub local_only: Vec<ModelSummary>,
    /// Model counts by capability, keyed by the wire word.
    pub by_category: BTreeMap<String, usize>,
    /// How many credentials the file carries; they are encrypted, so the
    /// preview says how many without opening them.
    pub secrets: usize,
}

/// What an applied import changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsImportReport {
    pub added: usize,
    pub replaced: usize,
    pub removed: usize,
    pub keys_stored: usize,
    pub keys_removed: usize,
    /// Set when the configuration was written but the credentials were not.
    /// The reason is shown; the models are already in place.
    pub key_failure: Option<String>,
}

/// The configuration document checks out and is ready to write.
pub struct PreparedSettings {
    pub models: Vec<ModelConfig>,
    pub defaults: Defaults,
    pub preferences: Preferences,
}

/// A configuration file that cannot be imported, with the reason a reader can
/// act on.
#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("{0}")]
    FileInvalid(String),
    #[error(
        "the configuration file is version {found}, newer than this build, which reads version {supported}"
    )]
    VersionUnsupported { found: u32, supported: u32 },
    #[error("model configuration {model} cannot be imported: {reason}")]
    ModelInvalid { model: String, reason: String },
    #[error("the {capability} default cannot be imported: {reason}")]
    DefaultsInvalid {
        capability: &'static str,
        reference: String,
        reason: String,
    },
    #[error("{0}")]
    PassphraseRequired(String),
    #[error("{0}")]
    PassphraseInvalid(String),
    #[error("{0}")]
    FileReadFailed(String),
    #[error("the configuration file is {bytes} bytes, above the {limit} byte limit")]
    FileTooLarge { bytes: usize, limit: usize },
    #[error("the configuration file changed since it was previewed")]
    FileChanged,
    #[error(transparent)]
    Storage(#[from] MetadataError),
}

impl SettingsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::FileInvalid(_) => "SETTINGS_FILE_INVALID",
            Self::VersionUnsupported { .. } => "SETTINGS_VERSION_UNSUPPORTED",
            Self::ModelInvalid { .. } => "SETTINGS_MODEL_INVALID",
            Self::DefaultsInvalid { .. } => "SETTINGS_DEFAULTS_INVALID",
            Self::PassphraseRequired(_) => "SETTINGS_PASSPHRASE_REQUIRED",
            Self::PassphraseInvalid(_) => "SETTINGS_PASSPHRASE_INVALID",
            Self::FileReadFailed(_) => "SETTINGS_FILE_READ_FAILED",
            Self::FileTooLarge { .. } => "SETTINGS_FILE_TOO_LARGE",
            Self::FileChanged => "SETTINGS_FILE_CHANGED",
            Self::Storage(error) => error.code(),
        }
    }

    /// The structured fields a Chinese message reads. Never a passphrase.
    pub fn details(&self) -> Option<serde_json::Value> {
        match self {
            Self::VersionUnsupported { found, supported } => Some(serde_json::json!({
                "found": found,
                "supported": supported,
            })),
            Self::ModelInvalid { model, reason } => Some(serde_json::json!({
                "model": model,
                "reason": reason,
            })),
            Self::DefaultsInvalid {
                capability,
                reference,
                reason,
            } => Some(serde_json::json!({
                "capability": capability,
                "reference": reference,
                "reason": reason,
            })),
            Self::FileTooLarge { bytes, limit } => Some(serde_json::json!({
                "bytes": bytes,
                "limit": limit,
            })),
            _ => None,
        }
    }
}

/// The digest an apply carries back, over the exact bytes previewed.
pub fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Reads one document and checks everything that does not depend on what is
/// already configured.
pub fn parse_document(bytes: &[u8]) -> Result<SettingsDocument, SettingsError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(SettingsError::FileTooLarge {
            bytes: bytes.len(),
            limit: MAX_FILE_BYTES,
        });
    }
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| SettingsError::FileInvalid(format!("not valid JSON: {error}")))?;
    // A key field has no business in a model configuration. Refusing it is
    // kinder than silently dropping a credential a hand-edited file thought
    // it was carrying.
    if let Some(models) = value.get("models").and_then(serde_json::Value::as_array) {
        for model in models {
            if model.get("apiKey").is_some_and(|value| !value.is_null()) {
                return Err(SettingsError::FileInvalid(
                    "model configurations in this file carry an apiKey field; \
                     export again with the encrypted credentials option instead"
                        .to_string(),
                ));
            }
        }
    }
    let document: SettingsDocument = serde_json::from_value(value)
        .map_err(|error| SettingsError::FileInvalid(error.to_string()))?;
    if document.format != DOCUMENT_FORMAT {
        return Err(SettingsError::FileInvalid(format!(
            "this is not a Moka Canvas configuration (format {:?})",
            document.format
        )));
    }
    if document.version > DOCUMENT_VERSION {
        return Err(SettingsError::VersionUnsupported {
            found: document.version,
            supported: DOCUMENT_VERSION,
        });
    }
    if document.version == 0 {
        return Err(SettingsError::FileInvalid(
            "the configuration file names no version".to_string(),
        ));
    }
    if document.models.len() > MAX_MODELS {
        return Err(SettingsError::FileInvalid(format!(
            "the file names {} models; at most {MAX_MODELS} are imported at once",
            document.models.len()
        )));
    }
    if let Some(credentials) = &document.credentials {
        portable::validate(credentials)?;
        if credentials.count > document.models.len() {
            return Err(SettingsError::FileInvalid(
                "the file carries more credentials than model configurations".to_string(),
            ));
        }
    }
    Ok(document)
}

impl ModelRepo {
    /// Builds the document an export writes, and says how many credentials it
    /// sealed.
    pub async fn export_settings(
        &self,
        include_keys: bool,
        passphrase: Option<&str>,
    ) -> Result<(SettingsDocument, usize), SettingsError> {
        let snapshot = self.metadata.models_snapshot().await?;
        let mut key_count = 0;
        let mut credentials = None;
        if include_keys {
            let passphrase = require_export_passphrase(passphrase)?;
            let mut keys = BTreeMap::new();
            for model in &snapshot.models {
                if let Some(key) = self.metadata.get_secret(&model.id).await? {
                    keys.insert(model.id.clone(), key);
                }
            }
            key_count = keys.len();
            if key_count > 0 {
                let plaintext = serde_json::to_string(&keys).map_err(|error| {
                    SettingsError::FileInvalid(format!(
                        "the credentials could not be serialized: {error}"
                    ))
                })?;
                let passphrase = passphrase.to_string();
                credentials = Some(
                    tokio::task::spawn_blocking(move || {
                        portable::seal(&passphrase, key_count, &plaintext)
                    })
                    .await
                    .map_err(|error| {
                        SettingsError::PassphraseInvalid(format!(
                            "sealing the credentials was cancelled: {error}"
                        ))
                    })??,
                );
            }
        }
        Ok((
            SettingsDocument {
                format: DOCUMENT_FORMAT.to_string(),
                version: DOCUMENT_VERSION,
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                exported_at: now_iso(),
                models: snapshot.models,
                defaults: snapshot.defaults,
                preferences: snapshot.preferences,
                credentials,
            },
            key_count,
        ))
    }

    /// Validates a document and describes what applying it would do.
    pub async fn preview_settings(
        &self,
        bytes: &[u8],
        mode: ImportMode,
    ) -> Result<SettingsPreview, SettingsError> {
        let document = parse_document(bytes)?;
        let prepared = self.prepare_settings(&document, mode).await?;
        let local = self.metadata.models_snapshot().await?;
        let local_by_id: HashMap<&str, &ModelConfig> = local
            .models
            .iter()
            .map(|model| (model.id.as_str(), model))
            .collect();
        let imported_ids: HashSet<&str> = prepared
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect();

        let mut conflicts = Vec::new();
        let mut added = 0;
        for model in &prepared.models {
            if local_by_id.contains_key(model.id.as_str()) {
                conflicts.push(summary(model));
            } else {
                added += 1;
            }
        }
        let local_only = local
            .models
            .iter()
            .filter(|model| !imported_ids.contains(model.id.as_str()))
            .map(summary)
            .collect();

        let mut by_category: BTreeMap<String, usize> = BTreeMap::new();
        for model in &prepared.models {
            *by_category
                .entry(model.category.as_str().to_string())
                .or_insert(0) += 1;
        }

        Ok(SettingsPreview {
            digest: digest(bytes),
            revision: local.revision,
            format: document.format,
            version: document.version,
            app_version: document.app_version,
            exported_at: document.exported_at,
            models: prepared.models.len(),
            added,
            conflicts,
            local_only,
            by_category,
            secrets: document
                .credentials
                .as_ref()
                .map(|credentials| credentials.count)
                .unwrap_or(0),
        })
    }

    /// Applies a document that was previewed, returning the new view and what
    /// changed.
    pub async fn import_settings(
        &self,
        bytes: &[u8],
        mode: ImportMode,
        include_keys: bool,
        passphrase: Option<&str>,
        expected_revision: Option<u64>,
    ) -> Result<(ModelsView, SettingsImportReport), SettingsError> {
        let document = parse_document(bytes)?;
        let prepared = self.prepare_settings(&document, mode).await?;

        let mut keys = Vec::new();
        if include_keys {
            if let Some(sealed) = &document.credentials {
                let passphrase = require_import_passphrase(passphrase)?;
                let passphrase = passphrase.to_string();
                let sealed = sealed.clone();
                let plaintext =
                    tokio::task::spawn_blocking(move || portable::open(&passphrase, &sealed))
                        .await
                        .map_err(|error| {
                            SettingsError::PassphraseInvalid(format!(
                                "opening the credentials was cancelled: {error}"
                            ))
                        })?
                        .map_err(|_| {
                            SettingsError::PassphraseInvalid(
                        "the passphrase does not open this file, or its credentials are damaged"
                            .to_string(),
                    )
                        })?;
                let stored: BTreeMap<String, String> =
                    serde_json::from_str(&plaintext).map_err(|error| {
                        SettingsError::FileInvalid(format!(
                            "the credentials are not a model-to-key map: {error}"
                        ))
                    })?;
                if stored.len() > portable::MAX_ENTRIES {
                    return Err(SettingsError::FileInvalid(format!(
                        "the file carries {} credentials; at most {} are imported at once",
                        stored.len(),
                        portable::MAX_ENTRIES
                    )));
                }
                let known: HashSet<&str> = prepared
                    .models
                    .iter()
                    .map(|model| model.id.as_str())
                    .collect();
                for (model_id, key) in stored {
                    if !known.contains(model_id.as_str()) {
                        return Err(SettingsError::FileInvalid(format!(
                            "a credential names model configuration {model_id}, which is not in the file"
                        )));
                    }
                    if key.is_empty() {
                        return Err(SettingsError::FileInvalid(format!(
                            "the credential for {model_id} is empty"
                        )));
                    }
                    if key.len() > 8_192 {
                        return Err(SettingsError::FileInvalid(format!(
                            "the credential for {model_id} is longer than any API key"
                        )));
                    }
                    keys.push(ImportedKey {
                        model_id,
                        api_key: key,
                    });
                }
            }
        }

        let outcome = self
            .metadata
            .import_settings(
                ImportedSettings {
                    models: prepared.models,
                    defaults: prepared.defaults,
                    preferences: prepared.preferences,
                    replace: mode == ImportMode::Replace,
                    keys,
                },
                expected_revision,
            )
            .await?;
        let view = self.view().await.map_err(|error| {
            SettingsError::Storage(MetadataError::unavailable(format!(
                "the imported configuration could not be read back: {error}"
            )))
        })?;
        Ok((
            view,
            SettingsImportReport {
                added: outcome.added,
                replaced: outcome.replaced,
                removed: outcome.removed,
                keys_stored: outcome.keys_stored,
                keys_removed: outcome.keys_removed,
                key_failure: outcome.key_failure,
            },
        ))
    }

    /// The validation an import and its preview share.
    async fn prepare_settings(
        &self,
        document: &SettingsDocument,
        mode: ImportMode,
    ) -> Result<PreparedSettings, SettingsError> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut models = Vec::with_capacity(document.models.len());
        for model in &document.models {
            let draft = ModelDraft {
                id: model.id.clone(),
                category: model.category,
                protocol: model.protocol.clone(),
                url: model.url.clone(),
                model: model.model.clone(),
                display_name: model.display_name.clone(),
                max_video_seconds: model.max_video_seconds,
                reasoning_effort: model.reasoning_effort.clone(),
                max_tokens: model.max_tokens,
                temperature: model.temperature,
                params: model.params.clone(),
                scenes: model.scenes.clone(),
                sub_models: model.sub_models.clone(),
                enabled: model.enabled,
                expected_revision: None,
            };
            let draft =
                self.validate_draft(draft)
                    .await
                    .map_err(|error| SettingsError::ModelInvalid {
                        model: model.id.clone(),
                        reason: error.to_string(),
                    })?;
            if !seen.insert(draft.id.clone()) {
                return Err(SettingsError::FileInvalid(format!(
                    "the file names model configuration {} twice",
                    draft.id
                )));
            }
            models.push(ModelConfig {
                id: draft.id,
                category: draft.category,
                protocol: draft.protocol,
                url: draft.url,
                model: draft.model,
                display_name: draft.display_name,
                max_video_seconds: draft.max_video_seconds,
                reasoning_effort: draft.reasoning_effort,
                max_tokens: draft.max_tokens,
                temperature: draft.temperature,
                params: draft.params,
                scenes: draft.scenes,
                sub_models: draft.sub_models,
                enabled: draft.enabled,
            });
        }

        let local = self.metadata.models_snapshot().await?;
        let mut final_categories: HashMap<String, Capability> = if mode == ImportMode::Replace {
            HashMap::new()
        } else {
            local
                .models
                .iter()
                .map(|model| (model.id.clone(), model.category))
                .collect()
        };
        for model in &models {
            final_categories.insert(model.id.clone(), model.category);
        }
        let defaults = normalize_defaults(&document.defaults, &final_categories)?;
        validate_preferences(&document.preferences).map_err(|error| {
            SettingsError::FileInvalid(format!("generation preferences: {error}"))
        })?;

        Ok(PreparedSettings {
            models,
            defaults,
            preferences: document.preferences.clone(),
        })
    }
}

fn summary(model: &ModelConfig) -> ModelSummary {
    ModelSummary {
        id: model.id.clone(),
        display_name: model.display_name.clone(),
        category: model.category,
    }
}

fn normalize_defaults(
    defaults: &Defaults,
    categories: &HashMap<String, Capability>,
) -> Result<Defaults, SettingsError> {
    let mut normalized = defaults.clone();
    for (capability, slot) in [
        (Capability::Text, &mut normalized.text),
        (Capability::Image, &mut normalized.image),
        (Capability::Speech, &mut normalized.speech),
        (Capability::Music, &mut normalized.music),
        (Capability::Video, &mut normalized.video),
        (Capability::Asr, &mut normalized.asr),
    ] {
        let Some(reference) = slot.as_mut() else {
            continue;
        };
        let trimmed = reference.trim().to_string();
        if trimmed.is_empty() {
            *slot = None;
            continue;
        }
        let found = categories
            .get(&trimmed)
            .ok_or_else(|| SettingsError::DefaultsInvalid {
                capability: capability.as_str(),
                reference: trimmed.clone(),
                reason: "no model configuration by that name is in the file or on this machine"
                    .to_string(),
            })?;
        if *found != capability {
            return Err(SettingsError::DefaultsInvalid {
                capability: capability.as_str(),
                reference: trimmed,
                reason: format!("it generates {}", found.as_str()),
            });
        }
        *slot = Some(trimmed);
    }
    Ok(normalized)
}

fn require_export_passphrase(passphrase: Option<&str>) -> Result<&str, SettingsError> {
    let passphrase = passphrase.unwrap_or("");
    if passphrase.is_empty() {
        return Err(SettingsError::PassphraseRequired(
            "a passphrase is required to include API keys".to_string(),
        ));
    }
    if passphrase.len() > MAX_PASSPHRASE_BYTES {
        return Err(SettingsError::PassphraseRequired(format!(
            "the passphrase must be at most {MAX_PASSPHRASE_BYTES} bytes"
        )));
    }
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(SettingsError::PassphraseRequired(format!(
            "the passphrase must be at least {MIN_PASSPHRASE_CHARS} characters"
        )));
    }
    Ok(passphrase)
}

fn require_import_passphrase(passphrase: Option<&str>) -> Result<&str, SettingsError> {
    let passphrase = passphrase.unwrap_or("");
    if passphrase.is_empty() {
        return Err(SettingsError::PassphraseRequired(
            "this file carries encrypted API keys; enter the passphrase it was exported with"
                .to_string(),
        ));
    }
    if passphrase.len() > MAX_PASSPHRASE_BYTES {
        return Err(SettingsError::PassphraseRequired(format!(
            "the passphrase must be at most {MAX_PASSPHRASE_BYTES} bytes"
        )));
    }
    Ok(passphrase)
}
