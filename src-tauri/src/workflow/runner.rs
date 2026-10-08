//! The run manager: owns the run lifecycle (queue, drive, cancel, retry) and
//! persists every transition through the project store. A bounded number of runs
//! drive at once, and each driver is the only writer of the record it drives, so
//! cancel requests arrive through an in-memory flag the driver observes between
//! and during steps.

use super::events::{streamed_words, RunEvent, RunEvents};
use super::validate::{validate_run, RunSnapshot};
use super::{
    data_type_for, executor_key_for, operation_type_for, ExecutionError, ExecutionOutput,
    ExecutionRequest, PlacedJob, ProgressReporter, ValueProvenance, WorkflowExecutor,
    WorkflowValue,
};
use crate::domain::commands::make_node;
use crate::domain::validate::{MAX_RESULT_SLOTS, MAX_TITLE_LENGTH};
use crate::domain::{
    new_id, now_iso, AssetId, CanvasDocument, Capability, DataType, DocumentCommand, EdgeEndpoint,
    MokaFile, NodeData, NodeId, NodeKind, NodePatch, PortDirection, ResultSlot, ResultSlotStatus,
    RunId, RunRecord, RunStatus, RunStepRecord, SessionId, ValidationIssue, WorkflowEdge,
    WorkflowNode,
};
use crate::generate::{ingest_generated, GenerateResult};
use crate::project::store::FsProjectStore;
use crate::project::{ProjectError, ProjectStore};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub struct RunManager {
    executors: Vec<Arc<dyn WorkflowExecutor>>,
    enabled_executors: Vec<String>,
    /// How many runs drive at once, as permits rather than as a lock.
    ///
    /// A run past the ceiling waits here with its record still saying queued,
    /// which is what a client reads and what the run list shows; nothing has to
    /// be told it is waiting. The driver is still the only writer of the record
    /// it is driving, so two runs driving are two runs, not two writers of one.
    gate: tokio::sync::Semaphore,
    /// Serializes status transitions between the driver and cancel requests.
    transitions: tokio::sync::Mutex<()>,
    cancel_requests: Mutex<HashSet<RunId>>,
    /// What the runs being driven are saying, to anybody listening.
    events: RunEvents,
}

#[derive(Debug)]
pub enum StartRunError {
    Validation(Vec<ValidationIssue>),
    Store(ProjectError),
}

impl From<ProjectError> for StartRunError {
    fn from(error: ProjectError) -> Self {
        Self::Store(error)
    }
}

/// What one step leaves behind: what to write on the run record, and what the
/// node downstream reads.
struct StepArtifacts {
    text: Option<String>,
    assets: Option<Vec<AssetId>>,
    /// The upstream job the step went through, for the ones that are a job
    /// rather than an answer waited out.
    task: Option<PlacedJob>,
}

/// What one scheduled node turned out to be.
///
/// Decided before anything is run, because the two answers need different
/// things done to them: one is written down and waited out in two halves, and
/// the other has nothing to wait for.
enum StepPlan {
    /// Nothing an executor could do, so the node passes on what it already had.
    Passthrough(Option<WorkflowValue>, StepArtifacts),
    /// An executor takes it.
    Scheduled {
        executor: Arc<dyn WorkflowExecutor>,
        request: ExecutionRequest,
    },
}

/// How far to the right of a node the results past its first are placed, and how
/// far apart from each other: enough that the cards do not overlap, close enough
/// that the set still reads as one answer.
const RESULT_GAP: f64 = 40.0;

/// What a cancelled run says when a provider was still working for it.
///
/// The stop is this app's alone. There is no way back to a job once it has been
/// placed, so it ends when the far end ends it and is charged for as usual, and
/// somebody reading a cancelled run has to be told that rather than left to find
/// it on a bill.
const JOB_OUTLIVES_CANCEL: &str =
    "Cancelled here, but the job the provider is running was not: it may still finish and still be billed.";

/// Why a run stopped walking its steps, as the step that stopped it saw it.
///
/// The message and, when a step failed rather than the reader asking it to
/// stop, the code and values behind it: a client says the trouble again in
/// another language from those, and a reader of any language is owed them.
struct Halt {
    status: RunStatus,
    message: Option<String>,
    code: Option<String>,
    details: Option<serde_json::Value>,
}

impl Halt {
    /// A run stopped with something to say that no step classified.
    fn stopped(status: RunStatus, message: Option<String>) -> Self {
        Self {
            status,
            message,
            code: None,
            details: None,
        }
    }

    fn succeeded() -> Self {
        Self::stopped(RunStatus::Succeeded, None)
    }
}

/// What a step a previous process already finished still has to hand downstream.
///
/// Read off the record rather than asked of anybody again. A node nothing ran
/// passes on what it carries, exactly as it would have the first time through;
/// the answer of a node an executor ran is what the record says it produced.
fn remembered(
    snapshot: &RunSnapshot,
    node_id: &str,
    step: &RunStepRecord,
) -> Option<WorkflowValue> {
    let node = snapshot.nodes.get(node_id)?;
    if executor_key_for(node).is_none() {
        return snapshot.source_value(node_id);
    }
    let source = ValueProvenance {
        node_id: node.id.clone(),
        port_id: "out".to_string(),
    };
    match step.output_asset_ids.clone().unwrap_or_default().first() {
        // A picture, a voice or a shot travelled as the asset it became; words
        // travelled as words.
        Some(asset_id) if data_type_for(node.kind) != DataType::Text => {
            Some(WorkflowValue::Media {
                media_type: data_type_for(node.kind),
                asset_id: asset_id.clone(),
                source,
            })
        }
        _ => step
            .output_text
            .clone()
            .map(|text| WorkflowValue::Text { text, source }),
    }
}

/// What a finished step leaves on the node that made it.
///
/// Kept apart from the run record on purpose. The record says what happened;
/// this says what the canvas looks like afterwards, and a node that only passed
/// a value through has nothing to say about either.
enum Promotion {
    /// The answers a step made, in the order the provider gave them, and where
    /// the first of them goes.
    Answered {
        answers: Vec<Answer>,
        placement: Placement,
    },
    /// Nothing worth keeping, and why.
    Failed(String),
}

/// Where the first answer of a run goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    /// Onto the node that asked: a node holding nothing has nothing to lose,
    /// and a node holding words takes the new ones over the old, which stay
    /// reachable as results of their own rather than as a copy of the node.
    Own,
    /// Onto a card beside the node that asked, which already showed a picture
    /// and keeps showing it: an answer written over what somebody placed there
    /// would take away the only copy of it, and asking a picture again is how
    /// a canvas is compared rather than how it is overwritten.
    Beside,
}

/// One answer, as the node that holds it records it.
enum Answer {
    /// Words, and the asset they were filed as when they were filed.
    Words {
        text: String,
        asset_id: Option<AssetId>,
    },
    /// Media, as the asset it became.
    Media(AssetId),
}

impl Answer {
    /// What a node of this kind holds of it.
    ///
    /// Only a text node carries words as its own content and only a media node
    /// points at an asset as the thing it shows; an operation node holds
    /// neither, and its answer stays on the slot, which is where a reader looks
    /// for it.
    fn write_onto(&self, data: &mut NodeData, kind: NodeKind) {
        match (self, kind) {
            (Answer::Words { text, .. }, NodeKind::Text) => data.content = Some(text.clone()),
            (Answer::Media(asset_id), _) => data.asset_id = Some(asset_id.clone()),
            (Answer::Words { .. }, _) => {}
        }
    }

    fn asset_id(&self) -> Option<&AssetId> {
        match self {
            Answer::Words { asset_id, .. } => asset_id.as_ref(),
            Answer::Media(asset_id) => Some(asset_id),
        }
    }

    fn text(&self) -> Option<&str> {
        match self {
            Answer::Words { text, .. } => Some(text),
            Answer::Media(_) => None,
        }
    }

    /// One result as the node holding it records it. `primary` says whether this
    /// is the answer the node shows as its own, which an answer placed beside it
    /// is not.
    fn slot(&self, index: usize, primary: bool) -> ResultSlot {
        ResultSlot {
            id: slot_id(index),
            status: ResultSlotStatus::Succeeded,
            asset_id: self.asset_id().cloned(),
            text: self.text().map(str::to_string),
            error: None,
            is_primary: primary,
        }
    }
}

/// Whether the node a run saw had anything on it.
///
/// A text node is made holding an empty string rather than nothing, so what it
/// says has to be read rather than merely looked for.
fn was_empty(node: &WorkflowNode) -> bool {
    node.data.asset_id.is_none()
        && node
            .data
            .content
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
}

/// Whether a node is asked to make something, as opposed to read for what it
/// already holds.
///
/// A node the run was told to run is asked whatever is on it: asking again is
/// how a canvas gets a second answer to choose from. A node pulled in because
/// something below it reads it is asked only while it has nothing to hand
/// down. An upstream generation that already holds an answer is read instead,
/// because asking again would pay a provider for a copy of words or a picture
/// that are already on the node — placed beside it as though somebody had
/// asked for two.
fn is_asked(node: &WorkflowNode, requested: bool) -> bool {
    requested || was_empty(node)
}

