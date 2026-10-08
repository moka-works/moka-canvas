pub mod commands;
pub mod folders;
pub mod story;
pub mod timeline;
pub mod validate;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use story::{
    StoryActPatch, StoryBriefPatch, StoryDocument, StoryEditPatch, StoryElementPatch,
    StoryKeyframePatch, StoryShotGranularity, StorySlot, StorySlotTarget, StoryVoiceRead,
};

pub type ProjectId = String;
pub type CanvasId = String;
pub type NodeId = String;
pub type EdgeId = String;
pub type AssetId = String;
pub type RunId = String;
pub type SessionId = String;
pub type MessageId = String;
pub type TimelineId = String;
pub type TrackId = String;
pub type ClipId = String;
pub type TransitionId = String;
pub type IsoTimestamp = String;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    pub id: ProjectId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<String>,
    pub revision: i32,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProbe {
    pub mime: String,
    pub bytes: i64,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channels: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_asset_id: Option<AssetId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProvenance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_id: Option<CanvasId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_node_id: Option<NodeId>,
    /// The conversation that asked for this, when one did.
    ///
    /// Like a run, it is a reference only the machine that made it can honour:
    /// conversations travel with a full backup and not with a package of the work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_session_id: Option<SessionId>,
    /// The story job whose item drew this, and the story it was drawn for.
    ///
    /// A story job is a batch of generations rather than a run of a graph, so
    /// the reference a picture carries is the batch and the place in the
    /// document it was filed under. Both are this machine's: they name work
    /// that happened here and are not part of what a package carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub story_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub story_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_asset_ids: Option<Vec<AssetId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter_snapshot: Option<serde_json::Value>,
    pub created_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEntry {
    pub id: AssetId,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<AssetProbe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<AssetProvenance>,
    /// What a reader says about the asset, so the shelf can be searched by it.
    ///
    /// These came in without a schema version of their own: an entry stored
    /// before they existed leaves them off rather than leaves them empty, so
    /// reading such a project and writing it back gives the bytes it arrived
    /// with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    /// Whether the project was handed the file or made it itself. What a
    /// generation or a conversation produced is said by `provenance` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// What the asset is a picture of, in words: the ask it came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyword: Option<String>,
}

pub const ASSET_ORIGINS: [&str; 2] = ["brought", "filed"];

pub const ASSET_CATEGORIES: [&str; 5] = ["images", "music", "voice", "texts", "videos"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ResourceRegistry {
    #[serde(default)]
    pub images: Vec<ResourceEntry>,
    #[serde(default)]
    pub music: Vec<ResourceEntry>,
    #[serde(default)]
    pub voice: Vec<ResourceEntry>,
    #[serde(default)]
    pub texts: Vec<ResourceEntry>,
    #[serde(default)]
    pub videos: Vec<ResourceEntry>,
}

impl ResourceRegistry {
    pub fn category_mut(&mut self, category: &str) -> Option<&mut Vec<ResourceEntry>> {
        match category {
            "images" => Some(&mut self.images),
            "music" => Some(&mut self.music),
            "voice" => Some(&mut self.voice),
            "texts" => Some(&mut self.texts),
            "videos" => Some(&mut self.videos),
            _ => None,
        }
    }

    pub fn category(&self, category: &str) -> Option<&Vec<ResourceEntry>> {
        match category {
            "images" => Some(&self.images),
            "music" => Some(&self.music),
            "voice" => Some(&self.voice),
            "texts" => Some(&self.texts),
            "videos" => Some(&self.videos),
            _ => None,
        }
    }

    pub fn all(&self) -> impl Iterator<Item = &ResourceEntry> {
        ASSET_CATEGORIES
            .iter()
            .filter_map(|c| self.category(c))
            .flatten()
    }

    pub fn all_mut(&mut self) -> impl Iterator<Item = &mut ResourceEntry> {
        [
            &mut self.images,
            &mut self.music,
            &mut self.voice,
            &mut self.texts,
            &mut self.videos,
        ]
        .into_iter()
        .flatten()
    }

    pub fn find(&self, id: &str) -> Option<&ResourceEntry> {
        self.all().find(|entry| entry.id == id)
    }

    pub fn find_mut(&mut self, id: &str) -> Option<&mut ResourceEntry> {
        let category = ASSET_CATEGORIES.into_iter().find(|category| {
            self.category(category)
                .map(|list| list.iter().any(|entry| entry.id == id))
                .unwrap_or(false)
        })?;
        self.category_mut(category)
            .and_then(|list| list.iter_mut().find(|entry| entry.id == id))
    }

    pub fn category_of(&self, id: &str) -> Option<&'static str> {
        ASSET_CATEGORIES.iter().copied().find(|category| {
            self.category(category)
                .map(|list| list.iter().any(|entry| entry.id == id))
                .unwrap_or(false)
        })
    }

    pub fn remove(&mut self, id: &str) -> Option<ResourceEntry> {
        for category in ASSET_CATEGORIES {
            if let Some(list) = self.category_mut(category) {
                if let Some(index) = list.iter().position(|entry| entry.id == id) {
                    return Some(list.remove(index));
                }
            }
        }
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundMode {
    Dots,
    Lines,
    Blank,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSettings {
    pub background: BackgroundMode,
    pub show_minimap: bool,
    pub snap_to_grid: bool,
}

impl Default for DocumentSettings {
    fn default() -> Self {
        Self {
            background: BackgroundMode::Dots,
            show_minimap: true,
            snap_to_grid: true,
        }
    }
}

/// A change to some of a canvas's own view settings; what is left out stays.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<BackgroundMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_minimap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snap_to_grid: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Text,
    Image,
    Audio,
    Video,
    Operation,
    Group,
    Export,
}

impl NodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeKind::Text => "text",
            NodeKind::Image => "image",
            NodeKind::Audio => "audio",
            NodeKind::Video => "video",
            NodeKind::Operation => "operation",
            NodeKind::Group => "group",
            NodeKind::Export => "export",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataType {
    Text,
    Image,
    Audio,
    Video,
    Timeline,
    Artifact,
}

/// The generation modality a provider model serves. Narrower than
/// [`DataType`], which also covers port payloads that are never generated.
///
/// Sound is two capabilities rather than one: [`Capability::Speech`] reads
/// words aloud and [`Capability::Music`] composes under them. A model is
/// configured for one of them, and a sound node's spec says which it asks for.
///
/// [`Capability::Asr`] reads the other way round from the rest: it takes audio
/// in and answers with words, so no node generates in it and it is configured
/// for callers that transcribe rather than for the canvas.
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    #[default]
    Text,
    Image,
    Speech,
    Music,
    Video,
    Asr,
}

impl Capability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Capability::Text => "text",
            Capability::Image => "image",
            Capability::Speech => "speech",
            Capability::Music => "music",
            Capability::Video => "video",
            Capability::Asr => "asr",
        }
    }

    /// Whether a node of that kind may ask for this capability.
    ///
    /// Sound is the one kind two capabilities serve, which is why the check is
    /// this way round: the node says how it is drawn, its spec says what it is
    /// asking for.
    pub fn serves(&self, kind: NodeKind) -> bool {
        matches!(
            (kind, self),
            (NodeKind::Text, Capability::Text)
                | (NodeKind::Image, Capability::Image)
                | (NodeKind::Video, Capability::Video)
                | (NodeKind::Audio, Capability::Speech | Capability::Music)
        )
    }
}

