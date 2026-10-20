use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Where a web deployment is looked for when nothing was typed for it: a file
/// beside the project, never inside the program tree, and never tracked — the
/// tracked one is `config/moka.example.yaml`, which says what the keys mean
/// rather than what one machine wants.
pub const DEFAULT_CONFIG_PATH: &str = "config/moka.yaml";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub bind: String,
    pub static_dir: PathBuf,
    #[serde(default = "default_max_upload_bytes")]
    pub max_upload_bytes: u64,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: default_bind().to_string(),
            static_dir: PathBuf::from(default_static_dir()),
            max_upload_bytes: default_max_upload_bytes(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsConfig {
    #[serde(default = "default_max_moka_file_bytes")]
    pub max_moka_file_bytes: u64,
}

impl Default for ProjectsConfig {
    fn default() -> Self {
        Self {
            max_moka_file_bytes: default_max_moka_file_bytes(),
        }
    }
}

/// Application-level metadata: recent projects, model configurations, encrypted
/// credentials, global preferences, and the prompt library cache. None of it
/// belongs to a project, so none of it travels inside a project directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataConfig {
    #[serde(default = "default_metadata_store")]
    pub store: String,
    /// Empty means "resolve per platform"; see `metadata::paths::resolve_dir`.
    #[serde(default)]
    pub dir: Option<PathBuf>,
    #[serde(default = "default_max_document_bytes")]
    pub max_document_bytes: u64,
}

impl Default for MetadataConfig {
    fn default() -> Self {
        Self {
            store: default_metadata_store(),
            dir: None,
            max_document_bytes: default_max_document_bytes(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowConfig {
    #[serde(default = "default_enabled_executors")]
    pub enabled_executors: Vec<String>,
}

/// Budgets for talking to a provider. Every value bounds how long to wait or
/// how much to accept; none of them change what is asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateConfig {
    /// One text exchange. Words are asked for as a stream, so what this bounds
    /// is how long a channel may stay silent before it is given up on rather
    /// than how long the whole answer may take: a thinking model deliberates
    /// before its first word and a long answer arrives piece by piece.
    #[serde(default = "default_text_timeout_seconds")]
    pub text_timeout_seconds: u64,
    #[serde(default = "default_image_timeout_seconds")]
    pub image_timeout_seconds: u64,
    #[serde(default = "default_audio_timeout_seconds")]
    pub audio_timeout_seconds: u64,
    /// One speech-recognition exchange, which is usually an upload of the
    /// audio being transcribed rather than a handful of words.
    #[serde(default = "default_asr_timeout_seconds")]
    pub asr_timeout_seconds: u64,
    /// Starting an upstream video job, which answers with a handle at once.
    #[serde(default = "default_video_task_timeout_seconds")]
    pub video_task_timeout_seconds: u64,
    /// One poll of an upstream video job.
    #[serde(default = "default_video_poll_timeout_seconds")]
    pub video_poll_timeout_seconds: u64,
    /// Attempts for a failure waiting can fix, counting the first.
    #[serde(default = "default_max_attempts")]
    pub max_attempts: u32,
    /// First backoff wait; doubled each attempt, and a `Retry-After` wins.
    #[serde(default = "default_retry_base_ms")]
    pub retry_base_ms: u64,
    #[serde(default = "default_max_image_input_bytes")]
    pub max_image_input_bytes: u64,
    #[serde(default = "default_max_media_input_bytes")]
    pub max_media_input_bytes: u64,
    /// What one reply from a provider may weigh.
    ///
    /// A generation answer can carry a base64 image, so the ceiling here is far
    /// above the one a model list gets, and above the one on the answer it
    /// carries: an answer arrives encoded, so the reply is the larger of the two.
    #[serde(default = "default_max_response_bytes")]
    pub max_response_bytes: u64,
    /// How many runs drive at once. One past the ceiling waits with its record
    /// still saying queued, which is what a client reads.
    #[serde(default = "default_max_concurrent_runs")]
    pub max_concurrent_runs: usize,
    /// Nothing reaches a provider. The executor that would is not offered, so a
    /// generation node is refused before a run starts rather than failing inside
    /// one.
    #[serde(default)]
    pub offline: bool,
    /// What one answer's media may add up to.
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: u64,
    /// How many pieces one answer may carry, which is also how many cards a node
    /// can point at.
    #[serde(default = "default_max_output_items")]
    pub max_output_items: usize,
    /// Looks at an upstream job before it is given up on.
    #[serde(default = "default_video_max_polls")]
    pub video_max_polls: u32,
    /// Writing down what a provider was asked and what it answered.
    #[serde(default)]
    pub debug: DebugConfig,
}

/// Recording the calls that reach a provider, for the one kind of trouble a log
/// line cannot describe: an answer that arrived and was the wrong thing.
///
/// Off until somebody asks for it, and documented as an exception in
/// `docs/security.md` rather than as a feature, because what gets written down is
/// the prompt somebody typed. Where the recordings go and how a credential is
/// treated are not settings: recordings always land in the `records` subdirectory
/// of the platform application data directory, and a credential is always masked.
/// The field is optional so that a file which says nothing about recording can be
/// told apart from one that says it is off, which is what lets the environment
/// and the command line have a say without repeating the section. Unknown keys
/// are refused, so that a key which was removed fails at startup instead of
/// being silently ignored.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugConfig {
    /// Absent means "whatever the environment says, and off if it says nothing".
    #[serde(default)]
    pub enabled: Option<bool>,
}

impl Default for GenerateConfig {
    fn default() -> Self {
        Self {
            text_timeout_seconds: default_text_timeout_seconds(),
            image_timeout_seconds: default_image_timeout_seconds(),
            audio_timeout_seconds: default_audio_timeout_seconds(),
            asr_timeout_seconds: default_asr_timeout_seconds(),
            video_task_timeout_seconds: default_video_task_timeout_seconds(),
            video_poll_timeout_seconds: default_video_poll_timeout_seconds(),
            max_attempts: default_max_attempts(),
            retry_base_ms: default_retry_base_ms(),
            max_image_input_bytes: default_max_image_input_bytes(),
            max_media_input_bytes: default_max_media_input_bytes(),
            max_response_bytes: default_max_response_bytes(),
            max_concurrent_runs: default_max_concurrent_runs(),
            offline: false,
            max_output_bytes: default_max_output_bytes(),
            max_output_items: default_max_output_items(),
            video_max_polls: default_video_max_polls(),
            debug: DebugConfig::default(),
        }
    }
}

impl GenerateConfig {
    /// How long one request of this capability may take. Video is task-based,
    /// so its budget belongs to the two task calls rather than to `generate`.
    ///
    /// Speech and music share the audio budget: both are one HTTP request
    /// answered somewhere between seconds and a minute, and the stored key is
    /// the one a reader's own config file has always set.
    pub fn timeout_for(&self, capability: crate::domain::Capability) -> std::time::Duration {
        let secs = match capability {
            crate::domain::Capability::Text => self.text_timeout_seconds,
            crate::domain::Capability::Image => self.image_timeout_seconds,
            crate::domain::Capability::Speech | crate::domain::Capability::Music => {
                self.audio_timeout_seconds
            }
            crate::domain::Capability::Video => self.video_task_timeout_seconds,
            crate::domain::Capability::Asr => self.asr_timeout_seconds,
        };
        std::time::Duration::from_secs(secs)
    }

    /// How long one look at an upstream job may take. Video is the only
    /// capability with a job today, so its budget answers for all of them.
    pub fn poll_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.video_poll_timeout_seconds)
    }

