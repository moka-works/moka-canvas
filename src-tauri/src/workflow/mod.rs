//! Graph execution: authoritative run validation, the executor boundary,
//! and the durable run lifecycle persisted under `history/runs/`.
//!
//! [`executor`] answers the operations that need nothing but the document.
//! [`provider`] answers the ones that need a channel, and is the only place a
//! run reaches the gateway. [`events`] is what a run says while it is going, to
//! anybody watching.

pub mod events;
pub mod executor;
pub mod provider;
pub mod runner;
pub mod validate;

use crate::domain::{
    AssetId, DataType, IsoTimestamp, NodeId, NodeKind, RunId, ValidationIssue, WorkflowNode,
};
use crate::generate::{DeltaSink, GenerateRequest, GeneratedItem};
use crate::project::store::FsProjectStore;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;

/// The executor every generated answer is handed to. A generation node does not
/// name its own the way an operation node does: which model answers is the
/// spec's business, not the node's.
pub const PROVIDER_EXECUTOR_KEY: &str = "provider";

/// The executor an extension node is handed to. Every extension, whatever its
/// definition, runs through the same machinery: which script is loaded and
/// which models it may call comes from the node's own data.
pub const EXTENSION_EXECUTOR_KEY: &str = "extension";

/// Which node/port produced a value, recorded for audit.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValueProvenance {
    pub node_id: NodeId,
    pub port_id: String,
}

/// A typed value flowing between nodes during a run.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkflowValue {
    Text {
        text: String,
        source: ValueProvenance,
    },
    Media {
        media_type: DataType,
        asset_id: AssetId,
        source: ValueProvenance,
    },
    Artifact {
        asset_id: AssetId,
        media_type: Option<DataType>,
        source: ValueProvenance,
    },
}

impl WorkflowValue {
    pub fn data_type(&self) -> DataType {
        match self {
            Self::Text { .. } => DataType::Text,
            Self::Media { media_type, .. } => *media_type,
            Self::Artifact { media_type, .. } => media_type.unwrap_or(DataType::Artifact),
        }
    }
}

/// The executor a node's step is handed to, or `None` when the node has nothing
/// a run could do.
///
/// An operation node that names no executor still answers here rather than
/// `None`: which executor it wants is a separate question from whether it can
/// be run at all, and the two deserve different complaints.
pub fn executor_key_for(node: &WorkflowNode) -> Option<&str> {
    match node.kind {
        NodeKind::Operation => Some(node.data.executor_key.as_deref().unwrap_or_default()),
        NodeKind::Text | NodeKind::Image | NodeKind::Audio | NodeKind::Video => {
            node.data.generation.as_ref().map(|_| PROVIDER_EXECUTOR_KEY)
        }
        // An extension node is runnable even when its definition has been
        // taken away: the refusal says the definition is missing, which is
        // more useful than the node not being offered a run at all.
        NodeKind::Extension => Some(EXTENSION_EXECUTOR_KEY),
        _ => None,
    }
}

/// The operation a node's step asks its executor for. An operation node carries
/// its own; a generation node's is derived from the capability its spec
/// declares, which is the same word the gateway routes on.
pub fn operation_type_for(node: &WorkflowNode) -> String {
    match node.kind {
        NodeKind::Operation => node.data.operation_type.clone().unwrap_or_default(),
        NodeKind::Extension => EXTENSION_EXECUTOR_KEY.to_string(),
        _ => node
            .data
            .generation
            .as_ref()
            .map(|spec| format!("generate.{}", spec.capability.as_str()))
            .unwrap_or_default(),
    }
}

/// The type a node's answer travels downstream as. Everything that is not media
/// travels as words, which is what an operation node reads.
pub fn data_type_for(kind: NodeKind) -> DataType {
    match kind {
        NodeKind::Image => DataType::Image,
        NodeKind::Audio => DataType::Audio,
        NodeKind::Video => DataType::Video,
        _ => DataType::Text,
    }
}

