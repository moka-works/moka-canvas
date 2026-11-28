//! Credentials sealed for a file that leaves this machine.
//!
//! At rest, a credential is sealed with a master key that never leaves the
//! metadata directory (or the OS keychain). A configuration export may carry
//! credentials to another machine, where that master key does not exist, so
//! this module seals them under a key derived from a passphrase the reader
//! chooses. The passphrase is the only secret that travels beside the file;
//! losing it loses the credentials.
//!
//! PBKDF2-HMAC-SHA256 is used rather than a memory-hard function only because
//! it is the one this build already ships. Parameters travel with the envelope
//! and are bounded on the way back in: a file that asks for billions of rounds
//! is a denial of service, not a stronger key.

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::crypto;
use super::MetadataError;

/// The envelope version this build writes and reads.
pub const FORMAT_VERSION: u32 = 1;

/// The only key-derivation function this build accepts.
pub const KDF_PBKDF2_SHA256: &str = "pbkdf2-sha256";

/// The work factor new exports use.
pub const DEFAULT_ROUNDS: u32 = 600_000;

/// The bounds an imported envelope may name. Below the floor is weaker than
/// this build ever wrote; above the ceiling is a request to burn unbounded CPU.
pub const MIN_ROUNDS: u32 = 100_000;
pub const MAX_ROUNDS: u32 = 1_000_000;

/// How many credentials one envelope may carry. A configuration larger than
/// this is a guard against a malformed file, not a deployment this program
/// expects.
pub const MAX_ENTRIES: usize = 4_096;

const SALT_LEN: usize = 16;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const MAX_CIPHERTEXT_BYTES: usize = 8 * 1024 * 1024;

/// Binds the ciphertext to this purpose, so a sealed blob from somewhere else
/// cannot be transplanted into a configuration export.
const AAD: &str = "moka-canvas.settings.credentials.v1";

/// Credentials encrypted with a passphrase-derived key.
///
/// `ciphertext` is base64 of `nonce || AES-256-GCM ciphertext`, the same
/// layout [`crypto::seal`] produces for at-rest credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedSecrets {
    pub version: u32,
    pub kdf: String,
    pub rounds: u32,
    pub salt: String,
    /// How many credentials the encrypted map holds. Outside the ciphertext on
    /// purpose: a preview must say there are keys without being given the
    /// passphrase. It is informational; the decrypted map is what counts.
    pub count: usize,
    pub ciphertext: String,
}

/// Seals a small UTF-8 payload under a passphrase-derived key.
///
/// Blocking: the key derivation is CPU-bound. Call it through
/// `tokio::task::spawn_blocking`.
pub fn seal(
    passphrase: &str,
    count: usize,
    plaintext: &str,
) -> Result<SealedSecrets, MetadataError> {
    if passphrase.is_empty() {
        return Err(MetadataError::invalid("a passphrase is required"));
    }
    if count > MAX_ENTRIES {
        return Err(MetadataError::invalid(format!(
            "a credentials envelope holds at most {MAX_ENTRIES} entries"
        )));
    }
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let key = derive(passphrase, &salt, DEFAULT_ROUNDS);
    let ciphertext = crypto::seal(&key, AAD, plaintext)?;
    Ok(SealedSecrets {
        version: FORMAT_VERSION,
        kdf: KDF_PBKDF2_SHA256.to_string(),
        rounds: DEFAULT_ROUNDS,
        salt: base64::engine::general_purpose::STANDARD.encode(salt),
        count,
        ciphertext,
    })
}

/// Opens a payload sealed by [`seal`].
///
/// Blocking: call through `tokio::task::spawn_blocking`. A wrong passphrase
/// and a damaged ciphertext are reported the same way, because an authenticated
/// cipher cannot tell them apart and guessing would be worse than saying so.
pub fn open(passphrase: &str, sealed: &SealedSecrets) -> Result<String, MetadataError> {
    validate(sealed)?;
    if passphrase.is_empty() {
        return Err(MetadataError::invalid("a passphrase is required"));
    }
    let salt = base64::engine::general_purpose::STANDARD
        .decode(&sealed.salt)
        .map_err(|_| invalid_envelope("the salt is not valid base64"))?;
    let key = derive(passphrase, &salt, sealed.rounds);
    crypto::open(&key, AAD, &sealed.ciphertext).map_err(|_| {
        MetadataError::secret_unreadable(
            "the passphrase does not open this file, or its credentials are damaged",
        )
    })
}

