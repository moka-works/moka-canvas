//! Credentials at rest: AES-256-GCM sealed with the owning id (a model configuration) as additional
//! authenticated data, plus resolution of the master key that protects them.
//!
//! Binding the owning id (a model configuration) into the AAD means ciphertext copied from one
//! owner's entry into another's will not open. That is a mistake-resistance
//! measure, not a defence against a process that can already read this
//! directory: such a process can read `master.key` too when the OS keychain is
//! unavailable. What encryption buys here is that no plaintext key appears on
//! disk, in a backup, in a synced folder, or in a log.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use super::{MetadataError, SecretStorage};
use crate::config::RuntimeMode;
use crate::fs;
use crate::paths::APP_ID;

/// Base64-encoded 32-byte master key. The server-mode source of truth, because
/// a server has no desktop session and therefore no keychain to ask. Optional:
/// when it is absent, the first credential stored creates a file-held key
/// instead — see [`KeyProvider::acquire`].
pub const KEY_ENV: &str = "MOKA_METADATA_KEY";

/// Keychain account holding the master key in desktop mode.
pub const KEYRING_ACCOUNT: &str = "metadata-master-key";

/// Fallback location when the OS keychain is unavailable.
pub const MASTER_KEY_FILE: &str = "master.key";

/// Records the tier new master keys are created in. Switching tiers is an
/// explicit act; nothing migrates on its own.
pub const STORAGE_PREF_FILE: &str = "keystore.json";

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// Seals a credential. The output is base64 of `nonce || ciphertext`.
pub fn seal(key: &[u8; KEY_LEN], owner_id: &str, plaintext: &str) -> Result<String, MetadataError> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| MetadataError::unavailable("cipher"))?;
    let payload = Payload {
        msg: plaintext.as_bytes(),
        aad: owner_id.as_bytes(),
    };
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), payload)
        .map_err(|_| MetadataError::write_failed("credential could not be sealed"))?;
    let mut combined = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(combined))
}

/// Opens a credential sealed by [`seal`].
pub fn open(
    key: &[u8; KEY_LEN],
    owner_id: &str,
    cipher_text: &str,
) -> Result<String, MetadataError> {
    let combined = base64::engine::general_purpose::STANDARD
        .decode(cipher_text)
        .map_err(|_| MetadataError::secret_unreadable("credential is not valid base64"))?;
    if combined.len() < NONCE_LEN {
        return Err(MetadataError::secret_unreadable("credential is truncated"));
    }
    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_LEN);
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| MetadataError::unavailable("cipher"))?;
    let payload = Payload {
        msg: ciphertext,
        aad: owner_id.as_bytes(),
    };
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), payload)
        .map_err(|_| {
            MetadataError::secret_unreadable(
                "credential does not match this owner or the current master key",
            )
        })?;
    String::from_utf8(plaintext)
        .map_err(|_| MetadataError::secret_unreadable("credential is not valid text"))
}

/// Resolves and caches the master key for one metadata directory.
pub struct KeyProvider {
    root: PathBuf,
    mode: RuntimeMode,
    cached: Mutex<Option<MasterKey>>,
}

#[derive(Clone)]
pub struct MasterKey {
    bytes: [u8; KEY_LEN],
    storage: SecretStorage,
}

/// Deliberately hand-written: a derived `Debug` would print the key bytes into
/// a panic message or a log line.
impl std::fmt::Debug for MasterKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MasterKey")
            .field("storage", &self.storage)
            .finish_non_exhaustive()
    }
}

impl MasterKey {
    pub fn bytes(&self) -> &[u8; KEY_LEN] {
        &self.bytes
    }

    pub fn storage(&self) -> SecretStorage {
        self.storage
    }
}

impl KeyProvider {
    pub fn new(root: &Path, mode: RuntimeMode) -> Self {
        Self {
            root: root.to_path_buf(),
            mode,
            cached: Mutex::new(None),
        }
    }

