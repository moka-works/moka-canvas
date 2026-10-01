pub mod codec;
pub mod package;
pub mod store;

use crate::domain::{AssetProvenance, MokaFile, ResourceEntry, SelfCheckReport};
use crate::story::StoryJobRecord;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("{0}")]
    Codec(#[from] codec::CodecError),
    #[error("{code}: {message}")]
    Domain { code: &'static str, message: String },
    #[error("package error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl ProjectError {
    pub fn domain(code: &'static str, message: impl Into<String>) -> Self {
        Self::Domain {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Codec(error) => error.code(),
            Self::Domain { code, .. } => code,
            Self::Zip(_) => "PACKAGE_INVALID",
            Self::Io(_) => "INTERNAL",
        }
    }
}

pub struct OpenProject {
    pub root: PathBuf,
    pub moka: MokaFile,
    pub self_check: SelfCheckReport,
    /// Whether the read behind the check has finished; false while the files
    /// whose contents could not be spoken for by their sizes are still being
    /// read, and the report may grow.
    pub self_check_verified: bool,
}

pub struct CreateProject {
    pub name: String,
    /// What the interface calls a new project's first canvas, in the language
    /// it is being drawn in. Absent when the caller has no language to give:
    /// the scaffold then falls back to its own English name.
    pub first_canvas_name: Option<String>,
}

#[derive(Debug)]
pub struct SaveResult {
    pub revision: i32,
    pub updated_at: String,
}

/// Result of an asset mutation; every asset change persists the document,
/// so the caller always learns the new revision.
#[derive(Debug)]
pub struct AssetChange {
    pub entry: ResourceEntry,
    pub revision: i32,
    pub updated_at: String,
}

/// Result of putting a node's work on the shelf.
///
/// Filing the same text node twice answers with the entry the first call made
/// rather than a second copy of it, so `created` says which call this was.
#[derive(Debug)]
pub struct FiledAsset {
    pub change: AssetChange,
    pub created: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ByteRange {
    pub start: u64,
    pub end: Option<u64>,
}

pub struct StagedAsset {
    pub name: String,
    pub tmp_path: PathBuf,
    pub declared_mime: Option<String>,
    pub category_hint: Option<String>,
    /// Where the asset came from, for the ones that were made rather than
    /// imported. Only `add_asset` reads it: replacing an existing asset's bytes
    /// keeps the provenance that entry already carries.
    pub provenance: Option<AssetProvenance>,
}

pub struct AssetFile {
    pub entry: ResourceEntry,
    pub path: PathBuf,
    pub range: Option<ByteRange>,
}

/// What a reader says about an asset, put right on its own.
///
/// A part left out is a part nobody spoke about, so it stands as it was — the
/// shelf edits one corner of an entry at a time, and saying nothing is not the
/// same as taking something back. An empty note or keyword does take it back:
/// there is no other way to say so from a text field.
#[derive(Debug, Clone, Default)]
pub struct AssetShelfEdit {
    pub tags: Option<Vec<String>>,
    pub note: Option<String>,
    pub favorite: Option<bool>,
    pub keyword: Option<String>,
}

pub struct PackageReport {
    pub destination: PathBuf,
    pub entries: usize,
    pub bytes: u64,
    pub incomplete: bool,
}

/// What a package carries beyond the work itself.
///
/// The default is a package of the work: the canvases, the assets, and the asks
/// that made them, which is what somebody else could pick up and keep making
/// with. What this machine did to the project, and material nobody has placed on
/// a canvas, are both left out unless they are asked for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PackageScope {
    /// The records of the runs this machine made, which carry the prompts they
    /// were asked with and the names of the models that answered. For moving
    /// one's own project to another machine, not for handing it over.
    pub personal_history: bool,
    /// Only the assets a canvas points at, leaving out material nobody placed.
    pub referenced_assets_only: bool,
}

/// One open project: what every room reads and writes.
///
/// Opening, making and importing a project are what a [`ProjectRegistry`] is
/// for, since they are what a project is made *by*; everything here is asked
/// of a project that is already open.
///
/// [`ProjectRegistry`]: store::ProjectRegistry
#[async_trait::async_trait]
pub trait ProjectStore: Send + Sync {
    async fn current(&self) -> Result<Option<OpenProject>, ProjectError>;
    /// The open project's root, without the document that stands in it.
    ///
    /// A caller that wants somewhere to put something — a drawing of a picture,
    /// a package going out — asks this rather than reading the document back
    /// out to throw it away.
    async fn project_root(&self) -> Result<PathBuf, ProjectError>;
    /// The open project's latest file check, and whether the read behind it has
    /// finished. `None` when no project is open.
    async fn self_check_status(&self) -> Result<Option<(SelfCheckReport, bool)>, ProjectError>;
    async fn apply_commands(
        &self,
        expected_revision: i32,
        commands: Vec<crate::domain::DocumentCommand>,
    ) -> Result<SaveResult, ProjectError>;
    async fn add_asset(&self, staged: StagedAsset) -> Result<AssetChange, ProjectError>;
    async fn remove_asset(&self, id: &str) -> Result<SaveResult, ProjectError>;
    async fn replace_asset_bytes(
        &self,
        id: &str,
        staged: StagedAsset,
    ) -> Result<AssetChange, ProjectError>;
    /// Writes what a reader says about an asset. The registry entry is all it
    /// touches: the file underneath is neither read nor re-hashed, so a note
    /// added to a video costs nothing of the video's.
    async fn update_asset_shelf(
        &self,
        id: &str,
        edit: AssetShelfEdit,
    ) -> Result<AssetChange, ProjectError>;
    /// Puts what a node holds onto the shelf.
    ///
    /// A text node's words are read from the document and written into the
    /// project as a file of their own, so they do not have to travel up from
    /// the browser a second time. A node that already holds a file keeps that
    /// file and is marked as kept to hand. Filing the same text node again
    /// answers with the entry the first call made.
    async fn file_node_as_asset(
        &self,
        canvas_id: &str,
        node_id: &str,
    ) -> Result<FiledAsset, ProjectError>;
    async fn asset_file(
        &self,
        id: &str,
        range: Option<ByteRange>,
    ) -> Result<AssetFile, ProjectError>;
    async fn export_package(
        &self,
        destination: &Path,
        allow_incomplete: bool,
        scope: PackageScope,
    ) -> Result<PackageReport, ProjectError>;
    async fn list_runs(&self) -> Result<Vec<crate::domain::RunRecord>, ProjectError>;
    async fn create_run(
        &self,
        run: crate::domain::RunRecord,
    ) -> Result<crate::domain::RunRecord, ProjectError>;
    async fn get_run(&self, id: &str) -> Result<crate::domain::RunRecord, ProjectError>;
    async fn update_run(
        &self,
        run: crate::domain::RunRecord,
    ) -> Result<crate::domain::RunRecord, ProjectError>;
    /// Keeps a record of work a provider is still doing, so the poll that
    /// collects it can be placed again after this process has been restarted.
    ///
    /// The payload is opaque here on purpose: what a job is belongs to the layer
    /// that placed it, and what this layer promises is only that the record
    /// stays inside the project and out of an exported package.
    async fn record_job(&self, id: &str, record: serde_json::Value) -> Result<(), ProjectError>;
    /// Drops one, because the job answered or nobody is coming back for it.
    async fn drop_job(&self, id: &str) -> Result<(), ProjectError>;
    /// The record kept for one job, if there still is one.
    async fn job(&self, id: &str) -> Result<Option<serde_json::Value>, ProjectError>;
    /// The story jobs this project has been asked for, newest first.
    ///
    /// Reading the list also sweeps the old records away: what a project keeps
    /// is the recent batches and every batch that has not settled, and nothing
    /// else reads the directory to notice the rest.
    async fn list_story_jobs(&self) -> Result<Vec<StoryJobRecord>, ProjectError>;
    async fn create_story_job(&self, job: StoryJobRecord) -> Result<StoryJobRecord, ProjectError>;
    async fn get_story_job(&self, id: &str) -> Result<StoryJobRecord, ProjectError>;
    async fn update_story_job(&self, job: StoryJobRecord) -> Result<StoryJobRecord, ProjectError>;
}
