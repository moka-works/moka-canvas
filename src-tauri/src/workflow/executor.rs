//! The deterministic executor: local text operations with no external
//! dependencies. It exercises the full run pipeline — validation, queueing,
//! cancellation, result promotion — before any networked provider ships.

use super::{
    ExecutionError, ExecutionOutput, ExecutionRequest, ExecutionValidationError, ProgressReporter,
    WorkflowExecutor, WorkflowValue,
};
use crate::domain::{RunId, ValidationIssue};
use crate::project::store::FsProjectStore;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

const OPERATION_TEXT: &str = "deterministic.text";
const DEFAULT_SEPARATOR: &str = "\n\n";
const MAX_SEPARATOR_CHARS: usize = 100;
const MAX_DELAY_MS: u64 = 10_000;
const MAX_FAIL_WITH_CHARS: usize = 200;
const CANCEL_POLL_MS: u64 = 25;

#[derive(Default)]
pub struct DeterministicExecutor {
    cancelled: Mutex<HashSet<String>>,
}

impl DeterministicExecutor {
    pub fn new() -> Self {
        Self::default()
    }

    fn is_cancelled(&self, run_id: &str) -> bool {
        self.cancelled
            .lock()
            .expect("cancel registry poisoned")
            .contains(run_id)
    }

    fn clear_cancel(&self, run_id: &str) {
        self.cancelled
            .lock()
            .expect("cancel registry poisoned")
            .remove(run_id);
    }
}

struct TextParams {
    separator: String,
    delay_ms: u64,
    fail_with: Option<String>,
}

fn param_issue(message: impl Into<String>, node_id: &str) -> ValidationIssue {
    ValidationIssue {
        code: "PARAM_INVALID".to_string(),
        message: message.into(),
        canvas_id: None,
        node_id: Some(node_id.to_string()),
        port_id: None,
        edge_id: None,
        timeline_id: None,
        track_id: None,
        clip_id: None,
        transition_id: None,
    }
}

fn parse_text_params(
    raw: &serde_json::Value,
    node_id: &str,
) -> Result<TextParams, ExecutionValidationError> {
    let mut issues = Vec::new();
    let mut params = TextParams {
        separator: DEFAULT_SEPARATOR.to_string(),
        delay_ms: 0,
        fail_with: None,
    };
    match raw {
        serde_json::Value::Null => {}
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                match key.as_str() {
                    "separator" => match value.as_str() {
                        Some(separator) if separator.chars().count() <= MAX_SEPARATOR_CHARS => {
                            params.separator = separator.to_string();
                        }
                        Some(_) => issues.push(param_issue(
                            format!(
                                "\"separator\" must be at most {MAX_SEPARATOR_CHARS} characters"
                            ),
                            node_id,
                        )),
                        None => issues.push(param_issue("\"separator\" must be a string", node_id)),
                    },
                    "delayMs" => match value.as_f64() {
                        Some(delay)
                            if delay.is_finite()
                                && delay >= 0.0
                                && delay <= MAX_DELAY_MS as f64 =>
                        {
                            params.delay_ms = delay.round() as u64;
                        }
                        _ => issues.push(param_issue(
                            format!("\"delayMs\" must be a number between 0 and {MAX_DELAY_MS}"),
                            node_id,
                        )),
                    },
                    "failWith" => match value {
                        serde_json::Value::Null => {}
                        serde_json::Value::String(message)
                            if message.chars().count() <= MAX_FAIL_WITH_CHARS =>
                        {
                            params.fail_with = Some(message.clone());
                        }
                        serde_json::Value::String(_) => issues.push(param_issue(
                            format!(
                                "\"failWith\" must be at most {MAX_FAIL_WITH_CHARS} characters"
                            ),
                            node_id,
                        )),
                        _ => issues.push(param_issue("\"failWith\" must be a string", node_id)),
                    },
                    other => issues.push(param_issue(
                        format!("Unknown parameter \"{other}\""),
                        node_id,
                    )),
                }
            }
        }
        _ => issues.push(param_issue("Parameters must be an object", node_id)),
    }
    if issues.is_empty() {
        Ok(params)
    } else {
        Err(ExecutionValidationError { issues })
    }
}

#[async_trait::async_trait]
impl WorkflowExecutor for DeterministicExecutor {
    fn key(&self) -> &str {
        "deterministic"
    }

    fn supports(&self, operation_type: &str) -> bool {
        operation_type == OPERATION_TEXT
    }

    async fn validate(&self, request: &ExecutionRequest) -> Result<(), ExecutionValidationError> {
        let mut issues = match parse_text_params(&request.parameters, &request.node_id) {
            Ok(_) => Vec::new(),
            Err(error) => error.issues,
        };
        let texts = request.inputs.get("text").map(Vec::len).unwrap_or(0);
        if texts == 0 {
            issues.push(ValidationIssue {
                code: "PORT_UNRESOLVED".to_string(),
                message: "The text input needs at least one connection".to_string(),
                canvas_id: None,
                node_id: Some(request.node_id.clone()),
                port_id: Some("text".to_string()),
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(ExecutionValidationError { issues })
        }
    }

    async fn execute(
        &self,
        _session: &Arc<FsProjectStore>,
        request: ExecutionRequest,
        progress: ProgressReporter,
    ) -> Result<ExecutionOutput, ExecutionError> {
        let params = parse_text_params(&request.parameters, &request.node_id)
            .map_err(|_| ExecutionError::failed("Parameters failed validation"))?;
        progress.report(0.0);

        if self.is_cancelled(&request.run_id) {
            self.clear_cancel(&request.run_id);
            return Err(ExecutionError::cancelled());
        }
        if params.delay_ms > 0 {
            let slices = (params.delay_ms / CANCEL_POLL_MS).max(1);
            let slice_ms = params.delay_ms / slices;
            for elapsed in 0..slices {
                tokio::time::sleep(std::time::Duration::from_millis(slice_ms)).await;
                if self.is_cancelled(&request.run_id) {
                    self.clear_cancel(&request.run_id);
                    return Err(ExecutionError::cancelled());
                }
                progress.report((elapsed + 1) as f64 / (slices + 1) as f64);
            }
        }

        if let Some(message) = params.fail_with {
            self.clear_cancel(&request.run_id);
            return Err(ExecutionError {
                code: "STEP_FAILED",
                message,
                details: None,
                retryable: true,
                cancelled: false,
            });
        }

        let texts: Vec<&str> = request
            .inputs
            .get("text")
            .into_iter()
            .flatten()
            .filter_map(|value| match value {
                WorkflowValue::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        self.clear_cancel(&request.run_id);
        progress.report(1.0);
        Ok(ExecutionOutput {
            text: Some(texts.join(&params.separator)),
            ..Default::default()
        })
    }

    async fn cancel(&self, run_id: &RunId) -> Result<(), ExecutionError> {
        self.cancelled
            .lock()
            .expect("cancel registry poisoned")
            .insert(run_id.to_string());
        Ok(())
    }
}
