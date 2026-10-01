//! The provider executor: one generation step, placed through the gateway.
//!
//! Who answers and how is the gateway's business; this module is the shape
//! that fits a generation into the run pipeline. It adds the three things the
//! gateway has no words for: a cancellation flag per run, because a run is
//! cancelled from the outside while a step sits in the middle of a provider
//! call; a wait for a job that answers later rather than at once; and the
//! splitting of that job into a start and a wait, so the run can write the
//! handle down in between and pick the same job up after a restart.

use super::{
    ExecutionError, ExecutionOutput, ExecutionRequest, ExecutionValidationError, PlacedJob,
    ProgressReporter, WorkflowExecutor, PROVIDER_EXECUTOR_KEY,
};
use crate::domain::{Capability, RunId, ValidationIssue};
use crate::generate::{
    AsyncTask, Cancel, DeltaSink, Gateway, GenerateRequest, GenerateResult, ProviderError,
    TaskState,
};
use crate::project::store::FsProjectStore;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const OPERATION_PREFIX: &str = "generate.";

/// How long between two looks at a job a provider is still making. A shot takes
/// minutes, and asking every few hundred milliseconds would only add traffic to
/// a queue the provider is already working through.
const POLL_INTERVAL: Duration = Duration::from_millis(2500);

/// The flags a run's steps answer to.
///
/// One per run rather than one per step, because a run drives one step at a
/// time and a cancel names the run.
#[derive(Default)]
struct CancelRegistry(Mutex<HashMap<RunId, Cancel>>);

impl CancelRegistry {
    /// The flag this run's step answers to.
    ///
    /// Looked up rather than made fresh: a cancel that arrived before the step
    /// started left its flag here, and picking that one up is what makes the
    /// gateway refuse at once instead of placing a call nobody wants any more.
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

/// Hands every generation step to the models the user configured.
pub struct ProviderExecutor {
    gateway: Arc<Gateway>,
    in_flight: CancelRegistry,
}

impl ProviderExecutor {
    pub fn new(gateway: Arc<Gateway>) -> Self {
        Self {
            gateway,
            in_flight: CancelRegistry::default(),
        }
    }

