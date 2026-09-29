//! Domain types exchanged through [`super::MetadataStore`].
//!
//! These are the shapes callers see. On-disk documents wrap them in envelopes
//! that carry a revision counter; the envelopes never leave the backend.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::domain::{Capability, IsoTimestamp};

/// Cap on the recent-project list. Older entries fall off the end.
pub const MAX_RECENT: usize = 24;

/// Cap on cached prompt entries for a single source. A refresh beyond this
/// count drops the oldest entries by fetch time.
pub const MAX_PROMPT_ITEMS_PER_SOURCE: usize = 3_000;

/// Cap on one search page, so a large cache cannot be pulled in one request.
pub const MAX_SEARCH_PAGE_SIZE: usize = 100;

/// The backend implementations that exist. A database backend would add a
/// variant here without changing any caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetadataStoreKind {
    File,
}

impl MetadataStoreKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MetadataStoreKind::File => "file",
        }
    }
}

/// A project the user opened on this machine. Only the path points at project
/// content; metadata never stores the content itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub last_opened: IsoTimestamp,
}

/// The wire protocol a model configuration speaks.
///
/// A protocol is a name, not a case in this program. The name is the converter
/// that serves it — a directory under the models tree holding a `model.json`
/// and the script beside it — and everything about the shape it speaks, from
/// the address it asks to the way its answer is read, belongs to that
/// converter. A name this build has never heard of is therefore a protocol a
/// stored configuration may speak, as long as a converter on this machine
/// stands behind it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Protocol(String);

impl Protocol {
    /// The protocol a name stands for. Whether anything serves that name is
    /// answered by the models tree rather than here.
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    /// The protocol a stored or configured name stands for.
    pub fn from_wire_name(name: &str) -> Self {
        Self(name.to_string())
    }

    /// The name as it travels on the wire and reads in a settings form.
    pub fn wire_name(&self) -> &str {
        &self.0
    }
}

/// A scenario one configured model may be asked for.
///
/// Some providers name a different model — or serve it at a different address
/// — per scenario: one model for a shot made from words alone, another for a
/// shot that opens on a picture, another for a run of reference pictures. The
/// scenario is read off the request, and where a configuration routes its
/// scenarios through sub-models it picks the one that answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scene {
    TextToVideo,
    ImageToVideo,
    FirstLastFrame,
    ReferenceToVideo,
    TextToImage,
    ImageEdit,
}

impl Scene {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TextToVideo => "textToVideo",
            Self::ImageToVideo => "imageToVideo",
            Self::FirstLastFrame => "firstLastFrame",
            Self::ReferenceToVideo => "referenceToVideo",
            Self::TextToImage => "textToImage",
            Self::ImageEdit => "imageEdit",
        }
    }

    /// The scenarios a category's configurations may route on. A capability
    /// with one shape has none, and its configurations keep one model for
    /// everything.
    pub fn of_category(category: Capability) -> &'static [Scene] {
        match category {
            Capability::Video => &[
                Scene::TextToVideo,
                Scene::ImageToVideo,
                Scene::FirstLastFrame,
                Scene::ReferenceToVideo,
            ],
            Capability::Image => &[Scene::TextToImage, Scene::ImageEdit],
            _ => &[],
        }
    }
}

/// One scenario's own model name and address, under a configuration.
///
/// A sub-model is a routing entry rather than a model of its own: it borrows
/// the configuration's protocol and credential, names the model the provider
/// knows for its scenarios, and carries an address of its own only where the
/// provider serves those scenarios somewhere else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubModel {
    /// The model name the provider knows for these scenarios.
    pub model: String,
    /// The address these scenarios are served at; `None` inherits the
    /// configuration's own address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The scenarios this sub-model answers for. One scenario is routed to at
    /// most one sub-model, so which one answers is never a guess.
    #[serde(default)]
    pub scenes: Vec<Scene>,
}

/// One configured model, standing on its own.
///
/// There is no provider grouping: every model carries its own address,
/// protocol, and credential, so two models from the same vendor are two
/// configurations that cannot interfere with each other. Deliberately has no
/// credential field: the API key lives in a separate encrypted document,
/// keyed by this configuration's `id`, and never appears in a snapshot handed
/// to the generation hot path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    /// What the model generates; also the settings tab it appears under.
    pub category: Capability,
    /// The wire format the endpoint speaks; a name the models tree serves.
    pub protocol: Protocol,
    /// The complete endpoint address requests are sent to — not a base URL.
    /// For example `https://api.openai.com/v1/chat/completions` or
    /// `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`.
    pub url: String,
    /// The model name the provider knows, sent in the request body where the
    /// protocol has one.
    pub model: String,
    /// What the settings list and model pickers show.
    pub display_name: String,
    /// The longest one clip this model can film, in seconds, when the
    /// deployment knows it. A provider films what its model takes, and a
    /// telling longer than that is filmed in pieces the length of this one;
    /// absent means the app's own ceiling stands in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_video_seconds: Option<u32>,
    /// The scenarios the model above answers, where the deployment splits its
    /// work by scenario. Empty claims nothing, which with no sub-models either
    /// leaves the model above answering every request — the way every
    /// configuration worked before scenes could be claimed — and beside
    /// sub-models leaves it answering only the requests that name no scenario.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scenes: Vec<Scene>,
    /// Per-scenario models, where the deployment needs them. Empty means no
    /// scenario routes anywhere but to the model above.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sub_models: Vec<SubModel>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Caller-supplied model configuration contents for an upsert, with the