    /// The input ceiling for an asset of this kind.
    pub fn input_cap_for(&self, capability: crate::domain::Capability) -> u64 {
        match capability {
            crate::domain::Capability::Image | crate::domain::Capability::Text => {
                self.max_image_input_bytes
            }
            crate::domain::Capability::Speech
            | crate::domain::Capability::Music
            | crate::domain::Capability::Video
            | crate::domain::Capability::Asr => self.max_media_input_bytes,
        }
    }

    /// How many runs may drive at once.
    ///
    /// Never none: a ceiling of zero is a queue nothing ever leaves, and a
    /// mistyped number should not be able to ask for one.
    pub fn concurrent_runs(&self) -> usize {
        self.max_concurrent_runs.max(1)
    }

    /// How many looks at an upstream job before it is given up on.
    ///
    /// Never none, because a ceiling of zero would fail a job before asking
    /// about it once, and a job this process placed is one a provider is already
    /// being paid for.
    pub fn poll_ceiling(&self) -> u32 {
        self.video_max_polls.max(1)
    }
}

/// Where the timeline exporter finds its renderer, and how long it may take.
///
/// The path is the only place a program is named, and it is read from the
/// configuration file rather than from a request: an export body names a
/// timeline and nothing else. Left out, the locator walks the environment and
/// then the platform search path, and a machine with no ffmpeg is a machine
/// whose export is unavailable rather than one that fails to start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipConfig {
    /// An explicit ffmpeg, ahead of the environment and the search path.
    #[serde(default)]
    pub ffmpeg_path: Option<PathBuf>,
    /// How long one render may run before it is stopped and reported failed.
    #[serde(default = "default_clip_timeout_seconds")]
    pub timeout_seconds: u64,
}

impl Default for ClipConfig {
    fn default() -> Self {
        Self {
            ffmpeg_path: None,
            timeout_seconds: default_clip_timeout_seconds(),
        }
    }
}

impl ClipConfig {
    /// The budget one render gets. Never zero: a ceiling of none would stop
    /// every export the moment it started, and a mistyped number should not be
    /// able to ask for one.
    pub fn timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.timeout_seconds.max(1))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub product_name: String,
    #[serde(default = "default_max_upload_bytes")]
    pub max_upload_bytes: u64,
    #[serde(default = "default_allowed_media_types")]
    pub allowed_media_types: Vec<String>,
}