/// What one succeeded step writes back, or `None` for a step that made nothing
/// to keep.
fn promotion_for(
    node: &WorkflowNode,
    artifacts: &StepArtifacts,
    requested: bool,
) -> Option<Promotion> {
    // Only a node an executor ran made anything. What a written text node or a
    // bound image already carries is its own, and a run did not add to it; and
    // a node the run read rather than ran has nothing new on it either — the
    // same question that decided its step decides this.
    executor_key_for(node)?;
    if !is_asked(node, requested) {
        return None;
    }
    let assets = artifacts.assets.clone().unwrap_or_default();
    let answers = match node.kind {
        NodeKind::Image | NodeKind::Audio | NodeKind::Video => {
            assets.into_iter().map(Answer::Media).collect()
        }
        _ => vec![Answer::Words {
            text: artifacts.text.clone().unwrap_or_default(),
            asset_id: assets.into_iter().next(),
        }],
    };
    // Read off the node as the run saw it rather than as it stands when the
    // answer lands: what somebody put there while it ran is theirs to keep, and
    // a generation waited out is a long time to have changed one's mind.
    //
    // Words are written onto the node whatever it said before: a text node's
    // content is the same stuff its answer is, so a second ask would otherwise
    // put a near-copy of the node beside it and call the pair a comparison.
    // What the node said stays reachable as a result, which is the keeping that
    // matters for words; a picture overwritten is a picture gone.
    let words = matches!(answers.first(), Some(Answer::Words { .. }));
    let placement = if was_empty(node) || words {
        Placement::Own
    } else {
        Placement::Beside
    };
    // An answer with no asset in it leaves a media node holding what it held:
    // there is nothing to point a card at.
    (!answers.is_empty()).then_some(Promotion::Answered { answers, placement })
}

/// A slot's id. The first is simply the result; the ones past it are numbered,
/// because an inspector that lists them has something to call each by.
fn slot_id(index: usize) -> String {
    if index == 0 {
        "result".to_string()
    } else {
        format!("result-{}", index + 1)
    }
}

fn failed(message: &str) -> ResultSlot {
    ResultSlot {
        id: slot_id(0),
        status: ResultSlotStatus::Failed,
        asset_id: None,
        text: None,
        error: Some(message.to_string()),
        is_primary: true,
    }
}

/// The cards for the answers that do not go onto the node that asked, and the
/// ids to record on it. Cards are numbered from `first`.
///
/// An answer that already has a card from an earlier run keeps it, updated rather
/// than replaced, so a card the user moved stays where they put it and a re-run
/// does not litter the canvas with a second set. Nothing is ever removed: a node
/// on the canvas is the user's to delete, and a run that asked for fewer answers
/// this time does not get to take one away.
fn result_nodes(
    canvas: &CanvasDocument,
    live: &WorkflowNode,
    extra: &[Answer],
    first: usize,
) -> (Vec<DocumentCommand>, Vec<NodeId>) {
    let mut commands = Vec::new();
    let mut ids = Vec::new();
    let previous = live.data.result_node_ids.clone().unwrap_or_default();
    for (index, answer) in extra.iter().enumerate() {
        let slots = Some(vec![answer.slot(0, true)]);
        let id = match previous.get(index).and_then(|id| canvas.node(id)) {
            Some(child) => {
                let mut data = child.data.clone();
                answer.write_onto(&mut data, child.kind);
                data.result_slots = slots;
                commands.push(DocumentCommand::UpdateNode {
                    canvas_id: canvas.id.clone(),
                    node_id: child.id.clone(),
                    patch: NodePatch {
                        title: None,
                        z_index: None,
                        data: Some(data),
                    },
                });
                child.id.clone()
            }
            None => {
                let mut child = make_node(
                    live.kind,
                    card_title(&live.title, first + index),
                    live.bounds.x + (live.bounds.width + RESULT_GAP) * (index as f64 + 1.0),
                    live.bounds.y,
                );
                answer.write_onto(&mut child.data, child.kind);
                child.data.result_slots = slots;
                // A card is made with the defaults for its kind, which call
                // every audio music; the node that asked for it knows better.
                child.data.audio_category = live.data.audio_category.clone();
                commands.push(DocumentCommand::AddNode {
                    canvas_id: canvas.id.clone(),
                    node: child.clone(),
                });
                child.id
            }
        };
        ids.push(id);
    }
    // Cards this run did not reach stay listed. They are still on the canvas,
    // and the next run that asks for more results reuses them rather than
    // adding a second set beside them.
    ids.extend(
        previous
            .iter()
            .skip(extra.len())
            .filter(|id| canvas.node(id).is_some())
            .cloned(),
    );
    (commands, ids)
}

/// The edge joining a node to the card that took its answer's place, or `None`
/// when there is nowhere to put one.
///
/// A kind with no input that can take what the node makes is left unjoined
/// rather than joined wrongly, and so is a card an earlier run made, which has
/// the edge already or had it taken away on purpose. Both matter because a
/// batch is applied as one: an edge the document refuses would cost the answers
/// beside it.
fn joined_back(
    canvas: &CanvasDocument,
    made: &[DocumentCommand],
    live: &WorkflowNode,
    card_id: &str,
) -> Option<DocumentCommand> {
    // The card is not on the canvas yet, it is in the commands about to be
    // written, so it is read out of those.
    let card = made.iter().find_map(|command| match command {
        DocumentCommand::AddNode { node, .. } if node.id == card_id => Some(node),
        _ => None,
    })?;
    let out = live.port("out")?;
    let into = card.ports.iter().find(|port| {
        port.direction == PortDirection::Input
            && port
                .data_types
                .iter()
                .any(|data_type| out.data_types.contains(data_type))
    })?;
    Some(DocumentCommand::AddEdge {
        canvas_id: canvas.id.clone(),
        edge: WorkflowEdge {
            id: new_id(),
            source: EdgeEndpoint {
                node_id: live.id.clone(),
                port_id: out.id.clone(),
            },
            target: EdgeEndpoint {
                node_id: card.id.clone(),
                port_id: into.id.clone(),
            },
            created_at: now_iso(),
        },
    })
}

/// A generated card's title: the node it came from, numbered. Shortened from the
/// parent's title when that alone would take the whole limit, since a title past
/// it is refused and would cost the whole write.
fn card_title(parent: &str, number: usize) -> String {
    let suffix = format!(" {number}");
    let room = MAX_TITLE_LENGTH.saturating_sub(suffix.chars().count());
    let mut title: String = parent.chars().take(room).collect();
    title.push_str(&suffix);
    title
}