/// The modality a node generates in, or `None` for the kinds that never
/// carry a generation spec.
///
/// A sound node generates in two capabilities; this answers with the one a
/// spec that names none would read as, which is speech.
pub fn generation_capability_for(kind: NodeKind) -> Option<Capability> {
    match kind {
        NodeKind::Text => Some(Capability::Text),
        NodeKind::Image => Some(Capability::Image),
        NodeKind::Audio => Some(Capability::Speech),
        NodeKind::Video => Some(Capability::Video),
        NodeKind::Operation | NodeKind::Group | NodeKind::Export => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum GenerationMode {
    #[default]
    Generate,
    Edit,
    Extend,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum GenerationInputMode {
    #[default]
    Upstream,
    Manual,
    Mentions,
}

/// What a node asks a provider to make; mirrors the TypeScript
/// `GenerationSpec` field for field, including key order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GenerationSpec {
    pub capability: Capability,
    pub mode: GenerationMode,
    /// A model configuration id; empty means fall back to the category default.
    pub model: String,
    pub prompt: String,
    pub input_mode: GenerationInputMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_node_ids: Option<Vec<NodeId>>,
    pub updated_at: IsoTimestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PortDirection {
    Input,
    Output,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cardinality {
    One,
    Many,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortDefinition {
    pub id: String,
    pub direction: PortDirection,
    pub data_types: Vec<DataType>,
    pub required: bool,
    pub cardinality: Cardinality,
    pub label: String,
}

fn port(
    id: &str,
    direction: PortDirection,
    data_types: Vec<DataType>,
    label: &str,
    cardinality: Cardinality,
) -> PortDefinition {
    PortDefinition {
        id: id.to_string(),
        direction,
        data_types,
        required: false,
        cardinality,
        label: label.to_string(),
    }
}

fn input(
    id: &str,
    data_types: Vec<DataType>,
    label: &str,
    cardinality: Cardinality,
) -> PortDefinition {
    port(id, PortDirection::Input, data_types, label, cardinality)
}

fn output(id: &str, data_types: Vec<DataType>, label: &str) -> PortDefinition {
    port(
        id,
        PortDirection::Output,
        data_types,
        label,
        Cardinality::One,
    )
}

/// The one port table both languages share by convention; must stay in
/// lockstep with `NODE_PORTS` in `src/shared/domain/constants.ts`.
pub fn derive_ports(kind: NodeKind) -> Vec<PortDefinition> {
    match kind {
        NodeKind::Text => vec![
            input("prompt", vec![DataType::Text], "Prompt", Cardinality::Many),
            input("images", vec![DataType::Image], "Images", Cardinality::Many),
            input("audio", vec![DataType::Audio], "Audio", Cardinality::One),
            input("video", vec![DataType::Video], "Video", Cardinality::One),
            output("out", vec![DataType::Text], "Text"),
        ],
        NodeKind::Image => vec![
            input("prompt", vec![DataType::Text], "Prompt", Cardinality::Many),
            input("images", vec![DataType::Image], "Images", Cardinality::Many),
            input("mask", vec![DataType::Image], "Mask", Cardinality::One),
            output("out", vec![DataType::Image], "Image"),
        ],
        NodeKind::Audio => vec![
            input("prompt", vec![DataType::Text], "Prompt", Cardinality::Many),
            input("audio", vec![DataType::Audio], "Audio", Cardinality::One),
            output("out", vec![DataType::Audio], "Audio"),
        ],
        NodeKind::Video => vec![
            input("prompt", vec![DataType::Text], "Prompt", Cardinality::Many),
            input("images", vec![DataType::Image], "Images", Cardinality::Many),
            input(
                "firstFrame",
                vec![DataType::Image],
                "First frame",
                Cardinality::One,
            ),
            input(
                "lastFrame",
                vec![DataType::Image],
                "Last frame",
                Cardinality::One,
            ),
            input("videos", vec![DataType::Video], "Videos", Cardinality::Many),
            input("audios", vec![DataType::Audio], "Audios", Cardinality::Many),
            output("out", vec![DataType::Video], "Video"),
        ],
        NodeKind::Operation => vec![
            input("text", vec![DataType::Text], "Text", Cardinality::Many),
            input("images", vec![DataType::Image], "Images", Cardinality::Many),
            input("audio", vec![DataType::Audio], "Audio", Cardinality::One),
            input("video", vec![DataType::Video], "Video", Cardinality::One),
            port(
                "out",
                PortDirection::Output,
                vec![
                    DataType::Text,
                    DataType::Image,
                    DataType::Audio,
                    DataType::Video,
                ],
                "Result",
                Cardinality::Many,
            ),
        ],
        NodeKind::Group => Vec::new(),
        NodeKind::Export => vec![
            input("video", vec![DataType::Video], "Video", Cardinality::One),
            input("audio", vec![DataType::Audio], "Audio", Cardinality::One),
            output("out", vec![DataType::Artifact], "Artifact"),
        ],
    }
}

/// Ports are derived data: the table wins for every port it knows, and
/// stored ports the table does not list are kept verbatim after it.
pub fn reconcile_ports(kind: NodeKind, stored: &[PortDefinition]) -> Vec<PortDefinition> {
    let mut derived = derive_ports(kind);
    let extras: Vec<PortDefinition> = stored
        .iter()
        .filter(|port| !derived.iter().any(|known| known.id == port.id))
        .cloned()
        .collect();
    derived.extend(extras);
    derived
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultSlotStatus {
    Empty,
    Pending,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSlot {
    pub id: String,
    pub status: ResultSlotStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub is_primary: bool,
}

/// Flat node payload; which fields are meaningful is determined by `kind`.
/// Field declaration order must match the TypeScript codec key order so
/// both languages produce byte-identical BSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<GenerationSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_slots: Option<Vec<ResultSlot>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_node_ids: Option<Vec<NodeId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_node_ids: Option<Vec<NodeId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: NodeId,
    pub kind: NodeKind,
    pub title: String,
    pub bounds: Rect,
    pub z_index: i32,
    pub ports: Vec<PortDefinition>,
    pub data: NodeData,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
}

impl WorkflowNode {
    pub fn port(&self, port_id: &str) -> Option<&PortDefinition> {
        self.ports.iter().find(|port| port.id == port_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeEndpoint {
    pub node_id: NodeId,
    pub port_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub id: EdgeId,
    pub source: EdgeEndpoint,
    pub target: EdgeEndpoint,
    pub created_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMembership {
    pub group_id: NodeId,
    pub child_node_ids: Vec<NodeId>,
}

/// Who a line of a conversation is from: the reader, a model, or a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantRole {
    User,
    Assistant,
    Error,
}

/// A card a line was asked about, as that line remembered it; mirrors the
/// TypeScript `AssistantReference` field for field, including key order.
///
/// The title and the kind are kept beside the id because the card may be gone by
/// the time the line is read again, and a line that can say only "a card that no
/// longer exists" tells nobody what was asked about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantReference {
    pub node_id: NodeId,
    pub title: String,
    pub kind: NodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
}

/// A run a line set going, noted so the line can say what it started; mirrors the
/// TypeScript `AssistantToolCall` field for field, including key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantToolCall {
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<NodeId>,
    pub summary: String,
}

/// Why a line that failed failed, and whether asking again could work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantFailure {
    pub code: String,
    pub retryable: bool,
}

/// One line of a conversation; mirrors the TypeScript `AssistantMessage` field
/// for field, including key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub id: MessageId,
    pub role: AssistantRole,
    pub text: String,
    pub created_at: IsoTimestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<AssistantReference>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<AssistantToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<AssistantFailure>,
}

/// One conversation about one canvas, carried by the canvas itself; mirrors the
/// TypeScript `AssistantSession` field for field, including key order.
///
/// A canvas holds its own and never another's: what was asked about the cards on
/// this board belongs to this board, so opening a document opens onto the
/// conversations that were had over it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSession {
    pub id: SessionId,
    pub title: String,
    pub messages: Vec<AssistantMessage>,
    pub created_at: IsoTimestamp,
    /// When something was last said, which is how the newest conversation is found.
    ///
    /// Only ever moves forward: taking a line back does not put this back with it,
    /// since a conversation just taken back out of is still the one to open onto.
    pub updated_at: IsoTimestamp,
}

/// A directory in the project's canvas tree; mirrors the TypeScript
/// `CanvasFolder` field for field, including key order.
///
/// Folders hold canvases and other folders, and hold nothing else: they are a
/// way of arranging the boards a project has rather than a container of its own.
/// The parent is left off rather than named for a folder at the project root,
/// which is what a document written before folders existed says about every
/// canvas in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFolder {
    pub id: String,
    pub name: String,
    /// The folder holding this one; absent means the project root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub created_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocument {
    pub id: CanvasId,
    pub name: String,
    pub schema_version: i32,
    pub viewport: Viewport,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    pub groups: Vec<GroupMembership>,
    pub settings: DocumentSettings,
    /// The conversations had over this canvas.
    ///
    /// Left off rather than left empty on a document written before conversations
    /// existed, so that reading such a document and writing it back gives the bytes
    /// it arrived with. It came in without a schema version of its own for the same
    /// reason: nothing stored had to change to make room for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<AssistantSession>>,
    /// The folder this canvas sits in, when it sits in one.
    ///
    /// Left off rather than named for a canvas at the project root, so a
    /// document written before folders existed is read and written back as the
    /// bytes it arrived with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

impl CanvasDocument {
    pub fn node(&self, node_id: &str) -> Option<&WorkflowNode> {
        self.nodes.iter().find(|node| node.id == node_id)
    }

    pub fn empty(id: CanvasId, name: String) -> Self {
        Self {
            id,
            name,
            schema_version: CANVAS_SCHEMA_VERSION,
            viewport: Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            nodes: Vec::new(),
            edges: Vec::new(),
            groups: Vec::new(),
            settings: DocumentSettings::default(),
            sessions: None,
            folder_id: None,
        }
    }
}

// ---------------------------------------------------------------------------
// The cutting room: one project's timelines
// ---------------------------------------------------------------------------

/// What a track holds, which is also what a clip of that kind may land on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
    Text,
}

impl TrackKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrackKind::Video => "video",
            TrackKind::Audio => "audio",
            TrackKind::Text => "text",
        }
    }
}

