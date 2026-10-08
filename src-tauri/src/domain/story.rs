//! The story room: what a telling is made of, the guardrails it is kept
//! within, and the commands that settle one step of it.
//!
//! The rules live here rather than in `commands.rs` for the reason the cutting
//! room's do: the document validator reads the same functions the commands do,
//! so what a command writes and what a check accepts cannot drift apart.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use super::commands::CommandError;
use super::{
    AssetId, ClipId, DocumentCommand, IsoTimestamp, MokaFile, TimelineId, ValidationIssue,
};

pub const STORY_SCHEMA_VERSION: i32 = 1;
pub const MAX_STORIES_PER_PROJECT: usize = 20;
pub const STORY_NAME_MAX: usize = 60;
pub const STORY_IDEA_MAX: usize = 20_000;
pub const MAX_CHAPTERS_PER_STORY: usize = 60;
pub const MAX_ELEMENTS_PER_STORY: usize = 200;
pub const MAX_TAKES_PER_SLOT: usize = 12;
pub const MAX_ACTS_PER_CHAPTER: usize = 30;
pub const MAX_KEYFRAMES_PER_ACT: usize = 12;
/// How many of a frame's mentioned reference pictures its ask carries when the
/// story says nothing, and the most it may be set to carry.
pub const REFERENCE_IMAGES_DEFAULT: u32 = 3;
pub const REFERENCE_IMAGES_MAX: u32 = 9;
pub const MAX_DIALOGUE_LINES_PER_KEYFRAME: usize = 12;
pub const MAX_DIALOGUE_LINE_LENGTH: usize = 500;
/// What a voice named in a story may be called, and what it may say of itself.
pub const VOICE_MODEL_MAX: usize = 120;
pub const VOICE_NAME_MAX: usize = 120;
pub const VOICE_INSTRUCTIONS_MAX: usize = 500;
/// The pace and pitch a character may claim, the bounds the preferences hold to.
pub const VOICE_RATE_MIN: f64 = 0.5;
pub const VOICE_RATE_MAX: f64 = 2.0;
pub const VOICE_PITCH_MIN: f64 = 0.5;
pub const VOICE_PITCH_MAX: f64 = 2.0;
pub const MIN_KEYFRAME_MS: i64 = 400;
pub const MAX_KEYFRAME_MS: i64 = 60_000;
pub const MIN_TOTAL_DURATION_MS: i64 = 30_000;
pub const MAX_TOTAL_DURATION_MS: i64 = 8 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// The words a story's enums are written in
// -----------------------------------------------------------------------------

/// An enum a document may name in a word this build does not know.
///
/// A board is words a model wrote and a reader edited, and a word this build
/// has no meaning for is not a reason to refuse the whole project: the field
/// is read as the plainest thing it could be, which is what the TypeScript
/// codec does with the same document. The two languages have to agree about
/// what they will read, so the leniency is spelled on both sides.
pub trait WordEnum: Sized {
    fn from_word(word: &str) -> Option<Self>;
    /// What this is called when the word is one this build does not know.
    fn plainest() -> Self;
}

/// Reads a word from any `WordEnum`, falling back rather than refusing.
pub fn word<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: WordEnum + Deserialize<'de>,
{
    let word = String::deserialize(deserializer)?;
    Ok(T::from_word(&word).unwrap_or_else(T::plainest))
}

macro_rules! word_enum {
    ($name:ident, $plainest:ident, { $($word:literal => $variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $word)] $variant,)+
        }

        impl $name {
            pub fn as_str(&self) -> &'static str {
                match self {
                    $(Self::$variant => $word,)+
                }
            }
        }

        impl WordEnum for $name {
            fn from_word(word: &str) -> Option<Self> {
                match word {
                    $($word => Some(Self::$variant),)+
                    _ => None,
                }
            }

            fn plainest() -> Self {
                Self::$plainest
            }
        }
    };
}

word_enum!(StoryAspect, Widescreen, {
    "16:9" => Widescreen,
    "9:16" => Vertical,
    "1:1" => Square,
    "4:3" => Classic,
    "21:9" => Cinema,
});

word_enum!(StoryElementKind, Prop, {
    "character" => Character,
    "scene" => Scene,
    "prop" => Prop,
});

word_enum!(StoryShotSize, Medium, {
    "extremeClose" => ExtremeClose,
    "close" => Close,
    "mediumClose" => MediumClose,
    "medium" => Medium,
    "mediumFull" => MediumFull,
    "full" => Full,
    "wide" => Wide,
    "extremeWide" => ExtremeWide,
});

word_enum!(StoryCameraMove, Static, {
    "static" => Static,
    "handheld" => Handheld,
    "pushIn" => PushIn,
    "pullOut" => PullOut,
    "panLeft" => PanLeft,
    "panRight" => PanRight,
    "tiltUp" => TiltUp,
    "tiltDown" => TiltDown,
    "trackLeft" => TrackLeft,
    "trackRight" => TrackRight,
    "arc" => Arc,
    "craneUp" => CraneUp,
    "zoomIn" => ZoomIn,
    "zoomOut" => ZoomOut,
});

word_enum!(StoryCameraAngle, EyeLevel, {
    "eyeLevel" => EyeLevel,
    "high" => High,
    "low" => Low,
    "overhead" => Overhead,
    "dutch" => Dutch,
    "overTheShoulder" => OverTheShoulder,
    "pointOfView" => PointOfView,
});

word_enum!(StoryShotGranularity, Act, {
    "act" => Act,
    "keyframe" => Keyframe,
});

word_enum!(StoryFilmRole, Reference, {
    "reference" => Reference,
    "firstFrame" => FirstFrame,
    "firstLastFrame" => FirstLastFrame,
});

/// A frame nothing has been said about is a reference, the way a frame with no
/// words is a medium shot: the plain word is what the absence meant anyway.
fn plain_film_role() -> StoryFilmRole {
    StoryFilmRole::Reference
}

fn is_plain_film_role(role: &StoryFilmRole) -> bool {
    *role == StoryFilmRole::Reference
}

// -----------------------------------------------------------------------------
// What a telling is made of
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryBrief {
    pub idea: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_split: Option<bool>,
    pub total_duration_ms: i64,
    #[serde(deserialize_with = "word")]
    pub aspect: StoryAspect,
    pub genre: String,
    pub style: String,
}

/// The fields a caller may move on a brief, for `updateStoryBrief`.
///
/// The three fields that may be absent are double-layered the way an act's
/// scene is: left off leaves the field where it was, and a null takes it away,
/// since the undo of adding a manuscript has to be able to say so.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryBriefPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::deserialize_double_option"
    )]
    pub source_asset_id: Option<Option<AssetId>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::deserialize_double_option"
    )]
    pub source_name: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::deserialize_double_option"
    )]
    pub source_split: Option<Option<bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aspect: Option<StoryAspect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

/// One filmed piece filed into a place. An act too long for one film is made
/// of several, so a take carries a list of files — written and read as
/// `assetIds`, the list the room, the wire and the file all speak. A document
/// from when a take was a single file carries a lone `assetId`, and is read as
/// the one-file list it means.
#[derive(Debug, Clone, PartialEq)]
pub struct StoryTake {
    pub asset_ids: Vec<AssetId>,
    pub job_id: Option<String>,
    pub item_id: Option<String>,
    pub note: Option<String>,
    pub created_at: IsoTimestamp,
}