impl RunManager {
    pub fn new(
        executors: Vec<Arc<dyn WorkflowExecutor>>,
        enabled_executors: Vec<String>,
        concurrent_runs: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            executors,
            enabled_executors,
            gate: tokio::sync::Semaphore::new(concurrent_runs),
            transitions: tokio::sync::Mutex::new(()),
            cancel_requests: Mutex::new(HashSet::new()),
            events: RunEvents::default(),
        })
    }

    /// What the runs being driven are saying.
    ///
    /// Handed out rather than served from inside, because the listener is a
    /// route and a route reads the run record as well: the two have to be the
    /// same bus for the record to arrive where the words were going.
    pub fn events(&self) -> RunEvents {
        self.events.clone()
    }

    /// What one step says about how far along it is.
    ///
    /// Published to whoever is listening and kept for the record, because a run
    /// that ends before the next write still says how far it got — which is the
    /// difference between "it stopped" and "it stopped three quarters in".
    fn reporter(
        &self,
        run_id: &RunId,
        node_id: &NodeId,
        reached: Arc<Mutex<Option<f64>>>,
    ) -> ProgressReporter {
        let events = self.events.clone();
        let run_id = run_id.clone();
        let node_id = node_id.clone();
        ProgressReporter::new(Arc::new(move |fraction| {
            *reached
                .lock()
                .expect("a step's progress is not held across a call") = Some(fraction);
            events.publish(RunEvent::progress(
                run_id.clone(),
                node_id.clone(),
                fraction,
            ));
        }))
    }

    /// Says a run has ended and stops its channel.
    ///
    /// Both, because a listener that is told nothing waits for a record that is
    /// already written, and a channel left open is a stream left hanging.
    async fn ended(&self, run: &RunRecord) {
        // The last read of an answer is still buffered when the step that
        // produced it returns, and a listener stops reading at an ending.
        self.events.settle(&run.id).await;
        self.events.publish(RunEvent::done(
            run.id.clone(),
            run.status,
            run.error.clone(),
        ));
        self.events.close(&run.id);
    }

    /// Validates the request against the current document, persists the
    /// queued record, and hands the run to the driver task.
    ///
    /// `store` is the project the run belongs to, resolved for the request that
    /// asked for it: the document is validated against that project and the
    /// record is kept in it, whatever anybody opens while the run drives.
    pub async fn start(
        self: &Arc<Self>,
        store: &Arc<FsProjectStore>,
        canvas_id: &str,
        node_ids: Vec<NodeId>,
        retry_of_run_id: Option<RunId>,
        assistant_session_id: Option<SessionId>,
    ) -> Result<RunRecord, StartRunError> {
        let opened = store
            .current()
            .await?
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let snapshot = validate_run(
            &opened.root,
            &opened.moka,
            canvas_id,
            &node_ids,
            &self.executors,
            &self.enabled_executors,
        )
        .await
        .map_err(StartRunError::Validation)?;

        let executor_key = node_ids
            .first()
            .and_then(|id| snapshot.nodes.get(id))
            .and_then(executor_key_for)
            .unwrap_or_default()
            .to_string();
        let mut parameters = serde_json::Map::new();
        for node_id in &node_ids {
            if let Some(node) = snapshot.nodes.get(node_id) {
                parameters.insert(
                    node.id.clone(),
                    node.data
                        .parameters
                        .clone()
                        .unwrap_or(serde_json::Value::Null),
                );
            }
        }

        let now = now_iso();
        let run = RunRecord {
            id: new_id(),
            project_id: opened.moka.metadata.id.clone(),
            canvas_id: canvas_id.to_string(),
            requested_node_ids: node_ids,
            status: RunStatus::Queued,
            executor_key,
            graph_hash: snapshot.graph_hash.clone(),
            parameters: serde_json::Value::Object(parameters),
            retry_of_run_id,
            assistant_session_id,
            steps: snapshot
                .order
                .iter()
                .map(|node_id| RunStepRecord {
                    node_id: node_id.clone(),
                    status: RunStatus::Queued,
                    started_at: None,
                    finished_at: None,
                    error: None,
                    error_code: None,
                    error_details: None,
                    output_asset_ids: None,
                    output_text: None,
                    task_id: None,
                    task_created_at: None,
                    progress: None,
                })
                .collect(),
            error: None,
            error_code: None,
            error_details: None,
            cancel_requested: false,
            created_at: now.clone(),
            updated_at: now,
        };
        let run = store.create_run(run).await?;

        let driver = Arc::clone(self);
        let session = Arc::clone(store);
        let run_id = run.id.clone();
        tokio::spawn(async move {
            driver.drive(session, run_id, snapshot).await;
        });
        Ok(run)
    }

    /// A retry is a brand-new run linked to its predecessor; it revalidates
    /// against the current document rather than trusting the old snapshot.
    pub async fn retry(
        self: &Arc<Self>,
        store: &Arc<FsProjectStore>,
        run_id: &str,
    ) -> Result<RunRecord, StartRunError> {
        let run = store.get_run(run_id).await?;
        if !matches!(run.status, RunStatus::Failed | RunStatus::Cancelled) {
            return Err(ProjectError::domain(
                "RUN_NOT_RETRYABLE",
                "Only failed or cancelled runs can be retried",
            )
            .into());
        }
        self.start(
            store,
            &run.canvas_id.clone(),
            run.requested_node_ids.clone(),
            Some(run.id.clone()),
            // Asking again for what a conversation asked for is still that
            // conversation asking, and an answer filed without it would be
            // traceable to nothing.
            run.assistant_session_id.clone(),
        )
        .await
    }

    /// Picks up the runs a previous process was in the middle of.
    ///
    /// Called when a project opens, because that is the first moment there is
    /// somewhere to put an answer. The sweep on open has already failed
    /// everything that cannot be picked up again, so what is left here is
    /// waiting on a job a provider is still running.
    pub async fn resume_interrupted(self: &Arc<Self>, store: &Arc<FsProjectStore>) {
        let interrupted = match store.interrupted_runs().await {
            Ok(interrupted) => interrupted,
            Err(error) => {
                tracing::warn!("the runs left in progress could not be listed: {error}");
                return;
            }
        };
        for run_id in interrupted {
            let driver = Arc::clone(self);
            let session = Arc::clone(store);
            tokio::spawn(async move {
                driver.resume(session, run_id).await;
            });
        }
    }

    /// Drives a run that was already under way.
    ///
    /// Revalidated against the document rather than trusted: it may have been
    /// edited while the process was down, and a step whose node is gone has
    /// nothing left to wait out.
    async fn resume(self: Arc<Self>, store: Arc<FsProjectStore>, run_id: RunId) {
        let run = match store.get_run(&run_id).await {
            Ok(run) => run,
            Err(error) => {
                tracing::warn!("run {run_id}: could not be read back: {error}");
                return;
            }
        };
        let Some(opened) = store.current().await.ok().flatten() else {
            return;
        };
        let snapshot = match validate_run(
            &opened.root,
            &opened.moka,
            &run.canvas_id,
            &run.requested_node_ids,
            &self.executors,
            &self.enabled_executors,
        )
        .await
        {
            Ok(snapshot) => snapshot,
            Err(issues) => {
                let reason = issues
                    .first()
                    .map(|issue| issue.message.clone())
                    .unwrap_or_else(|| "The document no longer supports this run".to_string());
                tracing::warn!("run {run_id}: {reason}");
                self.end_unresumable(&store, run, &reason).await;
                return;
            }
        };
        // Steps are walked by position, so an order that came out differently is
        // a record this driver cannot read: it would write one node's answer
        // onto another's step.
        let same_walk = snapshot.order.len() == run.steps.len()
            && snapshot
                .order
                .iter()
                .zip(run.steps.iter())
                .all(|(node_id, step)| node_id == &step.node_id);
        if !same_walk {
            let reason = "The graph was edited while this run was in progress";
            tracing::warn!("run {run_id}: {reason}");
            self.end_unresumable(&store, run, reason).await;
            return;
        }
        self.drive(store, run_id, snapshot).await;
    }

    /// Ends a run that cannot be picked up again.
    ///
    /// Left in progress it would be attempted at every open after this one, and
    /// the notes of the jobs it was waiting on would stay on disk for nobody.
    async fn end_unresumable(&self, store: &Arc<FsProjectStore>, run: RunRecord, reason: &str) {
        let _guard = self.transitions.lock().await;
        let run_id = run.id.clone();
        let mut run = run;
        for step in &run.steps {
            if let Some(task_id) = &step.task_id {
                if let Err(error) = store.drop_job(task_id).await {
                    tracing::warn!("run {run_id}: job {task_id} could not be forgotten: {error}");
                }
            }
        }
        run.status = RunStatus::Failed;
        run.error = Some(reason.to_string());
        for step in &mut run.steps {
            if matches!(step.status, RunStatus::Queued | RunStatus::Running) {
                step.status = RunStatus::Failed;
                step.error = Some("Interrupted before completion".to_string());
            }
        }
        run.updated_at = now_iso();
        match store.update_run(run).await {
            Ok(run) => self.ended(&run).await,
            Err(error) => tracing::warn!("run {run_id}: could not be ended: {error}"),
        }
    }

    pub async fn cancel(
        &self,
        store: &Arc<FsProjectStore>,
        run_id: &str,
    ) -> Result<RunRecord, ProjectError> {
        let _guard = self.transitions.lock().await;
        let run = store.get_run(run_id).await?;
        match run.status {
            RunStatus::Queued => {
                let mut run = run;
                run.status = RunStatus::Cancelled;
                run.cancel_requested = true;
                for step in &mut run.steps {
                    if step.status == RunStatus::Queued {
                        step.status = RunStatus::Cancelled;
                    }
                }
                run.updated_at = now_iso();
                // Ended here rather than by a driver, and so said here: a run
                // cancelled before it started has nobody else to speak for it.
                let run = store.update_run(run).await?;
                self.ended(&run).await;
                Ok(run)
            }
            RunStatus::Running => {
                let owned = run_id.to_string();
                self.cancel_requests
                    .lock()
                    .expect("cancel registry poisoned")
                    .insert(owned.clone());
                for executor in &self.executors {
                    let _ = executor.cancel(&owned).await;
                }
                let mut run = run;
                run.cancel_requested = true;
                Ok(run)
            }
            _ => Err(ProjectError::domain(
                "RUN_NOT_CANCELLABLE",
                "The run has already finished",
            )),
        }
    }

    fn cancellation_requested(&self, run_id: &str) -> bool {
        self.cancel_requests
            .lock()
            .expect("cancel registry poisoned")
            .contains(run_id)
    }

    async fn drive(
        self: Arc<Self>,
        store: Arc<FsProjectStore>,
        run_id: RunId,
        snapshot: RunSnapshot,
    ) {
        // Held for the whole walk rather than taken per step: what the ceiling
        // bounds is how many runs are driving, and a step that let its permit go
        // would hand the run's place to another one mid-flight.
        let _permit = self
            .gate
            .acquire()
            .await
            .expect("the ceiling on runs is never closed");
        let mut run = {
            let _guard = self.transitions.lock().await;
            match store.get_run(&run_id).await {
                Ok(run) if run.status == RunStatus::Queued => {
                    let mut run = run;
                    run.status = RunStatus::Running;
                    run.updated_at = now_iso();
                    match store.update_run(run).await {
                        Ok(run) => run,
                        Err(error) => {
                            tracing::warn!("run {run_id}: could not mark running: {error}");
                            return;
                        }
                    }
                }
                // A run a previous process was in the middle of. It is already
                // recorded as running, so picking it up is walking the steps it
                // had not reached rather than starting over.
                Ok(run) if run.status == RunStatus::Running => run,
                // Ended while waiting for the gate, or unreadable. Either way
                // there is nothing to drive, and a listener is told so rather
                // than left waiting on a driver that is not coming.
                Ok(run) => {
                    self.ended(&run).await;
                    return;
                }
                Err(error) => {
                    tracing::warn!("run {run_id}: could not be read back: {error}");
                    return;
                }
            }
        };

        // The snapshot is written to as the run goes, so the order it is walked
        // in is taken out first: a step's answer has to reach the step after it,
        // and the order is the one thing about the walk that must not change.
        let mut snapshot = snapshot;
        let order = snapshot.order.clone();
        let mut outputs: HashMap<NodeId, WorkflowValue> = HashMap::new();
        let mut halt: Option<Halt> = None;

        for (position, node_id) in order.iter().enumerate() {
            if self.cancellation_requested(&run_id) {
                halt = Some(Halt::stopped(RunStatus::Cancelled, None));
                break;
            }
            // A step a previous process already finished is remembered rather
            // than run again: what the steps after it need is the answer, and
            // asking a provider for it a second time would pay twice for one.
            if run.steps[position].status == RunStatus::Succeeded {
                if let Some(value) = remembered(&snapshot, node_id, &run.steps[position]) {
                    snapshot.record_output(node_id, &value);
                    outputs.insert(node_id.clone(), value);
                }
                continue;
            }
            // A handle already on the record is a job that was placed before the
            // process stopped, which is waited out rather than placed again.
            let placed = run.steps[position]
                .task_id
                .clone()
                .map(|task_id| PlacedJob {
                    run_id: run.id.clone(),
                    task_id,
                    created_at: run.steps[position]
                        .task_created_at
                        .clone()
                        .unwrap_or_else(now_iso),
                });
            if run.steps[position].status != RunStatus::Running {
                run.steps[position].status = RunStatus::Running;
                run.steps[position].started_at = Some(now_iso());
                run.updated_at = now_iso();
                if let Err(error) = store.update_run(run.clone()).await {
                    tracing::warn!("run {run_id}: could not persist step start: {error}");
                }
            }

            let outcome = self
                .run_step(&store, &mut run, &snapshot, position, &outputs, placed)
                .await;
            run.steps[position].finished_at = Some(now_iso());
            match outcome {
                Ok((value, artifacts)) => {
                    // Decided before the artifacts are moved into the record.
                    let requested = run.requested_node_ids.iter().any(|id| id == node_id);
                    let promotion = promotion_for(&snapshot.nodes[node_id], &artifacts, requested);
                    let step = &mut run.steps[position];
                    step.status = RunStatus::Succeeded;
                    step.output_text = artifacts.text;
                    step.output_asset_ids = artifacts.assets;
                    step.task_id = artifacts.task.as_ref().map(|job| job.task_id.clone());
                    step.task_created_at = artifacts.task.map(|job| job.created_at);
                    if let Some(promotion) = promotion {
                        self.promote_result(&store, &snapshot, node_id, promotion)
                            .await;
                    }
                    if let Some(value) = value {
                        snapshot.record_output(node_id, &value);
                        outputs.insert(node_id.clone(), value);
                    }
                }
                Err(error) => {
                    if error.cancelled {
                        run.steps[position].status = RunStatus::Cancelled;
                        // Stopping here stops the waiting, not the work: a job a
                        // provider is running has no way back and keeps costing
                        // until it ends on its own.
                        let billing = run.steps[position]
                            .task_id
                            .is_some()
                            .then(|| JOB_OUTLIVES_CANCEL.to_string());
                        halt = Some(Halt::stopped(RunStatus::Cancelled, billing));
                    } else {
                        run.steps[position].status = RunStatus::Failed;
                        run.steps[position].error = Some(error.message.clone());
                        run.steps[position].error_code = Some(error.code.to_string());
                        run.steps[position].error_details = error.details.clone();
                        let title = &snapshot.nodes[node_id].title;
                        halt = Some(Halt {
                            status: RunStatus::Failed,
                            message: Some(format!("\"{title}\": {}", error.message)),
                            code: Some(error.code.to_string()),
                            details: error.details.clone(),
                        });
                        // A cancellation produced no output. Only a step an
                        // executor ran can fail, so there is no kind to check.
                        self.promote_result(
                            &store,
                            &snapshot,
                            node_id,
                            Promotion::Failed(error.message.clone()),
                        )
                        .await;
                    }
                    run.updated_at = now_iso();
                    let _ = store.update_run(run.clone()).await;
                    break;
                }
            }
            run.updated_at = now_iso();
            if let Err(error) = store.update_run(run.clone()).await {
                tracing::warn!("run {run_id}: could not persist step result: {error}");
            }
        }

        let ended = halt.unwrap_or_else(Halt::succeeded);
        // Given up before the run is written as ended, because the note of a job
        // is the only thing that makes a run resumable: a process that stops in
        // between leaves a run that fails the next time somebody asks after the
        // job, rather than a handle on disk that nobody is ever coming back for.
        for step in &run.steps {
            if let Some(task_id) = &step.task_id {
                if let Err(error) = store.drop_job(task_id).await {
                    tracing::warn!("run {run_id}: job {task_id} could not be forgotten: {error}");
                }
            }
        }
        {
            let _guard = self.transitions.lock().await;
            for step in &mut run.steps {
                if matches!(step.status, RunStatus::Queued | RunStatus::Running) {
                    step.status = RunStatus::Cancelled;
                }
            }
            run.status = ended.status;
            run.error = ended.message;
            run.error_code = ended.code;
            run.error_details = ended.details;
            if run.status == RunStatus::Cancelled {
                run.cancel_requested = true;
            }
            run.updated_at = now_iso();
            match store.update_run(run).await {
                // Said after the write rather than before: a listener that
                // hears the ending is about to ask for the record, and it has
                // to be there.
                Ok(run) => self.ended(&run).await,
                Err(error) => {
                    tracing::warn!("run {run_id}: could not persist final state: {error}")
                }
            }
        }
        self.cancel_requests
            .lock()
            .expect("cancel registry poisoned")
            .remove(&run_id);
    }

    /// Resolves one scheduled node into what is going to happen to it.
    ///
    /// A node with nothing an executor could do passes the value it already had
    /// downstream, which is how written words or a bound image reach the step
    /// after them. An upstream generation the run was not asked for passes its
    /// own answer down the same way once it has one. Everything else is handed
    /// to the executor it names.
    fn plan_step(
        &self,
        run: &RunRecord,
        snapshot: &RunSnapshot,
        node_id: &str,
        outputs: &HashMap<NodeId, WorkflowValue>,
    ) -> Result<StepPlan, ExecutionError> {
        let node = &snapshot.nodes[node_id];
        let requested = run.requested_node_ids.iter().any(|id| id == node_id);
        // Read rather than asked: a node the run was not told to run that
        // already holds an answer hands it down instead of paying a provider
        // for a copy of it. The same question decides what is written back,
        // so the two cannot come apart.
        let executor_key = executor_key_for(node).filter(|_| is_asked(node, requested));
        let Some(executor_key) = executor_key else {
            let value = snapshot.source_value(&node.id);
            let artifacts = match &value {
                Some(WorkflowValue::Text { text, .. }) => StepArtifacts {
                    text: Some(text.clone()),
                    assets: None,
                    task: None,
                },
                Some(WorkflowValue::Media { asset_id, .. })
                | Some(WorkflowValue::Artifact { asset_id, .. }) => StepArtifacts {
                    text: None,
                    assets: Some(vec![asset_id.clone()]),
                    task: None,
                },
                None => StepArtifacts {
                    text: None,
                    assets: None,
                    task: None,
                },
            };
            return Ok(StepPlan::Passthrough(value, artifacts));
        };

        let operation_type = operation_type_for(node);
        let executor = self
            .executors
            .iter()
            // Both halves matter: an executor that would take the operation but
            // is not the one the node named would run a step the document never
            // asked for.
            .find(|executor| executor.key() == executor_key && executor.supports(&operation_type))
            .ok_or_else(|| ExecutionError {
                code: "OPERATION_UNSUPPORTED",
                message: format!("No executor supports \"{operation_type}\""),
                details: None,
                retryable: false,
                cancelled: false,
            })?;

        let mut inputs: BTreeMap<String, Vec<WorkflowValue>> = BTreeMap::new();
        for edge in snapshot.edges_for_target(&node.id) {
            if let Some(value) = outputs.get(&edge.source.node_id) {
                inputs
                    .entry(edge.target.port_id.clone())
                    .or_default()
                    .push(value.clone());
            }
        }
        for port in &node.ports {
            if port.direction == PortDirection::Input {
                inputs.entry(port.id.clone()).or_default();
            }
        }

        let request = ExecutionRequest {
            run_id: run.id.clone(),
            node_id: node.id.clone(),
            operation_type,
            parameters: node
                .data
                .parameters
                .clone()
                .unwrap_or(serde_json::Value::Null),
            inputs,
            generation: node
                .data
                .generation
                .as_ref()
                // Resolved once here rather than in the executor: the same
                // reading of the graph builds the request and stamps the answer
                // that comes back, so the two cannot disagree about what fed it.
                .map(|spec| snapshot.generation_inputs(&node.id).request_for(spec)),
            // Words are the only answer that arrives a piece at a time, so the
            // only one worth a stream of its own. Where they will land is known
            // now, and saying so lets a listener show them there rather than
            // somewhere it has to move them from later.
            deltas: node
                .data
                .generation
                .as_ref()
                .filter(|spec| spec.capability == Capability::Text)
                .map(|_| {
                    streamed_words(
                        self.events.clone(),
                        run.id.clone(),
                        node.id.clone(),
                        slot_id(0),
                    )
                })
                .unwrap_or_default(),
        };
        Ok(StepPlan::Scheduled {
            executor: Arc::clone(executor),
            request,
        })
    }

    /// Runs one scheduled node.
    ///
    /// A step whose answer arrives later is the reason this is not one call:
    /// the handle is written onto the record the moment a job exists, because a
    /// shot takes minutes and a process that stops in the middle of one has to
    /// leave enough behind to ask again rather than pay for a second shot.
    async fn run_step(
        &self,
        store: &Arc<FsProjectStore>,
        run: &mut RunRecord,
        snapshot: &RunSnapshot,
        position: usize,
        outputs: &HashMap<NodeId, WorkflowValue>,
        placed: Option<PlacedJob>,
    ) -> Result<(Option<WorkflowValue>, StepArtifacts), ExecutionError> {
        let node_id = run.steps[position].node_id.clone();
        let plan = self.plan_step(run, snapshot, &node_id, outputs)?;
        match plan {
            StepPlan::Passthrough(value, artifacts) => Ok((value, artifacts)),
            StepPlan::Scheduled { executor, request } => {
                // Kept beside the reporter rather than asked of it: a reporter
                // is a callback with no way to answer a question, and the
                // record has to say how far the step got even when the next
                // thing it did was fail.
                let reached = Arc::new(Mutex::new(None));
                let progress = self.reporter(&run.id, &node_id, Arc::clone(&reached));
                let how_far = || {
                    *reached
                        .lock()
                        .expect("a step's progress is not held across a call")
                };
                let job = match placed {
                    // A job a previous process placed is waited out rather than
                    // placed again: it survived, and so did the answer it is
                    // going to give.
                    Some(job) => job,
                    None => {
                        let Some(job) = executor.place_job(store, request.clone()).await? else {
                            // Nothing to wait for, so nothing to write down.
                            let outcome = executor.execute(store, request, progress).await;
                            run.steps[position].progress = how_far();
                            return self
                                .finish_step(store, run, snapshot, &node_id, outcome?)
                                .await;
                        };
                        run.steps[position].task_id = Some(job.task_id.clone());
                        run.steps[position].task_created_at = Some(job.created_at.clone());
                        run.updated_at = now_iso();
                        if let Err(error) = store.update_run(run.clone()).await {
                            tracing::warn!(
                                "run {}: could not persist the job handle: {error}",
                                run.id
                            );
                        }
                        job
                    }
                };
                let outcome = executor.wait_job(store, job.clone(), progress).await;
                run.steps[position].progress = how_far();
                let (value, mut artifacts) = self
                    .finish_step(store, run, snapshot, &node_id, outcome?)
                    .await?;
                // Reported with the artifacts as well, so a step waited out in
                // one call and one waited out in two leave the same record.
                artifacts.task = Some(job);
                Ok((value, artifacts))
            }
        }
    }

    /// Files a step's answer in the project and turns it into what travels on.
    ///
    /// A generation's answer is filed before any of it travels downstream: what
    /// flows between nodes is an asset reference, never the bytes.
    async fn finish_step(
        &self,
        store: &Arc<FsProjectStore>,
        run: &RunRecord,
        snapshot: &RunSnapshot,
        node_id: &str,
        output: ExecutionOutput,
    ) -> Result<(Option<WorkflowValue>, StepArtifacts), ExecutionError> {
        let node = &snapshot.nodes[node_id];
        let source = ValueProvenance {
            node_id: node.id.clone(),
            port_id: "out".to_string(),
        };
        let ExecutionOutput { text, items, task } = output;
        if node.data.generation.is_none() {
            let value = text
                .clone()
                .map(|text| WorkflowValue::Text { text, source });
            return Ok((
                value,
                StepArtifacts {
                    text,
                    assets: None,
                    task: None,
                },
            ));
        }

        let result = GenerateResult {
            text: text.clone(),
            items,
            usage: None,
        };
        let resolved = snapshot.generation_inputs(&node.id);
        let entries = ingest_generated(store.as_ref(), run, node, &resolved, &result)
            .await
            .map_err(|error| ExecutionError {
                code: error.code(),
                message: error.to_string(),
                details: None,
                // The provider already answered; what failed is filing the
                // answer. Retrying the step would pay for a second generation
                // to fix a problem on this disk.
                retryable: false,
                cancelled: false,
            })?;
        let assets: Vec<AssetId> = entries.into_iter().map(|entry| entry.id).collect();
        let value = match assets.first() {
            // A picture, a voice or a shot travels as the asset it became.
            // Words travel as words, whether or not filing them made a text
            // asset of its own.
            Some(asset_id) if data_type_for(node.kind) != DataType::Text => {
                Some(WorkflowValue::Media {
                    media_type: data_type_for(node.kind),
                    asset_id: asset_id.clone(),
                    source,
                })
            }
            _ => text
                .clone()
                .map(|text| WorkflowValue::Text { text, source }),
        };
        Ok((
            value,
            StepArtifacts {
                text,
                assets: if assets.is_empty() {
                    None
                } else {
                    Some(assets)
                },
                task,
            },
        ))
    }

    /// Writes a step's result onto the node that made it, through the command
    /// pipeline so the document stays the single source of truth.
    ///
    /// Best-effort: the run record keeps the output even when the node vanished
    /// or the write could not land, and a result the canvas cannot show is not
    /// worth failing a run over.
    async fn promote_result(
        &self,
        store: &Arc<FsProjectStore>,
        snapshot: &RunSnapshot,
        node_id: &str,
        promotion: Promotion,
    ) {
        let canvas_id = snapshot.canvas_id.clone();
        let node_id = node_id.to_string();
        self.write_live(
            store,
            &format!("run: result promotion for node {node_id}"),
            |moka| promotion_commands(moka, &canvas_id, &node_id, &promotion),
        )
        .await;
    }

    /// Applies a write built from the document as it is right now, rebuilding it
    /// from a fresh read whenever the document moved in between.
    async fn write_live(
        &self,
        store: &Arc<FsProjectStore>,
        label: &str,
        build: impl Fn(&MokaFile) -> Option<Vec<DocumentCommand>>,
    ) {
        for _ in 0..5 {
            let current = match store.current().await {
                Ok(Some(opened)) => opened,
                _ => return,
            };
            let revision = current.moka.metadata.revision;
            let Some(commands) = build(&current.moka) else {
                return;
            };
            match store.apply_commands(revision, commands).await {
                Ok(_) => return,
                Err(error) if error.code() == "REVISION_CONFLICT" => continue,
                Err(error) => {
                    tracing::warn!("{label}: {error}");
                    return;
                }
            }
        }
        tracing::warn!("{label}: the document kept moving");
    }
}