    /// Startup check: refuse to come up holding ciphertext that cannot be
    /// opened, which would otherwise look like "configured" and fail every
    /// request with an authentication error.
    pub fn probe(&self, secrets_present: bool) -> Result<(), MetadataError> {
        if self.find_existing()?.is_some() {
            return Ok(());
        }
        if secrets_present {
            return Err(MetadataError::key_missing(match self.mode {
                RuntimeMode::Native => format!(
                    "no master key is available for {}; the OS keychain entry and {} are both absent",
                    APP_ID,
                    self.master_key_path().display()
                ),
                RuntimeMode::Web => format!(
                    "{KEY_ENV} is not set and {} is absent, but stored credentials \
                     exist; supply the key that sealed them. A key generated now \
                     would open none of them",
                    self.master_key_path().display()
                ),
            }));
        }
        Ok(())
    }

    /// Returns the master key, creating and persisting one on first use in
    /// the preferred tier — the file tier unless an explicit switch asked for
    /// the OS keychain.
    ///
    /// Blocking: consults the OS keychain. Call it through
    /// `tokio::task::spawn_blocking`.
    ///
    /// A key is only ever created where no ciphertext exists yet: [`probe`]
    /// refuses to start a server holding credentials it cannot open, so this
    /// never runs against a directory whose key was lost.
    pub fn acquire(&self) -> Result<MasterKey, MetadataError> {
        if let Some(existing) = self.find_existing()? {
            return Ok(existing);
        }
        let generated = generate();
        if self.preference() == SecretStorage::Keyring {
            match self.store_in_keyring(&generated) {
                Ok(()) => {
                    return self.cache(MasterKey {
                        bytes: generated,
                        storage: SecretStorage::Keyring,
                    })
                }
                Err(keyring_error) => tracing::warn!(
                    target: "moka::metadata",
                    error = %keyring_error,
                    "OS keychain unavailable; falling back to a file-held master key"
                ),
            }
        } else if self.mode != RuntimeMode::Native {
            // Refusing here instead would leave a server started without an
            // exported key unable to store a credential at all, and the refusal
            // would surface only when someone typed an API key in. The file tier
            // is the default everywhere; it is weaker than an exported key, so
            // say so rather than letting it look equivalent.
            tracing::warn!(
                target: "moka::metadata",
                path = %self.master_key_path().display(),
                "{KEY_ENV} is not set and a server has no OS keychain; storing a \
                 file-held master key beside the credentials it protects. Whatever \
                 can read this directory can read it, and a backup of the directory \
                 carries it: export a key for a deployment meant to outlive this one"
            );
        }
        self.write_master_key_file(&generated)?;
        self.cache(MasterKey {
            bytes: generated,
            storage: SecretStorage::File,
        })
    }

    /// Where the master key currently comes from, without creating one.
    pub fn storage(&self) -> SecretStorage {
        if let Ok(Some(key)) = self.cached.lock().map(|guard| guard.clone()) {
            return key.storage;
        }
        self.find_existing()
            .ok()
            .flatten()
            .map(|key| key.storage)
            .unwrap_or(SecretStorage::Unset)
    }

    /// Whether the OS keychain is a tier this runtime can offer. macOS and
    /// Windows desktop builds have a trustworthy native store; everywhere
    /// else the file tier is the only choice.
    pub fn keyring_supported(&self) -> bool {
        self.mode == RuntimeMode::Native
            && (cfg!(target_os = "macos") || cfg!(target_os = "windows"))
    }

    /// The tiers this runtime can offer: the file tier always, and the OS
    /// keychain where a trustworthy native store exists.
    pub fn storage_options(&self) -> Vec<SecretStorage> {
        let mut options = vec![SecretStorage::File];
        if self.keyring_supported() {
            options.push(SecretStorage::Keyring);
        }
        options
    }

    /// The tier new master keys are created in: the persisted choice when it
    /// names a tier this runtime can offer, and the file tier otherwise.
    pub fn preference(&self) -> SecretStorage {
        let Ok(raw) = std::fs::read_to_string(self.root.join(STORAGE_PREF_FILE)) else {
            return SecretStorage::File;
        };
        match serde_json::from_str::<StoragePref>(&raw) {
            Ok(pref) if pref.storage == SecretStorage::Keyring && self.keyring_supported() => {
                SecretStorage::Keyring
            }
            _ => SecretStorage::File,
        }
    }