impl Default for PublicConfig {
    fn default() -> Self {
        Self {
            product_name: default_product_name().to_string(),
            max_upload_bytes: default_max_upload_bytes(),
            allowed_media_types: default_allowed_media_types(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsConfig {
    #[serde(default = "default_max_nodes_per_canvas")]
    pub max_nodes_per_canvas: usize,
    #[serde(default = "default_max_edges_per_canvas")]
    pub max_edges_per_canvas: usize,
    #[serde(default = "default_max_canvases_per_project")]
    pub max_canvases_per_project: usize,
    #[serde(default = "default_max_package_bytes")]
    pub max_package_bytes: u64,
    #[serde(default = "default_max_package_entries")]
    pub max_package_entries: usize,
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            max_nodes_per_canvas: default_max_nodes_per_canvas(),
            max_edges_per_canvas: default_max_edges_per_canvas(),
            max_canvases_per_project: default_max_canvases_per_project(),
            max_package_bytes: default_max_package_bytes(),
            max_package_entries: default_max_package_entries(),
        }
    }
}

fn default_bind() -> &'static str {
    "127.0.0.1:3000"
}
fn default_static_dir() -> &'static str {
    "./dist"
}
fn default_product_name() -> &'static str {
    "Moka Canvas"
}
fn default_max_upload_bytes() -> u64 {
    2_147_483_648
}
fn default_max_moka_file_bytes() -> u64 {
    33_554_432
}
fn default_metadata_store() -> String {
    "file".to_string()
}
fn default_max_document_bytes() -> u64 {
    33_554_432
}
fn default_enabled_executors() -> Vec<String> {
    vec![
        "deterministic".to_string(),
        "provider".to_string(),
        "extension".to_string(),
    ]
}
fn default_allowed_media_types() -> Vec<String> {
    vec![
        "image".into(),
        "audio".into(),
        "video".into(),
        "text".into(),
        "model".into(),
    ]
}
fn default_max_nodes_per_canvas() -> usize {
    5_000
}
fn default_max_edges_per_canvas() -> usize {
    10_000
}
fn default_max_canvases_per_project() -> usize {
    64
}
fn default_max_package_bytes() -> u64 {
    4_294_967_296
}
fn default_max_package_entries() -> usize {
    50_000
}
fn default_text_timeout_seconds() -> u64 {
    120
}
fn default_image_timeout_seconds() -> u64 {
    300
}
fn default_audio_timeout_seconds() -> u64 {
    120
}
/// Room for one upload of the audio being transcribed, which for a long clip is
/// tens of megabytes rather than the few kilobytes a JSON body weighs.
fn default_asr_timeout_seconds() -> u64 {
    600
}
fn default_video_task_timeout_seconds() -> u64 {
    60
}
fn default_video_poll_timeout_seconds() -> u64 {
    30
}
fn default_max_attempts() -> u32 {
    3
}
fn default_retry_base_ms() -> u64 {
    1_000
}
fn default_max_image_input_bytes() -> u64 {
    20 * 1024 * 1024
}
fn default_max_media_input_bytes() -> u64 {
    200 * 1024 * 1024
}
/// Wide enough to carry the biggest answer one is allowed to keep.
///
/// An answer arrives encoded inside a reply, so the reply is the larger of the
/// two. Deriving one from the other rather than shipping two numbers is what
/// keeps the ceiling on an answer the one that bites: a reply ceiling below it
/// would refuse answers that were inside it, and the number a deployment set
/// about its answers would never be reached.
fn default_max_response_bytes() -> u64 {
    default_max_output_bytes() * 3 / 2
}
fn default_max_concurrent_runs() -> usize {
    2
}
fn default_max_output_bytes() -> u64 {
    256 * 1024 * 1024
}
/// The same number as the cards a node can point at, taken from the one place
/// that says so: a piece past it would be filed in the project with nowhere on
/// the canvas to show it.
fn default_max_output_items() -> usize {
    crate::domain::validate::MAX_RESULT_SLOTS
}
fn default_video_max_polls() -> u32 {
    120
}

/// Budgets for the story room's batches, which are generations like any other
/// and are bounded like any other. What is different is the shape of the ask:
/// one job is dozens of pieces, so how wide a batch may run is its own number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StoryConfig {
    /// How many stories one project may tell. The same number as the client
    /// enforces, so a room that offers the button is never refused by a server
    /// that would not have taken it.
    pub max_stories_per_project: usize,
    /// How many pieces one batch may carry.
    pub max_items_per_job: usize,
    /// How many generations may be in flight at once, across every batch.
    pub max_parallel_items: usize,
    /// How many batches one project may be driving at once. Generous on
    /// purpose — a reader drawing a cast one card at a time makes a batch per
    /// card, and those are independent asks — while still bounding what a
    /// runaway can leave waiting. How many generations are really in flight is
    /// [`Self::max_parallel_items`], which every batch shares.
    pub max_active_jobs_per_project: usize,
    /// How many ended records a project keeps, besides the ones still running.
    pub keep_records: usize,
}