/// Clip kinds are the same set: a clip is a track's content.
pub type ClipKind = TrackKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionKind {
    None,
    Crossfade,
    DipToBlack,
    DipToWhite,
    SlideLeft,
    SlideUp,
    Wipe,
    ZoomIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextPosition {
    Top,
    Center,
    Bottom,
}

/// One row of a timeline.
///
/// The order of the list is the order the rows draw in: an upper video track
/// draws over a lower one. Muting is sound and hiding is picture, and the two
/// say nothing about each other: a hidden track's sound still mixes in, and a
/// muted one's picture still draws. Locking is neither — it only keeps the
/// editor from moving the row's clips, and the document itself holds no rule
/// about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTrack {
    pub id: TrackId,
    pub kind: TrackKind,
    pub name: String,
    pub muted: bool,
    pub hidden: bool,
    pub locked: bool,
    pub created_at: IsoTimestamp,
}

/// The visual grade a video clip wears. Absent means untouched; each axis is a
/// fraction of the range the picture allows.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAdjust {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
}

/// How a text clip is written, in pixels on the timeline's own canvas.
///
/// Field declaration order must match the TypeScript codec key order so both
/// languages produce byte-identical BSON. `background` deliberately carries no
/// skip: a null plate must be written, not left off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextClipStyle {
    pub font_family: String,
    pub font_size: i32,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub align: TextAlign,
    pub position: TextPosition,
    /// #rrggbb, or null for no backing plate.
    pub background: Option<String>,
    /// Outline width in timeline pixels; 0 is no outline.
    pub stroke_width: i32,
    /// #rrggbb; always present, harmless at zero width.
    pub stroke_color: String,
}