/// optional revision the caller last read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDraft {
    pub id: String,
    pub category: Capability,
    pub protocol: Protocol,
    pub url: String,
    pub model: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_video_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scenes: Vec<Scene>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sub_models: Vec<SubModel>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

/// The stored form of a model configuration, as returned after a write.
pub type ModelRecord = ModelConfig;

/// Default model per capability, addressed by model configuration id.
///
/// One per capability, plainly: a score's model is a music model like a
/// read-aloud's is a speech one, and neither answers for the other.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Defaults {
    pub text: Option<String>,
    pub image: Option<String>,
    pub speech: Option<String>,
    pub music: Option<String>,
    pub video: Option<String>,
    pub asr: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreferences {
    pub size: String,
    pub quality: String,
    pub background: String,
    pub count: u32,
}

impl Default for ImagePreferences {
    fn default() -> Self {
        Self {
            size: "1:1".to_string(),
            quality: "auto".to_string(),
            background: String::new(),
            count: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoPreferences {
    pub seconds: u32,
    pub resolution: String,
    pub generate_audio: bool,
    pub watermark: bool,
    pub mode: String,
    pub ratio: String,
}

impl Default for VideoPreferences {
    fn default() -> Self {
        Self {
            seconds: 6,
            resolution: "720".to_string(),
            generate_audio: true,
            watermark: false,
            mode: "auto".to_string(),
            ratio: String::new(),
        }
    }
}

/// What a read-aloud ask is shaped by.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpeechPreferences {
    pub voice: String,
    pub format: String,
    pub speed: f64,
    pub instructions: String,
    pub sample_rate: u32,
    pub volume: u32,
    pub rate: f64,
    pub pitch: f64,
}

impl Default for SpeechPreferences {
    fn default() -> Self {
        Self {
            // No voice is invented: what a model answers to is its own, and a
            // name from one vendor means nothing to another.
            voice: String::new(),
            format: "mp3".to_string(),
            speed: 1.0,
            instructions: String::new(),
            sample_rate: 22050,
            volume: 50,
            rate: 1.0,
            pitch: 1.0,
        }
    }
}

/// What a score's ask is shaped by. Less than a voice's: what a score is
/// about belongs to the ask itself, and the music preferences only say what
/// shape the answer takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MusicPreferences {
    pub format: String,
    pub watermark: bool,
}

impl Default for MusicPreferences {
    fn default() -> Self {
        Self {
            format: "mp3".to_string(),
            watermark: false,
        }
    }
}

/// What the story room cuts a telling to, in characters.
///
/// A long telling reaches a model a piece at a time, and how much one piece may
/// carry is a property of the deployment the room is talking to rather than of
/// any one telling: a manuscript is cut into the parts a chapter is written
/// from, and the chapters are read for their cast a part at a time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoryPreferences {
    pub split_chars: u32,
    pub read_chars: u32,
}

impl Default for StoryPreferences {
    fn default() -> Self {
        Self {
            split_chars: 12_000,
            read_chars: 8_000,
        }
    }
}

/// Global generation defaults. A node's own parameters override these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub system_prompt: String,
    pub reasoning_effort: String,
    pub image: ImagePreferences,
    pub video: VideoPreferences,
    pub speech: SpeechPreferences,
    /// Without a field-level default a document stored without this group
    /// would fail to parse, and the whole of it — configurations, keys,
    /// defaults — would be reset rather than read.
    #[serde(default)]
    pub music: MusicPreferences,
    #[serde(default)]
    pub story: StoryPreferences,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            system_prompt: String::new(),
            reasoning_effort: "auto".to_string(),
            image: ImagePreferences::default(),
            video: VideoPreferences::default(),
            speech: SpeechPreferences::default(),
            music: MusicPreferences::default(),
            story: StoryPreferences::default(),
        }
    }
}