/// The commands one promotion is written with, built from the document as it
/// stands, or `None` when the node it belongs to is no longer there.
///
/// The cards come before the node that points at them and the edge between them
/// comes after both, and the whole set is a single batch: written apart, a crash
/// on the way would leave a slot naming a card that was never added, or an edge
/// the document refuses for want of a node at one end of it.
fn promotion_commands(
    moka: &MokaFile,
    canvas_id: &str,
    node_id: &str,
    promotion: &Promotion,
) -> Option<Vec<DocumentCommand>> {
    let canvas = moka.canvas(canvas_id)?;
    let live = canvas.node(node_id)?;
    let mut data = live.data.clone();
    let (answers, placement) = match promotion {
        Promotion::Answered { answers, placement } => (answers.as_slice(), *placement),
        // What the node held before is left where it was: a failed attempt says
        // why it failed, it does not take the last answer that worked away. It
        // gets no card either, since there is nothing for one to hold.
        Promotion::Failed(message) => {
            data.result_slots = Some(vec![failed(message)]);
            return Some(vec![write_back(canvas_id, node_id, data)]);
        }
    };
    let (own, cards, numbering) = match placement {
        Placement::Own => (answers.first(), answers.get(1..).unwrap_or(&[]), 2),
        Placement::Beside => (None, answers, 1),
    };
    if let Some(answer) = own {
        answer.write_onto(&mut data, live.kind);
    }
    let mut commands = Vec::new();
    let (made, ids) = result_nodes(canvas, live, cards, numbering);
    commands.extend(made);
    if placement == Placement::Beside {
        if let Some(card_id) = ids.first() {
            // The card standing in for the node's own answer is joined back to
            // it, so the canvas says what it came from. One edge says that: the
            // cards beside it are the same batch, not a chain.
            commands.extend(joined_back(canvas, &commands, live, card_id));
        }
    }
    data.result_node_ids = Some(ids);
    data.result_slots = Some(slots_after(live, answers, own.is_some(), placement));
    commands.push(write_back(canvas_id, node_id, data));
    Some(commands)
}