/// Checks an envelope without the passphrase, so a preview can tell a reader
/// that a file carries keys before asking for one.
pub fn validate(sealed: &SealedSecrets) -> Result<(), MetadataError> {
    if sealed.version != FORMAT_VERSION {
        return Err(MetadataError::invalid(format!(
            "credentials envelope version {} is not supported (this build reads {FORMAT_VERSION})",
            sealed.version
        )));
    }
    if sealed.kdf != KDF_PBKDF2_SHA256 {
        return Err(invalid_envelope(format!(
            "unsupported key derivation {:?}",
            sealed.kdf
        )));
    }
    if !(MIN_ROUNDS..=MAX_ROUNDS).contains(&sealed.rounds) {
        return Err(invalid_envelope(format!(
            "key derivation rounds must be between {MIN_ROUNDS} and {MAX_ROUNDS}"
        )));
    }
    if sealed.count > MAX_ENTRIES {
        return Err(invalid_envelope(format!(
            "a credentials envelope holds at most {MAX_ENTRIES} entries"
        )));
    }
    let salt = base64::engine::general_purpose::STANDARD
        .decode(&sealed.salt)
        .map_err(|_| invalid_envelope("the salt is not valid base64"))?;
    if salt.len() != SALT_LEN {
        return Err(invalid_envelope(format!(
            "the salt must be {SALT_LEN} bytes"
        )));
    }
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&sealed.ciphertext)
        .map_err(|_| invalid_envelope("the ciphertext is not valid base64"))?;
    if ciphertext.len() < NONCE_LEN + TAG_LEN {
        return Err(invalid_envelope("the ciphertext is truncated"));
    }
    if ciphertext.len() > MAX_CIPHERTEXT_BYTES {
        return Err(invalid_envelope("the ciphertext is too large"));
    }
    Ok(())
}

fn invalid_envelope(reason: impl Into<String>) -> MetadataError {
    MetadataError::invalid(format!("credentials envelope: {}", reason.into()))
}

fn derive(passphrase: &str, salt: &[u8], rounds: u32) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2::pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, rounds, &mut key);
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSPHRASE: &str = "correct horse battery staple";

    #[test]
    fn seals_and_opens_a_credential_map() {
        let sealed = seal(PASSPHRASE, 2, r#"{"openai":"sk-secret"}"#).unwrap();
        validate(&sealed).unwrap();
        assert_eq!(sealed.count, 2);
        assert_eq!(
            open(PASSPHRASE, &sealed).unwrap(),
            r#"{"openai":"sk-secret"}"#
        );
        assert!(!sealed.ciphertext.contains("sk-secret"));
    }

    #[test]
    fn a_wrong_passphrase_opens_nothing() {
        let sealed = seal(PASSPHRASE, 1, "payload").unwrap();
        let error = open("another passphrase", &sealed).unwrap_err();
        assert_eq!(error.code(), "METADATA_UNAVAILABLE");
    }

    #[test]
    fn a_tampered_ciphertext_is_refused() {
        let mut sealed = seal(PASSPHRASE, 1, "payload").unwrap();
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(&sealed.ciphertext)
            .unwrap();
        bytes[NONCE_LEN + 1] ^= 0xff;
        sealed.ciphertext = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert!(open(PASSPHRASE, &sealed).is_err());
    }

    #[test]
    fn an_envelope_asking_for_unbounded_work_is_refused_before_deriving() {
        let mut sealed = seal(PASSPHRASE, 1, "payload").unwrap();
        sealed.rounds = MAX_ROUNDS + 1;
        assert!(validate(&sealed).is_err());
        sealed.rounds = MIN_ROUNDS - 1;
        assert!(validate(&sealed).is_err());
        sealed.rounds = DEFAULT_ROUNDS;
        sealed.kdf = "argon2id".to_string();
        assert!(validate(&sealed).is_err());
        sealed.kdf = KDF_PBKDF2_SHA256.to_string();
        sealed.salt = base64::engine::general_purpose::STANDARD.encode([1u8; 8]);
        assert!(validate(&sealed).is_err());
    }

    #[test]
    fn each_seal_uses_a_fresh_salt() {
        let first = seal(PASSPHRASE, 1, "payload").unwrap();
        let second = seal(PASSPHRASE, 1, "payload").unwrap();
        assert_ne!(first.salt, second.salt);
        assert_ne!(first.ciphertext, second.ciphertext);
    }
}