    /// Moves the master key protecting the stored credentials between the
    /// file tier and the OS keychain. The key itself does not change, so
    /// existing ciphertext keeps opening; only its home moves. This is the
    /// only migration there is: startup resolves whichever tier holds the
    /// key and moves nothing.
    ///
    /// Blocking: consults the OS keychain. Call it through
    /// `tokio::task::spawn_blocking`.
    pub fn switch_storage(&self, target: SecretStorage) -> Result<SecretStorage, MetadataError> {
        if target != SecretStorage::File && target != SecretStorage::Keyring {
            return Err(MetadataError::invalid(
                "secret storage can only be switched to file or keyring",
            ));
        }
        if self.env_key()?.is_some() {
            return Err(MetadataError::invalid(format!(
                "{KEY_ENV} is set; the exported key takes precedence and cannot be moved"
            )));
        }
        if target == SecretStorage::Keyring && !self.keyring_supported() {
            return Err(MetadataError::unavailable(
                "the OS keychain is not available in this runtime",
            ));
        }
        let Some(current) = self.find_existing()? else {
            // Nothing is stored yet: record the choice so the first
            // credential creates its key there.
            self.write_pref(target)?;
            return Ok(self.storage());
        };
        if current.storage() != target {
            match target {
                SecretStorage::Keyring => {
                    self.store_in_keyring(current.bytes()).map_err(|error| {
                        MetadataError::unavailable(format!(
                            "the OS keychain refused the master key: {error}"
                        ))
                    })?;
                    if let Err(error) = std::fs::remove_file(self.master_key_path()) {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            return Err(MetadataError::write_failed(format!(
                                "{} could not be removed: {error}",
                                self.master_key_path().display()
                            )));
                        }
                    }
                }
                _ => {
                    self.write_master_key_file(current.bytes())?;
                    self.clear_keyring();
                }
            }
        }
        self.write_pref(target)?;
        self.cache(MasterKey {
            bytes: *current.bytes(),
            storage: target,
        })?;
        Ok(target)
    }

    fn clear_keyring(&self) {
        if let Ok(entry) = keyring::Entry::new(APP_ID, KEYRING_ACCOUNT) {
            if let Err(error) = entry.delete_credential() {
                tracing::warn!(
                    target: "moka::metadata",
                    error = %error,
                    "the keychain entry could not be removed"
                );
            }
        }
    }

    fn write_pref(&self, storage: SecretStorage) -> Result<(), MetadataError> {
        let bytes = serde_json::to_vec_pretty(&StoragePref { storage })
            .map_err(|error| MetadataError::write_failed(error.to_string()))?;
        fs::atomic_write(
            &self.root,
            &self.root.join(STORAGE_PREF_FILE),
            &bytes,
            fs::DOCUMENT_MODE,
        )
        .map_err(|error| {
            MetadataError::write_failed(format!(
                "the storage preference could not be stored: {error}"
            ))
        })
    }

    fn cache(&self, key: MasterKey) -> Result<MasterKey, MetadataError> {
        if let Ok(mut guard) = self.cached.lock() {
            *guard = Some(key.clone());
        }
        Ok(key)
    }

    fn find_existing(&self) -> Result<Option<MasterKey>, MetadataError> {
        if let Ok(guard) = self.cached.lock() {
            if let Some(key) = guard.clone() {
                return Ok(Some(key));
            }
        }
        if let Some(key) = self.env_key()? {
            return Ok(Some(key));
        }
        // The preferred tier leads and the other one remains a fallback: a
        // key held in the OS keychain from before the file tier became the
        // default still has to open, but nothing migrates until an explicit
        // switch asks for it.
        if self.preference() == SecretStorage::Keyring {
            if let Some(key) = self.keyring_key() {
                return Ok(Some(key));
            }
            return self.file_key();
        }
        if let Some(key) = self.file_key()? {
            return Ok(Some(key));
        }
        if self.mode == RuntimeMode::Native {
            return Ok(self.keyring_key());
        }
        Ok(None)
    }

    fn env_key(&self) -> Result<Option<MasterKey>, MetadataError> {
        let Ok(raw) = std::env::var(KEY_ENV) else {
            return Ok(None);
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let bytes = decode_key(trimmed).ok_or_else(|| {
            MetadataError::key_missing(format!(
                "{KEY_ENV} must be base64 of exactly {KEY_LEN} bytes"
            ))
        })?;
        Ok(Some(MasterKey {
            bytes,
            storage: SecretStorage::Env,
        }))
    }

    fn keyring_key(&self) -> Option<MasterKey> {
        let entry = keyring::Entry::new(APP_ID, KEYRING_ACCOUNT).ok()?;
        let raw = entry.get_password().ok()?;
        let bytes = decode_key(raw.trim())?;
        Some(MasterKey {
            bytes,
            storage: SecretStorage::Keyring,
        })
    }

    fn store_in_keyring(&self, bytes: &[u8; KEY_LEN]) -> Result<(), keyring::Error> {
        let entry = keyring::Entry::new(APP_ID, KEYRING_ACCOUNT)?;
        entry.set_password(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    fn master_key_path(&self) -> PathBuf {
        self.root.join(MASTER_KEY_FILE)
    }

    fn file_key(&self) -> Result<Option<MasterKey>, MetadataError> {
        let path = self.master_key_path();
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Ok(None);
        };
        let bytes = decode_key(raw.trim()).ok_or_else(|| {
            MetadataError::key_missing(format!(
                "{} is not base64 of {KEY_LEN} bytes",
                path.display()
            ))
        })?;
        Ok(Some(MasterKey {
            bytes,
            storage: SecretStorage::File,
        }))
    }

    fn write_master_key_file(&self, bytes: &[u8; KEY_LEN]) -> Result<(), MetadataError> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        fs::atomic_write(
            &self.root,
            &self.master_key_path(),
            encoded.as_bytes(),
            fs::SECRET_MODE,
        )
        .map_err(|error| {
            MetadataError::write_failed(format!("master key could not be stored: {error}"))
        })
    }
}