/// Everything the generation path needs about model configurations, minus
/// credentials.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsSnapshot {
    pub version: u32,
    pub revision: u64,
    pub models: Vec<ModelConfig>,
    pub defaults: Defaults,
    pub preferences: Preferences,
}

impl Default for ModelsSnapshot {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            models: Vec::new(),
            defaults: Defaults::default(),
            preferences: Preferences::default(),
        }
    }
}

/// What may be disclosed about a stored credential. Never the credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub set: bool,
    pub masked: Option<String>,
    pub fingerprint: Option<String>,
    pub rotated_at: Option<IsoTimestamp>,
}

/// Where prompt entries are fetched from, plus the conditional-request state
/// that lets a refresh keep the previous cache when it fails.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptSource {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    pub format: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_ok_at: Option<IsoTimestamp>,
    pub last_error: Option<String>,
    pub item_count: usize,
}

impl Default for PromptSource {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            url: String::new(),
            enabled: false,
            format: "image-prompts-v1".to_string(),
            etag: None,
            last_modified: None,
            last_ok_at: None,
            last_error: None,
            item_count: 0,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptItem {
    pub id: String,
    pub source_id: String,
    pub title: String,
    pub prompt: String,
    pub url: Option<String>,
    pub cover: Option<String>,
    pub model: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptQuery {
    pub q: Option<String>,
    pub tags: Vec<String>,
    pub source: Option<String>,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPage {
    pub items: Vec<PromptItem>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

/// Per-document diagnostics, reported through `/api/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub name: String,
    pub bytes: u64,
    pub revision: u64,
    pub corrupt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataInfo {
    pub store: MetadataStoreKind,
    /// Redacted for display: the home directory appears as `$HOME`.
    pub root: PathBuf,
    pub schema_version: u32,
    pub secret_storage: SecretStorage,
    /// The tiers this runtime can offer for the master key. The file tier is
    /// always one of them; the OS keychain joins it only in desktop builds
    /// with a trustworthy native store.
    pub secret_storage_options: Vec<SecretStorage>,
    /// The tier new master keys are created in: the persisted choice when it
    /// names a tier this runtime can offer, and the file tier otherwise.
    pub secret_storage_pref: SecretStorage,
    pub documents: Vec<DocumentInfo>,
}

/// Where the master key that protects credentials came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretStorage {
    Keyring,
    File,
    /// Supplied through the environment; not persisted by this process.
    Env,
    /// No credential has been stored yet, so no master key was needed.
    Unset,
}

impl SecretStorage {
    pub fn as_str(&self) -> &'static str {
        match self {
            SecretStorage::Keyring => "keyring",
            SecretStorage::File => "file",
            SecretStorage::Env => "env",
            SecretStorage::Unset => "unset",
        }
    }
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_serialize_as_lowercase_names() {
        let json = serde_json::to_string(&Capability::Image).unwrap();
        assert_eq!(json, "\"image\"");
    }

    #[test]
    fn protocols_serialize_as_the_names_they_are() {
        for name in ["openaiChat", "openaiResponses", "gemini", "geminiVideo"] {
            let protocol = Protocol::new(name);
            assert_eq!(
                serde_json::to_string(&protocol).unwrap(),
                format!("\"{name}\"")
            );
            // A name is read back as itself, so a configuration written by one
            // build is understood by the next.
            assert_eq!(
                serde_json::from_str::<Protocol>(&format!("\"{name}\"")).unwrap(),
                protocol
            );
        }

        // A converter's id is carried as it stands rather than as a case of its
        // own, which is what lets a protocol arrive as a directory without a
        // name for it being written down in this program first.
        let scripted = Protocol::from_wire_name("wan3Image");
        assert_eq!(scripted.wire_name(), "wan3Image");
        assert_eq!(serde_json::to_string(&scripted).unwrap(), "\"wan3Image\"");
        assert_eq!(
            serde_json::from_str::<Protocol>("\"wan3Image\"").unwrap(),
            scripted
        );
    }

    #[test]
    fn documents_use_camel_case_field_names() {
        let recent = RecentProject {
            id: "id".to_string(),
            name: "Film".to_string(),
            path: PathBuf::from("/tmp/film"),
            last_opened: "2026-09-09T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&recent).unwrap();
        assert!(json.contains("\"lastOpened\""), "{json}");
        assert!(!json.contains("last_opened"), "{json}");
    }

    #[test]
    fn a_model_config_has_no_credential_field() {
        let config = ModelConfig {
            id: "gpt-4o".to_string(),
            category: Capability::Text,
            protocol: Protocol::new("openaiChat"),
            url: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-4o".to_string(),
            display_name: "GPT-4o".to_string(),
            max_video_seconds: None,
            scenes: Vec::new(),
            sub_models: Vec::new(),
            enabled: true,
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("apiKey"), "{json}");
        assert!(!json.contains("api_key"), "{json}");
        assert!(json.contains("\"displayName\""), "{json}");
        assert!(json.contains("\"category\":\"text\""), "{json}");
        assert!(json.contains("\"protocol\":\"openaiChat\""), "{json}");
        assert!(
            !json.contains("subModels"),
            "a configuration that routes nothing writes nothing about scenes: {json}"
        );
        assert!(
            !json.contains("\"scenes\""),
            "a configuration that claims nothing writes nothing about scenes: {json}"
        );
    }

    #[test]
    fn scenes_and_sub_models_are_read_from_a_document_that_carries_them() {
        // A configuration written before scenes could be claimed parses
        // without them, and one that carries them parses with everything
        // spelled out.
        let legacy = r#"{
            "id": "filmer", "category": "video", "protocol": "openaiVideos",
            "url": "https://provider.test/v1/videos", "model": "filmer",
            "displayName": "Filmer"
        }"#;
        let config: ModelConfig = serde_json::from_str(legacy).unwrap();
        assert!(config.scenes.is_empty());
        assert!(config.sub_models.is_empty());
        assert!(config.enabled, "enabled still defaults to true");

        let own = r#"{
            "id": "filmer", "category": "video", "protocol": "openaiVideos",
            "url": "https://provider.test/v1/videos", "model": "happy-t2v",
            "displayName": "Filmer",
            "scenes": ["textToVideo", "imageToVideo"]
        }"#;
        let config: ModelConfig = serde_json::from_str(own).unwrap();
        assert_eq!(
            config.scenes,
            vec![Scene::TextToVideo, Scene::ImageToVideo],
            "the scenarios the configuration's own model answers"
        );

        let routed = r#"{
            "id": "filmer", "category": "video", "protocol": "openaiVideos",
            "url": "https://provider.test/v1/videos", "model": "filmer",
            "displayName": "Filmer",
            "subModels": [
                {"model": "happy-t2v", "scenes": ["textToVideo"]},
                {"model": "happy-i2v", "url": "https://provider.test/v1/images",
                 "scenes": ["imageToVideo", "firstLastFrame"]}
            ]
        }"#;
        let config: ModelConfig = serde_json::from_str(routed).unwrap();
        assert_eq!(config.sub_models.len(), 2);
        assert_eq!(config.sub_models[0].model, "happy-t2v");
        assert_eq!(
            config.sub_models[0].url, None,
            "an address left off means the configuration's own"
        );
        assert_eq!(
            config.sub_models[1].scenes,
            vec![Scene::ImageToVideo, Scene::FirstLastFrame]
        );
    }

