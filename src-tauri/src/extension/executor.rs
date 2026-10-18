//! The executor an extension node's step is handed to.
//!
//! It does two things the rest of the program cannot. Before a run it reads
//! the definition off the disk again and refuses the step if the definition is
//! gone, changed under the node, or cannot be satisfied by the models the
//! reader bound — so a run never starts work the script would only discover at
//! the first model call. During the run it puts the script in a fresh Lua
//! state and answers its model calls through the gateway, filing every answer
//! as an asset the moment it arrives.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;

use crate::domain::validate::generation_param_keys;
use crate::domain::validate::MAX_RESULT_SLOTS;
use crate::domain::{
    now_iso, AssetId, AssetProvenance, CanvasId, Capability, DataType, ExtensionCallRecord,
    ExtensionOutputValue, NodeId, PortDefinition, ResultSlot, ResultSlotStatus, RunId,
    ValidationIssue,
};
use crate::generate::{
    file_incoming, Cancel, DeltaSink, Gateway, GenerateInput, GenerateRequest, GenerateResult,
    Incoming, InputRole, InputWindow as GenerateWindow, ModelRepo, ProviderError, TaskState,
};
use crate::project::store::FsProjectStore;
use crate::project::ProjectStore;
use crate::workflow::{
    ExecutionError, ExecutionOutput, ExecutionRequest, ExecutionValidationError, ExtensionStep,
    ProgressReporter, WorkflowExecutor, WorkflowValue, EXTENSION_EXECUTOR_KEY,
};

use super::registry::load_one;
use super::runtime::{
    self, LogWriter, ModelAnswer, ModelCall, ModelCaller, ModelError, ModelHandleInfo, ModelItem,
    ScriptContext, StepControl,
};

/// How long between two looks at a job, where the provider offered no advice.
const POLL_INTERVAL: Duration = Duration::from_millis(2_500);

/// The flags a run's steps answer to, kept for a cancel that arrives before
/// the step has started and for one that arrives in the middle of it.
#[derive(Default)]
struct CancelRegistry(Mutex<HashMap<RunId, Cancel>>);

impl CancelRegistry {
    fn flag(&self, run_id: &str) -> Cancel {
        self.0
            .lock()
            .expect("cancel registry poisoned")
            .entry(run_id.to_string())
            .or_default()
            .clone()
    }

    fn release(&self, run_id: &str) {
        self.0
            .lock()
            .expect("cancel registry poisoned")
            .remove(run_id);
    }
}

pub struct ExtensionExecutor {
    root: PathBuf,
    gateway: Arc<Gateway>,
    models: Arc<ModelRepo>,
    in_flight: CancelRegistry,
}

impl ExtensionExecutor {
    pub fn new(root: PathBuf, gateway: Arc<Gateway>, models: Arc<ModelRepo>) -> Self {
        Self {
            root,
            gateway,
            models,
            in_flight: CancelRegistry::default(),
        }
    }

    /// Everything about a step that can be refused before it runs. The same
    /// check serves `validate` and the first moment of `execute`, so a step
    /// that passed validation cannot start against a definition that changed
    /// in between.
    async fn preflight(
        &self,
        request: &ExecutionRequest,
    ) -> Result<super::manifest::NodeDefinition, Vec<ValidationIssue>> {
        let mut issues = Vec::new();
        let node_id = request.node_id.clone();
        let Some(invocation) = request.extension.as_ref() else {
            issues.push(issue(
                "EXTENSION_NOT_INSTALLED",
                "The node carries no extension state",
                &node_id,
                None,
            ));
            return Err(issues);
        };
        let definition = match load_one(&self.root, &invocation.extension_id) {
            Ok(definition) => definition,
            Err(problem) => {
                issues.push(issue(&problem.code, problem.message, &node_id, None));
                return Err(issues);
            }
        };
        if definition.api_version != invocation.api_version {
            issues.push(issue(
                "EXTENSION_VERSION_INCOMPATIBLE",
                format!(
                    "The node was inserted against contract version {}, and the installed definition speaks {}",
                    invocation.api_version, definition.api_version
                ),
                &node_id,
                None,
            ));
        }
        if definition.contract_hash != invocation.contract_hash {
            issues.push(issue(
                "EXTENSION_CONTRACT_CHANGED",
                format!(
                    "The definition \"{}\" changed since this node was inserted; refresh the node to use its ports and slots",
                    definition.id
                ),
                &node_id,
                None,
            ));
        } else if !ports_match(&invocation.ports, &definition) {
            issues.push(issue(
                "EXTENSION_CONTRACT_CHANGED",
                format!(
                    "The node's ports no longer match the definition \"{}\"",
                    definition.id
                ),
                &node_id,
                None,
            ));
        }

        let snapshot = match self.models.snapshot().await {
            Ok(snapshot) => Some(snapshot),
            Err(error) => {
                issues.push(issue(
                    "EXTENSION_MODEL_MISSING",
                    format!("The model configuration could not be read: {error}"),
                    &node_id,
                    None,
                ));
                None
            }
        };
        for slot in &definition.models {
            let bound = invocation
                .bindings
                .get(&slot.id)
                .map(|value| value.trim())
                .filter(|value| !value.is_empty());
            let Some(bound) = bound else {
                if slot.required {
                    issues.push(issue(
                        "EXTENSION_MODEL_MISSING",
                        format!("The required model slot \"{}\" is not bound", slot.id),
                        &node_id,
                        None,
                    ));
                }
                continue;
            };
            if let Some(snapshot) = &snapshot {
                use crate::generate::models::resolve_within;
                match resolve_within(snapshot, bound, slot.capability, None) {
                    Ok(_) => {}
                    Err(ProviderError::CapabilityMismatch { .. }) => issues.push(issue(
                        "EXTENSION_SLOT_CAPABILITY_MISMATCH",
                        format!(
                            "The model bound to slot \"{}\" does not serve {}",
                            slot.id,
                            slot.capability.as_str()
                        ),
                        &node_id,
                        None,
                    )),
                    Err(error) => issues.push(issue(
                        "EXTENSION_MODEL_MISSING",
                        format!(
                            "The model bound to slot \"{}\" is not usable: {error}",
                            slot.id
                        ),
                        &node_id,
                        None,
                    )),
                }
            }
        }

        for input in &definition.inputs {
            let values = request.inputs.get(&input.id);
            let count = values.map(Vec::len).unwrap_or(0);
            if input.required && count == 0 {
                issues.push(issue(
                    "EXTENSION_INPUT_MISSING",
                    format!(
                        "The input \"{}\" is required and nothing is connected",
                        input.id
                    ),
                    &node_id,
                    Some(input.id.clone()),
                ));
            }
            if input.cardinality == crate::domain::Cardinality::One && count > 1 {
                issues.push(issue(
                    "EXTENSION_INPUT_CARDINALITY",
                    format!(
                        "The input \"{}\" takes one value and {count} are connected",
                        input.id
                    ),
                    &node_id,
                    Some(input.id.clone()),
                ));
            }
        }

        if let Err(message) = definition.resolved_parameters(Some(&request.parameters)) {
            issues.push(issue(
                "EXTENSION_PARAMETER_INVALID",
                message,
                &node_id,
                None,
            ));
        }
        if issues.is_empty() {
            Ok(definition)
        } else {
            Err(issues)
        }
    }
}

