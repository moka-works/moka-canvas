use crate::clip::jobs::ExportRegistry;
use crate::clip::locate::{CapabilityProbe, ClipCapabilities};
use crate::config::{AppConfig, RuntimeMode};
use crate::generate::{Gateway, ModelRepo};
use crate::metadata::{self, MetadataStore};
use crate::project::store::FsProjectStore;
use crate::project::ProjectStore;
use crate::story::StoryJobManager;
use crate::workflow::executor::DeterministicExecutor;
use crate::workflow::provider::ProviderExecutor;
use crate::workflow::runner::RunManager;
use crate::workflow::WorkflowExecutor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub mod dto;
pub mod filesystem;
pub mod problem;
pub mod routes;

#[derive(Clone)]
pub struct ApiState {
    pub mode: RuntimeMode,
    pub config: Arc<AppConfig>,
    pub store: Arc<FsProjectStore>,
    pub metadata: Arc<dyn MetadataStore>,
    pub models: Arc<ModelRepo>,
    pub gateway: Arc<Gateway>,
    pub runs: Arc<RunManager>,
    /// The story room's batches, which drive generations of their own rather
    /// than steps of a graph.
    pub story_jobs: Arc<StoryJobManager>,
    /// Where the timeline exporter finds ffmpeg, and what it can do. Resolved
    /// once per process; a machine without one is not a failure to start.
    clip_probe: Arc<CapabilityProbe>,
    /// The one render this process may be running, and the handles it is
    /// polled with.
    pub exports: Arc<ExportRegistry>,
    /// Root directory of the models tree: one directory per converter, each
    /// carrying its own `model.json`.
    converter_root: PathBuf,
}

impl ApiState {
    /// Opens the metadata directory before anything can serve a request.
    ///
    /// `root` is the location startup validation already resolved and checked
    /// for isolation, so the store never resolves it a second time.
    ///
    /// Fails when the directory is locked by another process, was written by a
    /// newer format version, or holds credentials with no master key available
    /// to open them.
    pub fn new(config: AppConfig, mode: RuntimeMode, root: &Path) -> anyhow::Result<Self> {
        let metadata = metadata::open(root, &config.metadata, mode)?;
        let converter_root = root
            .parent()
            .map(|p| p.join("models"))
            .unwrap_or_else(|| PathBuf::from("models"));
        Ok(Self::with_metadata(config, mode, metadata, converter_root))
    }

    pub fn with_metadata(
        config: AppConfig,
        mode: RuntimeMode,
        metadata: Arc<dyn MetadataStore>,
        converter_root: PathBuf,
    ) -> Self {
        let config = Arc::new(config);
        let store = Arc::new(FsProjectStore::new(Arc::clone(&config)));
        let models = Arc::new(ModelRepo::new(Arc::clone(&metadata)));
        // The same renderer the cutting room exports with, asked for one cut
        // instead: a recognition request names a window of a recording, and a
        // window is made with the program this deployment already has.
        let clip_probe = Arc::new(CapabilityProbe::new(&config.clip));
        let gateway = Arc::new(Gateway::new(
            Arc::clone(&models),
            Arc::clone(&store) as Arc<dyn ProjectStore>,
            config.generate.clone(),
            Some(Arc::new(crate::clip::audio::Windows::new(Arc::clone(
                &clip_probe,
            )))),
        ));
        let provider = Arc::new(ProviderExecutor::new(Arc::clone(&gateway)));
        let executors: Vec<Arc<dyn WorkflowExecutor>> = vec![
            Arc::new(DeterministicExecutor::new()),
            Arc::clone(&provider) as Arc<dyn WorkflowExecutor>,
        ];
        let runs = RunManager::new(
            Arc::clone(&store),
            executors,
            config.active_executors(),
            config.generate.concurrent_runs(),
        );
        let story_jobs = StoryJobManager::new(Arc::clone(&store), provider, config.story.clone());
        Self {
            mode,
            store,
            metadata,
            models,
            gateway,
            config,
            runs,
            story_jobs,
            clip_probe,
            exports: Arc::new(ExportRegistry::new()),
            converter_root,
        }
    }

    /// What the machine's renderer can do, probed once and remembered.
    pub fn clip_capabilities(&self) -> ClipCapabilities {
        self.clip_probe.capabilities()
    }