/// The slot list a promotion leaves on the node that asked.
///
/// An answer placed beside the node names the batch: the node keeps showing
/// what it showed, and the list is what the cards hold. An answer written onto
/// the node replaces what it held, so the results earlier runs left stay
/// listed — demoted, in the order they were made — and words no slot ever held
/// are kept as one more result: the node was their only copy, and the node is
/// what the answer is written over. Where the list would grow past what a node
/// may hold, the oldest kept results are what fall off, since a node over the
/// ceiling is one no run can be started for.
fn slots_after(
    node: &WorkflowNode,
    answers: &[Answer],
    own: bool,
    placement: Placement,
) -> Vec<ResultSlot> {
    let mut slots: Vec<ResultSlot> = match placement {
        Placement::Own => {
            let mut kept: Vec<ResultSlot> = node
                .data
                .result_slots
                .clone()
                .unwrap_or_default()
                .into_iter()
                .filter(|slot| slot.status == ResultSlotStatus::Succeeded)
                .map(|slot| ResultSlot {
                    is_primary: false,
                    ..slot
                })
                .collect();
            let preserved = preserved(node, &kept)
                .filter(|slot| !answers.iter().any(|answer| same_answer(slot, answer)));
            // A re-run that answers the same way is one result asked twice
            // rather than two results to choose between: the kept copy makes
            // way for the fresh one, which takes its place as the primary.
            kept.retain(|slot| !answers.iter().any(|answer| same_answer(slot, answer)));
            let room =
                MAX_RESULT_SLOTS.saturating_sub(answers.len() + preserved.is_some() as usize);
            if kept.len() > room {
                kept.drain(0..kept.len() - room);
            }
            kept.extend(preserved);
            kept
        }
        Placement::Beside => Vec::new(),
    };
    for (index, answer) in answers.iter().enumerate() {
        slots.push(answer.slot(index, own && index == 0));
    }
    // Numbered from scratch: an inspector lists results by these ids, and what
    // a result is called follows where it now stands rather than when it was
    // first made.
    for (index, slot) in slots.iter_mut().enumerate() {
        slot.id = slot_id(index);
    }
    slots
}

/// Whether a kept result and a fresh answer hold one thing.
///
/// Words are known by what they say: a run files the same sentence as a new
/// text asset every time it is asked, so comparing the assets would call one
/// answer two, and the list is of results to choose between rather than of
/// asks. A picture has no words to go by and is known by its asset instead.
fn same_answer(slot: &ResultSlot, answer: &Answer) -> bool {
    match (slot.text.as_deref(), answer.text()) {
        (Some(one), Some(other)) => one == other,
        _ => slot.asset_id.is_some() && slot.asset_id.as_ref() == answer.asset_id(),
    }
}

/// What a node holds that no kept result holds: the words themselves, kept as
/// one more result, because an answer written over them leaves the node as the
/// only copy of them there ever was. Only a text node is asked, since only a
/// text node's own content is what an answer replaces; a media node takes an
/// answer onto itself only while it holds nothing.
fn preserved(node: &WorkflowNode, kept: &[ResultSlot]) -> Option<ResultSlot> {
    if node.kind != NodeKind::Text {
        return None;
    }
    let text = node.data.content.as_deref()?;
    if text.trim().is_empty() {
        return None;
    }
    if kept.iter().any(|slot| slot.text.as_deref() == Some(text)) {
        return None;
    }
    Some(ResultSlot {
        // Named where the list it joins is numbered.
        id: String::new(),
        status: ResultSlotStatus::Succeeded,
        asset_id: None,
        text: Some(text.to_string()),
        error: None,
        is_primary: false,
    })
}