/// Whether the ports copied onto a node still say what the installed
/// definition says. Labels and declaration order are not part of it.
fn ports_match(stacked: &[PortDefinition], definition: &super::manifest::NodeDefinition) -> bool {
    let expected: Vec<PortDefinition> = definition
        .inputs
        .iter()
        .chain(definition.outputs.iter())
        .map(|port| port.snapshot())
        .collect();
    if expected.len() != stacked.len() {
        return false;
    }
    expected.iter().all(|wanted| {
        stacked.iter().any(|held| {
            held.id == wanted.id
                && held.direction == wanted.direction
                && held.required == wanted.required
                && held.cardinality == wanted.cardinality
                && same_types(&held.data_types, &wanted.data_types)
        })
    })
}

fn same_types(one: &[DataType], two: &[DataType]) -> bool {
    let sorted = |kinds: &[DataType]| {
        let mut named: Vec<&str> = kinds.iter().map(DataType::as_str).collect();
        named.sort_unstable();
        named
    };
    sorted(one) == sorted(two)
}

fn issue(
    code: &str,
    message: impl Into<String>,
    node_id: &str,
    port_id: Option<String>,
) -> ValidationIssue {
    ValidationIssue {
        code: code.to_string(),
        message: message.into(),
        canvas_id: None,
        node_id: Some(node_id.to_string()),
        port_id,
        edge_id: None,
        timeline_id: None,
        track_id: None,
        clip_id: None,
        transition_id: None,
    }
}

fn execution(issues: Vec<ValidationIssue>) -> ExecutionError {
    let first = issues.first();
    ExecutionError {
        code: static_code(first.map(|issue| issue.code.as_str()).unwrap_or_default()),
        message: first
            .map(|issue| issue.message.clone())
            .unwrap_or_else(|| "The extension step cannot run".to_string()),
        details: serde_json::to_value(&issues)
            .ok()
            .map(|issues| serde_json::json!({ "issues": issues })),
        retryable: false,
        cancelled: false,
    }
}

/// The codes an executor may carry are `'static` so a run record holds a
/// stable word, while preflight issues are built at runtime.
fn static_code(code: &str) -> &'static str {
    match code {
        "EXTENSION_NOT_INSTALLED" => "EXTENSION_NOT_INSTALLED",
        "EXTENSION_VERSION_INCOMPATIBLE" => "EXTENSION_VERSION_INCOMPATIBLE",
        "EXTENSION_CONTRACT_CHANGED" => "EXTENSION_CONTRACT_CHANGED",
        "EXTENSION_MODEL_MISSING" => "EXTENSION_MODEL_MISSING",
        "EXTENSION_SLOT_CAPABILITY_MISMATCH" => "EXTENSION_SLOT_CAPABILITY_MISMATCH",
        "EXTENSION_INPUT_MISSING" => "EXTENSION_INPUT_MISSING",
        "EXTENSION_INPUT_CARDINALITY" => "EXTENSION_INPUT_CARDINALITY",
        "EXTENSION_PARAMETER_INVALID" => "EXTENSION_PARAMETER_INVALID",
        "EXTENSION_SCRIPT_FAILED" => "EXTENSION_SCRIPT_FAILED",
        "EXTENSION_MODEL_CALL_FAILED" => "EXTENSION_MODEL_CALL_FAILED",
        "EXTENSION_OUTPUT_INVALID" => "EXTENSION_OUTPUT_INVALID",
        "EXTENSION_LIMIT_EXCEEDED" => "EXTENSION_LIMIT_EXCEEDED",
        "EXTENSION_TIMEOUT" => "EXTENSION_TIMEOUT",
        "EXTENSION_INTERRUPTED" => "EXTENSION_INTERRUPTED",
        "EXTENSION_CANCELLED" => "EXTENSION_CANCELLED",
        "EXTENSION_SCRIPT_MISSING" => "EXTENSION_SCRIPT_MISSING",
        "EXTENSION_SCRIPT_TOO_LARGE" => "EXTENSION_SCRIPT_TOO_LARGE",
        "EXTENSION_MANIFEST_INVALID" => "EXTENSION_MANIFEST_INVALID",
        "EXTENSION_API_VERSION_UNSUPPORTED" => "EXTENSION_API_VERSION_UNSUPPORTED",
        _ => "EXTENSION_PREFLIGHT_FAILED",
    }
}

