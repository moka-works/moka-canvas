use crate::config::LimitsConfig;
use crate::domain::{Capability, DocumentCommand, MokaFile, ResourceEntry, SelfCheckReport};
use crate::generate::{AsyncTask, GenerateResult, GeneratedItem, InputRole, Usage};
use crate::metadata::{
    ImagePreferences, ModelDraft, MusicPreferences, SecretStorage, SpeechPreferences,
    StoryPreferences, VideoPreferences,
};
use crate::story::{StoryJobItem, StoryJobKind, StoryTarget};
use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub directory: String,
    pub name: String,
    /// What the interface calls a new project's first canvas, in the language
    /// it is drawn in; absent callers get the scaffold's English name.
    #[serde(default)]
    pub first_canvas_name: Option<String>,
    /// Whether the caller has agreed that a folder already holding something
    /// gets a subfolder named after the project. Absent — or false — asks for
    /// the folder itself, and such a folder is then refused rather than
    /// written into.
    #[serde(default)]
    pub use_subdirectory: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProjectRequest {
    pub archive_path: String,
    pub directory: String,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCommandsRequest {
    pub expected_revision: i32,
    pub commands: Vec<DocumentCommand>,
}

/// One batch of story generations, as a room asks for it.
///
/// The pieces carry their own prompts and references because the story is the
/// room's: which character a drawing is of, what a shot says — all of it is
/// read out of the document by the client and sent up already resolved. What
/// comes back is applied by the client the same way, by the ids it chose.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartStoryJobRequest {
    pub story_id: String,
    pub kind: StoryJobKind,
    pub items: Vec<StoryJobItemDraft>,
    /// The model a reader picked for this batch in the room's own bar, when
    /// they picked one; the deployment's default answers otherwise.
    #[serde(default)]
    pub model: Option<String>,
}

/// Which batches a reader is asking for: one story's, or the project's.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryJobQuery {
    #[serde(default)]
    pub story_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryJobItemDraft {
    pub id: String,
    pub target: StoryTarget,
    pub capability: Capability,
    pub prompt: String,
    /// The standing instruction a written answer is asked under.
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub inputs: Vec<StoryJobInput>,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

/// A reference a piece carries, as the client says what it is for.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryJobInput {
    pub role: InputRole,
    pub asset_id: String,
}

impl StoryJobInput {
    /// The same input as the generation layer reads it, with no window: a story
    /// asks for a whole drawing or a whole clip, never for a stretch of one.
    pub fn into_generate_input(self) -> crate::generate::GenerateInput {
        crate::generate::GenerateInput {
            role: self.role,
            asset_id: self.asset_id,
            window: None,
        }
    }
}

impl StoryJobItemDraft {
    /// The piece the job manager works with.
    pub fn into_item(self) -> StoryJobItem {
        StoryJobItem::queued(
            self.id,
            self.target,
            self.capability,
            self.prompt,
            self.system,
            self.inputs
                .into_iter()
                .map(StoryJobInput::into_generate_input)
                .collect(),
            self.params.unwrap_or(serde_json::Value::Null),
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub canvas_id: String,
    pub node_ids: Vec<String>,
    /// The conversation asking on a card's behalf, when a conversation is.
    #[serde(default)]
    pub assistant_session_id: Option<String>,
}

/// What a render is asked for: which timeline, and where the finished file goes.
///
/// Where the renderer is and what it is asked with are facts about this machine,
/// never about a request; the destination is the one thing a request does say,
/// because it is a reader's own choice and nobody else can make it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipExportRequest {
    pub timeline_id: String,
    pub destination: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPreviewRequest {
    pub canvas_id: String,
    pub node_id: String,
}

/// What one node will send, resolved on the server.
///
/// The client could walk the graph itself, and then there would be two answers
/// to "what does this node feed the model": the one on screen and the one sent.
/// A preview that disagrees with the run is worse than no preview, so the
/// walking happens here and the client only renders it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPreviewResponse {
    /// The prompt as a run will send it: the node's own, with contributing text
    /// folded in behind the labels that point at it.
    pub prompt: String,
    pub inputs: Vec<PreviewInput>,
    /// Characters cut off the contributing text to stay inside the prompt cap.
    /// Zero unless something had to go.
    pub truncated_chars: usize,
    /// Ids named by a mention this canvas has no node for. Nothing is sent for
    /// one, so an ask carrying any is one to refuse before it costs anything.
    pub unresolved: Vec<String>,
}

/// One reference travelling beside the prompt. The details come from what the
/// project recorded about the asset, so a reader sees the size and length a
/// provider will be handed rather than only a name.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInput {
    pub role: InputRole,
    /// The card this reference is, which is how a reader gets from the list back
    /// to the canvas.
    pub node_id: String,
    pub asset_id: String,
    pub name: Option<String>,
    pub mime: Option<String>,
    pub bytes: Option<i64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration_ms: Option<i64>,
    /// Set when the asset this names is not there. A run would trip over it, so
    /// the preview says so first.
    pub missing: bool,
}