/// A fresh master key, base64-encoded for `MOKA_METADATA_KEY`.
///
/// Printed for an operator to place wherever the deployment keeps secrets; this
/// process writes nothing, because where the value lives afterwards is not this
/// process's decision.
pub fn generate_encoded() -> String {
    base64::engine::general_purpose::STANDARD.encode(generate())
}

fn decode_key(raw: &str) -> Option<[u8; KEY_LEN]> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
    bytes.try_into().ok()
}

fn generate() -> [u8; KEY_LEN] {
    let mut bytes = [0u8; KEY_LEN];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

/// The persisted choice of where the master key lives: `"file"` or
/// `"keyring"`. Anything else reads as the default.
#[derive(Serialize, Deserialize)]
struct StoragePref {
    storage: SecretStorage,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; KEY_LEN] {
        [7u8; KEY_LEN]
    }

    #[test]
    fn seals_and_opens_a_credential() {
        let cipher = seal(&key(), "openai", "sk-secret-value").unwrap();
        assert_ne!(cipher, "sk-secret-value");
        assert_eq!(open(&key(), "openai", &cipher).unwrap(), "sk-secret-value");
    }

    #[test]
    fn ciphertext_is_bound_to_the_owner() {
        let cipher = seal(&key(), "openai", "sk-secret-value").unwrap();
        let error = open(&key(), "gemini", &cipher).unwrap_err();
        assert!(matches!(error, MetadataError::SecretUnreadable(_)));
    }

    #[test]
    fn ciphertext_is_bound_to_the_master_key() {
        let cipher = seal(&key(), "openai", "sk-secret-value").unwrap();
        let other = [9u8; KEY_LEN];
        assert!(open(&other, "openai", &cipher).is_err());
    }

    #[test]
    fn sealing_the_same_value_twice_differs() {
        let first = seal(&key(), "openai", "sk-secret-value").unwrap();
        let second = seal(&key(), "openai", "sk-secret-value").unwrap();
        assert_ne!(first, second, "nonce must not repeat");
    }

    #[test]
    fn malformed_ciphertext_is_rejected() {
        assert!(open(&key(), "openai", "not-base64!").is_err());
        assert!(open(&key(), "openai", "").is_err());
        let short = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        assert!(open(&key(), "openai", &short).is_err());
    }

    #[test]
    fn a_malformed_file_held_key_is_reported_actionably() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(MASTER_KEY_FILE), "too-short").unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        let error = provider.acquire().unwrap_err();
        assert!(matches!(error, MetadataError::KeyMissing(_)));
        assert!(error.to_string().contains(MASTER_KEY_FILE), "{error}");
    }

    #[test]
    fn server_mode_without_a_key_creates_a_file_held_one() {
        if std::env::var(KEY_ENV).is_ok() {
            // The developer's shell exports a master key; nothing to assert.
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        let created = provider.acquire().expect("a server can always store a key");
        assert_eq!(created.storage(), SecretStorage::File);

        // The key is on disk for the next process, not just in this one's cache.
        let reloaded = KeyProvider::new(root.path(), RuntimeMode::Web);
        let recovered = reloaded.acquire().expect("the stored key is found");
        assert_eq!(recovered.bytes(), created.bytes());
    }

    #[test]
    fn a_generated_key_is_exportable_and_not_repeated() {
        let first = generate_encoded();
        let second = generate_encoded();
        assert_ne!(first, second);
        assert_eq!(decode_key(&first).unwrap().len(), KEY_LEN);
    }

    #[test]
    fn an_exported_key_is_read_even_when_a_file_held_one_exists() {
        let Ok(raw) = std::env::var(KEY_ENV) else {
            // Without an exported key there is nothing to prefer.
            return;
        };
        let expected = decode_key(raw.trim()).expect("the exported key is valid");
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        provider.write_master_key_file(&generate()).unwrap();

        let found = provider.acquire().unwrap();
        assert_eq!(found.storage(), SecretStorage::Env);
        assert_eq!(found.bytes(), &expected);
    }

    #[test]
    fn stored_credentials_without_a_key_fail_the_startup_probe() {
        if std::env::var(KEY_ENV).is_ok() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        let error = provider.probe(true).unwrap_err();
        assert_eq!(error.code(), "CONFIG_METADATA_KEY_MISSING");
        // An empty credential store is allowed to start: the key is only
        // needed once something is stored.
        assert!(provider.probe(false).is_ok());
    }

    #[test]
    fn a_file_held_master_key_survives_a_reload() {
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        let generated = generate();
        provider.write_master_key_file(&generated).unwrap();

        let reloaded = KeyProvider::new(root.path(), RuntimeMode::Web);
        let recovered = reloaded.find_existing().unwrap().expect("file-held key");
        assert_eq!(recovered.bytes(), &generated);
        assert_eq!(recovered.storage(), SecretStorage::File);
    }

    #[cfg(unix)]
    #[test]
    fn the_master_key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        provider.write_master_key_file(&generate()).unwrap();
        let mode = std::fs::metadata(root.path().join(MASTER_KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn the_storage_preference_defaults_to_the_file_tier() {
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        assert_eq!(provider.preference(), SecretStorage::File);
        assert_eq!(provider.storage_options(), vec![SecretStorage::File]);
    }

    #[test]
    fn only_file_and_keyring_are_switchable_targets() {
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        assert!(matches!(
            provider.switch_storage(SecretStorage::Env),
            Err(MetadataError::Invalid(_))
        ));
        assert!(matches!(
            provider.switch_storage(SecretStorage::Unset),
            Err(MetadataError::Invalid(_))
        ));
    }

    #[test]
    fn switching_to_the_keyring_needs_a_runtime_that_has_one() {
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        let error = provider.switch_storage(SecretStorage::Keyring).unwrap_err();
        assert!(matches!(error, MetadataError::Unavailable(_)));
    }

    #[test]
    fn a_switch_without_any_key_yet_only_records_the_choice() {
        if std::env::var(KEY_ENV).is_ok() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        let storage = provider.switch_storage(SecretStorage::File).unwrap();
        // No credential has ever been stored, so no master key exists yet;
        // the choice is recorded for the one that will.
        assert_eq!(storage, SecretStorage::Unset);
        assert!(root.path().join(STORAGE_PREF_FILE).exists());
        assert!(!root.path().join(MASTER_KEY_FILE).exists());
    }

    #[test]
    fn a_file_tier_switch_keeps_an_existing_key_where_it_can_be_found() {
        if std::env::var(KEY_ENV).is_ok() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let provider = KeyProvider::new(root.path(), RuntimeMode::Web);
        let created = provider.acquire().unwrap();
        assert_eq!(created.storage(), SecretStorage::File);

        // Switching to the tier the key already lives in changes nothing but
        // the recorded preference, and the key survives for the next process.
        let storage = provider.switch_storage(SecretStorage::File).unwrap();
        assert_eq!(storage, SecretStorage::File);
        let reloaded = KeyProvider::new(root.path(), RuntimeMode::Web);
        assert_eq!(reloaded.acquire().unwrap().bytes(), created.bytes());
    }
}