#[async_trait]
#[allow(clippy::result_large_err)]
impl WorkflowExecutor for ExtensionExecutor {
    fn key(&self) -> &str {
        EXTENSION_EXECUTOR_KEY
    }

    fn supports(&self, operation_type: &str) -> bool {
        operation_type == EXTENSION_EXECUTOR_KEY
    }

    async fn validate(&self, request: &ExecutionRequest) -> Result<(), ExecutionValidationError> {
        match self.preflight(request).await {
            Ok(_) => Ok(()),
            Err(issues) => Err(ExecutionValidationError { issues }),
        }
    }

    async fn execute(
        &self,
        session: &Arc<FsProjectStore>,
        request: ExecutionRequest,
        progress: ProgressReporter,
    ) -> Result<ExecutionOutput, ExecutionError> {
        if request.resumed {
            return Err(ExecutionError {
                code: "EXTENSION_INTERRUPTED",
                message: "The step was interrupted before it finished; run the node again"
                    .to_string(),
                details: None,
                retryable: false,
                cancelled: false,
            });
        }
        let definition = match self.preflight(&request).await {
            Ok(definition) => Arc::new(definition),
            Err(issues) => return Err(execution(issues)),
        };
        let params = match definition.resolved_parameters(Some(&request.parameters)) {
            Ok(params) => serde_json::Value::Object(params),
            Err(message) => {
                return Err(execution(vec![issue(
                    "EXTENSION_PARAMETER_INVALID",
                    message,
                    &request.node_id,
                    None,
                )]))
            }
        };
        let invocation = request
            .extension
            .as_ref()
            .expect("preflight checked the extension state");
        let node_title = invocation.node_title.clone();

        let cancel = self.in_flight.flag(&request.run_id);
        let control = StepControl::new(
            Duration::from_secs(definition.limits.timeout_seconds),
            Some(cancel.clone()),
        );
        let live = request.logs.clone();
        let logs = Arc::new(LogWriter::new(
            usize::try_from(definition.limits.max_log_bytes).unwrap_or(usize::MAX),
            Some(Arc::new(move |level: &str, message: &str| {
                live.push(level, message);
            })),
        ));

        let (inputs_json, resource_types) = script_inputs(session, &request).await;
        let input_ids: HashSet<AssetId> = request
            .inputs
            .values()
            .flatten()
            .filter_map(asset_of)
            .collect();

        // One model handle per bound slot, with the name a log will use. The
        // binding itself is what the gateway places the call with.
        let snapshot = match self.models.snapshot().await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.in_flight.release(&request.run_id);
                return Err(execution(vec![issue(
                    "EXTENSION_MODEL_MISSING",
                    format!("The model configuration could not be read: {error}"),
                    &request.node_id,
                    None,
                )]));
            }
        };
        let mut handles = BTreeMap::new();
        for slot in &definition.models {
            let Some(binding) = invocation
                .bindings
                .get(&slot.id)
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let model_name =
                crate::generate::models::resolve_within(&snapshot, binding, slot.capability, None)
                    .map(|model| model.display_name)
                    .unwrap_or_else(|_| slot.label.clone());
            handles.insert(
                slot.id.clone(),
                ModelHandleInfo {
                    capability: slot.capability,
                    label: slot.label.clone(),
                    model_name,
                },
            );
        }

        let calls = Arc::new(Mutex::new(Vec::<ExtensionCallRecord>::new()));
        let created = Arc::new(Mutex::new(Vec::<AssetId>::new()));
        let call_count = Arc::new(AtomicU32::new(0));
        let caller = self.model_caller(
            session,
            &request,
            &definition,
            invocation,
            &handles,
            &input_ids,
            &control,
            &cancel,
            &logs,
            &calls,
            &created,
            &call_count,
            &node_title,
        );
        let caller: ModelCaller = Arc::new(caller);

        let progress: Arc<dyn Fn(f64) + Send + Sync> = Arc::new(move |fraction| {
            progress.report(fraction);
        });
        let context = ScriptContext {
            definition: Arc::clone(&definition),
            node_id: request.node_id.clone(),
            node_title: node_title.clone(),
            inputs: inputs_json,
            params,
            models: handles,
            caller,
            logs: Arc::clone(&logs),
            progress,
            control: Arc::clone(&control),
        };

        let outcome = tokio::task::spawn_blocking(move || runtime::execute(context)).await;
        self.in_flight.release(&request.run_id);
        let outcome = match outcome {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(failure)) => {
                clean_created(session, &created).await;
                return Err(ExecutionError {
                    code: static_code(&failure.code),
                    message: failure.message,
                    details: Some(failure.details),
                    retryable: false,
                    cancelled: failure.cancelled,
                });
            }
            Err(error) => {
                clean_created(session, &created).await;
                return Err(ExecutionError {
                    code: "EXTENSION_SCRIPT_FAILED",
                    message: format!("The extension script stopped unexpectedly: {error}"),
                    details: None,
                    retryable: false,
                    cancelled: false,
                });
            }
        };
        if let Some(failure) = control.failure() {
            clean_created(session, &created).await;
            return Err(ExecutionError {
                code: static_code(&failure.code),
                message: failure.message,
                details: Some(failure.details),
                retryable: false,
                cancelled: failure.cancelled,
            });
        }

        let created_ids: Vec<AssetId> = created.lock().map(|held| held.clone()).unwrap_or_default();
        let values = match check_outputs(
            session,
            &definition,
            &outcome.value,
            &input_ids,
            &resource_types,
            &created_ids,
        )
        .await
        {
            Ok(values) => values,
            Err(message) => {
                clean_created(session, &created).await;
                return Err(ExecutionError {
                    code: "EXTENSION_OUTPUT_INVALID",
                    message,
                    details: Some(serde_json::json!({
                        "extensionId": invocation.extension_id,
                    })),
                    retryable: false,
                    cancelled: false,
                });
            }
        };

        let referenced: HashSet<AssetId> = values
            .ports
            .values()
            .flatten()
            .filter_map(asset_of)
            .collect();
        for asset_id in created_ids {
            if !referenced.contains(&asset_id) {
                if let Err(error) = session.remove_asset(&asset_id).await {
                    tracing::warn!("extension step left an intermediate asset {asset_id}: {error}");
                }
            }
        }

        let primary = definition.primary_output().map(|port| port.id.as_str());
        let primary_text = primary
            .and_then(|port| values.ports.get(port))
            .and_then(|values| values.first())
            .and_then(|value| match value {
                WorkflowValue::Text { text, .. } => Some(text.clone()),
                _ => None,
            });

        Ok(ExecutionOutput {
            text: primary_text,
            items: Vec::new(),
            task: None,
            ports: Some(values.ports),
            extension: Some(ExtensionStep {
                outputs: values.outputs,
                slots: values.slots,
            }),
            // The unreferenced files were removed above; what the runner sees
            // is an answer that already cleaned up after itself.
            created_assets: Vec::new(),
            logs: outcome.logs,
            calls: calls.lock().map(|held| held.clone()).unwrap_or_default(),
        })
    }

    async fn cancel(&self, run_id: &RunId) -> Result<(), ExecutionError> {
        self.in_flight.flag(run_id).cancel();
        Ok(())
    }
}