/// What an extension step needs that no other step does.
///
/// The executor never sees the node, so the definition it was inserted from,
/// the models the reader bound to its slots, and the ports it was drawn with
/// travel here. Nothing in it is a credential: a binding is a configuration id,
/// and the credential that goes with it is attached by the gateway.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionInvocation {
    pub extension_id: String,
    pub definition_version: u32,
    pub api_version: u32,
    pub contract_hash: String,
    pub bindings: BTreeMap<String, String>,
    /// The node's title, which a box of logs and a prompt may say.
    pub node_title: String,
    /// The node's port snapshot, which is what its required inputs and
    /// cardinalities are checked against.
    pub ports: Vec<crate::domain::PortDefinition>,
}

/// Everything an executor needs for one node step — resolved values and a
/// sanitized parameter model, never raw HTTP data or filesystem handles.
#[derive(Debug, Clone)]
pub struct ExecutionRequest {
    pub run_id: RunId,
    /// The canvas the run is on, which an answer's provenance records.
    pub canvas_id: crate::domain::CanvasId,
    pub node_id: NodeId,
    pub operation_type: String,
    pub parameters: serde_json::Value,
    /// Input port id → values in deterministic edge order.
    pub inputs: BTreeMap<String, Vec<WorkflowValue>>,
    /// What a generation step asks for, already resolved against the graph.
    ///
    /// Resolved by the run rather than by the executor, so that the graph is
    /// read in one place and an executor never needs a canvas to do its job.
    /// `None` for every other step.
    pub generation: Option<GenerateRequest>,
    /// What an extension step needs, and `None` for every other step.
    pub extension: Option<ExtensionInvocation>,
    /// True when the run record says this step was already under way in a
    /// process that is gone. An extension step does not replay: its script may
    /// already have paid for calls it cannot prove were made.
    pub resumed: bool,
    /// Where an answer that arrives a piece at a time puts each piece.
    ///
    /// Carried by the request rather than handed to `execute` beside the
    /// progress reporter, because which call streams is the executor's to
    /// decide and the sink has to travel with the request it belongs to. A
    /// default one is not watched, which is what makes a provider answer whole.
    pub deltas: DeltaSink,
    /// Where an extension script's logs go as it writes them.
    pub logs: LogSink,
}

/// What a caller does with one log line: its level and its text.
pub type LogHandler = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Where an extension script's log lines go while it runs.
///
/// The same shape as [`DeltaSink`] and for the same reason: a display only
/// needs a shortcut to what the record will say anyway, and one nobody is
/// watching costs a dropped callback rather than a queue.
#[derive(Clone, Default)]
pub struct LogSink {
    sink: Option<LogHandler>,
}

impl LogSink {
    pub fn new(sink: LogHandler) -> Self {
        Self { sink: Some(sink) }
    }

    pub fn push(&self, level: &str, message: &str) {
        if let Some(sink) = &self.sink {
            sink(level, message);
        }
    }
}

impl std::fmt::Debug for LogSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LogSink")
            .field("open", &self.sink.is_some())
            .finish()
    }
}

/// A step that answers later, in the run's hands.
///
/// What a run records about a job and what it needs to wait one out: the handle
/// it is polled by, when it started, and the run whose cancellation it answers
/// to. The job's own business — who is running it and under what name — stays
/// with the gateway, because a run record is served to clients.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedJob {
    pub run_id: RunId,
    pub task_id: String,
    pub created_at: IsoTimestamp,
}

/// What a step produced.
#[derive(Debug, Clone, Default)]
pub struct ExecutionOutput {
    pub text: Option<String>,
    /// Media a provider made, in the order it gave it. Empty for a step that
    /// only produced words.
    pub items: Vec<GeneratedItem>,
    /// The upstream job a step went through. A shot is always a job rather than
    /// an answer waited out, and recording which one produced the result is what
    /// lets a run say so afterwards.
    pub task: Option<PlacedJob>,
    /// What an extension step hands each output port. `None` for every other
    /// executor, whose answer is a single value the runner wraps in `"out"`.
    pub ports: Option<BTreeMap<String, Vec<WorkflowValue>>>,
    /// The extension's own record of what it produced: the snapshot written
    /// onto the node and the result slots a reader selects from.
    pub extension: Option<ExtensionStep>,
    /// Every file this step made, including the ones no output referenced.
    /// The runner removes the unreferenced ones once the answer has landed.
    pub created_assets: Vec<AssetId>,
    /// What the script wrote down while it worked, in the order it said it.
    pub logs: Vec<crate::domain::ExtensionLogRecord>,
    /// One line per model call, for the panel to say what was asked and what
    /// it cost in time.
    pub calls: Vec<crate::domain::ExtensionCallRecord>,
}

