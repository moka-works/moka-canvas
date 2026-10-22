//! Converter registry: the model directories on disk, read as a list of
//! available converter protocols.
//!
//! The models root holds one directory per capability — `text`, `image`,
//! `speech`, `music`, `video`, `asr` — and each of those holds one directory
//! per converter. A converter directory is self-contained: its `model.json`
//! carries the metadata and names the protocol adapter script beside it, so a
//! script is added by dropping a directory in and removed by taking one out.
//! A directory without a readable `model.json` is skipped rather than failing
//! the read: the rest of the directory is still worth showing.
//!
//! Everything a converter declares is data. The names it goes by in each
//! language, where it sits in a list, where its credential travels, and which
//! features it has all live in its own document, so the program holds no table
//! of protocols to keep in step with them.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The capability directories a models root holds, in the order a list reads.
///
/// A directory this build does not know — `audio`, from before sound was split
/// in two — is never read, which leaves a tree deployed by an older build
/// harmlessly in place.
pub const CAPABILITY_DIRS: [&str; 6] = ["text", "image", "speech", "music", "video", "asr"];

/// Where a converter's credential travels, as its `model.json` declares it.
///
/// A converter that says nothing gets the usual arrangement: a bearer token in
/// `Authorization`. The key itself never reaches a script; this only says which
/// header the host puts it in, and only for addresses inside the configured
/// origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSpec {
    /// The header the credential rides in. Empty means the endpoint takes no
    /// credential at all.
    pub header: String,
    /// What precedes the key in that header, `Bearer` by convention. Empty
    /// means the header carries the key itself.
    pub scheme: String,
}

impl Default for AuthSpec {
    fn default() -> Self {
        Self {
            header: "Authorization".to_string(),
            scheme: "Bearer".to_string(),
        }
    }
}

impl AuthSpec {
    /// Whether this arrangement is one a request can be sent with: a header
    /// name is a token, and an empty header is how a converter declines one.
    fn is_sendable(&self) -> bool {
        if self.header.is_empty() {
            return true;
        }
        !self.header.is_empty()
            && self
                .header
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && self.scheme.chars().all(|c| !c.is_control())
    }
}

/// The order a converter without one is listed in: after every converter that
/// states its own, so a reader's addition does not displace a shipped one.
fn default_order() -> u32 {
    1000
}

/// What a converter declares about itself beyond speaking its protocol.
///
/// These are read by whichever part of the program knows the feature, so a
/// name the program does not know is kept in `extra` rather than dropped. A
/// built-in converter's document must not put anything there: a misspelled
/// flag would otherwise be silently ignored, which is exactly what this type
/// exists to prevent. A converter of the reader's own may still declare a
/// flag a later build understands.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    /// The protocol maps native tool calls rather than the JSON fallback.
    #[serde(default, skip_serializing_if = "is_false")]
    pub tool_calling: bool,
    /// A voice has to be named; there is no default to fall back on.
    #[serde(default, skip_serializing_if = "is_false")]
    pub needs_voice: bool,
    /// The voice is copied from a reference recording rather than named.
    #[serde(default, skip_serializing_if = "is_false")]
    pub needs_reference_audio: bool,
    /// The protocol can carry a mask beside the picture it edits.
    #[serde(default, skip_serializing_if = "is_false")]
    pub mask: bool,
    /// The protocol answers through the task registry rather than in the
    /// call that asked. Video and recognition always do; an image protocol
    /// that needs a poll says so here.
    #[serde(default, skip_serializing_if = "is_false")]
    pub job: bool,
    /// Flags this build does not know. Kept so a converter written for a
    /// later build still loads here, and warned about from the registry.
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