    #[test]
    fn preferences_fall_back_to_the_documented_defaults() {
        let preferences = Preferences::default();
        assert_eq!(preferences.image.size, "1:1");
        assert_eq!(preferences.video.seconds, 6);
        assert!(preferences.video.generate_audio);
        assert!(!preferences.video.watermark);
        // Left blank on purpose: the voice a model answers to is named by the
        // model, so one is never chosen for it here.
        assert_eq!(preferences.speech.voice, "");
        assert!(!preferences.music.watermark);
        assert_eq!(preferences.reasoning_effort, "auto");
        assert_eq!(preferences.story.split_chars, 12_000);
        assert_eq!(preferences.story.read_chars, 8_000);
    }

    #[test]
    fn a_models_document_without_the_optional_groups_keeps_its_preferences() {
        // A group stored with a default reads as its default rather than
        // failing the whole document and resetting every model configuration
        // along with it.
        let stored: Preferences = serde_json::from_str(
            r#"{"systemPrompt":"be brief","reasoningEffort":"low",
                "image":{"size":"1:1","quality":"auto","background":"","count":1},
                "video":{"seconds":6,"resolution":"720","generateAudio":true,
                         "watermark":false,"mode":"auto","ratio":""},
                "speech":{"voice":"alloy","format":"mp3","speed":1.0,"instructions":"",
                          "sampleRate":22050,"volume":50,"rate":1.0,"pitch":1.0}}"#,
        )
        .expect("a document without the optional groups must parse");
        assert_eq!(stored.system_prompt, "be brief");
        assert_eq!(stored.speech.voice, "alloy");
        assert_eq!(stored.music, MusicPreferences::default());
        assert_eq!(stored.story, StoryPreferences::default());
    }

    #[test]
    fn partial_documents_fill_in_missing_fields() {
        let source: PromptSource =
            serde_json::from_str(r#"{"id":"a","name":"A","url":"https://x"}"#)
                .expect("sparse source must parse");
        assert!(!source.enabled);
        assert_eq!(source.format, "image-prompts-v1");
        assert_eq!(source.item_count, 0);
    }
}