impl Default for StoryConfig {
    fn default() -> Self {
        Self {
            max_stories_per_project: 20,
            max_items_per_job: 40,
            max_parallel_items: 2,
            max_active_jobs_per_project: 16,
            keep_records: 100,
        }
    }
}
fn default_clip_timeout_seconds() -> u64 {
    3_600
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    pub version: u32,
    pub server: ServerConfig,
    pub projects: ProjectsConfig,
    #[serde(default)]
    pub metadata: MetadataConfig,
    #[serde(default)]
    pub workflow: WorkflowConfig,
    #[serde(default)]
    pub generate: GenerateConfig,
    #[serde(default)]
    pub story: StoryConfig,
    #[serde(default)]
    pub clip: ClipConfig,
    pub public: PublicConfig,
    #[serde(default)]
    pub limits: LimitsConfig,
}

impl Default for AppConfig {
    /// What a deployment gets when no file was read: every ceiling and budget at
    /// the number the example file documents, loopback on port 3000, and the
    /// built frontend taken from `./dist` beside the working directory. The
    /// metadata directory is deliberately absent, so it resolves per platform.
    fn default() -> Self {
        Self {
            version: 1,
            server: ServerConfig::default(),
            projects: ProjectsConfig::default(),
            metadata: MetadataConfig::default(),
            workflow: WorkflowConfig::default(),
            generate: GenerateConfig::default(),
            story: StoryConfig::default(),
            clip: ClipConfig::default(),
            public: PublicConfig::default(),
            limits: LimitsConfig::default(),
        }
    }
}

impl AppConfig {
    /// The executors a run may use.
    ///
    /// Offline takes the one that reaches a provider out of the list rather than
    /// adding a refusal of its own: a node that cannot run is refused where every
    /// other reason a node cannot run is, and the list handed to a client is the
    /// list a run is validated against, so the two cannot disagree about what is
    /// switched off.
    pub fn active_executors(&self) -> Vec<String> {
        if !self.generate.offline {
            return self.workflow.enabled_executors.clone();
        }
        self.workflow
            .enabled_executors
            .iter()
            .filter(|key| {
                key.as_str() != crate::workflow::PROVIDER_EXECUTOR_KEY
                    && key.as_str() != crate::workflow::EXTENSION_EXECUTOR_KEY
            })
            .cloned()
            .collect()
    }
}

impl Default for WorkflowConfig {
    fn default() -> Self {
        Self {
            enabled_executors: default_enabled_executors(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("configuration file cannot be read: {0}")]
    Unreadable(String),
    #[error("configuration is not valid YAML: {0}")]
    InvalidYaml(String),
    #[error("configuration version {0} is not supported (expected 1)")]
    UnsupportedVersion(u32),
    #[error("static directory does not exist: {0}")]
    StaticDirMissing(String),
    #[error("metadata directory is not usable: {0}")]
    MetadataDirInvalid(String),
    #[error("unsupported metadata store: {0}")]
    MetadataStoreUnsupported(String),
    #[error("metadata master key is unavailable: {0}")]
    MetadataKeyMissing(String),
}

impl ConfigError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreadable(_) => "CONFIG_UNREADABLE",
            Self::InvalidYaml(_) => "CONFIG_INVALID",
            Self::UnsupportedVersion(_) => "CONFIG_VERSION_UNSUPPORTED",
            Self::StaticDirMissing(_) => "CONFIG_STATIC_DIR_MISSING",
            Self::MetadataDirInvalid(_) => "CONFIG_METADATA_DIR_INVALID",
            Self::MetadataStoreUnsupported(_) => "CONFIG_METADATA_STORE_UNSUPPORTED",
            Self::MetadataKeyMissing(_) => "CONFIG_METADATA_KEY_MISSING",
        }
    }
}

pub const NATIVE_CONFIG_YAML: &str = include_str!("../resources/native-config.yaml");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeMode {
    Web,
    Native,
}

impl RuntimeMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            RuntimeMode::Web => "web",
            RuntimeMode::Native => "tauri",
        }
    }
}

/// Loads the standalone YAML for the CLI/web server.
///
/// A file that is named at the command line has to be there: a deployment that
/// means to be read should not be answered by defaults because one character of
/// a path was mistyped. Only the path the program picked for itself may be
/// absent, and then it is absent on a fresh checkout, where defaults are what
/// anybody starting the server locally could mean.
pub fn load_config_file(path: &Path, typed_by_user: bool) -> Result<AppConfig, ConfigError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !typed_by_user => {
            return Ok(AppConfig::default());
        }
        Err(error) => {
            return Err(ConfigError::Unreadable(format!(
                "{}: {error}",
                path.display()
            )));
        }
    };
    parse_config(&raw)
}