impl Serialize for StoryTake {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("assetIds", &self.asset_ids)?;
        if let Some(job_id) = &self.job_id {
            map.serialize_entry("jobId", job_id)?;
        }
        if let Some(item_id) = &self.item_id {
            map.serialize_entry("itemId", item_id)?;
        }
        if let Some(note) = &self.note {
            map.serialize_entry("note", note)?;
        }
        map.serialize_entry("createdAt", &self.created_at)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for StoryTake {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            #[serde(default)]
            asset_id: Option<AssetId>,
            #[serde(default)]
            asset_ids: Option<Vec<AssetId>>,
            #[serde(default)]
            job_id: Option<String>,
            #[serde(default)]
            item_id: Option<String>,
            #[serde(default)]
            note: Option<String>,
            created_at: IsoTimestamp,
        }
        let wire = Wire::deserialize(deserializer)?;
        let asset_ids = match (wire.asset_id, wire.asset_ids) {
            (_, Some(asset_ids)) if !asset_ids.is_empty() => asset_ids,
            (Some(asset_id), None) => vec![asset_id],
            (_, Some(_)) => {
                return Err(serde::de::Error::invalid_value(
                    serde::de::Unexpected::Seq,
                    &"a take with at least one file",
                ));
            }
            (None, None) => return Err(serde::de::Error::missing_field("assetIds")),
        };
        Ok(StoryTake {
            asset_ids,
            job_id: wire.job_id,
            item_id: wire.item_id,
            note: wire.note,
            created_at: wire.created_at,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorySlot {
    pub takes: Vec<StoryTake>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryDialogueLine {
    /// The line's own name, which is what a take of it read aloud is filed
    /// under. Written before lines had names, so a document may leave it off:
    /// the client gives such a line one as it reads, and the field is written
    /// only once there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_id: Option<String>,
    pub speaker: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
}

/// One line of dialogue read aloud, and what it says.
///
/// Kept per line rather than per act because every character speaks in their
/// own voice: the words as they were read — which is how a line edited since
/// is told from one that has not been — and the tone it was read in, so the
/// card can say whose voice it is without reading the voice chain again.
/// What a line of dialogue was read as, for the card that shows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryVoiceRead {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub voice: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryVoiceTake {
    #[serde(default)]
    pub line_id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub voice: String,
    pub slot: StorySlot,
}

/// The voice a character or a narrator speaks in: which model reads it, in
/// which tone, and how. Every field left empty falls through to the next layer
/// of the chain the client resolves — the story's narrator, the machine's own
/// speech pick, and then the deployment's default.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryVoiceProfile {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub voice: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pitch: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// A recording this voice is copied from, when it is heard rather than
    /// named. A voice has two ways of being said — a name the provider knows
    /// and a piece of sound to imitate — and this is the second.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_asset_id: Option<AssetId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryKeyframe {
    pub id: String,
    pub title: String,
    #[serde(deserialize_with = "word")]
    pub shot_size: StoryShotSize,
    #[serde(deserialize_with = "word")]
    pub camera_move: StoryCameraMove,
    #[serde(deserialize_with = "word")]
    pub angle: StoryCameraAngle,
    /// How the frame is used when the act is shot: the head of a video of its
    /// own, the pair of a first-and-last video together with the frame after
    /// it, or one of the references a video is drawn from. Left off when plain,
    /// which is what a board that has never heard of roles means.
    #[serde(
        default = "plain_film_role",
        skip_serializing_if = "is_plain_film_role",
        deserialize_with = "word"
    )]
    pub film_role: StoryFilmRole,
    pub content: String,
    pub dialogue: Vec<StoryDialogueLine>,
    pub duration_ms: i64,
    pub art: StorySlot,
    pub video: StorySlot,
    /// The lines of this shot read aloud, each in its own speaker's voice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voices: Option<Vec<StoryVoiceTake>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryActSound {
    pub music: String,
    pub sfx: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambience: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryAct {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub character_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    pub prop_ids: Vec<String>,
    pub sound: StoryActSound,
    pub keyframes: Vec<StoryKeyframe>,
    pub video: StorySlot,
    /// The lines read aloud, and the music under them. Absent rather than
    /// empty on a telling that was never voiced: the two say different things,
    /// and only one of them is a reader who has not asked yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<StorySlot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub music: Option<StorySlot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryChapter {
    pub id: String,
    pub title: String,
    pub synopsis: String,
    pub target_duration_ms: i64,
    pub acts: Vec<StoryAct>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryElement {
    pub id: String,
    #[serde(deserialize_with = "word")]
    pub kind: StoryElementKind,
    pub name: String,
    pub description: String,
    pub chapter_ids: Vec<String>,
    pub main: StorySlot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turnaround: Option<StorySlot>,
    /// The voice this character speaks in, when the reader has given it one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<StoryVoiceProfile>,
}

/// One clip this story's assembly laid down.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryEditClip {
    pub act_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyframe_id: Option<String>,
    pub clip_id: ClipId,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryEdit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_id: Option<TimelineId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_by_act: Option<Vec<StoryEditClip>>,
    /// What the timeline was laid down from, as one short reading of it. A
    /// document written before this existed carries none, which the room reads
    /// as "the film is behind the telling".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assembled_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryDocument {
    pub id: String,
    pub name: String,
    pub schema_version: i32,
    pub brief: StoryBrief,
    pub chapters: Vec<StoryChapter>,
    pub elements: Vec<StoryElement>,
    #[serde(deserialize_with = "word")]
    pub shot_granularity: StoryShotGranularity,
    /// How many of a frame's mentioned reference pictures its ask may carry;
    /// a document written before the limit existed carries the default.
    #[serde(default = "default_max_reference_images")]
    pub max_reference_images: u32,
    /// Which steps of the telling the reader has settled, in telling order.
    /// The one thing a step's own press writes; everything else about a step's
    /// completeness is read off the content itself.
    #[serde(default)]
    pub confirmed_steps: Vec<StoryStep>,
    #[serde(default)]
    pub edit: StoryEdit,
    /// The voice lines that belong to no character are read in, and the one
    /// every character without a voice of its own falls back to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrator: Option<StoryVoiceProfile>,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
}

/// The five steps of a telling, in the order they are told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoryStep {
    Idea,
    Outline,
    Elements,
    Storyboard,
    Edit,
}

fn default_max_reference_images() -> u32 {
    REFERENCE_IMAGES_DEFAULT
}

/// A place in a story that holds a slot, as a command and a job name it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StorySlotTarget {
    #[serde(rename_all = "camelCase")]
    Element {
        element_id: String,
        view: StoryElementView,
    },
    #[serde(rename_all = "camelCase")]
    Keyframe {
        chapter_id: String,
        act_id: String,
        keyframe_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ActVideo { chapter_id: String, act_id: String },
    #[serde(rename_all = "camelCase")]
    KeyframeVideo {
        chapter_id: String,
        act_id: String,
        keyframe_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ActVoice { chapter_id: String, act_id: String },
    #[serde(rename_all = "camelCase")]
    LineVoice {
        chapter_id: String,
        act_id: String,
        keyframe_id: String,
        line_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ActMusic { chapter_id: String, act_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoryElementView {
    Main,
    Turnaround,
}

/// The fields a caller may move on an element, for `updateStoryElement`.
///
/// `voice` is double-layered the way an act's `scene_id` is: left off leaves
/// the voice where it was, and a null takes it away, since a character with no
/// voice named and a character whose voice was cleared are the same character.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryElementPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<StoryElementKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_ids: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::deserialize_double_option"
    )]
    pub voice: Option<Option<StoryVoiceProfile>>,
}

/// The fields a caller may move on an act, for `updateStoryAct`.
///
/// `scene_id` is double-layered the way a clip's grade is: left off leaves the
/// scene where it was, and a null takes it away, since a story with no scene
/// named and a story whose scene was cleared are the same story.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryActPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_ids: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::deserialize_double_option"
    )]
    pub scene_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prop_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<StoryActSound>,
}