/// What a package is asked to carry beyond the work itself.
///
/// Both choices are off by default: a package made without saying is a package
/// of the work, which is the kind that gets handed to somebody else. The
/// destination is the one thing a request must say, as a render's is: nobody
/// else can pick where a reader's file goes.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub destination: String,
    #[serde(default)]
    pub allow_incomplete: bool,
    /// The records of the runs this machine made, and the prompts they carried.
    #[serde(default)]
    pub include_personal_history: bool,
    /// Only the assets a canvas points at, leaving the rest of the library out.
    #[serde(default)]
    pub only_referenced_assets: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResponse {
    pub root: String,
    pub moka: MokaFile,
    pub self_check: SelfCheckReport,
    /// False while the read behind the check is still going, and `self_check`
    /// may yet grow.
    pub self_check_verified: bool,
}

/// The open project's file check on its own, for a client that entered a room
/// before the read behind it had finished.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckResponse {
    pub report: SelfCheckReport,
    pub verified: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResponse {
    pub revision: i32,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetChangeResponse {
    pub entry: ResourceEntry,
    pub revision: i32,
    pub updated_at: String,
}

/// What a reader says about an asset, put right on its own.
///
/// A part left out of the body is a part nobody spoke about, so it stands as it
/// was: writing the shelf edits one corner of an entry at a time.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetShelfRequest {
    pub tags: Option<Vec<String>>,
    pub note: Option<String>,
    pub favorite: Option<bool>,
    pub keyword: Option<String>,
}

/// Which node to put on the shelf.
///
/// The node is named rather than its contents sent: a text node's words are
/// already in the document the server holds, so they do not travel up again.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNodeRequest {
    pub canvas_id: String,
    pub node_id: String,
}

/// The entry a node's work landed on. `created` says whether this call is what
/// wrote it, which is how filing the same text node twice is told apart from
/// filing two different ones.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNodeResponse {
    pub entry: ResourceEntry,
    pub revision: i32,
    pub updated_at: String,
    pub created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageResponse {
    pub destination: String,
    pub entries: usize,
    pub bytes: u64,
    pub incomplete: bool,
}

/// Sanitized public projection of the app configuration. Filesystem paths,
/// the recent-registry location, and server internals must never appear here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfigResponse {
    pub product_name: String,
    pub max_upload_bytes: u64,
    pub allowed_media_types: Vec<String>,
    pub limits: LimitsConfig,
    pub capabilities: CapabilitiesResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesResponse {
    pub mode: String,
    pub executors: Vec<String>,
    pub asset_categories: Vec<String>,
}

/// A model configuration write. The credential rides along but is a separate
/// concern: leaving it out — or leaving it blank — keeps whatever is stored, so
/// renaming a model cannot quietly destroy a working key. Removing one is an
/// explicit call to the key endpoint.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertModelRequest {
    #[serde(flatten)]
    pub model: ModelDraft,
    #[serde(default)]
    pub api_key: Option<String>,
    /// The configuration a new one copies its credential from. The client
    /// never sees a stored key, so a copy names where to take it from rather
    /// than sending it. Honoured on a creation only — an edit keeps the key it
    /// has — and a source with no key simply copies nothing.
    #[serde(default)]
    pub copy_key_from: Option<String>,
}

/// Where the master key protecting the stored credentials should live.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStorageRequest {
    pub storage: SecretStorage,
}

/// Sets or clears one model configuration's credential on its own.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelKeyRequest {
    /// Absent, null, or blank all mean "clear it".
    #[serde(default)]
    pub api_key: Option<String>,
}

/// A partial edit to the per-capability defaults.
///
/// Absent means leave it alone and `null` means clear it, which is the whole
/// reason this is not just the stored `Defaults` shape: setting the image
/// default from a model picker must not wipe the others.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultsPatch {
    #[serde(default, deserialize_with = "present_value")]
    pub text: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub image: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub speech: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub music: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub video: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub asr: Option<Option<String>>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