impl Features {
    /// Whether the document declared nothing at all.
    pub fn is_empty(&self) -> bool {
        !self.tool_calling
            && !self.needs_voice
            && !self.needs_reference_audio
            && !self.mask
            && !self.job
            && self.extra.is_empty()
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// One converter's `model.json`.
///
/// The identifier is the name of the directory the document sits in, so the
/// document does not repeat it. `script` locates the protocol adapter Lua file
/// relative to that same directory — usually a bare filename beside the
/// document, which is what this module joins it onto.
///
/// Everything a converter declares beyond the script — the names it goes by in
/// each language, where it sits in a list, where its credential travels, which
/// features it has — is data rather than a table in the program, because these
/// are the facts that differ between converters and change when one is added.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    /// The name it goes by where no label for the reader's language is given,
    /// and in the program's own messages.
    pub display_name: String,
    /// The name it goes by per language, keyed by locale: `{"zh": "..."}`.
    /// A language without an entry falls back to `displayName`.
    #[serde(default)]
    pub labels: HashMap<String, String>,
    pub url_example: String,
    pub script: String,
    /// Where it sits among the converters of its capability, ascending, ties
    /// broken by name.
    #[serde(default = "default_order")]
    pub order: u32,
    /// Where its credential travels. Absent means `Authorization: Bearer`.
    #[serde(default)]
    pub auth: AuthSpec,
    /// What a converter declares about itself beyond speaking its protocol,
    /// read by whichever part of the program knows that feature.
    #[serde(default)]
    pub features: Features,
    /// The version of the built-in converter this document was deployed
    /// from, written for a built-in and absent for a directory a reader
    /// wrote by hand. Zero when absent, so any built-in version may take the
    /// place of a document that does not claim one.
    #[serde(default)]
    pub version: u32,
}

/// One protocol entry, as the rest of the program reads it: the converter's
/// capability is the group key it hangs under, its identifier is the map key,
/// and `script` is the path from the models root to the adapter script.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolEntry {
    pub script: String,
    pub display_name: String,
    pub labels: HashMap<String, String>,
    pub url_example: String,
    pub order: u32,
    pub auth: AuthSpec,
    pub features: Features,
}

/// Protocols grouped by capability: `text`, `image`, `audio`, `video`, `asr`.
pub type ProtocolGroups = HashMap<String, HashMap<String, ProtocolEntry>>;

/// Whether a `model.json` `script` value names a file in the document's own
/// directory: a bare filename, and not the document itself.
pub fn script_name_beside(script: &str) -> bool {
    let file_name = Path::new(script).file_name();
    file_name == Some(std::ffi::OsStr::new(script)) && !script.is_empty() && script != "model.json"
}

/// Whether a document says anything unusable about itself: a label with
/// nothing in it would render as a blank choice, and a credential header a
/// request cannot carry would fail only once a call was made.
fn declared_well(config: &ModelConfig) -> bool {
    let labelled = config
        .labels
        .iter()
        .all(|(locale, label)| !locale.trim().is_empty() && !label.trim().is_empty());
    labelled && config.auth.is_sendable()
}

/// Holds the loaded registry state.
pub struct ConverterRegistry {
    protocols: ProtocolGroups,
}

impl ConverterRegistry {
    /// Reads every capability directory under the models root and every
    /// converter directory inside them. Never fails: an unreadable directory,
    /// a missing `model.json`, or one that does not parse is left out, and a
    /// root that does not exist yet yields an empty registry.
    pub fn load(root: &Path) -> Self {
        let mut protocols: ProtocolGroups = HashMap::new();
        for capability in CAPABILITY_DIRS {
            let group = Self::load_capability(&root.join(capability));
            if !group.is_empty() {
                protocols.insert(capability.to_string(), group);
            }
        }
        Self { protocols }
    }