/// A built answer, ready to travel and to be written onto the node.
struct CheckedOutputs {
    ports: BTreeMap<String, Vec<WorkflowValue>>,
    outputs: BTreeMap<String, Vec<ExtensionOutputValue>>,
    slots: Vec<ResultSlot>,
}

async fn check_outputs(
    session: &Arc<FsProjectStore>,
    definition: &super::manifest::NodeDefinition,
    value: &serde_json::Value,
    input_ids: &HashSet<AssetId>,
    resource_types: &HashMap<AssetId, DataType>,
    created: &[AssetId],
) -> Result<CheckedOutputs, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "run must return a table".to_string())?;
    let outputs = root
        .get("outputs")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "run must return { outputs = { ... } }".to_string())?;

    let mut ports: BTreeMap<String, Vec<WorkflowValue>> = BTreeMap::new();
    let mut snapshot: BTreeMap<String, Vec<ExtensionOutputValue>> = BTreeMap::new();
    let mut slots: Vec<ResultSlot> = Vec::new();
    let primary = definition.primary_output().map(|port| port.id.clone());
    let created_set: HashSet<AssetId> = created.iter().cloned().collect();
    let registry = session
        .current()
        .await
        .ok()
        .flatten()
        .map(|open| open.moka.resources);
    let mut total_bytes = 0u64;
    let mut counted: HashSet<AssetId> = HashSet::new();

    for port_id in outputs.keys() {
        if definition.output(port_id).is_none() {
            return Err(format!(
                "the script returned an output port \"{port_id}\" the definition does not declare"
            ));
        }
    }

    for declared in &definition.outputs {
        let held = outputs
            .get(&declared.id)
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        if held.is_empty() {
            if declared.required {
                return Err(format!(
                    "the required output \"{}\" produced no value",
                    declared.id
                ));
            }
            snapshot.insert(declared.id.clone(), Vec::new());
            continue;
        }
        if declared.cardinality == crate::domain::Cardinality::One && held.len() > 1 {
            return Err(format!(
                "the output \"{}\" takes one value and {} were returned",
                declared.id,
                held.len()
            ));
        }
        let limit =
            usize::try_from(definition.limits.max_output_items_per_port).unwrap_or(usize::MAX);
        if held.len() > limit {
            return Err(format!(
                "the output \"{}\" returned {} values; its limit is {limit}",
                declared.id,
                held.len()
            ));
        }
        let mut values = Vec::with_capacity(held.len());
        let mut recorded = Vec::with_capacity(held.len());
        for (index, entry) in held.iter().enumerate() {
            let object = entry
                .as_object()
                .ok_or_else(|| format!("a value on \"{}\" is not a table", declared.id))?;
            let kind = object
                .get("type")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| format!("a value on \"{}\" has no type", declared.id))?;
            let data_type =
                data_type_named(kind).ok_or_else(|| format!("\"{kind}\" is not an output type"))?;
            if !declared.data_types.contains(&data_type) {
                return Err(format!(
                    "the output \"{}\" does not accept {kind}",
                    declared.id
                ));
            }
            let source = crate::workflow::ValueProvenance {
                node_id: definition.id.clone(),
                port_id: declared.id.clone(),
            };
            let value = if data_type == DataType::Text {
                if object.contains_key("assetId") {
                    return Err(format!(
                        "a text value on \"{}\" also names an asset",
                        declared.id
                    ));
                }
                let text = object
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| format!("a text value on \"{}\" has no words", declared.id))?;
                if text.len() as u64 > definition.limits.max_text_bytes {
                    return Err(format!(
                        "a text value on \"{}\" exceeds the text limit",
                        declared.id
                    ));
                }
                snapshot_value(&mut recorded, data_type, Some(text), None);
                WorkflowValue::Text {
                    text: text.to_string(),
                    source,
                }
            } else {
                if object.contains_key("text") {
                    return Err(format!(
                        "a media value on \"{}\" also carries words",
                        declared.id
                    ));
                }
                let asset_id = object
                    .get("assetId")
                    .and_then(serde_json::Value::as_str)
                    .filter(|asset| !asset.is_empty())
                    .ok_or_else(|| {
                        format!("a media value on \"{}\" names no asset", declared.id)
                    })?;
                if !input_ids.contains(asset_id) && !created_set.contains(asset_id) {
                    return Err(format!(
                        "the output \"{}\" names \"{asset_id}\", which this step neither received nor made",
                        declared.id
                    ));
                }
                let entry = registry
                    .as_ref()
                    .and_then(|registry| registry.find(asset_id));
                let actual = resource_types
                    .get(asset_id)
                    .copied()
                    .or_else(|| entry.and_then(|entry| type_of_mime(entry.mime.as_deref())))
                    .unwrap_or(DataType::Artifact);
                if data_type != DataType::Artifact && data_type != actual {
                    return Err(format!(
                        "the output \"{}\" calls \"{asset_id}\" {kind}, but it is {}",
                        declared.id,
                        actual.as_str()
                    ));
                }
                if counted.insert(asset_id.to_string()) {
                    if let Some(entry) = entry {
                        total_bytes =
                            total_bytes.saturating_add(entry.bytes.unwrap_or(0).max(0) as u64);
                    }
                }
                snapshot_value(&mut recorded, data_type, None, Some(asset_id));
                if data_type == DataType::Artifact {
                    WorkflowValue::Artifact {
                        asset_id: asset_id.to_string(),
                        media_type: Some(actual),
                        source,
                    }
                } else {
                    WorkflowValue::Media {
                        media_type: data_type,
                        asset_id: asset_id.to_string(),
                        source,
                    }
                }
            };
            let slot_id = if declared.cardinality == crate::domain::Cardinality::Many {
                format!("{}:{}", declared.id, index)
            } else {
                declared.id.clone()
            };
            slots.push(ResultSlot {
                id: slot_id,
                status: ResultSlotStatus::Succeeded,
                asset_id: match &value {
                    WorkflowValue::Media { asset_id, .. }
                    | WorkflowValue::Artifact { asset_id, .. } => Some(asset_id.clone()),
                    WorkflowValue::Text { .. } => None,
                },
                text: match &value {
                    WorkflowValue::Text { text, .. } => Some(text.clone()),
                    _ => None,
                },
                error: None,
                is_primary: primary.as_deref() == Some(declared.id.as_str()) && index == 0,
            });
            values.push(value);
        }
        if slots.len() > MAX_RESULT_SLOTS {
            return Err(format!(
                "the step produced more than {MAX_RESULT_SLOTS} results"
            ));
        }
        ports.insert(declared.id.clone(), values);
        snapshot.insert(declared.id.clone(), recorded);
    }
    if total_bytes > definition.limits.max_output_bytes {
        return Err(format!(
            "the step referenced more than {} bytes of media",
            definition.limits.max_output_bytes
        ));
    }
    if let Some(summary) = root.get("summary") {
        if !summary.is_null() {
            if let Some(summary) = summary.as_str() {
                if summary.len() as u64 > definition.limits.max_text_bytes {
                    return Err("the step's summary exceeds the text limit".to_string());
                }
            }
        }
    }
    Ok(CheckedOutputs {
        ports,
        outputs: snapshot,
        slots,
    })
}