    /// The renderer this process would run, where one was found.
    ///
    /// The path alone, without asking what the program can do: taking the
    /// sound out of a film uses one stream copy, and a program that turns out
    /// not to be able runs nothing and the file is answered as it is.
    pub fn clip_program(&self) -> Option<std::path::PathBuf> {
        self.clip_probe.program().map(|path| path.to_path_buf())
    }

    /// The models directory: where converter scripts live. Used during
    /// startup to deploy built-in converters and by the API to list the
    /// available protocols.
    pub fn converter_root(&self) -> &Path {
        &self.converter_root
    }
}

pub fn router() -> axum::Router<ApiState> {
    use axum::routing::{delete, get, post, put};
    axum::Router::new()
        .route("/api/v1/config", get(routes::public_config))
        .route("/api/v1/recent-projects", get(routes::list_recent))
        .route(
            "/api/v1/recent-projects/{id}",
            delete(routes::remove_recent),
        )
        .route("/api/v1/projects", post(routes::create_project))
        .route("/api/v1/projects/open", post(routes::open_project))
        .route("/api/v1/projects/import", post(routes::import_project))
        .route("/api/v1/projects/current", get(routes::current_project))
        // The file check lands behind a room: a client that entered before the
        // read finished asks here rather than reading the document again.
        .route(
            "/api/v1/projects/current/self-check",
            get(routes::current_self_check),
        )
        .route(
            "/api/v1/projects/current/commands",
            post(routes::apply_commands),
        )
        .route(
            "/api/v1/projects/current/assets",
            post(routes::upload_asset),
        )
        // A node's own work goes on the shelf through a route of its own: the
        // words are read out of the document here rather than sent up again.
        .route(
            "/api/v1/projects/current/assets/from-node",
            post(routes::file_node_asset),
        )
        // What a reader says about an asset is written onto the entry itself, so
        // it is the entry's own address that takes the patch; the bytes have a
        // separate one.
        .route(
            "/api/v1/projects/current/assets/{id}",
            get(routes::stream_asset)
                .patch(routes::patch_asset_shelf)
                .delete(routes::delete_asset),
        )
        .route(
            "/api/v1/projects/current/assets/{id}/content",
            put(routes::replace_asset),
        )
        // The file's sound alone, for the room's voices: a whole picture file
        // streamed for its sound is what this exists to keep them out of.
        .route(
            "/api/v1/projects/current/assets/{id}/audio",
            get(routes::stream_asset_audio),
        )
        .route(
            "/api/v1/projects/current/assets/{id}/reveal",
            post(routes::reveal_asset),
        )
        // Beside the assets rather than under the generation routes: nothing is
        // asked of anybody, so a reader whose picture could not be worked on has
        // no channel to go and configure and no bill to look at.
        .route(
            "/api/v1/projects/current/tools",
            post(routes::apply_picture_tool),
        )
        .route(
            "/api/v1/projects/current/export",
            post(routes::export_package),
        )
        .route(
            "/api/v1/projects/current/runs",
            get(routes::list_runs).post(routes::start_run),
        )
        .route("/api/v1/projects/current/runs/{id}", get(routes::get_run))
        .route(
            "/api/v1/projects/current/runs/{id}/cancel",
            post(routes::cancel_run),
        )
        .route(
            "/api/v1/projects/current/runs/{id}/retry",
            post(routes::retry_run),
        )
        // The story room's batches, beside the runs: both ask a provider for
        // work, and neither is the other's business.
        .route(
            "/api/v1/projects/current/story/jobs",
            get(routes::list_story_jobs).post(routes::start_story_job),
        )
        .route(
            "/api/v1/projects/current/story/jobs/{id}",
            get(routes::get_story_job),
        )
        .route(
            "/api/v1/projects/current/story/jobs/{id}/cancel",
            post(routes::cancel_story_job),
        )
        // A batch's answer is written into the story by the room, so the room
        // is what says it has been: every room opened later leaves an answer
        // that says so alone.
        .route(
            "/api/v1/projects/current/story/jobs/{id}/read",
            post(routes::read_story_job),
        )
        // Beside the run routes rather than under /generate: it answers from the
        // open document, so it belongs where the rest of the document is read.
        .route(
            "/api/v1/projects/current/generate/preview",
            post(routes::preview_generation),
        )
        .merge(model_router())
        .merge(generate_router())
        .merge(clip_router())
        .merge(filesystem_router())
        .route(
            "/api/v1/converter/protocols",
            get(routes::converter_protocols),
        )
}

