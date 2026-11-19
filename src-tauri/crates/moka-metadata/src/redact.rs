//! The only place credentials are reduced to something loggable.
//!
//! Every diagnostic surface — logs, `/api/health`, provider responses — goes
//! through these two functions. Nothing else is allowed to format a key.

use sha2::{Digest, Sha256};

/// First eight hex characters of the key's SHA-256 digest. Stable across
/// restarts, so two log lines can be correlated without revealing the key.
pub fn fingerprint(plaintext: &str) -> String {
    let digest = Sha256::digest(plaintext.as_bytes());
    let mut out = String::with_capacity(8);
    for byte in &digest[..4] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Keeps the first three and last four characters. Enough for a user to
/// recognise which key is configured; short enough that the remainder cannot
/// be brute-forced from the visible part.
pub fn masked(plaintext: &str) -> String {
    let chars: Vec<char> = plaintext.chars().collect();
    const PREFIX: usize = 3;
    const SUFFIX: usize = 4;
    if chars.len() <= PREFIX + SUFFIX {
        return "*".repeat(chars.len());
    }
    let head: String = chars[..PREFIX].iter().collect();
    let tail: String = chars[chars.len() - SUFFIX..].iter().collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_are_stable_and_short() {
        let first = fingerprint("sk-test-value");
        let second = fingerprint("sk-test-value");
        assert_eq!(first, second);
        assert_eq!(first.len(), 8);
        assert_ne!(first, fingerprint("sk-other-value"));
    }

    #[test]
    fn masking_keeps_only_the_recognisable_ends() {
        assert_eq!(masked("sk-abcdef123456"), "sk-…3456");
    }

    #[test]
    fn masking_hides_short_values_entirely() {
        // Revealing 3 of 5 characters would leave almost nothing secret.
        assert_eq!(masked("abcde"), "*****");
        assert_eq!(masked(""), "");
    }

    #[test]
    fn masking_never_emits_the_full_value() {
        for candidate in ["a", "abcd", "abcdefg", "sk-abcdef123456"] {
            assert!(!masked(candidate).contains(candidate) || candidate.is_empty());
        }
    }
}