fn type_of_mime(mime: Option<&str>) -> Option<DataType> {
    let mime = mime?;
    if mime.starts_with("image/") {
        Some(DataType::Image)
    } else if mime.starts_with("audio/") {
        Some(DataType::Audio)
    } else if mime.starts_with("video/") {
        Some(DataType::Video)
    } else {
        None
    }
}

fn snapshot_value(
    recorded: &mut Vec<ExtensionOutputValue>,
    data_type: DataType,
    text: Option<&str>,
    asset_id: Option<&str>,
) {
    recorded.push(ExtensionOutputValue {
        data_type,
        text: text.map(str::to_string),
        asset_id: asset_id.map(str::to_string),
    });
}

fn data_type_named(name: &str) -> Option<DataType> {
    match name {
        "text" => Some(DataType::Text),
        "image" => Some(DataType::Image),
        "audio" => Some(DataType::Audio),
        "video" => Some(DataType::Video),
        "artifact" => Some(DataType::Artifact),
        _ => None,
    }
}

fn asset_of(value: &WorkflowValue) -> Option<AssetId> {
    match value {
        WorkflowValue::Media { asset_id, .. } | WorkflowValue::Artifact { asset_id, .. } => {
            Some(asset_id.clone())
        }
        WorkflowValue::Text { .. } => None,
    }
}

async fn clean_created(session: &Arc<FsProjectStore>, created: &Arc<Mutex<Vec<AssetId>>>) {
    let held = created.lock().map(|held| held.clone()).unwrap_or_default();
    for asset_id in held {
        if let Err(error) = session.remove_asset(&asset_id).await {
            tracing::warn!(
                "extension step could not remove intermediate asset {asset_id}: {error}"
            );
        }
    }
}