    /// Reads one capability directory: each subdirectory that holds a
    /// readable `model.json` becomes an entry, keyed by the directory name.
    fn load_capability(dir: &Path) -> HashMap<String, ProtocolEntry> {
        let mut group = HashMap::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return group;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(id) = entry.file_name().into_string().ok() else {
                continue;
            };
            if let Some(entry) = Self::load_converter(&entry.path(), dir) {
                group.insert(id, entry);
            }
        }
        group
    }

    /// Reads one converter directory's `model.json`. `capability_dir` is the
    /// directory it sits in, named in the script path so every entry can be
    /// resolved against the models root alone.
    ///
    /// The script is a bare filename beside the document — one that climbs
    /// out of the converter's own directory, or names the document itself,
    /// is refused rather than followed. A document that says something
    /// unusable about itself — a blank label, a header a request cannot be
    /// sent with — is refused the same way, because a form offering half of
    /// what it declared is worse than a converter that is plainly absent.
    fn load_converter(dir: &Path, capability_dir: &Path) -> Option<ProtocolEntry> {
        let text = std::fs::read_to_string(dir.join("model.json")).ok()?;
        let config: ModelConfig = serde_json::from_str(&text).ok()?;
        if !script_name_beside(&config.script) || !declared_well(&config) {
            return None;
        }
        let capability = capability_dir.file_name()?.to_str()?;
        let id = dir.file_name()?.to_str()?;
        if !config.features.extra.is_empty() {
            let mut unknown: Vec<&String> = config.features.extra.keys().collect();
            unknown.sort();
            tracing::warn!(
                converter = id,
                features = ?unknown,
                "converter declares features this build does not know"
            );
        }
        Some(ProtocolEntry {
            script: format!("{capability}/{id}/{}", config.script),
            display_name: config.display_name,
            labels: config.labels,
            url_example: config.url_example,
            order: config.order,
            auth: config.auth,
            features: config.features,
        })
    }

    /// The protocols grouped by capability: `text` → id → entry.
    pub fn protocols(&self) -> &ProtocolGroups {
        &self.protocols
    }

    /// The protocols one capability offers, empty when it offers none.
    pub fn protocols_for(&self, capability: &str) -> Option<&HashMap<String, ProtocolEntry>> {
        self.protocols.get(capability)
    }

    /// Finds a protocol entry by id across every capability. Ids are unique
    /// in practice — one script speaks one endpoint shape — so the first hit
    /// is the hit.
    pub fn find(&self, id: &str) -> Option<&ProtocolEntry> {
        self.protocols.values().find_map(|group| group.get(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, converter: &str, model_json: &str, script: Option<&str>) {
        let converter_dir = dir.join(converter);
        std::fs::create_dir_all(&converter_dir).unwrap();
        std::fs::write(converter_dir.join("model.json"), model_json).unwrap();
        if let Some(name) = script {
            std::fs::write(converter_dir.join(name), "-- lua").unwrap();
        }
    }

    #[test]
    fn reads_every_converter_directory_under_its_capability() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("text"),
            "gemini",
            r#"{"displayName": "Gemini", "urlExample": "https://example.com", "script": "gemini.lua", "version": 1}"#,
            Some("gemini.lua"),
        );
        write(
            &dir.path().join("video"),
            "bailianVideo",
            r#"{"displayName": "Bailian Video", "urlExample": "https://example.com/bailian", "script": "bailian-video.lua", "version": 2}"#,
            Some("bailian-video.lua"),
        );
        // A converter whose document does not parse is left out, and the rest
        // of the directory is still read.
        write(&dir.path().join("text"), "broken", "{not json", None);

        let registry = ConverterRegistry::load(dir.path());
        assert_eq!(registry.protocols().len(), 2);
        assert!(registry
            .protocols_for("text")
            .unwrap()
            .contains_key("gemini"));
        assert!(!registry
            .protocols_for("text")
            .unwrap()
            .contains_key("broken"));
        assert!(registry.find("broken").is_none());
        assert_eq!(
            registry.find("bailianVideo").unwrap().script,
            "video/bailianVideo/bailian-video.lua"
        );
        assert_eq!(registry.find("gemini").unwrap().display_name, "Gemini");
    }

    #[test]
    fn a_converter_without_a_readable_document_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("audio/no-document")).unwrap();
        // A loose file where a converter directory is expected is not one.
        std::fs::write(dir.path().join("audio").join("stray.lua"), "-- lua").unwrap();

        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.protocols().is_empty());
        assert!(registry.find("no-document").is_none());
    }

    #[test]
    fn a_root_that_does_not_exist_reads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let registry = ConverterRegistry::load(&dir.path().join("models"));
        assert!(registry.protocols().is_empty());
        assert!(registry.protocols_for("text").is_none());
    }

    #[test]
    fn a_directory_left_in_the_root_is_not_a_capability() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("script-backup"),
            "gemini",
            r#"{"displayName": "Gemini", "urlExample": "https://example.com", "script": "gemini.lua"}"#,
            None,
        );
        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.protocols().is_empty());
    }

    #[test]
    fn a_script_that_would_climb_out_of_its_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("text"),
            "wanderer",
            r#"{"displayName": "Wanderer", "urlExample": "https://example.com", "script": "../../../etc/passwd"}"#,
            None,
        );
        write(
            &dir.path().join("text"),
            "absolute",
            r#"{"displayName": "Absolute", "urlExample": "https://example.com", "script": "/etc/passwd"}"#,
            None,
        );
        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.find("wanderer").is_none());
        assert!(registry.find("absolute").is_none());
    }

    #[test]
    fn only_a_bare_filename_sits_beside_the_document() {
        assert!(script_name_beside("bailian-video.lua"));
        assert!(!script_name_beside("../bailian-video.lua"));
        assert!(!script_name_beside("sub/bailian-video.lua"));
        assert!(!script_name_beside("/etc/passwd"));
        assert!(!script_name_beside("model.json"));
        assert!(!script_name_beside(""));
    }

    #[test]
    fn what_a_document_declares_about_itself_is_what_the_entry_carries() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("image"),
            "wanImage",
            r#"{
              "displayName": "Alibaba Cloud · Bailian Image (Wan)",
              "labels": {"zh": "阿里云百炼 · 图像生成与编辑（万相）"},
              "urlExample": "https://{WorkspaceId}.example.com/images",
              "script": "wan-image.lua",
              "order": 20,
              "auth": {"header": "x-api-key", "scheme": ""},
              "features": {"mask": true},
              "version": 1
            }"#,
            Some("wan-image.lua"),
        );

        let registry = ConverterRegistry::load(dir.path());
        let entry = registry.find("wanImage").unwrap();
        assert_eq!(entry.order, 20);
        assert_eq!(
            entry.labels.get("zh").map(String::as_str),
            Some("阿里云百炼 · 图像生成与编辑（万相）")
        );
        assert_eq!(
            entry.auth,
            AuthSpec {
                header: "x-api-key".into(),
                scheme: String::new()
            }
        );
        assert!(entry.features.mask);
    }

    #[test]
    fn a_feature_this_build_does_not_know_is_kept_and_not_mistaken_for_one_it_does() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("text"),
            "typo",
            r#"{"displayName": "Typo", "urlExample": "https://example.com", "script": "typo.lua", "features": {"toolCallng": true}}"#,
            Some("typo.lua"),
        );

        let entry = ConverterRegistry::load(dir.path())
            .find("typo")
            .cloned()
            .unwrap();
        assert!(
            !entry.features.tool_calling,
            "the misspelling is not the flag"
        );
        assert_eq!(
            entry.features.extra.get("toolCallng"),
            Some(&serde_json::Value::Bool(true))
        );
    }

    #[test]
    fn a_document_that_says_nothing_gets_the_usual_arrangement() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("text"),
            "plain",
            r#"{"displayName": "Plain", "urlExample": "https://example.com", "script": "plain.lua"}"#,
            Some("plain.lua"),
        );

        let entry = ConverterRegistry::load(dir.path())
            .find("plain")
            .unwrap()
            .clone();
        // Listed after every converter that states an order of its own, and
        // credentialed the way most endpoints ask for it.
        assert_eq!(entry.order, 1000);
        assert_eq!(entry.auth, AuthSpec::default());
        assert!(entry.labels.is_empty());
        assert!(entry.features.is_empty());
    }

    #[test]
    fn a_document_that_declares_something_unusable_is_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().join("text");
        write(
            &models,
            "blank-label",
            r#"{"displayName": "Blank", "labels": {"zh": "  "}, "urlExample": "https://example.com", "script": "a.lua"}"#,
            Some("a.lua"),
        );
        write(
            &models,
            "unsendable-auth",
            r#"{"displayName": "Unsendable", "urlExample": "https://example.com", "script": "b.lua", "auth": {"header": "not a header", "scheme": "Bearer"}}"#,
            Some("b.lua"),
        );

        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.find("blank-label").is_none());
        assert!(registry.find("unsendable-auth").is_none());
        // An empty header is how a converter declines a credential, which is
        // a declaration rather than a defect.
        write(
            &models,
            "keyless",
            r#"{"displayName": "Keyless", "urlExample": "https://example.com", "script": "c.lua", "auth": {"header": "", "scheme": ""}}"#,
            Some("c.lua"),
        );
        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.find("keyless").is_some());
    }
}