/// Loads the compiled-in YAML for the desktop app. Placeholders resolve
/// against the platform app-data/resource directories; there is no
/// user-editable override in this mode.
pub fn load_native_config(
    app_data_dir: &Path,
    resource_dir: &Path,
) -> Result<AppConfig, ConfigError> {
    let raw = NATIVE_CONFIG_YAML
        .replace("${appData}", &yaml_path(app_data_dir))
        .replace("${resourceDir}", &yaml_path(resource_dir));
    parse_config(&raw)
}

/// Renders a path for substitution into a double-quoted YAML scalar.
///
/// Two things about a Windows path break the substitution. Its backslashes
/// begin an escape inside a double-quoted scalar, so `"C:\Program Files"` is
/// read as `\P`, which is not one, and the compiled-in configuration is
/// refused over a path nobody typed. And the verbatim form the shell's
/// resource directory arrives in stops the template's forward slash from
/// being a separator, so a directory that is there reads as absent.
fn yaml_path(path: &Path) -> String {
    let plain = plain_path(path);
    plain
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// Drops the `\\?\` verbatim prefix Windows hands back for a canonicalized
/// path, which is what the desktop shell's resource directory arrives as.
///
/// A verbatim path is passed to the filesystem exactly as written, so the
/// forward slash the configuration template joins with (`${resourceDir}/web`)
/// stops being a separator and the directory that is there reads as absent.
/// The prefix buys nothing here: these are short paths inside the install
/// tree and the application data directory.
fn plain_path(path: &Path) -> std::borrow::Cow<'_, Path> {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.starts_with("UNC\\") => {
            std::borrow::Cow::Owned(PathBuf::from(format!(r"\\{}", &rest[4..])))
        }
        Some(rest) => std::borrow::Cow::Owned(PathBuf::from(rest)),
        None => std::borrow::Cow::Borrowed(path),
    }
}

fn parse_config(raw: &str) -> Result<AppConfig, ConfigError> {
    let config: AppConfig =
        serde_yaml::from_str(raw).map_err(|error| ConfigError::InvalidYaml(error.to_string()))?;
    if config.version != 1 {
        return Err(ConfigError::UnsupportedVersion(config.version));
    }
    Ok(config)
}

/// Startup-time environment validation: the static directory must exist and
/// the metadata backend must be reachable at a safe location.
///
/// Returns the resolved metadata root so the caller can open the store
/// without resolving the location a second time.
pub fn validate_startup(
    config: &AppConfig,
    mode: RuntimeMode,
    app_data: Option<&Path>,
) -> Result<PathBuf, ConfigError> {
    if !config.server.static_dir.is_dir() {
        return Err(ConfigError::StaticDirMissing(
            config.server.static_dir.display().to_string(),
        ));
    }
    let store = crate::metadata::paths::resolve_store(&config.metadata);
    if store != crate::metadata::FILE_STORE {
        return Err(ConfigError::MetadataStoreUnsupported(format!(
            "{store:?} is not implemented; set metadata.store to {:?}",
            crate::metadata::FILE_STORE
        )));
    }
    let dir = crate::metadata::paths::resolve_dir(&config.metadata, mode, app_data)?;
    crate::metadata::paths::ensure_isolated(&dir, &config.server.static_dir)
}