/// The values a script sees under `inputs`, plus what kind each referenced
/// asset really is and the names it was given.
async fn script_inputs(
    session: &Arc<FsProjectStore>,
    request: &ExecutionRequest,
) -> (serde_json::Value, HashMap<AssetId, DataType>) {
    let opened = session.current().await.ok().flatten();
    let mut resources = HashMap::new();
    if let Some(opened) = &opened {
        for entry in opened.moka.resources.all() {
            resources.insert(entry.id.clone(), entry.clone());
        }
    }
    let mut inputs = serde_json::Map::new();
    let mut types = HashMap::new();
    for (port, values) in &request.inputs {
        let mut listed = Vec::with_capacity(values.len());
        for value in values {
            let (source_node, source_port) = match value {
                WorkflowValue::Text { source, .. }
                | WorkflowValue::Media { source, .. }
                | WorkflowValue::Artifact { source, .. } => {
                    (source.node_id.clone(), source.port_id.clone())
                }
            };
            let source = serde_json::json!({ "nodeId": source_node, "portId": source_port });
            match value {
                WorkflowValue::Text { text, .. } => {
                    listed.push(serde_json::json!({
                        "type": "text",
                        "text": text,
                        "source": source,
                    }));
                }
                WorkflowValue::Media {
                    media_type,
                    asset_id,
                    ..
                }
                | WorkflowValue::Artifact {
                    asset_id,
                    media_type: Some(media_type),
                    ..
                } => {
                    let entry = resources.get(asset_id);
                    let kind = media_type.as_str();
                    types.insert(asset_id.clone(), *media_type);
                    listed.push(serde_json::json!({
                        "type": kind,
                        "assetId": asset_id,
                        "mime": entry.and_then(|entry| entry.mime.clone()),
                        "name": entry.map(|entry| entry.name.clone()),
                        "width": entry.and_then(|entry| entry.probe.as_ref().and_then(|probe| probe.width)),
                        "height": entry.and_then(|entry| entry.probe.as_ref().and_then(|probe| probe.height)),
                        "durationMs": entry.and_then(|entry| entry.probe.as_ref().and_then(|probe| probe.duration_ms)),
                        "source": source,
                    }));
                }
                WorkflowValue::Artifact {
                    asset_id,
                    media_type: None,
                    ..
                } => {
                    let entry = resources.get(asset_id);
                    let mime = entry
                        .and_then(|entry| entry.mime.as_deref())
                        .unwrap_or_default();
                    let kind = if mime.starts_with("image/") {
                        DataType::Image
                    } else if mime.starts_with("audio/") {
                        DataType::Audio
                    } else if mime.starts_with("video/") {
                        DataType::Video
                    } else {
                        DataType::Artifact
                    };
                    types.insert(asset_id.clone(), kind);
                    listed.push(serde_json::json!({
                        "type": "artifact",
                        "assetId": asset_id,
                        "mime": entry.and_then(|entry| entry.mime.clone()),
                        "name": entry.map(|entry| entry.name.clone()),
                        "source": source,
                    }));
                }
            }
        }
        inputs.insert(port.clone(), serde_json::Value::Array(listed));
    }
    (serde_json::Value::Object(inputs), types)
}

impl ExtensionExecutor {
    #[allow(clippy::too_many_arguments, clippy::result_large_err)]
    fn model_caller(
        &self,
        session: &Arc<FsProjectStore>,
        request: &ExecutionRequest,
        definition: &Arc<super::manifest::NodeDefinition>,
        invocation: &crate::workflow::ExtensionInvocation,
        handles: &BTreeMap<String, ModelHandleInfo>,
        input_ids: &HashSet<AssetId>,
        control: &Arc<StepControl>,
        cancel: &Cancel,
        logs: &Arc<LogWriter>,
        calls: &Arc<Mutex<Vec<ExtensionCallRecord>>>,
        created: &Arc<Mutex<Vec<AssetId>>>,
        count: &Arc<AtomicU32>,
        node_title: &str,
    ) -> impl Fn(ModelCall) -> Result<ModelAnswer, ModelError> + Send + Sync + 'static {
        let gateway = Arc::clone(&self.gateway);
        let session = Arc::clone(session);
        let run_id = request.run_id.clone();
        let canvas_id: CanvasId = request.canvas_id.clone();
        let node_id: NodeId = request.node_id.clone();
        let node_title = node_title.to_string();
        let extension_id = invocation.extension_id.clone();
        let definition = Arc::clone(definition);
        let handles = handles.clone();
        let bindings = invocation.bindings.clone();
        let input_ids = input_ids.clone();
        let control = Arc::clone(control);
        let cancel = cancel.clone();
        let logs = Arc::clone(logs);
        let calls = Arc::clone(calls);
        let created = Arc::clone(created);
        let count = Arc::clone(count);
        let max_calls = definition.limits.max_model_calls;
        let handle = tokio::runtime::Handle::current();