/// The node that asked, written last: a crash on the way leaves cards nothing
/// points at rather than slots pointing at cards that were never made.
fn write_back(canvas_id: &str, node_id: &str, data: NodeData) -> DocumentCommand {
    DocumentCommand::UpdateNode {
        canvas_id: canvas_id.to_string(),
        node_id: node_id.to_string(),
        patch: NodePatch {
            title: None,
            z_index: None,
            data: Some(data),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_test_config;
    use crate::domain::{
        derive_ports, generation_capability_for, now_iso, GenerationSpec, NodeData,
        ProjectMetadata, Rect, ResourceRegistry, MOKA_FILE_VERSION,
    };
    use crate::project::CreateProject;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    fn node(kind: NodeKind, name: &str, data: NodeData) -> WorkflowNode {
        let mut node = make_node(kind, name.to_string(), 0.0, 0.0);
        node.id = format!("node-{name}");
        node.data = data;
        node
    }

    /// A node that asks a provider for something, which is the only kind of node
    /// a run has an answer to write back onto.
    fn asking(kind: NodeKind, name: &str) -> WorkflowNode {
        node(
            kind,
            name,
            NodeData {
                generation: Some(GenerationSpec {
                    capability: generation_capability_for(kind).expect("a media kind asks"),
                    ..GenerationSpec::default()
                }),
                ..NodeData::default()
            },
        )
    }

    /// A card an earlier run made, holding the answer it was given.
    fn card(id: &str, asset_id: &str) -> WorkflowNode {
        let mut card = node(
            NodeKind::Image,
            "card",
            NodeData {
                asset_id: Some(asset_id.to_string()),
                ..NodeData::default()
            },
        );
        card.id = id.to_string();
        card
    }

    /// An answer in words, and the asset those words were filed as when they were.
    fn words(text: &str, asset_id: Option<&str>) -> Answer {
        Answer::Words {
            text: text.to_string(),
            asset_id: asset_id.map(str::to_string),
        }
    }

    /// Answers in media, in the order a provider gave them.
    fn media(ids: &[&str]) -> Vec<Answer> {
        ids.iter()
            .map(|id| Answer::Media((*id).to_string()))
            .collect()
    }

    /// A promotion whose first answer goes onto the node that asked, which is
    /// what a node holding nothing gets — and what a node holding words gets
    /// whatever it holds.
    fn onto(answers: Vec<Answer>) -> Promotion {
        Promotion::Answered {
            answers,
            placement: Placement::Own,
        }
    }

    /// A promotion whose answers all go onto cards beside the node that asked,
    /// which is what a node showing a picture gets when it asks again.
    fn beside(answers: Vec<Answer>) -> Promotion {
        Promotion::Answered {
            answers,
            placement: Placement::Beside,
        }
    }

    /// Where a promotion puts its first answer.
    fn placement_of(promotion: Option<Promotion>) -> Placement {
        let Promotion::Answered { placement, .. } =
            promotion.expect("a node an executor ran made something")
        else {
            panic!("and it made an answer");
        };
        placement
    }

    fn document(nodes: Vec<WorkflowNode>) -> MokaFile {
        let mut canvas = CanvasDocument::empty("canvas-1".to_string(), "Canvas".to_string());
        canvas.nodes = nodes;
        let now = now_iso();
        MokaFile {
            version: MOKA_FILE_VERSION.to_string(),
            metadata: ProjectMetadata {
                id: "project-1".to_string(),
                name: "Project".to_string(),
                description: None,
                cover_path: None,
                revision: 1,
                created_at: now.clone(),
                updated_at: now,
            },
            resources: ResourceRegistry::default(),
            folders: None,
            timelines: None,
            stories: None,
            canvas: vec![canvas],
        }
    }

    fn written(moka: &MokaFile, name: &str, promotion: &Promotion) -> Vec<DocumentCommand> {
        promotion_commands(moka, "canvas-1", &format!("node-{name}"), promotion)
            .expect("the node is on the canvas")
    }

    fn data_of(command: &DocumentCommand) -> &NodeData {
        match command {
            DocumentCommand::UpdateNode { patch, .. } => patch
                .data
                .as_ref()
                .expect("a promotion writes the node's data"),
            DocumentCommand::AddNode { node, .. } => &node.data,
            _ => panic!("a promotion only writes nodes"),
        }
    }

    fn id_of(command: &DocumentCommand) -> &str {
        match command {
            DocumentCommand::UpdateNode { node_id, .. } => node_id,
            DocumentCommand::AddNode { node, .. } => &node.id,
            _ => panic!("a promotion only writes nodes"),
        }
    }

    fn patch_of(command: &DocumentCommand) -> &NodePatch {
        match command {
            DocumentCommand::UpdateNode { patch, .. } => patch,
            _ => panic!("an added node carries no patch"),
        }
    }

    fn slots_of(data: &NodeData) -> &Vec<ResultSlot> {
        data.result_slots.as_ref().expect("a result is recorded")
    }

    #[test]
    fn a_node_nothing_ran_has_nothing_to_write_back() {
        let nodes = [
            node(
                NodeKind::Text,
                "brief",
                NodeData {
                    content: Some("a lantern".to_string()),
                    ..NodeData::default()
                },
            ),
            node(
                NodeKind::Image,
                "still",
                NodeData {
                    asset_id: Some("asset-1".to_string()),
                    ..NodeData::default()
                },
            ),
        ];
        let artifacts = StepArtifacts {
            text: Some("words".to_string()),
            assets: Some(vec!["asset-2".to_string()]),
            task: None,
        };
        for node in &nodes {
            assert!(
                promotion_for(node, &artifacts, true).is_none(),
                "{}",
                node.title
            );
        }
    }

    #[test]
    fn an_answer_with_no_media_in_it_leaves_a_media_node_holding_what_it_held() {
        let poster = asking(NodeKind::Image, "poster");
        let artifacts = StepArtifacts {
            text: Some("a caption".to_string()),
            assets: None,
            task: None,
        };
        assert!(promotion_for(&poster, &artifacts, true).is_none());
    }

    #[test]
    fn a_node_holding_something_keeps_a_picture_beside_it_and_takes_words_onto_it() {
        let artifacts = StepArtifacts {
            text: Some("An answer.".to_string()),
            assets: Some(vec!["asset-1".to_string()]),
            task: None,
        };
        // A node made and never written in holds an empty string rather than
        // nothing, and is still a node with nothing to lose.
        assert_eq!(
            placement_of(promotion_for(
                &asking(NodeKind::Text, "script"),
                &artifacts,
                true
            )),
            Placement::Own
        );
        assert_eq!(
            placement_of(promotion_for(
                &asking(NodeKind::Image, "poster"),
                &artifacts,
                true
            )),
            Placement::Own
        );

        // Words are what a text node is made of, so a second ask replaces the
        // first rather than putting a near-copy of the node beside it: what the
        // node said stays reachable as a result instead of as a duplicate node.
        let mut written_in = asking(NodeKind::Text, "script");
        written_in.data.content = Some("Written by hand.".to_string());
        assert_eq!(
            placement_of(promotion_for(&written_in, &artifacts, true)),
            Placement::Own
        );

        let mut showing = asking(NodeKind::Image, "poster");
        showing.data.asset_id = Some("asset-kept".to_string());
        assert_eq!(
            placement_of(promotion_for(&showing, &artifacts, true)),
            Placement::Beside
        );

        // What a run wrote is on the node when the next one starts, so asking
        // again is what puts an answer beside it rather than over it.
        let mut answered = asking(NodeKind::Text, "script");
        answered.data.content = Some("   ".to_string());
        assert_eq!(
            placement_of(promotion_for(&answered, &artifacts, true)),
            Placement::Own,
            "a node saying nothing but spaces still says nothing"
        );
    }

    #[test]
    fn an_upstream_node_the_run_was_not_asked_for_keeps_the_answer_it_has() {
        let artifacts = StepArtifacts {
            text: Some("A fresh answer.".to_string()),
            assets: Some(vec!["asset-1".to_string()]),
            task: None,
        };
        // Dragged in because something below reads it, and already holding an
        // answer: the run passes that answer down, and there is nothing to
        // write back — a second copy beside the node is the surprise this
        // rules out.
        let mut written_in = asking(NodeKind::Text, "script");
        written_in.data.content = Some("What is already there.".to_string());
        assert!(promotion_for(&written_in, &artifacts, false).is_none());

        // With nothing yet to hand down it is a step of the run like any other,
        // and its answer lands on it.
        assert_eq!(
            placement_of(promotion_for(
                &asking(NodeKind::Text, "script"),
                &artifacts,
                false
            )),
            Placement::Own
        );
    }

    #[test]
    fn words_go_into_a_text_node_and_onto_its_slot() {
        let moka = document(vec![asking(NodeKind::Text, "script")]);
        let commands = written(
            &moka,
            "script",
            &onto(vec![words("A lantern drifts.", Some("asset-text"))]),
        );
        assert_eq!(commands.len(), 1, "one node, one write");
        let data = data_of(&commands[0]);
        assert_eq!(data.content.as_deref(), Some("A lantern drifts."));
        let slots = slots_of(data);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].id, "result");
        assert_eq!(slots[0].status, ResultSlotStatus::Succeeded);
        assert_eq!(slots[0].text.as_deref(), Some("A lantern drifts."));
        assert_eq!(
            slots[0].asset_id.as_deref(),
            Some("asset-text"),
            "the text asset the words were filed as travels with them"
        );
        assert!(slots[0].is_primary);
    }

    #[test]
    fn words_reach_an_operation_node_through_its_slot_alone() {
        let join = node(
            NodeKind::Operation,
            "join",
            NodeData {
                operation_type: Some("deterministic.text".to_string()),
                executor_key: Some("deterministic".to_string()),
                ..NodeData::default()
            },
        );
        let moka = document(vec![join]);
        let commands = written(&moka, "join", &onto(vec![words("Joined.", None)]));
        let data = data_of(&commands[0]);
        // An operation node has no words of its own, and the document only ever
        // carries a content key on a text node.
        assert!(data.content.is_none());
        assert_eq!(slots_of(data)[0].text.as_deref(), Some("Joined."));
    }

    #[test]
    fn one_picture_backfills_the_node_that_asked_for_it() {
        let moka = document(vec![asking(NodeKind::Image, "poster")]);
        let commands = written(&moka, "poster", &onto(media(&["asset-1"])));
        assert_eq!(commands.len(), 1, "nothing beside the node itself");
        let data = data_of(&commands[0]);
        assert_eq!(data.asset_id.as_deref(), Some("asset-1"));
        assert!(data
            .result_node_ids
            .clone()
            .expect("the list is written")
            .is_empty());
        let slots = slots_of(data);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].asset_id.as_deref(), Some("asset-1"));
        assert!(slots[0].text.is_none());
        assert!(slots[0].is_primary);
    }

    #[test]
    fn three_pictures_fill_the_node_and_get_a_card_each() {
        let moka = document(vec![asking(NodeKind::Image, "poster")]);
        let assets: Vec<AssetId> = (1..=3).map(|index| format!("asset-{index}")).collect();
        let promotion = onto(assets.iter().cloned().map(Answer::Media).collect());
        let commands = written(&moka, "poster", &promotion);
        assert_eq!(
            commands.len(),
            3,
            "two cards and the node that points at them"
        );
        // The cards come first: written the other way round, a crash in between
        // leaves a slot pointing at a node that was never added.
        assert!(matches!(commands[0], DocumentCommand::AddNode { .. }));
        assert!(matches!(commands[1], DocumentCommand::AddNode { .. }));
        assert!(matches!(commands[2], DocumentCommand::UpdateNode { .. }));

        let parent = data_of(&commands[2]);
        assert_eq!(
            parent.asset_id.as_deref(),
            Some("asset-1"),
            "the first answer is the node's own"
        );
        let slots = slots_of(parent);
        assert_eq!(slots.len(), 3);
        for (index, slot) in slots.iter().enumerate() {
            assert_eq!(slot.status, ResultSlotStatus::Succeeded);
            assert_eq!(
                slot.asset_id.as_deref(),
                Some(assets[index].as_str()),
                "every answer is still named"
            );
            assert_eq!(slot.is_primary, index == 0);
        }
        let ids: Vec<&str> = slots.iter().map(|slot| slot.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["result", "result-2", "result-3"],
            "an inspector lists them by these, so they are not all the same"
        );

        let cards = parent
            .result_node_ids
            .clone()
            .expect("the cards are recorded");
        assert_eq!(cards.len(), 2);
        let mut left = 280.0;
        for (index, command) in commands.iter().take(2).enumerate() {
            let DocumentCommand::AddNode { node, .. } = command else {
                panic!("checked above");
            };
            assert_eq!(node.id, cards[index]);
            assert_eq!(
                node.kind,
                NodeKind::Image,
                "a card is the same kind of thing"
            );
            assert_eq!(node.title, format!("poster {}", index + 2));
            assert_eq!(node.ports, derive_ports(NodeKind::Image));
            assert!(
                node.data.generation.is_none(),
                "a card holds an answer, it does not ask for one"
            );
            assert_eq!(
                node.data.asset_id.as_deref(),
                Some(assets[index + 1].as_str())
            );
            let card_slots = slots_of(&node.data);
            assert_eq!(card_slots.len(), 1);
            assert_eq!(
                card_slots[0].asset_id.as_deref(),
                Some(assets[index + 1].as_str())
            );
            assert!(
                card_slots[0].is_primary,
                "a card's own answer is its primary"
            );
            // Beside the node that asked, then beside each other, on the same line.
            assert!(node.bounds.x > left, "{}", node.bounds.x);
            assert_eq!(node.bounds.y, 0.0);
            left = node.bounds.x + node.bounds.width;
        }
    }

    #[test]
    fn a_card_says_which_kind_of_audio_it_holds() {
        let mut voice = asking(NodeKind::Audio, "voice");
        voice.data.audio_category = Some("voice".to_string());
        let moka = document(vec![voice]);
        let commands = written(&moka, "voice", &onto(media(&["asset-1", "asset-2"])));
        let DocumentCommand::AddNode { node, .. } = &commands[0] else {
            panic!("the second answer gets a card");
        };
        assert_eq!(node.kind, NodeKind::Audio);
        assert_eq!(
            node.data.audio_category.as_deref(),
            Some("voice"),
            "a card is made for the node that asked, not for its kind in general"
        );
    }

    #[test]
    fn a_re_run_writes_into_the_cards_it_made_last_time() {
        let mut poster = asking(NodeKind::Image, "poster");
        poster.data.result_node_ids = Some(vec!["node-kept".to_string(), "node-gone".to_string()]);
        let mut kept = card("node-kept", "asset-old");
        kept.title = "The one I moved".to_string();
        kept.bounds = Rect {
            x: 900.0,
            y: 500.0,
            width: 280.0,
            height: 200.0,
        };
        let moka = document(vec![poster, kept]);
        let commands = written(
            &moka,
            "poster",
            &onto(media(&["asset-new", "asset-second", "asset-third"])),
        );
        assert_eq!(commands.len(), 3, "one card is written into, one is made");

        assert_eq!(id_of(&commands[0]), "node-kept");
        assert!(matches!(commands[0], DocumentCommand::UpdateNode { .. }));
        assert_eq!(
            data_of(&commands[0]).asset_id.as_deref(),
            Some("asset-second")
        );
        let patch = patch_of(&commands[0]);
        assert!(
            patch.title.is_none() && patch.z_index.is_none(),
            "a card the user renamed and moved keeps both"
        );

        let DocumentCommand::AddNode { node, .. } = &commands[1] else {
            panic!("the card that is gone is made again");
        };
        assert_eq!(node.data.asset_id.as_deref(), Some("asset-third"));

        let parent = data_of(&commands[2]);
        assert_eq!(slots_of(parent).len(), 3, "every answer is still named");
        let cards = parent
            .result_node_ids
            .clone()
            .expect("the cards are recorded");
        assert_eq!(cards, vec!["node-kept".to_string(), node.id.clone()]);
    }

    #[test]
    fn cards_a_shorter_re_run_did_not_reach_stay_listed() {
        let mut poster = asking(NodeKind::Image, "poster");
        poster.data.result_node_ids = Some(vec!["node-a".to_string(), "node-b".to_string()]);
        let moka = document(vec![
            poster,
            card("node-a", "asset-old-a"),
            card("node-b", "asset-old-b"),
        ]);
        let commands = written(&moka, "poster", &onto(media(&["asset-1"])));
        assert_eq!(
            commands.len(),
            1,
            "no card is written and none is taken away"
        );
        let data = data_of(&commands[0]);
        assert_eq!(slots_of(data).len(), 1, "the node holds the one answer");
        assert_eq!(
            data.result_node_ids
                .clone()
                .expect("the cards are recorded"),
            vec!["node-a".to_string(), "node-b".to_string()],
            "the next run that asks for more reuses them instead of adding a second set"
        );
    }

    #[test]
    fn words_written_over_what_a_node_said_keep_it_reachable_as_a_result() {
        let mut script = asking(NodeKind::Text, "script");
        script.data.content = Some("Written by hand.".to_string());
        let moka = document(vec![script]);
        let commands = written(
            &moka,
            "script",
            &onto(vec![words("A new answer.", Some("asset-text"))]),
        );
        assert_eq!(
            commands.len(),
            1,
            "the node itself: no card beside it and no edge to one"
        );
        let data = data_of(&commands[0]);
        assert_eq!(data.content.as_deref(), Some("A new answer."));
        let slots = slots_of(data);
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].id, "result");
        assert_eq!(
            slots[0].text.as_deref(),
            Some("Written by hand."),
            "what the node said before is a result now"
        );
        assert!(
            slots[0].asset_id.is_none(),
            "words typed by hand were never filed as anything"
        );
        assert!(!slots[0].is_primary);
        assert_eq!(slots[1].id, "result-2");
        assert_eq!(slots[1].text.as_deref(), Some("A new answer."));
        assert_eq!(slots[1].asset_id.as_deref(), Some("asset-text"));
        assert!(slots[1].is_primary, "the new answer is what the node shows");
    }

    #[test]
    fn a_re_run_over_an_answer_keeps_the_earlier_one_listed_once() {
        let mut script = asking(NodeKind::Text, "script");
        script.data.content = Some("The first answer.".to_string());
        script.data.result_slots = Some(vec![
            words("The first answer.", Some("asset-one")).slot(0, true)
        ]);
        let moka = document(vec![script]);
        let commands = written(
            &moka,
            "script",
            &onto(vec![words("The second answer.", Some("asset-two"))]),
        );
        assert_eq!(commands.len(), 1);
        let data = data_of(&commands[0]);
        assert_eq!(data.content.as_deref(), Some("The second answer."));
        let slots = slots_of(data);
        assert_eq!(
            slots.len(),
            2,
            "the first answer is still listed, and not listed twice"
        );
        assert_eq!(slots[0].text.as_deref(), Some("The first answer."));
        assert_eq!(slots[0].asset_id.as_deref(), Some("asset-one"));
        assert!(!slots[0].is_primary, "what the node showed is a choice now");
        assert_eq!(slots[1].text.as_deref(), Some("The second answer."));
        assert!(slots[1].is_primary);
    }

    #[test]
    fn an_identical_re_run_replaces_the_result_it_repeats() {
        let mut script = asking(NodeKind::Text, "script");
        script.data.content = Some("The same answer.".to_string());
        script.data.result_slots = Some(vec![
            words("The same answer.", Some("asset-one")).slot(0, true)
        ]);
        let moka = document(vec![script]);
        let commands = written(
            &moka,
            "script",
            &onto(vec![words("The same answer.", Some("asset-one"))]),
        );
        let data = data_of(&commands[0]);
        let slots = slots_of(data);
        assert_eq!(
            slots.len(),
            1,
            "the same answer asked for twice is one result, not two"
        );
        assert_eq!(slots[0].asset_id.as_deref(), Some("asset-one"));
        assert!(slots[0].is_primary);
    }

    #[test]
    fn a_slot_list_past_the_ceiling_loses_its_oldest_results_and_only_those() {
        let mut script = asking(NodeKind::Text, "script");
        script.data.content = Some("The newest of them.".to_string());
        script.data.result_slots = Some(
            (0..MAX_RESULT_SLOTS)
                .map(|index| words(&format!("Answer {index}."), None).slot(index, index == 0))
                .collect(),
        );
        let moka = document(vec![script]);
        let commands = written(
            &moka,
            "script",
            &onto(vec![words("One more.", Some("asset-new"))]),
        );
        let data = data_of(&commands[0]);
        let slots = slots_of(data);
        assert_eq!(
            slots.len(),
            MAX_RESULT_SLOTS,
            "a node over the ceiling is one no run can be started for"
        );
        assert_eq!(
            slots.last().expect("a slot").text.as_deref(),
            Some("One more."),
            "the answer being written is never what falls off"
        );
        assert!(slots.last().expect("a slot").is_primary);
        assert_eq!(
            slots[0].text.as_deref(),
            Some("Answer 2."),
            "the oldest kept results are what fall off"
        );
        assert_eq!(
            slots[MAX_RESULT_SLOTS - 2].text.as_deref(),
            Some("The newest of them."),
            "what the node held is kept even when older answers fall off: it is the only copy of itself"
        );
        let ids: Vec<&str> = slots.iter().map(|slot| slot.id.as_str()).collect();
        let wanted: Vec<String> = (0..MAX_RESULT_SLOTS).map(slot_id).collect();
        assert_eq!(
            ids,
            wanted.iter().map(String::as_str).collect::<Vec<&str>>(),
            "the list is numbered from scratch and stays numbered in order"
        );
    }

    #[test]
    fn answers_beside_a_node_join_only_the_first_card_to_it() {
        let mut poster = asking(NodeKind::Image, "poster");
        poster.data.asset_id = Some("asset-kept".to_string());
        let moka = document(vec![poster]);
        let commands = written(
            &moka,
            "poster",
            &beside(media(&["asset-new", "asset-second"])),
        );
        assert_eq!(
            commands.len(),
            4,
            "two cards, the edge to the first of them, and the node itself"
        );
        let DocumentCommand::AddNode { node: first, .. } = &commands[0] else {
            panic!("checked above");
        };
        let DocumentCommand::AddNode { node: second, .. } = &commands[1] else {
            panic!("checked above");
        };
        assert_eq!(first.title, "poster 1");
        assert_eq!(second.title, "poster 2");
        assert_eq!(first.data.asset_id.as_deref(), Some("asset-new"));
        assert_eq!(second.data.asset_id.as_deref(), Some("asset-second"));
        assert!(
            second.bounds.x > first.bounds.x + first.bounds.width,
            "the cards are beside each other as well as beside the node"
        );

        let DocumentCommand::AddEdge { edge, .. } = &commands[2] else {
            panic!("the first card is joined back");
        };
        assert_eq!(edge.source.node_id, "node-poster");
        assert_eq!(edge.target.node_id, first.id);
        assert_eq!(
            edge.target.port_id, "images",
            "a picture goes in where pictures are read"
        );

        let parent = data_of(&commands[3]);
        assert_eq!(
            parent.asset_id.as_deref(),
            Some("asset-kept"),
            "what the node showed is still what it shows"
        );
        assert_eq!(
            parent
                .result_node_ids
                .clone()
                .expect("the cards are recorded"),
            vec![first.id.clone(), second.id.clone()]
        );
        let slots = slots_of(parent);
        assert_eq!(slots.len(), 2, "every answer is still named");
        assert!(
            slots.iter().all(|slot| !slot.is_primary),
            "and none of them is the node's own"
        );
    }

    #[test]
    fn a_sound_card_is_joined_at_the_input_a_recording_lands_on() {
        let mut voice = asking(NodeKind::Audio, "voice");
        voice.data.asset_id = Some("asset-kept".to_string());
        let moka = document(vec![voice]);
        let commands = written(&moka, "voice", &beside(media(&["asset-new"])));
        assert_eq!(
            commands.len(),
            3,
            "a card, the edge into it, and the node: the sound card takes audio in, so the card its answer stands in is joined to it the way every other kind's is"
        );
        let DocumentCommand::AddNode { node: card, .. } = &commands[0] else {
            panic!("checked above");
        };
        let DocumentCommand::AddEdge { edge, .. } = &commands[1] else {
            panic!("the card is joined back");
        };
        assert_eq!(edge.source.node_id, "node-voice");
        assert_eq!(edge.source.port_id, "out");
        assert_eq!(edge.target.node_id, card.id);
        assert_eq!(
            edge.target.port_id, "audio",
            "a recording of the node lands where the voice the card copies is taken from"
        );
        assert_eq!(id_of(&commands[2]), "node-voice");
    }

    #[test]
    fn a_card_an_earlier_run_made_is_not_joined_a_second_time() {
        let mut poster = asking(NodeKind::Image, "poster");
        poster.data.asset_id = Some("asset-kept".to_string());
        poster.data.result_node_ids = Some(vec!["node-card".to_string()]);
        let moka = document(vec![poster, card("node-card", "asset-old")]);
        let commands = written(&moka, "poster", &beside(media(&["asset-new"])));
        assert_eq!(
            commands.len(),
            2,
            "the card and the node, and no edge again"
        );
        assert_eq!(id_of(&commands[0]), "node-card");
        assert!(
            matches!(commands[0], DocumentCommand::UpdateNode { .. }),
            "a card that is there is written into, which is how an edge it already has, or one taken away on purpose, is left as it is"
        );
        assert_eq!(id_of(&commands[1]), "node-poster");
    }

    #[test]
    fn a_failed_attempt_says_why_and_leaves_the_node_holding_what_it_held() {
        let mut script = asking(NodeKind::Text, "script");
        script.data.content = Some("An earlier answer.".to_string());
        script.data.result_slots = Some(vec![words("An earlier answer.", None).slot(0, true)]);
        let moka = document(vec![script]);
        let commands = written(
            &moka,
            "script",
            &Promotion::Failed("The provider refused.".to_string()),
        );
        assert_eq!(commands.len(), 1);
        let data = data_of(&commands[0]);
        assert_eq!(
            data.content.as_deref(),
            Some("An earlier answer."),
            "the last answer that worked stays on the card"
        );
        assert!(data.asset_id.is_none(), "a failure files nothing");
        let slots = slots_of(data);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].status, ResultSlotStatus::Failed);
        assert_eq!(slots[0].error.as_deref(), Some("The provider refused."));
        assert!(slots[0].text.is_none());
        assert!(slots[0].is_primary);
    }

    #[test]
    fn a_node_that_is_no_longer_on_the_canvas_has_nothing_to_write() {
        let moka = document(vec![asking(NodeKind::Text, "script")]);
        let promotion = onto(vec![words("words", None)]);
        assert!(promotion_commands(&moka, "canvas-1", "node-gone", &promotion).is_none());
        assert!(promotion_commands(&moka, "canvas-gone", "node-script", &promotion).is_none());
    }

    #[test]
    fn a_card_title_never_outgrows_the_limit_a_node_is_held_to() {
        let title = card_title(&"lantern".repeat(80), 2);
        assert_eq!(title.chars().count(), MAX_TITLE_LENGTH);
        assert!(title.ends_with(" 2"), "it still says which card it is");
        assert_eq!(card_title("Poster", 3), "Poster 3");
    }

    /// Opens a project on a temporary directory and a run manager with no
    /// executors: what is under test here is the write, not the running.
    async fn manager_over(tmp: &TempDir) -> (Arc<RunManager>, Arc<FsProjectStore>) {
        let config = Arc::new(parse_test_config(tmp.path()));
        let registry = crate::project::store::ProjectRegistry::new(config);
        let (store, _) = registry
            .create_project(
                &tmp.path().join("demo"),
                CreateProject {
                    name: "Demo".to_string(),
                    first_canvas_name: None,
                },
            )
            .await
            .expect("the project opens");
        let manager = RunManager::new(Vec::new(), Vec::new(), 1);
        (manager, store)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_write_rebuilds_itself_when_the_document_moves_under_it() {
        let tmp = TempDir::new().expect("a temporary directory");
        let (manager, store) = manager_over(&tmp).await;
        let canvas_id = {
            let opened = store.current().await.expect("read").expect("open");
            let canvas_id = opened.moka.canvas[0].id.clone();
            let mut script = make_node(NodeKind::Text, "Script".to_string(), 0.0, 0.0);
            script.id = "node-script".to_string();
            store
                .apply_commands(
                    opened.moka.metadata.revision,
                    vec![DocumentCommand::AddNode {
                        canvas_id: canvas_id.clone(),
                        node: script,
                    }],
                )
                .await
                .expect("the node is added");
            canvas_id
        };

        let handle = tokio::runtime::Handle::current();
        let competing = Arc::clone(&store);
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&attempts);
        let promotion = onto(vec![words("An answer.", None)]);
        manager
            .write_live(&store, "test", |moka| {
                // The first read is the one an edit lands behind: the rename goes
                // in after the document was read and before what was built from
                // it is applied, which is the race the retry is there for.
                if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                    let rename = DocumentCommand::UpdateNode {
                        canvas_id: moka.canvas[0].id.clone(),
                        node_id: "node-script".to_string(),
                        patch: NodePatch {
                            title: Some("Renamed while it ran".to_string()),
                            z_index: None,
                            data: None,
                        },
                    };
                    let store = Arc::clone(&competing);
                    let revision = moka.metadata.revision;
                    tokio::task::block_in_place(|| {
                        handle
                            .block_on(store.apply_commands(revision, vec![rename]))
                            .expect("the competing edit lands");
                    });
                }
                promotion_commands(moka, &canvas_id, "node-script", &promotion)
            })
            .await;

        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "the write was rebuilt once"
        );
        let opened = store.current().await.expect("read").expect("open");
        let script = opened
            .moka
            .canvas(&canvas_id)
            .expect("the canvas is there")
            .node("node-script")
            .expect("the node is there");
        assert_eq!(
            script.title, "Renamed while it ran",
            "the rebuild is built from what the other writer left"
        );
        assert_eq!(
            slots_of(&script.data)[0].text.as_deref(),
            Some("An answer."),
            "and the write still landed"
        );
    }
}