/// What a text clip says and how it is set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextClipData {
    pub content: String,
    pub style: TextClipStyle,
}

/// A piece of material placed on a timeline; field declaration order must match
/// the TypeScript codec key order so both languages produce byte-identical
/// BSON. The four optional fields are declared at the tail, where `encodeClip`
/// writes them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineClip {
    pub id: ClipId,
    pub track_id: TrackId,
    pub kind: ClipKind,
    /// What the timeline reads on the clip; the asset's name by default.
    pub label: String,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub in_point_ms: i64,
    pub out_point_ms: i64,
    /// 0.25..4, 1 being the material's own pace.
    pub speed: f64,
    /// 0..2, 1 being the material's own level.
    pub volume: f64,
    pub fade_in_ms: i64,
    pub fade_out_ms: i64,
    pub muted: bool,
    /// 0..1, for a clip on an upper video track drawing over the one below.
    pub opacity: f64,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
    /// The material the clip reads; a text clip names none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    /// Visual grade; absent means the clip is untouched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adjust: Option<ClipAdjust>,
    /// Preset look; absent and "none" mean the same untouched thing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    /// Present exactly on text clips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextClipData>,
}

/// How two neighbouring clips meet: the window after `after_clip_id` that the
/// follower is pulled back into, stored as geometry (R1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTransition {
    pub id: TransitionId,
    pub after_clip_id: ClipId,
    pub kind: TransitionKind,
    pub duration_ms: i64,
    pub created_at: IsoTimestamp,
}