        move |call: ModelCall| {
            let made = count.fetch_add(1, Ordering::SeqCst) + 1;
            if made > max_calls {
                return Err(ModelError {
                    code: "EXTENSION_LIMIT_EXCEEDED".into(),
                    message: format!("the script asked for more than {max_calls} model calls"),
                    details: serde_json::json!({ "maxModelCalls": max_calls }),
                    retryable: false,
                    cancelled: false,
                    timed_out: false,
                });
            }
            if control.is_cancelled() {
                return Err(model_cancelled());
            }
            if control.timed_out() {
                return Err(model_timeout());
            }
            let allowed = generation_param_keys(call.capability);
            if let Some(params) = call.params.as_object() {
                for key in params.keys() {
                    if !allowed.contains(&key.as_str()) {
                        return Err(ModelError {
                            code: "EXTENSION_SCRIPT_FAILED".into(),
                            message: format!(
                                "parameter \"{key}\" is not something a {} model takes",
                                call.capability.as_str()
                            ),
                            details: serde_json::json!({ "slot": call.slot, "parameter": key }),
                            retryable: false,
                            cancelled: false,
                            timed_out: false,
                        });
                    }
                }
            }
            let model_name = handles
                .get(&call.slot)
                .map(|handle| handle.model_name.clone())
                .unwrap_or_else(|| call.slot.clone());
            let binding = bindings.get(&call.slot).cloned().unwrap_or_default();
            let request = GenerateRequest {
                capability: call.capability,
                model: binding.clone(),
                prompt: call.prompt.clone(),
                system: call.system.clone(),
                params: call.params.as_object().cloned().unwrap_or_default(),
                inputs: match lua_inputs(&call.inputs) {
                    Ok(inputs) => inputs,
                    Err(message) => {
                        return Err(ModelError {
                            code: "EXTENSION_SCRIPT_FAILED".into(),
                            message,
                            details: serde_json::json!({ "slot": call.slot }),
                            retryable: false,
                            cancelled: false,
                            timed_out: false,
                        })
                    }
                },
            };
            let started = Instant::now();
            let remaining = control.remaining();
            if remaining.is_zero() {
                return Err(model_timeout());
            }
            let gateway = Arc::clone(&gateway);
            let session = Arc::clone(&session);
            let cancel = cancel.clone();
            let node_title = node_title.clone();
            let slot = call.slot.clone();
            let slot_label = definition
                .slot(&slot)
                .map(|held| held.label.clone())
                .unwrap_or_else(|| slot.clone());
            let capability = call.capability;
            let definition_id = extension_id.clone();
            let run = run_id.clone();
            let canvas = canvas_id.clone();
            let node = node_id.clone();
            let input_ids = input_ids.clone();
            let created_handle = Arc::clone(&created);
            let slot_for_call = slot.clone();

            let outcome = handle.block_on(async move {
                let answer = tokio::time::timeout(remaining, async {
                    call_gateway(&gateway, &session, request, &cancel, capability).await
                })
                .await;
                match answer {
                    Err(_) => Err(ProviderError::Timeout(
                        "the step's time limit was reached".into(),
                    )),
                    Ok(Err(error)) => Err(error),
                    Ok(Ok(result)) => {
                        let inputs: Vec<AssetId> = input_ids.iter().cloned().collect();
                        let filed = file_answers(
                            &session,
                            &run,
                            &canvas,
                            &node,
                            &node_title,
                            &slot_label,
                            &definition_id,
                            &slot_for_call,
                            &binding,
                            &inputs,
                            &result,
                        )
                        .await;
                        match filed {
                            Ok(items) => {
                                if let Ok(mut created) = created_handle.lock() {
                                    created.extend(items.iter().filter_map(|item| {
                                        if item.asset_id.is_empty() {
                                            None
                                        } else {
                                            Some(item.asset_id.clone())
                                        }
                                    }));
                                }
                                Ok((result, items))
                            }
                            Err(error) => Err(ProviderError::Unreachable(format!(
                                "the answer could not be filed: {error}"
                            ))),
                        }
                    }
                }
            });

            let took = started.elapsed();
            match outcome {
                Ok((result, items)) => {
                    if let Ok(mut records) = calls.lock() {
                        records.push(ExtensionCallRecord {
                            slot: slot.clone(),
                            model: model_name.clone(),
                            capability,
                            duration_ms: u64::try_from(took.as_millis()).unwrap_or(u64::MAX),
                            produced: items.len() as u32,
                            failed: false,
                            error: None,
                        });
                    }
                    let usage = result
                        .usage
                        .map(|usage| serde_json::to_value(usage).unwrap_or_default())
                        .unwrap_or(serde_json::Value::Null);
                    Ok(ModelAnswer {
                        text: result.text,
                        items,
                        usage,
                    })
                }
                Err(error) => {
                    let cancelled = matches!(error, ProviderError::Cancelled);
                    let timed_out = matches!(error, ProviderError::Timeout(_));
                    if let Ok(mut records) = calls.lock() {
                        records.push(ExtensionCallRecord {
                            slot: slot.clone(),
                            model: model_name.clone(),
                            capability,
                            duration_ms: u64::try_from(took.as_millis()).unwrap_or(u64::MAX),
                            produced: 0,
                            failed: true,
                            error: Some(error.to_string()),
                        });
                    }
                    logs.push(
                        "warn",
                        &format!("model call to \"{slot}\" failed: {}", error),
                    );
                    Err(ModelError {
                        code: if cancelled {
                            "EXTENSION_CANCELLED".into()
                        } else if control.timed_out() {
                            "EXTENSION_TIMEOUT".into()
                        } else {
                            "EXTENSION_MODEL_CALL_FAILED".into()
                        },
                        message: error.to_string(),
                        details: serde_json::json!({
                            "slot": slot,
                            "model": model_name,
                            "capability": capability.as_str(),
                            "providerCode": error.code(),
                            "retryable": error.retryable(),
                        }),
                        retryable: error.retryable(),
                        cancelled,
                        timed_out,
                    })
                }
            }
        }
    }
}

fn model_cancelled() -> ModelError {
    ModelError {
        code: "EXTENSION_CANCELLED".into(),
        message: "the run was cancelled".into(),
        details: serde_json::Value::Null,
        retryable: false,
        cancelled: true,
        timed_out: false,
    }
}

fn model_timeout() -> ModelError {
    ModelError {
        code: "EXTENSION_TIMEOUT".into(),
        message: "the step exceeded its time limit".into(),
        details: serde_json::Value::Null,
        retryable: false,
        cancelled: false,
        timed_out: true,
    }
}

