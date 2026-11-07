//! Story jobs: a batch of generations told as one piece of work.
//!
//! A canvas run is built around nodes and writing a document back — its record
//! names steps by node and its results are placed on a board. A story's answers
//! land in slots of a story, and one step of a story is dozens of generations
//! at once, so driving them as a run would tie the story room to canvas
//! semantics it does not have. What is here is the smaller machine the batch
//! needs: a record that says what was asked for and how far each piece got, one
//! driver per job, and the same gateway calls a run's steps go through.
//!
//! Nothing reads the document. A job is told what to ask for and is answered in
//! the project's own files; which slot of which story an answer belongs in is
//! the client's to know, and it is the client that writes the story back.

pub mod ingest;
pub mod jobs;
pub mod validate;

pub use jobs::{
    StoryArtView, StoryJobItem, StoryJobKind, StoryJobManager, StoryJobRecord, StoryJobStatus,
    StoryTarget,
};
pub use validate::validate_start;

/// How many generations a batch asks one model to serve at once when it names
/// no count of its own. The room always says; a client that predates the
/// setting gets the number the room used to hard-code.
pub const DEFAULT_PARALLEL_ITEMS: usize = 2;

/// What a failure to start a job says, in the shape the API reports.
///
/// The codes are the ones `story::validate` files its issues under; the status
/// a client reads off them is decided where every other code's status is.
pub const STORY_NOT_FOUND: &str = "STORY_NOT_FOUND";
pub const STORY_JOB_NOT_FOUND: &str = "STORY_JOB_NOT_FOUND";
pub const STORY_JOB_NOT_CANCELLABLE: &str = "STORY_JOB_NOT_CANCELLABLE";
pub const STORY_JOB_BUSY: &str = "STORY_JOB_BUSY";
pub const STORY_JOB_ITEM_LIMIT: &str = "STORY_JOB_ITEM_LIMIT";
pub const STORY_TARGET_INVALID: &str = "STORY_TARGET_INVALID";