/// A generation request carries a prompt and references to assets already in
/// the project, never the assets themselves, so it gets the same tight ceiling
/// as a model write rather than the one an upload needs.
fn generate_router() -> axum::Router<ApiState> {
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{get, post};

    const MAX_GENERATE_BODY_BYTES: usize = 1024 * 1024;

    axum::Router::new()
        .route("/api/v1/generate/text", post(routes::generate_text))
        .route("/api/v1/generate/image", post(routes::generate_image))
        .route("/api/v1/generate/speech", post(routes::generate_speech))
        .route("/api/v1/generate/music", post(routes::generate_music))
        .route("/api/v1/generate/video", post(routes::generate_video))
        .route("/api/v1/generate/asr", post(routes::generate_asr))
        .route(
            "/api/v1/generate/tasks/{id}",
            get(routes::poll_generation_task),
        )
        .route("/api/v1/generate/stream", get(routes::stream_run_events))
        .route_layer(DefaultBodyLimit::max(MAX_GENERATE_BODY_BYTES))
}

/// Rendering a timeline to a video file.
///
/// Its own family of routes rather than one under the project: an export has a
/// handle of its own, is polled by it, and is cancelled by it, which is the
/// same shape the generation tasks answer with. The body is a timeline id and
/// nothing else — how to reach a renderer is never something a request says.
fn clip_router() -> axum::Router<ApiState> {
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{get, post};

    const MAX_CLIP_BODY_BYTES: usize = 64 * 1024;

    axum::Router::new()
        .route("/api/v1/clip/capabilities", get(routes::clip_capabilities))
        .route("/api/v1/clip/export", post(routes::start_clip_export))
        .route(
            "/api/v1/clip/export/{id}",
            get(routes::get_clip_export).delete(routes::cancel_clip_export),
        )
        .route_layer(DefaultBodyLimit::max(MAX_CLIP_BODY_BYTES))
}

/// Model configuration carries a credential in the request body, and a model
/// document is small by nature, so these routes get a far tighter ceiling than
/// asset uploads. The limit is applied last for a request, so it replaces the
/// one the server router sets rather than adding to it.
fn model_router() -> axum::Router<ApiState> {
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{delete, get, patch, post, put};

    const MAX_PROVIDER_BODY_BYTES: usize = 1024 * 1024;

    axum::Router::new()
        .route(
            "/api/v1/models",
            get(routes::list_models).put(routes::upsert_model),
        )
        .route("/api/v1/models/{id}", delete(routes::delete_model))
        .route("/api/v1/models/{id}/key", post(routes::set_model_key))
        .route("/api/v1/models/defaults", patch(routes::patch_defaults))
        .route(
            "/api/v1/models/preferences",
            patch(routes::patch_preferences),
        )
        .route(
            "/api/v1/system/secret-storage",
            put(routes::set_secret_storage),
        )
        .route_layer(DefaultBodyLimit::max(MAX_PROVIDER_BODY_BYTES))
}

/// Where a file dialog's questions are answered.
///
/// Beside the project routes rather than under them: a listing answers where a
/// project could be, and does so before one exists. The listing itself is
/// served only to the web runtime, which has no dialog of its own — the
/// desktop asks the operating system instead, and a listing nobody there needs
/// is a way of reading this machine's directories that would otherwise not
/// exist. A write and a reveal are the other halves of the same question in
/// both runtimes; `api::filesystem` keeps the rules for all three.
///
/// The body ceiling is a picture's or a subtitle's worth — a listing and a
/// reveal carry no body at all — and it replaces the server router's upload
/// ceiling for these routes rather than adding to it.
fn filesystem_router() -> axum::Router<ApiState> {
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{get, post, put};

    const MAX_WRITE_BODY_BYTES: usize = 256 * 1024 * 1024;

    axum::Router::new()
        .route("/api/v1/filesystem", get(routes::browse_filesystem))
        .route("/api/v1/filesystem/file", put(routes::write_file))
        .route("/api/v1/filesystem/reveal", post(routes::reveal_path))
        .route_layer(DefaultBodyLimit::max(MAX_WRITE_BODY_BYTES))
}