fn lua_inputs(inputs: &[serde_json::Value]) -> Result<Vec<GenerateInput>, String> {
    let mut read = Vec::with_capacity(inputs.len());
    for input in inputs {
        let object = input
            .as_object()
            .ok_or_else(|| "a model input is not a table".to_string())?;
        let role = match object.get("role").and_then(serde_json::Value::as_str) {
            Some("reference") => InputRole::Reference,
            Some("firstFrame") => InputRole::FirstFrame,
            Some("lastFrame") => InputRole::LastFrame,
            Some("mask") => InputRole::Mask,
            Some("controlVideo") => InputRole::ControlVideo,
            Some("controlAudio") => InputRole::ControlAudio,
            Some(other) => return Err(format!("\"{other}\" is not a reference role")),
            None => return Err("a model input states no role".to_string()),
        };
        let asset_id = object
            .get("assetId")
            .and_then(serde_json::Value::as_str)
            .filter(|asset| !asset.is_empty())
            .ok_or_else(|| "a model input names no asset".to_string())?;
        let window = object
            .get("window")
            .and_then(serde_json::Value::as_object)
            .map(|window| GenerateWindow {
                start_ms: window
                    .get("startMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                duration_ms: window
                    .get("durationMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            });
        read.push(GenerateInput {
            role,
            asset_id: asset_id.to_string(),
            window,
        });
    }
    Ok(read)
}

async fn call_gateway(
    gateway: &Gateway,
    session: &Arc<FsProjectStore>,
    request: GenerateRequest,
    cancel: &Cancel,
    capability: Capability,
) -> Result<GenerateResult, ProviderError> {
    match capability {
        Capability::Text => {
            gateway
                .text(session, request, &DeltaSink::default(), cancel)
                .await
        }
        Capability::Image => gateway.image(session, request, cancel).await,
        Capability::Speech => gateway.speech(session, request, cancel).await,
        Capability::Music => gateway.music(session, request, cancel).await,
        Capability::Video => {
            let task = gateway.video(session, request, cancel).await?;
            let result = wait_job(gateway, session, &task.id, cancel).await;
            gateway.settle_job(session, &task.id).await;
            result
        }
        Capability::Asr => {
            let task = gateway.transcribe(session, request, cancel).await?;
            let result = wait_job(gateway, session, &task.id, cancel).await;
            gateway.settle_job(session, &task.id).await;
            result
        }
    }
}

/// Waits a job the extension started itself, to its end.
async fn wait_job(
    gateway: &Gateway,
    session: &Arc<FsProjectStore>,
    task: &str,
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    let ceiling = gateway.poll_ceiling();
    for _ in 0..ceiling {
        match gateway.poll(session, task, cancel).await? {
            TaskState::Succeeded(result) => return Ok(result),
            TaskState::Failed { message, retryable } => {
                return Err(if retryable {
                    ProviderError::Unreachable(message)
                } else {
                    ProviderError::Rejected(message)
                })
            }
            TaskState::Pending { retry_after_ms } => {
                let delay = if retry_after_ms > 0 {
                    Duration::from_millis(retry_after_ms)
                } else {
                    POLL_INTERVAL
                };
                cancel.wait(delay).await?;
            }
        }
    }
    Err(ProviderError::Timeout(
        "the job was still running after the last look".into(),
    ))
}

/// Files every item an answer carried, in the order it gave them, as a
/// step-only asset with the extension and slot that asked for it.
#[allow(clippy::too_many_arguments)]
async fn file_answers(
    session: &Arc<FsProjectStore>,
    run_id: &str,
    canvas_id: &str,
    node_id: &str,
    node_title: &str,
    slot_label: &str,
    extension_id: &str,
    slot: &str,
    model: &str,
    input_ids: &[AssetId],
    result: &GenerateResult,
) -> Result<Vec<ModelItem>, ProviderError> {
    let count = result.items.len();
    let mut incoming = Vec::with_capacity(count);
    for (index, item) in result.items.iter().enumerate() {
        let name = if count > 1 {
            format!("{node_title} · {slot_label} {}", index + 1)
        } else {
            format!("{node_title} · {slot_label}")
        };
        incoming.push(Incoming {
            name,
            bytes: item.bytes.clone(),
            mime: item.mime.clone(),
            category_hint: category_hint(item.kind),
            provenance: AssetProvenance {
                run_id: Some(run_id.to_string()),
                canvas_id: Some(canvas_id.to_string()),
                operation_node_id: Some(node_id.to_string()),
                assistant_session_id: None,
                story_job_id: None,
                story_id: None,
                input_asset_ids: if input_ids.is_empty() {
                    None
                } else {
                    Some(input_ids.to_vec())
                },
                parameter_snapshot: Some(serde_json::json!({
                    "extensionId": extension_id,
                    "slot": slot,
                    "call": index + 1,
                    "model": model,
                })),
                created_at: now_iso(),
            },
        });
    }
    let entries = file_incoming(session.as_ref(), incoming).await?;
    Ok(entries
        .into_iter()
        .zip(result.items.iter())
        .map(|(entry, item)| ModelItem {
            kind: media_kind(item.kind).to_string(),
            mime: item.mime.clone(),
            asset_id: entry.id,
            width: item.width,
            height: item.height,
            duration_ms: item.duration_ms,
        })
        .collect())
}

fn media_kind(kind: Capability) -> &'static str {
    match kind {
        Capability::Image => "image",
        Capability::Speech | Capability::Music => "audio",
        Capability::Video => "video",
        Capability::Text | Capability::Asr => "text",
    }
}

fn category_hint(kind: Capability) -> Option<String> {
    match kind {
        Capability::Speech => Some("voice".to_string()),
        Capability::Music => Some("music".to_string()),
        _ => None,
    }
}