/// The fields a caller may move on a shot, for `updateStoryKeyframe`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryKeyframePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shot_size: Option<StoryShotSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_move: Option<StoryCameraMove>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle: Option<StoryCameraAngle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub film_role: Option<StoryFilmRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialogue: Option<Vec<StoryDialogueLine>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

/// The fields a caller may move on an assembly, for `setStoryEdit`.
///
/// Every field is double-layered: left off leaves it where it was, and a null
/// takes it away — a story whose assembly was cleared is one that was never
/// assembled, and the undo of assembling it has to say so.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryEditPatch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::deserialize_double_option"
    )]
    pub timeline_id: Option<Option<TimelineId>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::deserialize_double_option"
    )]
    pub clip_by_act: Option<Option<Vec<StoryEditClip>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::deserialize_double_option"
    )]
    pub assembled_digest: Option<Option<String>>,
}

impl StoryDocument {
    /// Every asset this telling points at: its manuscript, its drawings, and
    /// the clips it made.
    pub fn asset_references(&self) -> Vec<AssetId> {
        let mut found: Vec<AssetId> = Vec::new();
        let mut add = |asset_id: &Option<AssetId>| {
            if let Some(asset_id) = asset_id {
                found.push(asset_id.clone());
            }
        };
        add(&self.brief.source_asset_id);
        let mut slot = |held: &StorySlot| {
            for take in &held.takes {
                found.extend(take.asset_ids.iter().cloned());
            }
        };
        for element in &self.elements {
            slot(&element.main);
            if let Some(turnaround) = &element.turnaround {
                slot(turnaround);
            }
        }
        for chapter in &self.chapters {
            for act in &chapter.acts {
                slot(&act.video);
                if let Some(voice) = &act.voice {
                    slot(voice);
                }
                if let Some(music) = &act.music {
                    slot(music);
                }
                for keyframe in &act.keyframes {
                    slot(&keyframe.art);
                    slot(&keyframe.video);
                    for take in keyframe.voices.iter().flatten() {
                        slot(&take.slot);
                    }
                }
            }
        }
        found
    }

    /// The act a chapter id and an act id name.
    pub fn act(&self, chapter_id: &str, act_id: &str) -> Option<&StoryAct> {
        self.chapters
            .iter()
            .find(|chapter| chapter.id == chapter_id)?
            .acts
            .iter()
            .find(|act| act.id == act_id)
    }

    /// The slot a target names, with the mistake it would be read as.
    ///
    /// Owned rather than borrowed: the two sound slots are absent on a telling
    /// that was never voiced, and an absent slot answers as the empty one — a
    /// take can be written into a place the reader has not asked about yet,
    /// and the undo of that write has nothing to put back.
    fn slot(&self, target: &StorySlotTarget) -> Result<StorySlot, CommandError> {
        match target {
            StorySlotTarget::Element { element_id, view } => {
                let element = self
                    .elements
                    .iter()
                    .find(|element| &element.id == element_id)
                    .ok_or_else(story_target_invalid)?;
                match view {
                    StoryElementView::Main => Ok(element.main.clone()),
                    StoryElementView::Turnaround => {
                        element.turnaround.clone().ok_or_else(story_target_invalid)
                    }
                }
            }
            StorySlotTarget::Keyframe {
                chapter_id,
                act_id,
                keyframe_id,
            } => self
                .keyframe(chapter_id, act_id, keyframe_id)
                .map(|keyframe| keyframe.art.clone())
                .ok_or_else(story_target_invalid),
            StorySlotTarget::KeyframeVideo {
                chapter_id,
                act_id,
                keyframe_id,
            } => self
                .keyframe(chapter_id, act_id, keyframe_id)
                .map(|keyframe| keyframe.video.clone())
                .ok_or_else(story_target_invalid),
            StorySlotTarget::ActVideo { chapter_id, act_id } => self
                .act(chapter_id, act_id)
                .map(|act| act.video.clone())
                .ok_or_else(story_target_invalid),
            StorySlotTarget::ActVoice { chapter_id, act_id } => self
                .act(chapter_id, act_id)
                .map(|act| act.voice.clone().unwrap_or_default())
                .ok_or_else(story_target_invalid),
            StorySlotTarget::ActMusic { chapter_id, act_id } => self
                .act(chapter_id, act_id)
                .map(|act| act.music.clone().unwrap_or_default())
                .ok_or_else(story_target_invalid),
            // The line's take is read off the shot, not off the line: a line
            // edited or taken out of the board leaves its take where it was,
            // so that what was said is not lost by what was said afterwards.
            StorySlotTarget::LineVoice {
                chapter_id,
                act_id,
                keyframe_id,
                line_id,
            } => self
                .keyframe(chapter_id, act_id, keyframe_id)
                .map(|keyframe| {
                    keyframe
                        .voices
                        .iter()
                        .flatten()
                        .find(|take| &take.line_id == line_id)
                        .map(|take| take.slot.clone())
                        .unwrap_or_default()
                })
                .ok_or_else(story_target_invalid),
        }
    }

    /// The take a line-voice target names, with the words it was read as.
    fn voice_take(&self, target: &StorySlotTarget) -> Option<StoryVoiceTake> {
        let StorySlotTarget::LineVoice {
            chapter_id,
            act_id,
            keyframe_id,
            line_id,
        } = target
        else {
            return None;
        };
        self.keyframe(chapter_id, act_id, keyframe_id)?
            .voices
            .iter()
            .flatten()
            .find(|take| &take.line_id == line_id)
            .cloned()
    }

    fn keyframe(
        &self,
        chapter_id: &str,
        act_id: &str,
        keyframe_id: &str,
    ) -> Option<&StoryKeyframe> {
        self.act(chapter_id, act_id)?
            .keyframes
            .iter()
            .find(|keyframe| keyframe.id == keyframe_id)
    }