/// What an extension step leaves on its node, besides the values travelling
/// downstream.
#[derive(Debug, Clone, Default)]
pub struct ExtensionStep {
    pub outputs: BTreeMap<String, Vec<crate::domain::ExtensionOutputValue>>,
    pub slots: Vec<crate::domain::ResultSlot>,
}

/// Validation failure from the executor's own operation schema.
#[derive(Debug)]
pub struct ExecutionValidationError {
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug)]
pub struct ExecutionError {
    pub code: &'static str,
    pub message: String,
    /// The structure behind the message, when there is any: which model, which
    /// capability, what the provider said. Written down beside the message so a
    /// client can say the same trouble in another language.
    pub details: Option<serde_json::Value>,
    pub retryable: bool,
    pub cancelled: bool,
}

impl ExecutionError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            code: "STEP_FAILED",
            message: message.into(),
            details: None,
            retryable: false,
            cancelled: false,
        }
    }

    pub fn cancelled() -> Self {
        Self {
            code: "CANCELLED",
            message: "Cancelled".into(),
            details: None,
            retryable: false,
            cancelled: true,
        }
    }
}

/// Progress callback wired by the runner; a no-op for instant executors.
#[derive(Clone, Default)]
pub struct ProgressReporter {
    sink: Option<Arc<dyn Fn(f64) + Send + Sync>>,
}

impl ProgressReporter {
    pub fn new(sink: Arc<dyn Fn(f64) + Send + Sync>) -> Self {
        Self { sink: Some(sink) }
    }

    pub fn report(&self, fraction: f64) {
        if let Some(sink) = &self.sink {
            sink(fraction);
        }
    }
}

#[async_trait::async_trait]
pub trait WorkflowExecutor: Send + Sync {
    fn key(&self) -> &str;
    fn supports(&self, operation_type: &str) -> bool;
    async fn validate(&self, request: &ExecutionRequest) -> Result<(), ExecutionValidationError>;
    /// Runs one step. `session` is the project the run belongs to, which is
    /// where an answer's bytes are filed and where a job's note is written.
    async fn execute(
        &self,
        session: &Arc<FsProjectStore>,
        request: ExecutionRequest,
        progress: ProgressReporter,
    ) -> Result<ExecutionOutput, ExecutionError>;
    /// Starts a step whose answer arrives later, when this executor has one.
    ///
    /// Split out of [`WorkflowExecutor::execute`] so the handle can be written
    /// down before the wait: a shot takes minutes and a run does not, and what
    /// is left behind is the difference between asking again and paying twice.
    /// `None` is the ordinary answer — this executor answers inside `execute`.
    async fn place_job(
        &self,
        _session: &Arc<FsProjectStore>,
        _request: ExecutionRequest,
    ) -> Result<Option<PlacedJob>, ExecutionError> {
        Ok(None)
    }
    /// Waits out a job, whether this process started it a moment ago or before a
    /// restart.
    ///
    /// Only ever handed a handle [`WorkflowExecutor::place_job`] gave out, or
    /// one read back off a run record that was.
    async fn wait_job(
        &self,
        _session: &Arc<FsProjectStore>,
        _job: PlacedJob,
        _progress: ProgressReporter,
    ) -> Result<ExecutionOutput, ExecutionError> {
        Err(ExecutionError::failed(
            "This executor starts no job to wait out",
        ))
    }
    async fn cancel(&self, run_id: &RunId) -> Result<(), ExecutionError>;
}