    /// One generation answered inside the call that asks for it.
    ///
    /// Borrowed by the story jobs, which drive batches of generations rather
    /// than a graph: a batch has no nodes and no run to hang a cancel flag on,
    /// so it brings its own flag and gets the same gateway call a step does.
    /// Everything a step adds around it — the merged preferences, the retries,
    /// the classification of a failure — is here rather than copied.
    ///
    /// The sink is the caller's: a step being watched streams its words to the
    /// screen, and a batch nobody is watching streams them into the void —
    /// which is still worth asking for, since an answer that travels as it is
    /// written is not the one a gateway gives up on.
    pub async fn answer_once(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        deltas: &DeltaSink,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ExecutionError> {
        if asks_for_nothing(&request) {
            return Err(ExecutionError {
                code: "GENERATION_PROMPT_EMPTY",
                message: "The prompt resolved to nothing and no reference came with it".to_string(),
                details: None,
                retryable: false,
                cancelled: false,
            });
        }
        let result = answered(session, &self.gateway, &request, deltas, cancel)
            .await
            .map_err(step_error)?;
        cancel.check().map_err(step_error)?;
        Ok(result)
    }

    /// Places a shot and hands the handle back without waiting for it.
    ///
    /// Split from the wait so a caller can write the handle down in between: a
    /// job that was placed before a process stopped is collectable by the next
    /// one only if something on disk says it exists.
    pub async fn shoot(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        cancel: &Cancel,
    ) -> Result<AsyncTask, ExecutionError> {
        // Only a shot is a job. Everything else answers inside the call that
        // asks, and a caller that named another capability has the wrong door.
        if request.capability != Capability::Video {
            return Err(ExecutionError {
                code: "VALIDATION_FAILED",
                message: "Only a shot is placed as a job".to_string(),
                details: None,
                retryable: false,
                cancelled: false,
            });
        }
        if asks_for_nothing(&request) {
            return Err(ExecutionError {
                code: "GENERATION_PROMPT_EMPTY",
                message: "The prompt resolved to nothing and no reference came with it".to_string(),
                details: None,
                retryable: false,
                cancelled: false,
            });
        }
        self.gateway
            .video(session, request, cancel)
            .await
            .map_err(step_error)
    }

    /// Waits out a job that was placed earlier, whoever placed it.
    ///
    /// The handle is the whole state: nothing else about the caller is needed
    /// to ask after it again, which is what lets the wait outlive the process
    /// that started it.
    pub async fn collect(
        &self,
        session: &Arc<FsProjectStore>,
        task: &str,
        cancel: &Cancel,
        progress: &ProgressReporter,
    ) -> Result<GenerateResult, ExecutionError> {
        let result = waited(session, &self.gateway, task, cancel, progress)
            .await
            .map_err(step_error)?;
        cancel.check().map_err(step_error)?;
        Ok(result)
    }
}

/// Whether an operation is one this executor can place. The capability is
/// carried by the request rather than spelled out in the operation, so a
/// capability added later needs no change here.
fn takes(operation_type: &str) -> bool {
    operation_type.starts_with(OPERATION_PREFIX)
}

/// What can be decided about a step before the run starts.
///
/// Only the structural half of it. Whether the prompt resolved to anything
/// cannot be answered here: an upstream generation node feeding this one has
/// not run yet, so its contribution is still empty and refusing on that would
/// break every chain. That question is asked again when the step runs.
fn check(request: &ExecutionRequest) -> Result<(), ExecutionValidationError> {
    if request.generation.is_none() {
        // Reachable only from an operation node that named this executor by
        // hand: a generation node always arrives with its request resolved.
        return Err(ExecutionValidationError {
            issues: vec![issue(
                "NOT_EXECUTABLE",
                format!("\"{}\" needs a generation to run", request.operation_type),
                &request.node_id,
            )],
        });
    }
    Ok(())
}

/// Whether a resolved request has anything to ask for.
///
/// The same rule the document checks, asked again at the first moment it can be
/// answered: an upstream generation has only just contributed, so a prompt that
/// looked empty before the run may not be one now. A reference beside a blank
/// prompt is an instruction-free edit rather than nothing to do, so only the
/// two together count as empty — asking a provider to draw nothing either bills
/// for a blank or is refused.
fn asks_for_nothing(generation: &GenerateRequest) -> bool {
    generation.prompt.trim().is_empty() && generation.inputs.is_empty()
}

/// What a step asks for, or the reason there is nothing to send.
///
/// One guard for both halves of a step: a request too empty to answer at once
/// is too empty to start a job for.
fn asked_for(request: &ExecutionRequest) -> Result<GenerateRequest, ExecutionError> {
    let Some(generation) = request.generation.clone() else {
        return Err(ExecutionError::failed(
            "The step carries no resolved generation",
        ));
    };
    // Asked here rather than before the run: this is the first moment the
    // question has an answer.
    if asks_for_nothing(&generation) {
        return Err(ExecutionError {
            code: "GENERATION_PROMPT_EMPTY",
            message: "The prompt resolved to nothing and no reference came with it".to_string(),
            details: None,
            retryable: false,
            cancelled: false,
        });
    }
    Ok(generation)
}

/// One answer, read as it arrives.
///
/// The capability decides which call is made, and the gateway stamps the same
/// capability back on, so a request that disagreed with the node it came from
/// cannot reach a provider it was not meant for.
async fn answered(
    session: &Arc<FsProjectStore>,
    gateway: &Gateway,
    request: &GenerateRequest,
    deltas: &DeltaSink,
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    match request.capability {
        // Words are the only answer that arrives a piece at a time. Whether a
        // provider is asked for a stream at all is the sink's business, so one
        // nobody is watching costs nothing here.
        Capability::Text => gateway.text(session, request.clone(), deltas, cancel).await,
        Capability::Image => gateway.image(session, request.clone(), cancel).await,
        Capability::Speech => gateway.speech(session, request.clone(), cancel).await,
        Capability::Music => gateway.music(session, request.clone(), cancel).await,
        // A shot is started and then waited out, and starting one here would be
        // starting something nobody in this call is going to collect.
        Capability::Video => Err(ProviderError::invalid(
            "a shot is a job rather than an answer waited out",
        )),
        // Recognition is asked for by the cutting room, which starts and
        // collects the job itself; no node generates in it.
        Capability::Asr => Err(ProviderError::invalid(
            "speech recognition is not something a node generates",
        )),
    }
}

/// Waits a job out, one look at a time.
///
/// A provider answers a shot with "still going" rather than with the result, so
/// this is a loop with a ceiling rather than a request held open. Each look is
/// a separate call, a hint about when to come back is obeyed when the provider
/// gives one, and the ceiling — a number the deployment set rather than one
/// this module knows — is what turns a job one silently forgot into a failure.
async fn waited(
    session: &Arc<FsProjectStore>,
    gateway: &Gateway,
    task: &str,
    cancel: &Cancel,
    progress: &ProgressReporter,
) -> Result<GenerateResult, ProviderError> {
    // Read once rather than per look: the fraction a caller is shown has to be
    // measured against the same ceiling the loop counts to.
    let ceiling = gateway.poll_ceiling();
    for look in 0..ceiling {
        let delay = match gateway.poll(session, task, cancel).await? {
            TaskState::Succeeded(result) => return Ok(result),
            // The job ended badly rather than this step failing to look, but
            // the two carry the same information: what went wrong, and whether
            // waiting could fix it.
            TaskState::Failed { message, retryable } => {
                return Err(if retryable {
                    ProviderError::Unreachable(message)
                } else {
                    ProviderError::Rejected(message)
                })
            }
            TaskState::Pending { retry_after_ms } => {
                progress.report(f64::from(look + 1) / f64::from(ceiling + 1));
                if retry_after_ms > 0 {
                    Duration::from_millis(retry_after_ms)
                } else {
                    POLL_INTERVAL
                }
            }
        };
        cancel.wait(delay).await?;
    }
    Err(ProviderError::Timeout(format!(
        "the job was still running after {ceiling} looks at it"
    )))
}

/// A provider failure as a step failure.
///
/// The code and the retryability are the provider's own classification, which
/// is the one a client already reads on the generation routes; only the shape
/// changes. The message is whatever the gateway lifted out of the answer, so
/// nothing a provider echoed back travels further than it already did.
fn step_error(error: ProviderError) -> ExecutionError {
    ExecutionError {
        code: error.code(),
        message: error.to_string(),
        details: error.details(),
        retryable: error.retryable(),
        cancelled: matches!(error, ProviderError::Cancelled),
    }
}

fn issue(code: &str, message: impl Into<String>, node_id: &str) -> ValidationIssue {
    ValidationIssue {
        code: code.to_string(),
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

#[async_trait::async_trait]
impl WorkflowExecutor for ProviderExecutor {
    fn key(&self) -> &str {
        PROVIDER_EXECUTOR_KEY
    }

    fn supports(&self, operation_type: &str) -> bool {
        takes(operation_type)
    }

    async fn validate(&self, request: &ExecutionRequest) -> Result<(), ExecutionValidationError> {
        check(request)
    }

    async fn execute(
        &self,
        session: &Arc<FsProjectStore>,
        request: ExecutionRequest,
        progress: ProgressReporter,
    ) -> Result<ExecutionOutput, ExecutionError> {
        // A shot goes through the same two halves a run drives separately, so
        // asking for a whole step and asking for it in two cannot come apart.
        if let Some(job) = self.place_job(session, request.clone()).await? {
            let mut output = self.wait_job(session, job.clone(), progress).await?;
            output.task = Some(job);
            return Ok(output);
        }
        let generation = asked_for(&request)?;
        progress.report(0.0);
        let cancel = self.in_flight.flag(&request.run_id);
        let outcome = answered(
            session,
            &self.gateway,
            &generation,
            &request.deltas,
            &cancel,
        )
        .await;
        self.in_flight.release(&request.run_id);
        let result = outcome.map_err(step_error)?;
        // Checked on the way out as well as on the way in: a cancel that landed
        // while the provider was working still means the run that asked has
        // gone, and keeping an answer for it would store a result nobody wanted.
        cancel.check().map_err(step_error)?;
        progress.report(1.0);
        Ok(ExecutionOutput {
            text: result.text,
            items: result.items,
            task: None,
        })
    }

    async fn place_job(
        &self,
        session: &Arc<FsProjectStore>,
        request: ExecutionRequest,
    ) -> Result<Option<PlacedJob>, ExecutionError> {
        let generation = asked_for(&request)?;
        // Only a shot is a job. Everything else answers inside the call that
        // asks, and there is nothing to write down in between.
        if generation.capability != Capability::Video {
            return Ok(None);
        }
        let cancel = self.in_flight.flag(&request.run_id);
        let task = match self.gateway.video(session, generation, &cancel).await {
            Ok(task) => task,
            Err(error) => {
                self.in_flight.release(&request.run_id);
                return Err(step_error(error));
            }
        };
        // Handed back before the wait rather than after it: this is the moment
        // a job exists at the far end and nothing on this side says so yet.
        Ok(Some(PlacedJob {
            run_id: request.run_id,
            task_id: task.id,
            created_at: task.created_at,
        }))
    }

    async fn wait_job(
        &self,
        session: &Arc<FsProjectStore>,
        job: PlacedJob,
        progress: ProgressReporter,
    ) -> Result<ExecutionOutput, ExecutionError> {
        progress.report(0.0);
        let cancel = self.in_flight.flag(&job.run_id);
        let outcome = waited(session, &self.gateway, &job.task_id, &cancel, &progress).await;
        self.in_flight.release(&job.run_id);
        let result = outcome.map_err(step_error)?;
        cancel.check().map_err(step_error)?;
        progress.report(1.0);
        // The job is not reported back: whoever waited it out already had the
        // handle, and a run that picked this up after a restart read it off its
        // own record.
        Ok(ExecutionOutput {
            text: result.text,
            items: result.items,
            task: None,
        })
    }

    async fn cancel(&self, run_id: &RunId) -> Result<(), ExecutionError> {
        // Flipped whether or not a step is running: one that has not started
        // yet picks the flag up when it does, and one that has is a no-op.
        self.in_flight.flag(run_id).cancel();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::{GenerateInput, InputRole};
    use std::collections::BTreeMap;

    fn step(operation_type: &str, prompt: &str) -> ExecutionRequest {
        ExecutionRequest {
            run_id: "run-1".to_string(),
            node_id: "node-1".to_string(),
            operation_type: operation_type.to_string(),
            parameters: serde_json::Value::Null,
            inputs: BTreeMap::new(),
            deltas: DeltaSink::default(),
            generation: Some(GenerateRequest {
                capability: Capability::Image,
                prompt: prompt.to_string(),
                ..GenerateRequest::default()
            }),
        }
    }

    #[test]
    fn only_a_generation_operation_is_this_executors_business() {
        for operation in [
            "generate.text",
            "generate.image",
            "generate.audio",
            "generate.video",
        ] {
            assert!(takes(operation), "{operation} must be taken");
        }
        // One with no dot has no capability to route on, and one whose name
        // merely begins with the same letters is somebody else's operation.
        for operation in ["deterministic.text", "generate", "", "generator.text"] {
            assert!(!takes(operation), "{operation} must be left alone");
        }
    }

    #[test]
    fn a_step_that_carries_no_generation_cannot_be_scheduled() {
        check(&step("generate.image", "   "))
            .expect("an empty prompt is not this check's business");

        // A hand-written operation node can name this executor without carrying
        // a generation at all, and there is nothing to send.
        let bare = ExecutionRequest {
            generation: None,
            ..step("generate.text", "a lantern")
        };
        let issues = check(&bare).expect_err("there is nothing to send").issues;
        assert_eq!(issues[0].code, "NOT_EXECUTABLE");
        assert_eq!(issues[0].node_id.as_deref(), Some("node-1"));
        assert!(issues[0].canvas_id.is_none(), "the scheduler fills this in");
    }

    #[test]
    fn a_blank_prompt_is_only_empty_when_nothing_came_with_it() {
        // Decided when the step runs rather than before the run, because an
        // upstream generation has not contributed yet when a run is validated.
        let blank = GenerateRequest {
            capability: Capability::Image,
            prompt: "   ".to_string(),
            ..GenerateRequest::default()
        };
        assert!(asks_for_nothing(&blank));

        // An instruction-free edit is a real request: the reference is what to
        // work on, and refusing it would refuse a legitimate way to ask.
        let edited = GenerateRequest {
            inputs: vec![GenerateInput {
                role: InputRole::Reference,
                asset_id: "asset-1".into(),
                window: None,
            }],
            ..blank.clone()
        };
        assert!(!asks_for_nothing(&edited));
        assert!(!asks_for_nothing(
            &step("generate.image", "a lantern").generation.unwrap()
        ));
    }

    #[test]
    fn a_provider_failure_keeps_its_own_code_and_its_own_advice() {
        let busy = step_error(ProviderError::RateLimited {
            detail: "slow down".into(),
            retry_after: None,
        });
        assert_eq!(busy.code, "PROVIDER_RATE_LIMIT");
        assert!(busy.retryable, "waiting is the fix for a busy provider");
        assert!(!busy.cancelled);

        let refused = step_error(ProviderError::Rejected("the prompt was refused".into()));
        assert_eq!(refused.code, "PROVIDER_BAD_REQUEST");
        assert!(!refused.retryable, "the same request fails the same way");

        let gone = step_error(ProviderError::Cancelled);
        assert_eq!(gone.code, "GENERATION_CANCELLED");
        assert!(gone.cancelled, "the runner reads this to halt the run");
        assert!(!gone.retryable);

        // The message is what the gateway lifted out of the answer, so it is
        // what reaches the run record and nothing further does.
        assert_eq!(
            refused.message,
            "the provider rejected the request: the prompt was refused"
        );
    }

    #[test]
    fn a_cancel_that_arrives_before_the_step_is_still_honoured() {
        let registry = CancelRegistry::default();
        // What `cancel` does: the executor is only the place the run id comes
        // from, and no gateway is involved in flipping a flag.
        registry.flag("run-9").cancel();

        let cancel = registry.flag("run-9");
        assert!(cancel.is_cancelled(), "the step picks the same flag up");
        assert_eq!(
            cancel.check().unwrap_err().code(),
            "GENERATION_CANCELLED",
            "the provider must never be asked"
        );

        registry.release("run-9");
        assert!(
            !registry.flag("run-9").is_cancelled(),
            "a finished step leaves no flag behind"
        );
    }
}