    /// This story with a slot written where the target names it.
    fn with_slot(
        &self,
        target: &StorySlotTarget,
        slot: StorySlot,
        read: Option<StoryVoiceRead>,
    ) -> StoryDocument {
        let mut next = self.clone();
        match target {
            StorySlotTarget::Element { element_id, view } => {
                for element in next.elements.iter_mut() {
                    if &element.id != element_id {
                        continue;
                    }
                    match view {
                        StoryElementView::Main => element.main = slot.clone(),
                        StoryElementView::Turnaround => element.turnaround = Some(slot.clone()),
                    }
                }
            }
            StorySlotTarget::Keyframe {
                chapter_id,
                act_id,
                keyframe_id,
            } => {
                for chapter in next.chapters.iter_mut() {
                    if &chapter.id != chapter_id {
                        continue;
                    }
                    for act in chapter.acts.iter_mut() {
                        if &act.id != act_id {
                            continue;
                        }
                        for keyframe in act.keyframes.iter_mut() {
                            if &keyframe.id == keyframe_id {
                                keyframe.art = slot.clone();
                            }
                        }
                    }
                }
            }
            StorySlotTarget::KeyframeVideo {
                chapter_id,
                act_id,
                keyframe_id,
            } => {
                for chapter in next.chapters.iter_mut() {
                    if &chapter.id != chapter_id {
                        continue;
                    }
                    for act in chapter.acts.iter_mut() {
                        if &act.id != act_id {
                            continue;
                        }
                        for keyframe in act.keyframes.iter_mut() {
                            if &keyframe.id == keyframe_id {
                                keyframe.video = slot.clone();
                            }
                        }
                    }
                }
            }
            StorySlotTarget::ActVideo { chapter_id, act_id } => {
                for chapter in next.chapters.iter_mut() {
                    if &chapter.id != chapter_id {
                        continue;
                    }
                    for act in chapter.acts.iter_mut() {
                        if &act.id == act_id {
                            act.video = slot.clone();
                        }
                    }
                }
            }
            StorySlotTarget::ActVoice { chapter_id, act_id } => {
                for chapter in next.chapters.iter_mut() {
                    if &chapter.id != chapter_id {
                        continue;
                    }
                    for act in chapter.acts.iter_mut() {
                        if &act.id == act_id {
                            act.voice = kept_sound_slot(slot.clone());
                        }
                    }
                }
            }
            StorySlotTarget::ActMusic { chapter_id, act_id } => {
                for chapter in next.chapters.iter_mut() {
                    if &chapter.id != chapter_id {
                        continue;
                    }
                    for act in chapter.acts.iter_mut() {
                        if &act.id == act_id {
                            act.music = kept_sound_slot(slot.clone());
                        }
                    }
                }
            }
            StorySlotTarget::LineVoice {
                chapter_id,
                act_id,
                keyframe_id,
                line_id,
            } => {
                for chapter in next.chapters.iter_mut() {
                    if &chapter.id != chapter_id {
                        continue;
                    }
                    for act in chapter.acts.iter_mut() {
                        if &act.id != act_id {
                            continue;
                        }
                        for keyframe in act.keyframes.iter_mut() {
                            if &keyframe.id == keyframe_id {
                                with_voice_take(keyframe, line_id, slot.clone(), read.clone());
                            }
                        }
                    }
                }
            }
        }
        next
    }
}

fn story_target_invalid() -> CommandError {
    CommandError::new("STORY_TARGET_INVALID", "The story does not hold that")
}

/// One of an act's two sound slots as the document keeps it.
///
/// An empty slot is kept as no slot at all: the two would say different things
/// about a place a reader has not asked about yet, and the undo of the first
/// take ever made for an act has to put the document back the way it was —
/// which is without the slot, not with an empty one.
/// One line's take kept on its shot, whole.
///
/// A slot that has come to hold nothing takes the whole entry with it: the two
/// would say different things about a line nobody has read yet, and the undo of
/// the first reading has to put the document back the way it was — without the
/// entry, not with an empty one. What the line was read as is kept beside the
/// takes, so the card can say the words the recording holds even after the line
/// beside them was rewritten. The entries stand in the order their lines do on
/// the board, so that two rooms holding the same reading write the same
/// document; a take whose line has left the shot is not on the board to be
/// ordered by, and comes last.
fn with_voice_take(
    keyframe: &mut StoryKeyframe,
    line_id: &str,
    slot: StorySlot,
    read: Option<StoryVoiceRead>,
) {
    let order: BTreeMap<&str, usize> = keyframe
        .dialogue
        .iter()
        .enumerate()
        .map(|(at, line)| (line.id.as_deref().unwrap_or(""), at))
        .collect();
    let held = keyframe.voices.take().unwrap_or_default();
    let before = held.iter().find(|take| take.line_id == line_id).cloned();
    let rest: Vec<StoryVoiceTake> = held
        .into_iter()
        .filter(|take| take.line_id != line_id)
        .collect();
    if slot.takes.is_empty() {
        keyframe.voices = if rest.is_empty() { None } else { Some(rest) };
        return;
    }
    let text = read
        .as_ref()
        .map(|read| read.text.clone())
        .or_else(|| before.as_ref().map(|take| take.text.clone()))
        .unwrap_or_default();
    let voice = read
        .as_ref()
        .map(|read| read.voice.clone())
        .or_else(|| before.as_ref().map(|take| take.voice.clone()))
        .unwrap_or_default();
    let mut voices = rest;
    voices.push(StoryVoiceTake {
        line_id: line_id.to_string(),
        text,
        voice,
        slot,
    });
    voices.sort_by_key(|take| {
        order
            .get(take.line_id.as_str())
            .copied()
            .unwrap_or(usize::MAX)
    });
    keyframe.voices = Some(voices);
}

fn kept_sound_slot(slot: StorySlot) -> Option<StorySlot> {
    if slot.takes.is_empty() {
        None
    } else {
        Some(slot)
    }
}

// -----------------------------------------------------------------------------
// Guardrails
// -----------------------------------------------------------------------------

/// An issue that belongs to no canvas, node, or timeline: a story's own.
///
/// The validator's own shape, built here because the story room is where a
/// story's troubles are known; `validate.rs` reads it for the same reason.
pub fn issue(code: &str, message: String) -> ValidationIssue {
    ValidationIssue {
        code: code.into(),
        message,
        canvas_id: None,
        node_id: None,
        port_id: None,
        edge_id: None,
        timeline_id: None,
        track_id: None,
        clip_id: None,
        transition_id: None,
    }
}

/// A story that says a possible thing, read over a document this build did
/// not necessarily write.
pub fn validate_story(story: &StoryDocument) -> Vec<ValidationIssue> {
    let mut issues: Vec<ValidationIssue> = Vec::new();

    if story.name.is_empty() || story.name.chars().count() > STORY_NAME_MAX {
        issues.push(issue(
            "STORY_NAME_INVALID",
            "Story name is empty or too long".into(),
        ));
    }
    if story.schema_version > STORY_SCHEMA_VERSION {
        issues.push(issue(
            "STORY_SCHEMA_NEWER",
            "Story schema is newer than this build reads".into(),
        ));
    }
    if !(MIN_TOTAL_DURATION_MS..=MAX_TOTAL_DURATION_MS).contains(&story.brief.total_duration_ms) {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!(
                "Story running time {} is out of range",
                story.brief.total_duration_ms
            ),
        ));
    }
    if story.chapters.len() > MAX_CHAPTERS_PER_STORY {
        issues.push(issue("STORY_CHAPTER_LIMIT", "Chapter limit reached".into()));
    }
    if story.elements.len() > MAX_ELEMENTS_PER_STORY {
        issues.push(issue("STORY_ELEMENT_LIMIT", "Element limit reached".into()));
    }
    if story.max_reference_images > REFERENCE_IMAGES_MAX {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!(
                "Story reference picture limit {} is out of range",
                story.max_reference_images
            ),
        ));
    }

    let mut slots: Vec<&StorySlot> = Vec::new();
    for element in &story.elements {
        slots.push(&element.main);
        if let Some(turnaround) = &element.turnaround {
            slots.push(turnaround);
        }
    }
    for chapter in &story.chapters {
        if chapter.acts.len() > MAX_ACTS_PER_CHAPTER {
            issues.push(issue("STORY_ACT_LIMIT", "Act limit reached".into()));
        }
        for act in &chapter.acts {
            slots.push(&act.video);
            if act.keyframes.len() > MAX_KEYFRAMES_PER_ACT {
                issues.push(issue(
                    "STORY_KEYFRAME_LIMIT",
                    "Keyframe limit reached".into(),
                ));
            }
            for keyframe in &act.keyframes {
                slots.push(&keyframe.art);
                slots.push(&keyframe.video);
                if !(MIN_KEYFRAME_MS..=MAX_KEYFRAME_MS).contains(&keyframe.duration_ms) {
                    issues.push(issue(
                        "VALIDATION_FAILED",
                        format!("Shot duration {} is out of range", keyframe.duration_ms),
                    ));
                }
            }
        }
    }
    for held in slots {
        if held.takes.len() > MAX_TAKES_PER_SLOT {
            issues.push(issue(
                "STORY_SLOT_FULL",
                "A place holds too many takes".into(),
            ));
        }
    }
    issues
}