/// Builds a configuration rooted inside the given directory, for tests.
pub fn parse_test_config(root: &Path) -> AppConfig {
    let static_dir = root.join("static");
    std::fs::create_dir_all(&static_dir).expect("static dir");
    AppConfig {
        version: 1,
        server: ServerConfig {
            bind: "127.0.0.1:0".into(),
            static_dir,
            max_upload_bytes: default_max_upload_bytes(),
        },
        projects: ProjectsConfig {
            max_moka_file_bytes: default_max_moka_file_bytes(),
        },
        metadata: MetadataConfig {
            store: default_metadata_store(),
            dir: Some(root.join("metadata")),
            max_document_bytes: default_max_document_bytes(),
        },
        workflow: WorkflowConfig::default(),
        generate: GenerateConfig::default(),
        story: StoryConfig::default(),
        clip: ClipConfig::default(),
        public: PublicConfig {
            product_name: "Moka Canvas".into(),
            max_upload_bytes: default_max_upload_bytes(),
            allowed_media_types: default_allowed_media_types(),
        },
        limits: LimitsConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_example_config() {
        let raw = include_str!("../../config/moka.example.yaml");
        let config = parse_config(raw).expect("example config must parse");
        assert_eq!(config.server.bind, "127.0.0.1:3000");
        assert_eq!(config.public.product_name, "Moka Canvas");
        // All three, because an example that left one out would refuse every
        // node of that kind the moment somebody copied it.
        assert_eq!(
            config.workflow.enabled_executors,
            vec![
                "deterministic".to_string(),
                "provider".to_string(),
                "extension".to_string()
            ]
        );
    }

    #[test]
    fn the_example_file_says_exactly_what_the_defaults_do() {
        let config = parse_config(include_str!("../../config/moka.example.yaml"))
            .expect("example config must parse");
        assert_eq!(
            config,
            AppConfig::default(),
            "an example that disagreed with the built-in defaults would be the drift \
             nobody can find from an answer"
        );
    }

    #[test]
    fn a_default_path_that_is_not_there_leaves_every_value_at_its_default() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("config/moka.yaml");
        let config = load_config_file(&missing, false).expect("an absent default is not a failure");
        assert_eq!(config, AppConfig::default());
        assert_eq!(config.server.bind, "127.0.0.1:3000");
        assert_eq!(config.metadata, MetadataConfig::default());
    }

    #[test]
    fn a_config_named_at_the_command_line_has_to_be_there() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("moka.yaml");
        let error = load_config_file(&missing, true).unwrap_err();
        assert_eq!(error.code(), "CONFIG_UNREADABLE");
        assert!(
            error.to_string().contains("moka.yaml"),
            "the refusal has to name the file somebody typed: {error}"
        );
    }

    #[test]
    fn a_file_that_is_there_but_unreadable_is_refused_either_way() {
        let root = tempfile::tempdir().unwrap();
        // A directory where a file is expected reads as unopenable rather than
        // absent, so the fallback for a missing default must not swallow it.
        let not_a_file = root.path().to_path_buf();
        assert!(load_config_file(&not_a_file, false).is_err());
        assert!(load_config_file(&not_a_file, true).is_err());
    }

    #[test]
    fn parses_the_embedded_native_config_with_placeholders() {
        let app_data = Path::new("/tmp/moka-app-data");
        let resource = Path::new("/tmp/moka-resources");
        let config = load_native_config(app_data, resource).expect("native config must parse");
        assert_eq!(
            config.metadata.dir,
            Some(PathBuf::from("/tmp/moka-app-data/metadata"))
        );
        assert_eq!(
            config.server.static_dir,
            PathBuf::from("/tmp/moka-resources/web")
        );
    }

    #[test]
    fn a_windows_path_survives_substitution_into_the_native_config() {
        // Both halves of a Windows path break the substitution: the
        // backslashes start an escape inside a double-quoted scalar, and the
        // verbatim prefix the shell hands back for the resource directory
        // stops the template's forward slash from being a separator. Startup
        // used to fail on the first with CONFIG_INVALID and, once that was
        // escaped, on the second with CONFIG_STATIC_DIR_MISSING.
        let app_data = Path::new("C:\\Users\\moka\\AppData\\Roaming\\MokaCanvas");
        let resource = Path::new(r"\\?\C:\Program Files\Moka Canvas");
        let config = load_native_config(app_data, resource).expect("native config must parse");
        assert_eq!(
            config.metadata.dir,
            Some(PathBuf::from(
                "C:\\Users\\moka\\AppData\\Roaming\\MokaCanvas/metadata"
            ))
        );
        assert_eq!(
            config.server.static_dir,
            PathBuf::from("C:\\Program Files\\Moka Canvas/web")
        );
    }

    #[test]
    fn a_verbatim_share_path_keeps_its_share() {
        // \\?\UNC\server\share is the verbatim spelling of \\server\share,
        // not of a directory called UNC on some drive.
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\files\moka")).as_ref(),
            Path::new(r"\\files\moka")
        );
        assert_eq!(
            plain_path(Path::new("/tmp/moka")).as_ref(),
            Path::new("/tmp/moka")
        );
    }

    #[test]
    fn metadata_section_is_optional() {
        let legacy = r#"
version: 1
server:
  bind: "127.0.0.1:3000"
  staticDir: "./dist"
projects:
  maxMokaFileBytes: 33554432
public:
  productName: "Moka Canvas"
"#;
        let config = parse_config(legacy).expect("legacy config must parse");
        assert_eq!(config.metadata, MetadataConfig::default());
    }

    #[test]
    fn generate_section_is_optional() {
        let legacy = r#"
version: 1
server:
  bind: "127.0.0.1:3000"
  staticDir: "./dist"
projects:
  maxMokaFileBytes: 33554432
public:
  productName: "Moka Canvas"
"#;
        let config = parse_config(legacy).expect("legacy config must parse");
        assert_eq!(config.generate, GenerateConfig::default());
        assert_eq!(config.generate.text_timeout_seconds, 120);
        assert_eq!(config.generate.image_timeout_seconds, 300);
        assert_eq!(config.generate.video_poll_timeout_seconds, 30);
        assert_eq!(config.generate.max_attempts, 3);
        assert_eq!(config.generate.max_concurrent_runs, 2);
        assert!(
            !config.generate.offline,
            "reaching a provider is the default"
        );
        assert_eq!(config.generate.max_output_bytes, 256 * 1024 * 1024);
        assert_eq!(config.generate.video_max_polls, 120);
    }

    #[test]
    fn a_section_written_where_it_does_not_belong_is_refused() {
        // The mistake this answers is a real one: `debug:` at the top level,
        // where nothing reads it. Ignored silently, the server runs with
        // recording off and says nothing about why; refused here, the answer
        // names the key and the file is fixed in a minute.
        let misplaced = r#"
version: 1
server:
  bind: "127.0.0.1:3000"
  staticDir: "./dist"
projects:
  maxMokaFileBytes: 33554432
public:
  productName: "Moka Canvas"
debug:
  enabled: true
"#;
        let error = parse_config(misplaced).unwrap_err();
        assert!(matches!(error, ConfigError::InvalidYaml(_)));
        assert!(error.to_string().contains("debug"), "{error}");
    }

    #[test]
    fn the_debug_section_refuses_a_key_that_was_taken_out() {
        // `dir` and `redactCredentials` were settings once; a file that still
        // carries one has to be told they are gone rather than quietly doing
        // something else than what it says.
        let stale = r#"
version: 1
server:
  bind: "127.0.0.1:3000"
  staticDir: "./dist"
projects:
  maxMokaFileBytes: 33554432
public:
  productName: "Moka Canvas"
generate:
  debug:
    enabled: true
    dir: "./llm-debug"
"#;
        let error = parse_config(stale).unwrap_err();
        assert!(matches!(error, ConfigError::InvalidYaml(_)));
        assert!(error.to_string().contains("dir"), "{error}");
    }

    #[test]
    fn an_offline_switch_takes_the_provider_out_of_the_list() {
        let root = tempfile::tempdir().unwrap();
        let mut config = parse_test_config(root.path());
        assert_eq!(
            config.active_executors(),
            vec![
                "deterministic".to_string(),
                "provider".to_string(),
                "extension".to_string()
            ]
        );

        config.generate.offline = true;
        assert_eq!(
            config.active_executors(),
            vec!["deterministic".to_string()],
            "a generation node is refused at validation rather than mid-run"
        );
        // What was configured is left alone: switching back on restores the list
        // rather than needing it written again.
        assert_eq!(config.workflow.enabled_executors.len(), 3);
    }

    #[test]
    fn a_ceiling_of_none_is_read_as_one() {
        let budgets = GenerateConfig::default();
        // The piece ceiling is the number of cards a node can point at, so an
        // answer that fits is an answer the canvas can show.
        assert_eq!(
            budgets.max_output_items,
            crate::domain::validate::MAX_RESULT_SLOTS
        );

        let none = GenerateConfig {
            max_concurrent_runs: 0,
            video_max_polls: 0,
            ..GenerateConfig::default()
        };
        assert_eq!(
            none.concurrent_runs(),
            1,
            "a queue nothing ever leaves is a typo"
        );
        assert_eq!(none.poll_ceiling(), 1, "a job is asked about at least once");
    }

    #[test]
    fn a_reply_is_allowed_to_carry_the_biggest_answer_one_may_keep() {
        let budgets = GenerateConfig::default();
        // An answer arrives encoded, so the reply holding it is bigger than the
        // answer inside it. A reply ceiling the other way round would be the one
        // that actually bites, and the ceiling on an answer would never be
        // reached at all.
        assert!(
            budgets.max_response_bytes > budgets.max_output_bytes,
            "{} has to carry {}",
            budgets.max_response_bytes,
            budgets.max_output_bytes
        );
    }

    #[test]
    fn each_capability_gets_its_own_budget() {
        let budgets = GenerateConfig::default();
        use crate::domain::Capability;
        assert_eq!(budgets.timeout_for(Capability::Text).as_secs(), 120);
        assert_eq!(budgets.timeout_for(Capability::Image).as_secs(), 300);
        // Sound is two capabilities and one budget: both are a single request.
        assert_eq!(budgets.timeout_for(Capability::Speech).as_secs(), 120);
        assert_eq!(budgets.timeout_for(Capability::Music).as_secs(), 120);
        // Starting a job answers at once, so it gets the short budget; waiting
        // for the job itself is the caller's polling loop, not one request.
        assert_eq!(budgets.timeout_for(Capability::Video).as_secs(), 60);
        assert_eq!(budgets.poll_timeout().as_secs(), 30);
        assert_eq!(
            budgets.input_cap_for(Capability::Image),
            budgets.max_image_input_bytes
        );
        assert_eq!(
            budgets.input_cap_for(Capability::Video),
            budgets.max_media_input_bytes
        );
    }

    #[test]
    fn one_generate_key_does_not_disturb_the_others() {
        let tuned = r#"
version: 1
server:
  bind: "127.0.0.1:3000"
  staticDir: "./dist"
projects:
  maxMokaFileBytes: 33554432
public:
  productName: "Moka Canvas"
generate:
  imageTimeoutSeconds: 60
  maxAttempts: 1
"#;
        let config = parse_config(tuned).expect("tuned config must parse");
        assert_eq!(config.generate.image_timeout_seconds, 60);
        assert_eq!(config.generate.max_attempts, 1);
        assert_eq!(
            config.generate.text_timeout_seconds,
            default_text_timeout_seconds()
        );
        assert_eq!(
            config.generate.max_response_bytes,
            default_max_response_bytes()
        );
    }

    #[test]
    fn budgets_are_picked_per_capability() {
        use crate::domain::Capability;
        let config = GenerateConfig::default();
        assert_eq!(config.timeout_for(Capability::Text).as_secs(), 120);
        assert_eq!(config.timeout_for(Capability::Image).as_secs(), 300);
        assert_eq!(config.timeout_for(Capability::Speech).as_secs(), 120);
        assert_eq!(config.timeout_for(Capability::Video).as_secs(), 60);
        assert_eq!(config.input_cap_for(Capability::Image), 20 * 1024 * 1024);
        assert_eq!(config.input_cap_for(Capability::Video), 200 * 1024 * 1024);
    }

    #[test]
    fn clip_section_is_optional() {
        let legacy = r#"
version: 1
server:
  bind: "127.0.0.1:3000"
  staticDir: "./dist"
projects:
  maxMokaFileBytes: 33554432
public:
  productName: "Moka Canvas"
"#;
        let config = parse_config(legacy).expect("legacy config must parse");
        assert_eq!(config.clip, ClipConfig::default());
        assert_eq!(config.clip.ffmpeg_path, None);
        assert_eq!(config.clip.timeout_seconds, 3600);
        assert_eq!(config.clip.timeout().as_secs(), 3600);
    }

    #[test]
    fn a_render_budget_of_none_is_read_as_one_second() {
        let config = ClipConfig {
            ffmpeg_path: None,
            timeout_seconds: 0,
        };
        assert_eq!(
            config.timeout().as_secs(),
            1,
            "a ceiling of none would stop every export the moment it started"
        );
    }

    #[test]
    fn one_clip_key_does_not_disturb_the_others() {
        let tuned = r#"
version: 1
server:
  bind: "127.0.0.1:3000"
  staticDir: "./dist"
projects:
  maxMokaFileBytes: 33554432
public:
  productName: "Moka Canvas"
clip:
  ffmpegPath: "/opt/ffmpeg"
"#;
        let config = parse_config(tuned).expect("tuned config must parse");
        assert_eq!(config.clip.ffmpeg_path, Some(PathBuf::from("/opt/ffmpeg")));
        assert_eq!(config.clip.timeout_seconds, default_clip_timeout_seconds());
    }

    #[test]
    fn rejects_an_unsupported_version() {
        let raw =
            include_str!("../../config/moka.example.yaml").replace("version: 1", "version: 9");
        let error = parse_config(&raw).unwrap_err();
        assert!(matches!(error, ConfigError::UnsupportedVersion(9)));
    }

    #[test]
    fn rejects_invalid_yaml() {
        let error = parse_config("version: [").unwrap_err();
        assert!(matches!(error, ConfigError::InvalidYaml(_)));
    }

    #[test]
    fn startup_validation_requires_the_static_dir() {
        let root = tempfile::tempdir().unwrap();
        let mut config = parse_test_config(root.path());
        config.server.static_dir = PathBuf::from("/tmp/moka-definitely-missing-dir");
        let error = validate_startup(&config, RuntimeMode::Web, None).unwrap_err();
        assert!(matches!(error, ConfigError::StaticDirMissing(_)));
    }

    #[test]
    fn startup_validation_rejects_an_unimplemented_store() {
        let root = tempfile::tempdir().unwrap();
        let mut config = parse_test_config(root.path());
        config.metadata.store = "postgres".to_string();
        let error = validate_startup(&config, RuntimeMode::Web, None).unwrap_err();
        assert_eq!(error.code(), "CONFIG_METADATA_STORE_UNSUPPORTED");
    }

    #[test]
    fn startup_validation_rejects_a_directory_inside_the_program_tree() {
        let root = tempfile::tempdir().unwrap();
        let mut config = parse_test_config(root.path());
        config.metadata.dir = Some(config.server.static_dir.join("metadata"));
        let error = validate_startup(&config, RuntimeMode::Web, None).unwrap_err();
        assert_eq!(error.code(), "CONFIG_METADATA_DIR_INVALID");
    }

    #[test]
    fn startup_validation_resolves_the_metadata_root() {
        let root = tempfile::tempdir().unwrap();
        let config = parse_test_config(root.path());
        let resolved = validate_startup(&config, RuntimeMode::Web, None).expect("valid config");
        assert!(resolved.is_absolute());
        assert!(resolved.is_dir());
    }
}