/// A partial edit to the generation preferences.
///
/// Unlike [`DefaultsPatch`] this needs no absent-versus-null distinction:
/// every field has a built-in value, so there is no cleared state to ask for
/// and `null` can only mean "keep what is stored". The three groups are
/// replaced whole, because half of a size-and-quality pair is not a meaning.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesPatch {
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub image: Option<ImagePreferences>,
    #[serde(default)]
    pub video: Option<VideoPreferences>,
    #[serde(default)]
    pub speech: Option<SpeechPreferences>,
    #[serde(default)]
    pub music: Option<MusicPreferences>,
    #[serde(default)]
    pub story: Option<StoryPreferences>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

/// An optional revision carried in a query string, for the requests that have
/// no body to put it in.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionQuery {
    #[serde(default)]
    pub revision: Option<u64>,
}

/// What a directory listing is asked for, in a query string.
///
/// `path` left out opens the listing at the reader's own home directory, and
/// `extensions` left out asks for the folders alone — see
/// [`super::filesystem`], which is where both rules are kept.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemQuery {
    #[serde(default)]
    pub path: Option<String>,
    /// Comma separated, and compared without regard to case.
    #[serde(default)]
    pub extensions: Option<String>,
}

/// What one directory holds, for the file dialog a browser has to draw itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemListing {
    /// The directory listed, resolved — which is not necessarily the one that
    /// was asked for, and is why the answer carries it.
    pub path: String,
    /// Where up leads, and `None` at the top of a filesystem.
    pub parent: Option<String>,
    pub entries: Vec<FilesystemEntry>,
    /// Whether the listing stopped before the directory was exhausted.
    pub truncated: bool,
}

/// One row of a listing: a name, where it leads, and which of the two it is.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemEntry {
    pub name: String,
    pub path: String,
    /// `directory` or `file`; a dialog opens the one and chooses the other.
    pub kind: &'static str,
}

/// Where a save is asked to write, in a query string.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemWriteQuery {
    /// The absolute path the save dialog settled on.
    #[serde(default)]
    pub path: Option<String>,
}

/// What a write answered: where the bytes landed, and how many there were.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemWriteResponse {
    pub path: String,
    pub bytes: u64,
}

/// The file a reader wants shown in this machine's file manager.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealRequest {
    pub path: String,
}

/// Which run a stream follows. One, because a listener is watching one.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStreamQuery {
    pub run_id: String,
}

/// One answer to a generation request.
///
/// `status` is `pending` only for a capability that runs as an upstream job,
/// where `task` carries the handle and `outputs` is empty; every other answer
/// is complete by the time it arrives.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResponse {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub outputs: Vec<GeneratedOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskHandle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

impl GenerateResponse {
    pub fn succeeded(result: GenerateResult) -> Self {
        Self {
            status: "succeeded",
            outputs: result.items.iter().map(GeneratedOutput::from).collect(),
            text: result.text,
            task: None,
            usage: result.usage,
        }
    }

    /// A job that has started and is not finished. `retry_after` is what the
    /// provider asked for; absent means poll at the caller's own pace.
    pub fn started(task: &AsyncTask, retry_after: Option<u64>) -> Self {
        Self {
            status: "pending",
            text: None,
            outputs: Vec::new(),
            task: Some(TaskHandle::from(task, retry_after)),
            usage: None,
        }
    }
}

/// One thing a provider made.
///
/// The bytes travel encoded because a generation answer has nowhere else to
/// go: nothing is stored until a run adopts it, and a client that received
/// only a size could not show what it had just asked for.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedOutput {
    pub kind: Capability,
    pub mime: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub data: String,
}

impl From<&GeneratedItem> for GeneratedOutput {
    fn from(item: &GeneratedItem) -> Self {
        Self {
            kind: item.kind,
            mime: item.mime.clone(),
            bytes: item.bytes.len() as u64,
            width: item.width,
            height: item.height,
            duration_ms: item.duration_ms,
            data: base64::engine::general_purpose::STANDARD.encode(&item.bytes),
        }
    }
}

/// The handle a job is polled with.
///
/// The provider's own identifier for the job is deliberately absent: it is
/// credential-adjacent in some protocols, and a client has no use for it that
/// this handle does not already serve.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskHandle {
    pub id: String,
    pub capability: Capability,
    pub model: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

impl TaskHandle {
    fn from(task: &AsyncTask, retry_after: Option<u64>) -> Self {
        Self {
            id: task.id.clone(),
            capability: task.capability,
            model: task.model.clone(),
            created_at: task.created_at.clone(),
            retry_after_ms: retry_after,
        }
    }
}

/// Tells "the field was left out" from "the field was sent as null", which
/// serde collapses into the same `None` for a bare `Option<Option<T>>`.
fn present_value<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(deserializer)?))
}