// -----------------------------------------------------------------------------
// The commands
// -----------------------------------------------------------------------------

/// The stories a project carries, or carrying the field not at all when it has
/// none — the same honest reading the timelines give an unused cutting room.
fn with_stories(moka: &MokaFile, stories: Vec<StoryDocument>) -> MokaFile {
    MokaFile {
        stories: if stories.is_empty() {
            None
        } else {
            Some(stories)
        },
        ..moka.clone()
    }
}

fn story_of<'a>(moka: &'a MokaFile, story_id: &str) -> Result<&'a StoryDocument, CommandError> {
    moka.stories
        .iter()
        .flatten()
        .find(|story| story.id == story_id)
        .ok_or_else(|| CommandError::new("STORY_NOT_FOUND", "Story not found"))
}

/// Puts a changed story back as it was handed over.
///
/// The story's own `updated_at` is the caller's to move, the way a timeline's
/// is: one date that changed on every undo as well as every edit would say
/// less than the edits do.
fn replace_story(moka: &MokaFile, story: StoryDocument) -> MokaFile {
    let stories: Vec<StoryDocument> = moka
        .stories
        .iter()
        .flatten()
        .map(|held| {
            if held.id == story.id {
                story.clone()
            } else {
                held.clone()
            }
        })
        .collect();
    with_stories(moka, stories)
}

fn check_story_name(name: &str) -> Result<(), CommandError> {
    if name.is_empty() {
        return Err(CommandError::new(
            "STORY_NAME_INVALID",
            "Story name is empty",
        ));
    }
    if name.chars().count() > STORY_NAME_MAX {
        return Err(CommandError::new(
            "STORY_NAME_INVALID",
            "Story name is too long",
        ));
    }
    Ok(())
}

fn check_story_brief(brief: &StoryBrief) -> Result<(), CommandError> {
    if !(MIN_TOTAL_DURATION_MS..=MAX_TOTAL_DURATION_MS).contains(&brief.total_duration_ms) {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Story running time is out of range",
        ));
    }
    Ok(())
}

/// A story's own guardrails, read before anything of it is written down.
fn check_story(story: &StoryDocument) -> Result<(), CommandError> {
    check_story_name(&story.name)?;
    if story.schema_version > STORY_SCHEMA_VERSION {
        return Err(CommandError::new(
            "STORY_SCHEMA_NEWER",
            "Story schema is newer than this build reads",
        ));
    }
    if story.chapters.len() > MAX_CHAPTERS_PER_STORY {
        return Err(CommandError::new(
            "STORY_CHAPTER_LIMIT",
            "Chapter limit reached",
        ));
    }
    if story.elements.len() > MAX_ELEMENTS_PER_STORY {
        return Err(CommandError::new(
            "STORY_ELEMENT_LIMIT",
            "Element limit reached",
        ));
    }
    if story.max_reference_images > REFERENCE_IMAGES_MAX {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Story reference picture limit is out of range",
        ));
    }
    for chapter in &story.chapters {
        if chapter.acts.len() > MAX_ACTS_PER_CHAPTER {
            return Err(CommandError::new("STORY_ACT_LIMIT", "Act limit reached"));
        }
        for act in &chapter.acts {
            if act.keyframes.len() > MAX_KEYFRAMES_PER_ACT {
                return Err(CommandError::new(
                    "STORY_KEYFRAME_LIMIT",
                    "Keyframe limit reached",
                ));
            }
        }
    }
    check_story_brief(&story.brief)
}

/// A slot a caller may file: the takes trimmed to what one place keeps, with
/// the oldest let go first, and no take kept twice.
fn check_slot(slot: StorySlot) -> StorySlot {
    let mut seen: BTreeSet<Vec<AssetId>> = BTreeSet::new();
    let takes: Vec<StoryTake> = slot
        .takes
        .into_iter()
        .filter(|take| seen.insert(take.asset_ids.clone()))
        .collect();
    let takes = if takes.len() > MAX_TAKES_PER_SLOT {
        takes[takes.len() - MAX_TAKES_PER_SLOT..].to_vec()
    } else {
        takes
    };
    StorySlot { takes }
}

/// The voice a character or a narrator is given: a model and a tone named
/// within reason, and a pace and pitch the providers all accept.
fn check_voice(voice: &StoryVoiceProfile) -> Result<(), CommandError> {
    if voice.model.chars().count() > VOICE_MODEL_MAX
        || voice.voice.chars().count() > VOICE_NAME_MAX
        || voice
            .instructions
            .as_ref()
            .is_some_and(|instructions| instructions.chars().count() > VOICE_INSTRUCTIONS_MAX)
    {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "The voice's model, tone, or manner is too long",
        ));
    }
    if let Some(rate) = voice.rate {
        if !(VOICE_RATE_MIN..=VOICE_RATE_MAX).contains(&rate) {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "The voice's pace is out of range",
            ));
        }
    }
    if let Some(pitch) = voice.pitch {
        if !(VOICE_PITCH_MIN..=VOICE_PITCH_MAX).contains(&pitch) {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "The voice's pitch is out of range",
            ));
        }
    }
    Ok(())
}

/// What a line was read as, held to the bounds the line itself is: the words a
/// recording holds are as long as the words a shot may be written with, and the
/// tone is a name like any other.
fn check_voice_read(read: &StoryVoiceRead) -> Result<(), CommandError> {
    if read.text.chars().count() > MAX_DIALOGUE_LINE_LENGTH {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Dialogue is too long for one shot",
        ));
    }
    if read.voice.chars().count() > VOICE_NAME_MAX {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "The voice's model, tone, or manner is too long",
        ));
    }
    Ok(())
}

fn check_dialogue(lines: &[StoryDialogueLine]) -> Result<(), CommandError> {
    if lines.len() > MAX_DIALOGUE_LINES_PER_KEYFRAME {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Dialogue is too long for one shot",
        ));
    }
    // A patch comes from a client that has read the document, so every line it
    // carries has a name: two lines sharing one would be two lines with one
    // take of it read aloud between them.
    let mut seen: Vec<&str> = Vec::with_capacity(lines.len());
    for line in lines {
        if line.text.trim().is_empty() || line.speaker.is_empty() {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "A dialogue line has no words in it",
            ));
        }
        match line.id.as_deref() {
            Some(id) if !id.trim().is_empty() && !seen.contains(&id) => seen.push(id),
            _ => {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "A dialogue line has no name of its own",
                ))
            }
        }
        if line.text.chars().count() > MAX_DIALOGUE_LINE_LENGTH {
            return Err(CommandError::new(
                "VALIDATION_FAILED",
                "Dialogue is too long for one shot",
            ));
        }
    }
    Ok(())
}