/// The frame the cutting room works at and the colour it cuts to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSettings {
    pub fps: i32,
    pub width: i32,
    pub height: i32,
    pub background: String,
}

/// One timeline: the tracks, the clips on them, and the transitions on their
/// seams.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDocument {
    pub id: TimelineId,
    pub name: String,
    pub schema_version: i32,
    pub settings: TimelineSettings,
    pub tracks: Vec<TimelineTrack>,
    pub clips: Vec<TimelineClip>,
    pub transitions: Vec<TimelineTransition>,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MokaFile {
    pub version: String,
    pub metadata: ProjectMetadata,
    pub resources: ResourceRegistry,
    /// The directories of the canvas tree, in the order the tree reads them.
    ///
    /// Left off rather than left empty on a document that has no folders, which
    /// is every document written before they existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<CanvasFolder>>,
    /// The project's timelines, in the order the cutting room's tabs read them.
    ///
    /// Left off rather than left empty on a document that has no timelines,
    /// which is every document written before the cutting room existed: a
    /// project that has cut nothing says so by carrying nothing here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timelines: Option<Vec<TimelineDocument>>,
    /// The stories this project has told, in the order the story room's list
    /// reads them.
    ///
    /// Left off rather than left empty on a document that tells none, which is
    /// every document written before the story room existed: a project that
    /// has never told one says so by carrying nothing here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stories: Option<Vec<StoryDocument>>,
    pub canvas: Vec<CanvasDocument>,
}

pub const MOKA_FILE_VERSION: &str = "v1";
/// Version 3 split the audio capability into speech and music; the codec
/// rewrites a v2 canvas's generation specs on decode.
pub const CANVAS_SCHEMA_VERSION: i32 = 3;
pub const PACKAGE_MANIFEST_VERSION: u32 = 2;

impl MokaFile {
    pub fn canvas(&self, canvas_id: &str) -> Option<&CanvasDocument> {
        self.canvas.iter().find(|canvas| canvas.id == canvas_id)
    }

    pub fn canvas_mut(&mut self, canvas_id: &str) -> Option<&mut CanvasDocument> {
        self.canvas.iter_mut().find(|canvas| canvas.id == canvas_id)
    }

    /// Asset id → the ids referencing it, across every canvas and timeline.
    ///
    /// A reference is a canvas node id or a timeline clip id: both halves of a
    /// document hold assets, and whether an asset is still in use is a question
    /// about the project rather than about one board.
    pub fn asset_references(&self) -> BTreeMap<AssetId, Vec<NodeId>> {
        let mut refs: BTreeMap<AssetId, Vec<NodeId>> = BTreeMap::new();
        let mut add = |asset_id: &Option<AssetId>, node_id: &NodeId| {
            if let Some(asset_id) = asset_id {
                refs.entry(asset_id.clone())
                    .or_default()
                    .push(node_id.clone());
            }
        };
        for canvas in &self.canvas {
            for node in &canvas.nodes {
                add(&node.data.asset_id, &node.id);
                add(&node.data.poster_asset_id, &node.id);
                if let Some(slots) = &node.data.result_slots {
                    for slot in slots {
                        add(&slot.asset_id, &node.id);
                    }
                }
            }
        }
        for timeline in self.timelines.iter().flatten() {
            for clip in &timeline.clips {
                add(&clip.asset_id, &clip.id);
            }
        }
        // A story's pictures are its own: the frames drawn for a shot, the
        // clip made of an act, and the manuscript a premise was lifted from
        // are all in use, however little of a canvas or a timeline they
        // appear on.
        for story in self.stories.iter().flatten() {
            for asset_id in story.asset_references() {
                refs.entry(asset_id).or_default().push(story.id.clone());
            }
        }
        refs
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<NodeData>,
}

/// A change to a timeline's own frame; only what is named moves, so a reader
/// changing the frame rate leaves the resolution where it was.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
}

/// A change to a track; only what is named moves, so renaming a track leaves
/// its mute where it was.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
}

/// Reads a field that must tell "left off" from "carried as null".
///
/// A plain `Option<Option<T>>` cannot tell the two apart: serde reads a null
/// and a missing key as the same `None`. This reads any present key — null
/// included — as `Some(...)`, so `Some(None)` is the null that clears the
/// field while a missing key stays `None` and leaves it alone.
pub(crate) fn deserialize_double_option<'de, D, T>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

/// The fields a caller may move on a clip.
///
/// A field left off is not touched; `adjust: null` is how a grade is cleared,
/// since JSON cannot spell "this key goes away" any other way. `filter` is
/// double-layered for the same reason: an undo that takes a preset back out
/// sends `filter: null`, and a single layer would read it as "leave it". Every
/// patch that arrives through the document pipeline is JSON, so the merge rule
/// and the undo rule are one rule: what a patch carries moves, what a patch
/// carries as null goes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<ClipId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_id: Option<TrackId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ClipKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_point_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out_point_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_in_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_out_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    /// Absent leaves the grade, null clears it, a value sets it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_double_option"
    )]
    pub adjust: Option<Option<ClipAdjust>>,
    /// Absent leaves the preset, null clears it, a value sets it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_double_option"
    )]
    pub filter: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextClipData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<IsoTimestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<IsoTimestamp>,
}