/// Applies one of the story room's commands and returns the new document plus
/// the inverse commands. Anything else is a programming error: `commands.rs`
/// routes only the story variants here.
pub fn apply_story_command(
    moka: &MokaFile,
    command: &DocumentCommand,
) -> Result<(MokaFile, Vec<DocumentCommand>), CommandError> {
    match command {
        DocumentCommand::AddStory { story, index } => {
            let stories = moka.stories.clone().unwrap_or_default();
            if stories.len() + 1 > MAX_STORIES_PER_PROJECT {
                return Err(CommandError::new(
                    "STORY_LIMIT_REACHED",
                    "Story limit reached",
                ));
            }
            if stories.iter().any(|held| held.id == story.id) {
                return Err(CommandError::new(
                    "STORY_ID_EXISTS",
                    "Story id already exists",
                ));
            }
            check_story(story)?;
            let at = index.unwrap_or(stories.len()).min(stories.len());
            let mut list = stories;
            list.insert(at, story.clone());
            Ok((
                with_stories(moka, list),
                vec![DocumentCommand::RemoveStory {
                    story_id: story.id.clone(),
                }],
            ))
        }
        DocumentCommand::RemoveStory { story_id } => {
            let stories = moka.stories.clone().unwrap_or_default();
            let Some(at) = stories.iter().position(|held| &held.id == story_id) else {
                return Err(CommandError::new("STORY_NOT_FOUND", "Story not found"));
            };
            let removed = stories[at].clone();
            let list: Vec<StoryDocument> = stories
                .into_iter()
                .filter(|held| &held.id != story_id)
                .collect();
            // Put back whole, at the place it was read: a story is a document
            // in its own right, so everything settled in it comes back with it.
            Ok((
                with_stories(moka, list),
                vec![DocumentCommand::AddStory {
                    story: removed,
                    index: Some(at),
                }],
            ))
        }
        DocumentCommand::RenameStory { story_id, name } => {
            let story = story_of(moka, story_id)?;
            check_story_name(name)?;
            let previous = story.name.clone();
            let mut next = story.clone();
            next.name = name.clone();
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::RenameStory {
                    story_id: story_id.clone(),
                    name: previous,
                }],
            ))
        }
        DocumentCommand::UpdateStoryBrief { story_id, patch } => {
            let story = story_of(moka, story_id)?;
            let previous = StoryBriefPatch {
                idea: patch.idea.as_ref().map(|_| story.brief.idea.clone()),
                source_asset_id: patch
                    .source_asset_id
                    .as_ref()
                    .map(|_| story.brief.source_asset_id.clone()),
                source_name: patch
                    .source_name
                    .as_ref()
                    .map(|_| story.brief.source_name.clone()),
                source_split: patch
                    .source_split
                    .as_ref()
                    .map(|_| story.brief.source_split),
                total_duration_ms: patch
                    .total_duration_ms
                    .map(|_| story.brief.total_duration_ms),
                aspect: patch.aspect.map(|_| story.brief.aspect),
                genre: patch.genre.as_ref().map(|_| story.brief.genre.clone()),
                style: patch.style.as_ref().map(|_| story.brief.style.clone()),
            };
            let mut brief = story.brief.clone();
            if let Some(idea) = &patch.idea {
                brief.idea = idea.clone();
            }
            // A key that is present moves, and a key carrying null goes: the
            // two rules are one rule, which is what makes the inverse exact.
            if let Some(source_asset_id) = &patch.source_asset_id {
                brief.source_asset_id = source_asset_id.clone();
            }
            if let Some(source_name) = &patch.source_name {
                brief.source_name = source_name.clone();
            }
            if let Some(source_split) = patch.source_split {
                brief.source_split = source_split;
            }
            if let Some(total) = patch.total_duration_ms {
                brief.total_duration_ms = total;
            }
            if let Some(aspect) = patch.aspect {
                brief.aspect = aspect;
            }
            if let Some(genre) = &patch.genre {
                brief.genre = genre.clone();
            }
            if let Some(style) = &patch.style {
                brief.style = style.clone();
            }
            check_story_brief(&brief)?;
            let mut next = story.clone();
            next.brief = brief;
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::UpdateStoryBrief {
                    story_id: story_id.clone(),
                    patch: previous,
                }],
            ))
        }
        DocumentCommand::UpdateStoryGranularity {
            story_id,
            shot_granularity,
        } => {
            let story = story_of(moka, story_id)?;
            let previous = story.shot_granularity;
            let mut next = story.clone();
            next.shot_granularity = *shot_granularity;
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::UpdateStoryGranularity {
                    story_id: story_id.clone(),
                    shot_granularity: previous,
                }],
            ))
        }
        DocumentCommand::UpdateStoryReferenceLimit {
            story_id,
            max_reference_images,
        } => {
            let story = story_of(moka, story_id)?;
            if *max_reference_images > REFERENCE_IMAGES_MAX {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Story reference picture limit is out of range",
                ));
            }
            let previous = story.max_reference_images;
            let mut next = story.clone();
            next.max_reference_images = *max_reference_images;
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::UpdateStoryReferenceLimit {
                    story_id: story_id.clone(),
                    max_reference_images: previous,
                }],
            ))
        }
        DocumentCommand::SetStoryChapters { story_id, chapters } => {
            let story = story_of(moka, story_id)?;
            if chapters.len() > MAX_CHAPTERS_PER_STORY {
                return Err(CommandError::new(
                    "STORY_CHAPTER_LIMIT",
                    "Chapter limit reached",
                ));
            }
            let held: BTreeMap<&str, &Vec<StoryAct>> = story
                .chapters
                .iter()
                .map(|chapter| (chapter.id.as_str(), &chapter.acts))
                .collect();
            // A chapter that keeps its id keeps its board: re-writing an
            // outline is not a reason to throw away what was shot from it.
            let merged: Vec<StoryChapter> = chapters
                .iter()
                .map(|chapter| StoryChapter {
                    acts: held
                        .get(chapter.id.as_str())
                        .map(|acts| (*acts).clone())
                        .unwrap_or_default(),
                    ..chapter.clone()
                })
                .collect();
            let mut next = story.clone();
            next.chapters = merged;
            check_story(&next)?;
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::SetStoryChapters {
                    story_id: story_id.clone(),
                    chapters: story.chapters.clone(),
                }],
            ))
        }
        DocumentCommand::SetStoryElements { story_id, elements } => {
            let story = story_of(moka, story_id)?;
            if elements.len() > MAX_ELEMENTS_PER_STORY {
                return Err(CommandError::new(
                    "STORY_ELEMENT_LIMIT",
                    "Element limit reached",
                ));
            }
            let held: BTreeMap<&str, &StoryElement> = story
                .elements
                .iter()
                .map(|element| (element.id.as_str(), element))
                .collect();
            // The drawings and the voice stay with the element they were made
            // for; what a new reading brings is its words, and the voice is
            // one of the reader's answers, so a re-listing that says nothing
            // of it leaves the voice standing.
            let merged: Vec<StoryElement> = elements
                .iter()
                .map(|element| match held.get(element.id.as_str()) {
                    Some(before) => StoryElement {
                        main: before.main.clone(),
                        turnaround: before.turnaround.clone(),
                        voice: element.voice.clone().or_else(|| before.voice.clone()),
                        ..element.clone()
                    },
                    None => element.clone(),
                })
                .collect();
            let mut next = story.clone();
            next.elements = merged;
            check_story(&next)?;
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::SetStoryElements {
                    story_id: story_id.clone(),
                    elements: story.elements.clone(),
                }],
            ))
        }
        DocumentCommand::UpdateStoryElement {
            story_id,
            element_id,
            patch,
        } => {
            let story = story_of(moka, story_id)?;
            let element = story
                .elements
                .iter()
                .find(|held| &held.id == element_id)
                .ok_or_else(story_target_invalid)?;
            if let Some(name) = &patch.name {
                let name = name.trim();
                if name.is_empty() || name.chars().count() > STORY_NAME_MAX {
                    return Err(CommandError::new(
                        "STORY_NAME_INVALID",
                        "Element name is empty or too long",
                    ));
                }
            }
            if let Some(description) = &patch.description {
                if description.chars().count() > STORY_IDEA_MAX {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "Description is too long",
                    ));
                }
            }
            if let Some(chapter_ids) = &patch.chapter_ids {
                if chapter_ids
                    .iter()
                    .any(|id| !story.chapters.iter().any(|chapter| &chapter.id == id))
                {
                    return Err(CommandError::new(
                        "STORY_TARGET_INVALID",
                        "Chapter not found in this story",
                    ));
                }
            }
            if let Some(Some(voice)) = &patch.voice {
                check_voice(voice)?;
            }
            let previous = StoryElementPatch {
                name: patch.name.as_ref().map(|_| element.name.clone()),
                kind: patch.kind.map(|_| element.kind),
                description: patch
                    .description
                    .as_ref()
                    .map(|_| element.description.clone()),
                chapter_ids: patch
                    .chapter_ids
                    .as_ref()
                    .map(|_| element.chapter_ids.clone()),
                // A voice the element did not hold is written back as an
                // explicit clearing, so that undoing the first voice left on a
                // character takes it off again rather than leaving it standing.
                voice: patch.voice.as_ref().map(|_| element.voice.clone()),
            };
            let mut next = story.clone();
            for held in next.elements.iter_mut() {
                if &held.id != element_id {
                    continue;
                }
                if let Some(name) = &patch.name {
                    held.name = name.trim().to_string();
                }
                if let Some(kind) = patch.kind {
                    held.kind = kind;
                }
                if let Some(description) = &patch.description {
                    held.description = description.clone();
                }
                if let Some(chapter_ids) = &patch.chapter_ids {
                    held.chapter_ids = chapter_ids.clone();
                }
                if let Some(voice) = &patch.voice {
                    held.voice = voice.clone();
                }
            }
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::UpdateStoryElement {
                    story_id: story_id.clone(),
                    element_id: element_id.clone(),
                    patch: previous,
                }],
            ))
        }
        DocumentCommand::UpdateStoryNarrator { story_id, narrator } => {
            let story = story_of(moka, story_id)?;
            if let Some(narrator) = narrator {
                check_voice(narrator)?;
            }
            let previous = story.narrator.clone();
            let mut next = story.clone();
            // A telling left without a voice of its own leaves the field off
            // rather than holding nothing: what it says then is that nobody
            // has said.
            next.narrator = narrator.clone();
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::UpdateStoryNarrator {
                    story_id: story_id.clone(),
                    narrator: previous,
                }],
            ))
        }
        DocumentCommand::SetStoryActs {
            story_id,
            chapter_id,
            acts,
        } => {
            let story = story_of(moka, story_id)?;
            let chapter = story
                .chapters
                .iter()
                .find(|held| &held.id == chapter_id)
                .ok_or_else(story_target_invalid)?;
            if acts.len() > MAX_ACTS_PER_CHAPTER {
                return Err(CommandError::new("STORY_ACT_LIMIT", "Act limit reached"));
            }
            for act in acts {
                if act.keyframes.len() > MAX_KEYFRAMES_PER_ACT {
                    return Err(CommandError::new(
                        "STORY_KEYFRAME_LIMIT",
                        "Keyframe limit reached",
                    ));
                }
            }
            let held_acts: BTreeMap<&str, &StoryAct> = chapter
                .acts
                .iter()
                .map(|act| (act.id.as_str(), act))
                .collect();
            let merged: Vec<StoryAct> = acts
                .iter()
                .map(|act| {
                    // A reference to an element that is no longer in the story
                    // is kept as it was written: the room draws it greyed out
                    // and says so, which is more use than a board that quietly
                    // lost the character it names.
                    let mut cleaned = act.clone();
                    let mut seen: BTreeSet<String> = BTreeSet::new();
                    cleaned.character_ids.retain(|id| seen.insert(id.clone()));
                    let mut seen: BTreeSet<String> = BTreeSet::new();
                    cleaned.prop_ids.retain(|id| seen.insert(id.clone()));
                    let Some(before) = held_acts.get(act.id.as_str()) else {
                        return cleaned;
                    };
                    let held_frames: BTreeMap<&str, &StoryKeyframe> = before
                        .keyframes
                        .iter()
                        .map(|keyframe| (keyframe.id.as_str(), keyframe))
                        .collect();
                    let keyframes: Vec<StoryKeyframe> = cleaned
                        .keyframes
                        .iter()
                        .map(|keyframe| match held_frames.get(keyframe.id.as_str()) {
                            Some(frame) => StoryKeyframe {
                                art: frame.art.clone(),
                                video: frame.video.clone(),
                                ..keyframe.clone()
                            },
                            None => keyframe.clone(),
                        })
                        .collect();
                    StoryAct {
                        video: before.video.clone(),
                        keyframes,
                        ..cleaned
                    }
                })
                .collect();
            let mut next = story.clone();
            if let Some(index) = next.chapters.iter().position(|held| &held.id == chapter_id) {
                next.chapters[index].acts = merged;
            }
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::SetStoryActs {
                    story_id: story_id.clone(),
                    chapter_id: chapter_id.clone(),
                    acts: chapter.acts.clone(),
                }],
            ))
        }
        DocumentCommand::UpdateStoryAct {
            story_id,
            chapter_id,
            act_id,
            patch,
        } => {
            let story = story_of(moka, story_id)?;
            let act = story
                .act(chapter_id, act_id)
                .ok_or_else(story_target_invalid)?;
            let previous = StoryActPatch {
                title: patch.title.as_ref().map(|_| act.title.clone()),
                summary: patch.summary.as_ref().map(|_| act.summary.clone()),
                character_ids: patch
                    .character_ids
                    .as_ref()
                    .map(|_| act.character_ids.clone()),
                scene_id: patch.scene_id.as_ref().map(|_| act.scene_id.clone()),
                prop_ids: patch.prop_ids.as_ref().map(|_| act.prop_ids.clone()),
                sound: patch.sound.as_ref().map(|_| act.sound.clone()),
            };
            let mut next = story.clone();
            for chapter in next.chapters.iter_mut() {
                if &chapter.id != chapter_id {
                    continue;
                }
                for held in chapter.acts.iter_mut() {
                    if &held.id != act_id {
                        continue;
                    }
                    if let Some(title) = &patch.title {
                        held.title = title.clone();
                    }
                    if let Some(summary) = &patch.summary {
                        held.summary = summary.clone();
                    }
                    if let Some(ids) = &patch.character_ids {
                        held.character_ids = ids.clone();
                    }
                    if let Some(scene) = &patch.scene_id {
                        held.scene_id = scene.clone();
                    }
                    if let Some(ids) = &patch.prop_ids {
                        held.prop_ids = ids.clone();
                    }
                    if let Some(sound) = &patch.sound {
                        held.sound = sound.clone();
                    }
                }
            }
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::UpdateStoryAct {
                    story_id: story_id.clone(),
                    chapter_id: chapter_id.clone(),
                    act_id: act_id.clone(),
                    patch: previous,
                }],
            ))
        }
        DocumentCommand::UpdateStoryKeyframe {
            story_id,
            chapter_id,
            act_id,
            keyframe_id,
            patch,
        } => {
            let story = story_of(moka, story_id)?;
            let act = story
                .act(chapter_id, act_id)
                .ok_or_else(story_target_invalid)?;
            let keyframe = act
                .keyframes
                .iter()
                .find(|held| &held.id == keyframe_id)
                .ok_or_else(story_target_invalid)?;
            if let Some(duration) = patch.duration_ms {
                if !(MIN_KEYFRAME_MS..=MAX_KEYFRAME_MS).contains(&duration) {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "Shot duration is out of range",
                    ));
                }
            }
            if let Some(dialogue) = &patch.dialogue {
                check_dialogue(dialogue)?;
            }
            let previous = StoryKeyframePatch {
                title: patch.title.as_ref().map(|_| keyframe.title.clone()),
                shot_size: patch.shot_size.map(|_| keyframe.shot_size),
                camera_move: patch.camera_move.map(|_| keyframe.camera_move),
                angle: patch.angle.map(|_| keyframe.angle),
                film_role: patch.film_role.map(|_| keyframe.film_role),
                content: patch.content.as_ref().map(|_| keyframe.content.clone()),
                dialogue: patch.dialogue.as_ref().map(|_| keyframe.dialogue.clone()),
                duration_ms: patch.duration_ms.map(|_| keyframe.duration_ms),
            };
            let mut next = story.clone();
            for chapter in next.chapters.iter_mut() {
                if &chapter.id != chapter_id {
                    continue;
                }
                for held in chapter.acts.iter_mut() {
                    if &held.id != act_id {
                        continue;
                    }
                    for frame in held.keyframes.iter_mut() {
                        if &frame.id != keyframe_id {
                            continue;
                        }
                        if let Some(title) = &patch.title {
                            frame.title = title.clone();
                        }
                        if let Some(shot_size) = patch.shot_size {
                            frame.shot_size = shot_size;
                        }
                        if let Some(camera_move) = patch.camera_move {
                            frame.camera_move = camera_move;
                        }
                        if let Some(angle) = patch.angle {
                            frame.angle = angle;
                        }
                        if let Some(film_role) = patch.film_role {
                            frame.film_role = film_role;
                        }
                        if let Some(content) = &patch.content {
                            frame.content = content.clone();
                        }
                        if let Some(dialogue) = &patch.dialogue {
                            frame.dialogue = dialogue.clone();
                        }
                        if let Some(duration) = patch.duration_ms {
                            frame.duration_ms = duration;
                        }
                    }
                }
            }
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::UpdateStoryKeyframe {
                    story_id: story_id.clone(),
                    chapter_id: chapter_id.clone(),
                    act_id: act_id.clone(),
                    keyframe_id: keyframe_id.clone(),
                    patch: previous,
                }],
            ))
        }
        DocumentCommand::SetStorySlot {
            story_id,
            target,
            slot,
            read,
        } => {
            let story = story_of(moka, story_id)?;
            let previous = story.slot(target)?;
            if let Some(read) = read {
                check_voice_read(read)?;
            }
            // What the entry said before this write, so that the undo of
            // replacing one reading with another brings the old words and
            // their tone back.
            let before = story.voice_take(target);
            let said = read.clone().or_else(|| {
                before.as_ref().map(|take| StoryVoiceRead {
                    text: take.text.clone(),
                    voice: take.voice.clone(),
                })
            });
            let next = story.with_slot(target, check_slot(slot.clone()), said);
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::SetStorySlot {
                    story_id: story_id.clone(),
                    target: target.clone(),
                    slot: previous,
                    read: before.map(|take| StoryVoiceRead {
                        text: take.text,
                        voice: take.voice,
                    }),
                }],
            ))
        }
        DocumentCommand::ConfirmStoryStep {
            story_id,
            step,
            confirmed,
        } => {
            let story = story_of(moka, story_id)?;
            let mut steps = story.confirmed_steps.clone();
            if *confirmed {
                if !steps.contains(step) {
                    steps.push(*step);
                }
            } else {
                steps.retain(|held| held != step);
            }
            // Kept in telling order rather than in the order the presses came,
            // so a document confirmed step by step reads as the telling does.
            steps.sort();
            steps.dedup();
            let mut next = story.clone();
            next.confirmed_steps = steps;
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::ConfirmStoryStep {
                    story_id: story_id.clone(),
                    step: *step,
                    confirmed: !*confirmed,
                }],
            ))
        }
        DocumentCommand::SetStoryEdit { story_id, patch } => {
            let story = story_of(moka, story_id)?;
            if let Some(Some(timeline_id)) = &patch.timeline_id {
                let held = moka
                    .timelines
                    .iter()
                    .flatten()
                    .any(|timeline| &timeline.id == timeline_id);
                if !held {
                    return Err(CommandError::new(
                        "TIMELINE_NOT_FOUND",
                        "Timeline not found",
                    ));
                }
            }
            let previous = StoryEditPatch {
                timeline_id: patch
                    .timeline_id
                    .as_ref()
                    .map(|_| story.edit.timeline_id.clone()),
                clip_by_act: patch
                    .clip_by_act
                    .as_ref()
                    .map(|_| story.edit.clip_by_act.clone()),
                assembled_digest: patch
                    .assembled_digest
                    .as_ref()
                    .map(|_| story.edit.assembled_digest.clone()),
            };
            let mut edit = story.edit.clone();
            if let Some(timeline_id) = &patch.timeline_id {
                edit.timeline_id = timeline_id.clone();
            }
            if let Some(clips) = &patch.clip_by_act {
                edit.clip_by_act = clips.clone();
            }
            if let Some(digest) = &patch.assembled_digest {
                if let Some(digest) = digest {
                    let shaped = digest.len() == 8
                        && digest
                            .chars()
                            .all(|at| at.is_ascii_digit() || ('a'..='f').contains(&at));
                    if !shaped {
                        return Err(CommandError::new(
                            "VALIDATION_FAILED",
                            "An assembly's digest is eight hexadecimal digits",
                        ));
                    }
                }
                edit.assembled_digest = digest.clone();
            }
            let mut next = story.clone();
            next.edit = edit;
            Ok((
                replace_story(moka, next),
                vec![DocumentCommand::SetStoryEdit {
                    story_id: story_id.clone(),
                    patch: previous,
                }],
            ))
        }
        _ => Err(CommandError::new(
            "VALIDATION_FAILED",
            "Not a story command",
        )),
    }
}