/// A change to one clip, named by id, for `updateClips`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipPatchEntry {
    pub clip_id: ClipId,
    pub patch: ClipPatch,
}

/// Where a clip goes for `moveClips`: `track_id` names the row it lands on,
/// left off when it stays where it is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMove {
    pub clip_id: ClipId,
    pub start_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_id: Option<TrackId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocumentCommand {
    /// The project's own words: what it is called and what it is about. The two
    /// are set together, which is how the settings form submits them, so the
    /// undo of an edit puts back exactly what was there; an empty description
    /// is no description at all.
    #[serde(rename_all = "camelCase")]
    UpdateProjectMetadata { name: String, description: String },
    #[serde(rename_all = "camelCase")]
    AddNode {
        canvas_id: CanvasId,
        node: WorkflowNode,
    },
    #[serde(rename_all = "camelCase")]
    UpdateNode {
        canvas_id: CanvasId,
        node_id: NodeId,
        patch: NodePatch,
    },
    #[serde(rename_all = "camelCase")]
    MoveNodes {
        canvas_id: CanvasId,
        positions: BTreeMap<NodeId, PointValue>,
    },
    #[serde(rename_all = "camelCase")]
    ResizeNode {
        canvas_id: CanvasId,
        node_id: NodeId,
        bounds: Rect,
    },
    #[serde(rename_all = "camelCase")]
    RemoveNodes {
        canvas_id: CanvasId,
        node_ids: Vec<NodeId>,
    },
    #[serde(rename_all = "camelCase")]
    AddEdge {
        canvas_id: CanvasId,
        edge: WorkflowEdge,
    },
    #[serde(rename_all = "camelCase")]
    RemoveEdges {
        canvas_id: CanvasId,
        edge_ids: Vec<EdgeId>,
    },
    #[serde(rename_all = "camelCase")]
    SetGroupMembership {
        canvas_id: CanvasId,
        group_id: NodeId,
        child_node_ids: Vec<NodeId>,
    },
    #[serde(rename_all = "camelCase")]
    SetViewport {
        canvas_id: CanvasId,
        viewport: Viewport,
    },
    /// A change to how the canvas itself is shown. Only what is named moves, so
    /// a caller changing the background leaves the minimap preference where it
    /// was.
    #[serde(rename_all = "camelCase")]
    SetCanvasSettings {
        canvas_id: CanvasId,
        settings: SettingsPatch,
    },
    /// A canvas's conversations. Lines are added and taken away rather than the
    /// list rewritten, so a turn carries only what it said: a conversation is kept
    /// to a length that can be read through, and sending the whole of one across
    /// for every line would cost more than the line.
    #[serde(rename_all = "camelCase")]
    AddSession {
        canvas_id: CanvasId,
        session: AssistantSession,
        index: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    RenameSession {
        canvas_id: CanvasId,
        session_id: SessionId,
        title: String,
    },
    #[serde(rename_all = "camelCase")]
    RemoveSession {
        canvas_id: CanvasId,
        session_id: SessionId,
    },
    /// `at` is where the lines land in the list as it stands when the command is
    /// applied, and is the tail when left off. It exists for the undo of a
    /// conversation that had to let its oldest lines go to make room.
    #[serde(rename_all = "camelCase")]
    AppendMessages {
        canvas_id: CanvasId,
        session_id: SessionId,
        messages: Vec<AssistantMessage>,
        at: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    RemoveMessages {
        canvas_id: CanvasId,
        session_id: SessionId,
        message_ids: Vec<MessageId>,
    },
    #[serde(rename_all = "camelCase")]
    AddCanvas {
        canvas: CanvasDocument,
        index: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    RenameCanvas { canvas_id: CanvasId, name: String },
    #[serde(rename_all = "camelCase")]
    ReorderCanvas { canvas_id: CanvasId, index: usize },
    #[serde(rename_all = "camelCase")]
    RemoveCanvas { canvas_id: CanvasId },
    /// The canvas tree.
    ///
    /// A folder is added whole, its parent named on it rather than beside it,
    /// and `index` is the place it takes among that parent's folders. What a
    /// canvas sits in is moved by `MoveCanvas`, whose `index` is the place it
    /// takes among the canvases of the folder it lands in — both are read
    /// within their own siblings, since the tree holds folders and canvases as
    /// two lists.
    #[serde(rename_all = "camelCase")]
    AddFolder {
        folder: CanvasFolder,
        index: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    RenameFolder { folder_id: String, name: String },
    #[serde(rename_all = "camelCase")]
    MoveFolder {
        folder_id: String,
        parent_id: Option<String>,
        index: usize,
    },
    /// Takes a folder out of the tree and leaves what it held where a reader
    /// can still reach it: its folders and its canvases move up into the folder
    /// that held it, at the place it held among its own siblings.
    #[serde(rename_all = "camelCase")]
    RemoveFolder { folder_id: String },
    #[serde(rename_all = "camelCase")]
    MoveCanvas {
        canvas_id: CanvasId,
        folder_id: Option<String>,
        index: usize,
    },
    // -------------------------------------------------------------------------
    // The cutting room. Every command names the timeline it works on, and none
    // of them reaches into the canvases: the two halves of a document do not
    // borrow each other's geometry.
    // -------------------------------------------------------------------------
    /// A timeline is added whole — its tracks, clips, and transitions included.
    #[serde(rename_all = "camelCase")]
    AddTimeline {
        timeline: TimelineDocument,
        index: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    RemoveTimeline { timeline_id: TimelineId },
    #[serde(rename_all = "camelCase")]
    RenameTimeline {
        timeline_id: TimelineId,
        name: String,
    },
    /// A change to the timeline's own frame: only what is named moves.
    #[serde(rename_all = "camelCase")]
    UpdateTimelineSettings {
        timeline_id: TimelineId,
        settings: TimelineSettingsPatch,
    },
    /// A track is added empty; its clips arrive by `addClips` naming it.
    #[serde(rename_all = "camelCase")]
    AddTrack {
        timeline_id: TimelineId,
        track: TimelineTrack,
        index: Option<usize>,
    },
    /// Takes a track out only when it holds nothing: taking a track and its
    /// clips in one go is a deletion the reader did not watch.
    #[serde(rename_all = "camelCase")]
    RemoveTrack {
        timeline_id: TimelineId,
        track_id: TrackId,
    },
    #[serde(rename_all = "camelCase")]
    UpdateTrack {
        timeline_id: TimelineId,
        track_id: TrackId,
        patch: TrackPatch,
    },
    /// Clips land together — a division or a paste arrives as many clips in one
    /// step of history. `seams` restores transitions together with the clips
    /// they join, read as already in place: nothing is pulled back, while
    /// `addTransitions` is the command that makes a seam.
    #[serde(rename_all = "camelCase")]
    AddClips {
        timeline_id: TimelineId,
        clips: Vec<TimelineClip>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seams: Option<Vec<TimelineTransition>>,
    },
    #[serde(rename_all = "camelCase")]
    RemoveClips {
        timeline_id: TimelineId,
        clip_ids: Vec<ClipId>,
    },
    #[serde(rename_all = "camelCase")]
    UpdateClips {
        timeline_id: TimelineId,
        patches: Vec<ClipPatchEntry>,
    },
    /// Only where a clip sits: `start_ms` on the timeline's clock and, when the
    /// clip lands on another row, the `track_id` it lands on.
    #[serde(rename_all = "camelCase")]
    MoveClips {
        timeline_id: TimelineId,
        moves: Vec<ClipMove>,
    },
    /// A transition lands on a butted seam, and the command pulls the follower
    /// back by the window's length itself. A batch is listed left to right.
    #[serde(rename_all = "camelCase")]
    AddTransitions {
        timeline_id: TimelineId,
        transitions: Vec<TimelineTransition>,
    },
    /// Transitions come off their seams and the followers take their places
    /// back. A batch is listed left to right, and seams this batch itself
    /// undoes do not count against it.
    #[serde(rename_all = "camelCase")]
    RemoveTransitions {
        timeline_id: TimelineId,
        transition_ids: Vec<TransitionId>,
    },
    // -------------------------------------------------------------------------
    // The story room. Everything here names the story it works on and nothing
    // else: a story is a document of its own, and the steps that fill it in do
    // not reach into the canvases or the cutting room.
    // -------------------------------------------------------------------------
    /// A story arrives whole — its brief, and whatever the steps have settled.
    #[serde(rename_all = "camelCase")]
    AddStory {
        story: StoryDocument,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    /// Takes a story out of the project.
    ///
    /// What it assembled is left standing: the timeline it wrote stays in the
    /// cutting room with its clips, because a film a reader can still watch is
    /// not this command's to throw away. What goes is the record of the story
    /// having made it.
    #[serde(rename_all = "camelCase")]
    RemoveStory { story_id: String },
    #[serde(rename_all = "camelCase")]
    RenameStory { story_id: String, name: String },
    /// A change to what the whole telling rests on. Only the fields the patch
    /// carries move, and nothing already made is remade.
    #[serde(rename_all = "camelCase")]
    UpdateStoryBrief {
        story_id: String,
        patch: StoryBriefPatch,
    },
    /// Only the granularity moves; clips already made are kept as they are.
    #[serde(rename_all = "camelCase")]
    UpdateStoryGranularity {
        story_id: String,
        shot_granularity: StoryShotGranularity,
    },
    /// Only the picture limit moves; frames already drawn are kept as they are.
    #[serde(rename_all = "camelCase")]
    UpdateStoryReferenceLimit {
        story_id: String,
        max_reference_images: u32,
    },
    /// The outline, whole.
    ///
    /// A chapter arriving with an id the story already knows keeps its board
    /// and everything settled on it, and only its words are replaced.
    #[serde(rename_all = "camelCase")]
    SetStoryChapters {
        story_id: String,
        chapters: Vec<story::StoryChapter>,
    },
    /// The cast, whole: a known element keeps its drawings and the reader's
    /// answers about them.
    #[serde(rename_all = "camelCase")]
    SetStoryElements {
        story_id: String,
        elements: Vec<story::StoryElement>,
    },
    #[serde(rename_all = "camelCase")]
    UpdateStoryElement {
        story_id: String,
        element_id: String,
        patch: StoryElementPatch,
    },
    /// The voice the telling reads lines in that belong to no character, and
    /// the one every character without a voice of its own falls back to. A
    /// null takes it away rather than leaving it holding nothing.
    #[serde(rename_all = "camelCase")]
    UpdateStoryNarrator {
        story_id: String,
        narrator: Option<story::StoryVoiceProfile>,
    },
    /// One episode's board, whole: a known act keeps its frames and its clip.
    #[serde(rename_all = "camelCase")]
    SetStoryActs {
        story_id: String,
        chapter_id: String,
        acts: Vec<story::StoryAct>,
    },
    /// Only the fields the patch carries move; a sound is replaced as one thing.
    #[serde(rename_all = "camelCase")]
    UpdateStoryAct {
        story_id: String,
        chapter_id: String,
        act_id: String,
        patch: StoryActPatch,
    },
    #[serde(rename_all = "camelCase")]
    UpdateStoryKeyframe {
        story_id: String,
        chapter_id: String,
        act_id: String,
        keyframe_id: String,
        patch: StoryKeyframePatch,
    },
    /// One place's takes, whole.
    ///
    /// Whole rather than one take added at a time, because keeping an older
    /// take and dropping the newest is as ordinary as the reverse.
    ///
    /// `read` is what a line of dialogue was read as, for a `lineVoice`
    /// target: the words the board holds for it, and the tone it was read in.
    #[serde(rename_all = "camelCase")]
    SetStorySlot {
        story_id: String,
        target: StorySlotTarget,
        slot: StorySlot,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        read: Option<StoryVoiceRead>,
    },
    /// A step of the telling settled, or taken back. The reader's own word
    /// about a step rather than a reading of the content: what a step still
    /// needs is derived from the document, and this is the one thing that
    /// opens the step after it.
    #[serde(rename_all = "camelCase")]
    ConfirmStoryStep {
        story_id: String,
        step: story::StoryStep,
        confirmed: bool,
    },
    /// What the story was assembled into, whole.
    #[serde(rename_all = "camelCase")]
    SetStoryEdit {
        story_id: String,
        patch: StoryEditPatch,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PointValue {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckNodeRef {
    pub canvas_id: CanvasId,
    pub node_id: NodeId,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelfCheckReason {
    Missing,
    Changed,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckIssue {
    pub asset_id: AssetId,
    pub name: String,
    pub expected_path: String,
    pub reason: SelfCheckReason,
    pub referencing_nodes: Vec<SelfCheckNodeRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckReport {
    pub ok: bool,
    pub issues: Vec<SelfCheckIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_id: Option<CanvasId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<NodeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<EdgeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_id: Option<TimelineId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_id: Option<TrackId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_id: Option<ClipId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_id: Option<TransitionId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStepRecord {
    pub node_id: NodeId,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<IsoTimestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<IsoTimestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// What kind of trouble the step hit, and the values behind it, so a client
    /// can say it again in the reader's own language. Absent for a step that
    /// failed before there was anything to classify it by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_details: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_asset_ids: Option<Vec<AssetId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_text: Option<String>,
    /// The handle a step that runs as an upstream job is polled by. Absent for
    /// a step that was waited out, which is most of them.
    ///
    /// This is the handle this process issued, not the provider's own; the
    /// model configuration that created the job is recovered from the node's
    /// model reference, so a poll cannot be pointed somewhere else by editing
    /// this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_created_at: Option<IsoTimestamp>,
    /// How much of the step has happened, 0 to 1. Absent means nobody has
    /// said, which is not the same as "nothing yet": a provider that reports no
    /// progress leaves this unset rather than claiming zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: RunId,
    pub project_id: ProjectId,
    pub canvas_id: CanvasId,
    pub requested_node_ids: Vec<NodeId>,
    pub status: RunStatus,
    pub executor_key: String,
    pub graph_hash: String,
    pub parameters: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_of_run_id: Option<RunId>,
    /// The conversation that asked for this, when a conversation did.
    ///
    /// Held by the record rather than by the document, because it is the record
    /// that is read when an answer is filed: a card on the canvas asks for
    /// itself, but a card made on somebody's behalf has to be told whose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_session_id: Option<SessionId>,
    pub steps: Vec<RunStepRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The trouble the run ended on, as the step that hit it classified it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_details: Option<serde_json::Value>,
    pub cancel_requested: bool,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
}

pub fn now_iso() -> IsoTimestamp {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// The few characters of an id that stand for it inside a name.
///
/// Read off the end of the id rather than its front, which is the whole of it:
/// an id spells when it was made in its first characters, so its head is the
/// same for everything made in the same minute — a tag taken from there is one
/// tag for two drawings of one batch, and the second file is written over the
/// first.
pub fn id_tag(id: &str, keep: usize) -> String {
    let chars: Vec<char> = id.chars().collect();
    chars[chars.len().saturating_sub(keep)..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sound card's input ports, pinned so the two tables stay in
    /// lockstep: `NODE_PORTS.audio` in `src/shared/domain/constants.ts` reads
    /// the same list, and the second one is where a recording wired in hands a
    /// voice-copying converter the voice it copies.
    #[test]
    fn the_sound_card_takes_words_and_one_recording() {
        let ports = derive_ports(NodeKind::Audio);
        let inputs: Vec<&str> = ports
            .iter()
            .filter(|port| port.direction == PortDirection::Input)
            .map(|port| port.id.as_str())
            .collect();
        assert_eq!(inputs, ["prompt", "audio"]);
    }
}
