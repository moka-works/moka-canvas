//! The story job manager: the record a batch leaves, and the driver that fills
//! it in.
//!
//! One job is one request to a provider answered many times over — a dozen
//! shots, a chapter's worth of keyframes — and the record it keeps is what makes
//! that batch a thing a reader can watch, stop, and ask for again: which pieces
//! were asked for, which came back, which did not, and what the answers became.
//! Only the driver writes a record, so pieces finishing at once do not race for
//! it: they report to the driver, and it decides what the record says next.
//!
//! A cancel is a flag the driver and its pieces observe, exactly as a run's is.
//! It ends the job rather than the pieces of it: what never ran stays queued, so
//! asking for the rest again is asking for the rest and not for the whole.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Semaphore};

use super::ingest::ingest_story_result;
use crate::config::StoryConfig;
use crate::domain::{new_id, now_iso, Capability};
use crate::generate::{Cancel, DeltaSink, GenerateInput, GenerateRequest};
use crate::project::store::FsProjectStore;
use crate::project::{ProjectError, ProjectStore};
use crate::workflow::provider::ProviderExecutor;
use crate::workflow::{ExecutionError, ProgressReporter};

/// How often a piece's progress may reach the record. A shot is looked at every
/// few seconds, and a record rewritten for each look is a file written for
/// nobody.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);

/// One batch of generations, and how far each piece of it got.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryJobRecord {
    pub id: String,
    pub project_id: String,
    pub story_id: String,
    pub kind: StoryJobKind,
    pub status: StoryJobStatus,
    /// The model configuration the batch was resolved to, so a reader can see
    /// what answered without opening the settings.
    pub model: String,
    pub items: Vec<StoryJobItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub cancel_requested: bool,
    /// When the room read this batch's answer into its story, if it has.
    ///
    /// The one field of a record the room writes rather than the driver, and
    /// written only once the batch has settled — the moment both sides know
    /// there is nothing left to write. Every room opened afterwards reads it
    /// and leaves the answer alone: written in a second time it would stand
    /// over whatever the reader has said to the story since, and an answer
    /// from a batch closed days ago is not a new telling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// What a batch is for: one step of a story's telling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoryJobKind {
    /// Breaking a premise into the episodes it is told in. Words, one call.
    Outline,
    /// Finding the characters, places and things the story needs. Words.
    Elements,
    /// One episode's board: its acts and its shots. Words, one call an episode.
    Storyboard,
    /// An element drawn: one view of a character, a place or a thing.
    ElementArt,
    /// One shot drawn.
    KeyframeArt,
    /// One act filmed.
    ActVideo,
    /// One shot filmed.
    KeyframeVideo,
    /// One act's lines read aloud, all in one voice.
    Voice,
    /// One act's music and sound, asked for as one piece.
    Music,
}

impl StoryJobKind {
    /// What this batch asks of a provider.
    pub fn capability(self) -> Capability {
        match self {
            StoryJobKind::Outline | StoryJobKind::Elements | StoryJobKind::Storyboard => {
                Capability::Text
            }
            StoryJobKind::ElementArt | StoryJobKind::KeyframeArt => Capability::Image,
            StoryJobKind::ActVideo | StoryJobKind::KeyframeVideo => Capability::Video,
            StoryJobKind::Voice => Capability::Speech,
            StoryJobKind::Music => Capability::Music,
        }
    }

    /// Whether the answer is words, which are kept rather than filed.
    pub fn is_words(self) -> bool {
        matches!(
            self,
            StoryJobKind::Outline | StoryJobKind::Elements | StoryJobKind::Storyboard
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoryJobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl StoryJobStatus {
    /// Whether nothing more will happen to a job that says this.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            StoryJobStatus::Succeeded | StoryJobStatus::Failed | StoryJobStatus::Cancelled
        )
    }
}

/// One generation of a batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryJobItem {
    /// Chosen by the client, which is what it applies the answer by: the id
    /// names a place in the story, and the server never reads the story.
    pub id: String,
    pub target: StoryTarget,
    pub capability: Capability,
    pub prompt: String,
    /// The standing instruction the answer is written under, when the ask
    /// carries one — the room's own words about the shape every written answer
    /// of this kind has. Sent as the request's system half rather than folded
    /// into the prompt, which is where a provider expects to find it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<GenerateInput>,
    #[serde(default)]
    pub params: serde_json::Value,
    pub status: StoryJobStatus,
    /// What a text answer said, whole. Reading it into a document is the
    /// client's business.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// What a media answer became in the project's files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asset_ids: Vec<String>,
    /// The handle of a shot placed at the provider, which is what a process
    /// that stops in the middle of one comes back by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// What kind of trouble it was, and the values behind it — which model,
    /// which capability. Written down beside the message so a client can say
    /// the same trouble in the reader's own language, and can tell a setting
    /// that has to be repaired from a wait that has to be sat out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_details: Option<serde_json::Value>,
    /// Whether the same request is worth asking again as it stands: a queue or
    /// a network is, a refusal is not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

impl StoryJobItem {
    /// A piece of work that has not been asked for yet.
    ///
    /// The capability is taken rather than read off the target: it is what the
    /// client says the piece is, and the check that it agrees with the target
    /// belongs to validation, where a disagreement is a request refused rather
    /// than one silently corrected.
    #[allow(clippy::too_many_arguments)]
    pub fn queued(
        id: String,
        target: StoryTarget,
        capability: Capability,
        prompt: String,
        system: Option<String>,
        inputs: Vec<GenerateInput>,
        params: serde_json::Value,
    ) -> Self {
        Self {
            id,
            target,
            capability,
            prompt,
            system,
            inputs,
            params,
            status: StoryJobStatus::Queued,
            text: None,
            asset_ids: Vec::new(),
            task_id: None,
            progress: None,
            error: None,
            error_code: None,
            error_details: None,
            retryable: None,
            started_at: None,
            finished_at: None,
        }
    }

    /// Whether this piece already has what it was asked for.
    ///
    /// Read when a batch is driven again: a job picked up after a restart, or
    /// one sent again with the pieces that had already answered still in it,
    /// does not pay twice for the same answer.
    fn is_answered(&self) -> bool {
        if self.status != StoryJobStatus::Succeeded {
            return false;
        }
        if self.capability == Capability::Text {
            self.text.is_some()
        } else {
            !self.asset_ids.is_empty()
        }
    }
}

/// Where in a story one generation belongs.
///
/// The server keeps it to say what an answer was for; it never checks it
/// against a document. The shape is the client's, and the client is what reads
/// it back into a slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StoryTarget {
    Outline,
    Elements,
    #[serde(rename_all = "camelCase")]
    Storyboard {
        chapter_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ElementArt {
        element_id: String,
        view: StoryArtView,
    },
    #[serde(rename_all = "camelCase")]
    KeyframeArt {
        chapter_id: String,
        act_id: String,
        keyframe_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ActVideo {
        chapter_id: String,
        act_id: String,
    },
    #[serde(rename_all = "camelCase")]
    KeyframeVideo {
        chapter_id: String,
        act_id: String,
        keyframe_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Voice {
        chapter_id: String,
        act_id: String,
    },
    #[serde(rename_all = "camelCase")]
    LineVoice {
        chapter_id: String,
        act_id: String,
        keyframe_id: String,
        line_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Music {
        chapter_id: String,
        act_id: String,
    },
}

impl StoryTarget {
    /// Which batch a target belongs to. One job carries pieces of one kind, so
    /// a piece filed under another is one nothing could apply.
    pub fn kind(&self) -> StoryJobKind {
        match self {
            StoryTarget::Outline => StoryJobKind::Outline,
            StoryTarget::Elements => StoryJobKind::Elements,
            StoryTarget::Storyboard { .. } => StoryJobKind::Storyboard,
            StoryTarget::ElementArt { .. } => StoryJobKind::ElementArt,
            StoryTarget::KeyframeArt { .. } => StoryJobKind::KeyframeArt,
            StoryTarget::ActVideo { .. } => StoryJobKind::ActVideo,
            StoryTarget::KeyframeVideo { .. } => StoryJobKind::KeyframeVideo,
            StoryTarget::Voice { .. } => StoryJobKind::Voice,
            StoryTarget::LineVoice { .. } => StoryJobKind::Voice,
            StoryTarget::Music { .. } => StoryJobKind::Music,
        }
    }
}

/// Which of an element's two drawings a piece is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoryArtView {
    Main,
    Turnaround,
}

/// What a piece of a batch needs to know about the batch it belongs to.
struct JobContext {
    job_id: String,
    story_id: String,
    kind: StoryJobKind,
    model: String,
}

/// What one generation of a batch turned into.
///
/// `started` is whether the piece ever reached a provider. A piece that was
/// still waiting its turn when a cancel arrived never did, and there is nothing
/// to say about it: it stays queued, because asking for it again is asking for
/// work that never happened.
struct ItemOutcome {
    started: bool,
    text: Option<String>,
    asset_ids: Vec<String>,
    error: Option<String>,
    code: Option<String>,
    details: Option<serde_json::Value>,
    retryable: Option<bool>,
    cancelled: bool,
}

impl ItemOutcome {
    fn answered(text: Option<String>, asset_ids: Vec<String>) -> Self {
        Self {
            started: true,
            text,
            asset_ids,
            error: None,
            code: None,
            details: None,
            retryable: None,
            cancelled: false,
        }
    }

    fn failed(error: String, retryable: bool) -> Self {
        Self {
            started: true,
            text: None,
            asset_ids: Vec::new(),
            error: Some(error),
            code: None,
            details: None,
            retryable: Some(retryable),
            cancelled: false,
        }
    }

    /// A piece that stopped, as its failure was classified: the message the
    /// reader is shown, and the code and values behind it.
    fn stopped(error: &ExecutionError) -> Self {
        Self {
            code: Some(error.code.to_string()),
            details: error.details.clone(),
            cancelled: error.cancelled,
            ..Self::failed(error.message.clone(), error.retryable)
        }
    }

    /// A piece that never reached a provider, because the batch was stopped
    /// while it was still waiting for its turn.
    fn never_ran() -> Self {
        Self {
            started: false,
            cancelled: true,
            ..Self::failed(String::new(), false)
        }
    }
}

/// What a piece says to the driver while it is being worked on.
enum ItemMessage {
    Started {
        index: usize,
    },
    /// A shot the provider is now filming. Written down the moment it is
    /// placed, because that handle is the whole of what a restart comes back
    /// by.
    Placed {
        index: usize,
        task_id: String,
    },
    Progress {
        index: usize,
        fraction: f64,
    },
    Done {
        index: usize,
        outcome: Box<ItemOutcome>,
    },
}

/// The story jobs this process is driving, and how to stop them.
pub struct StoryJobManager {
    store: Arc<FsProjectStore>,
    provider: Arc<ProviderExecutor>,
    /// The jobs being driven, by id, each with the flag it answers to.
    active: Mutex<HashMap<String, Cancel>>,
    /// How many generations may be in flight at once, across every job: a batch
    /// of twenty pieces does not open twenty connections to a provider, and two
    /// batches do not open two apiece.
    permits: Arc<Semaphore>,
    limits: StoryConfig,
}

impl StoryJobManager {
    pub fn new(
        store: Arc<FsProjectStore>,
        provider: Arc<ProviderExecutor>,
        limits: StoryConfig,
    ) -> Arc<Self> {
        let permits = Arc::new(Semaphore::new(limits.max_parallel_items.max(1)));
        Arc::new(Self {
            store,
            provider,
            active: Mutex::new(HashMap::new()),
            permits,
            limits,
        })
    }

    /// The limits a batch is started under, which the routes check against.
    pub fn limits(&self) -> &StoryConfig {
        &self.limits
    }

    /// Writes the queued record and hands it to a driver.
    ///
    /// The caller has already validated the request against the document; what
    /// is left here is the record and a driver that outlives the call.
    pub async fn start(
        self: &Arc<Self>,
        story_id: String,
        kind: StoryJobKind,
        model: String,
        items: Vec<StoryJobItem>,
    ) -> Result<StoryJobRecord, ProjectError> {
        let project_id = self
            .store
            .current()
            .await?
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
            .moka
            .metadata
            .id
            .clone();
        let now = now_iso();
        let record = StoryJobRecord {
            id: new_id(),
            project_id,
            story_id,
            kind,
            status: StoryJobStatus::Queued,
            model,
            items,
            error: None,
            cancel_requested: false,
            read_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let record = self.store.create_story_job(record).await?;
        let driver = Arc::clone(self);
        let job_id = record.id.clone();
        tokio::spawn(async move {
            driver.drive(job_id).await;
        });
        Ok(record)
    }

    /// Picks up the jobs a previous process was in the middle of.
    ///
    /// Called when a project opens, which is the first moment there is anywhere
    /// to put an answer. The sweep has already failed everything that cannot be
    /// picked up again, so what is left is waiting on a shot a provider is
    /// still filming.
    pub async fn resume_interrupted(self: &Arc<Self>) {
        let interrupted = match self.store.interrupted_story_jobs().await {
            Ok(interrupted) => interrupted,
            Err(error) => {
                tracing::warn!("the story jobs left in progress could not be listed: {error}");
                return;
            }
        };
        for job_id in interrupted {
            let driver = Arc::clone(self);
            tokio::spawn(async move {
                driver.drive(job_id).await;
            });
        }
    }

    /// Asks a batch to stop, and answers with what the record says now.
    ///
    /// A job somebody is driving is asked to stop rather than stopped: the
    /// driver is the only writer of the record, so the flag goes up and the
    /// record is read as it stands. One nobody is driving has nothing to
    /// interrupt and is ended here.
    pub async fn cancel(&self, job_id: &str) -> Result<StoryJobRecord, ProjectError> {
        let mut record = self.store.get_story_job(job_id).await?;
        if record.status.is_terminal() {
            return Err(ProjectError::domain(
                super::STORY_JOB_NOT_CANCELLABLE,
                "The job has already finished",
            ));
        }
        if let Some(cancel) = self.held(job_id) {
            cancel.cancel();
            // Answered as it stands, with the request itself marked: the driver
            // owns the record and has not written an ending yet, and a client
            // reading this has to see that its ask was heard.
            record.cancel_requested = true;
            return Ok(record);
        }
        record.status = StoryJobStatus::Cancelled;
        record.cancel_requested = true;
        record.updated_at = now_iso();
        self.store.update_story_job(record).await
    }

    /// Whether this process is driving the job right now.
    pub fn is_active(&self, job_id: &str) -> bool {
        self.held(job_id).is_some()
    }

    fn held(&self, job_id: &str) -> Option<Cancel> {
        self.active
            .lock()
            .expect("the story job registry is not held across a call")
            .get(job_id)
            .cloned()
    }

    fn release(&self, job_id: &str) {
        self.active
            .lock()
            .expect("the story job registry is not held across a call")
            .remove(job_id);
    }

    /// Drives one job from where its record says it stands.
    ///
    /// A fresh start and a project opening again walk the same path: pieces
    /// that already answered are left alone, pieces a previous process placed
    /// as jobs are waited out by the handle on the record, and the rest are
    /// asked for now.
    async fn drive(self: Arc<Self>, job_id: String) {
        let Some(record) = self.claim(&job_id).await else {
            return;
        };
        // The flag is armed before the first piece starts and not before: a
        // cancel that arrives while the record is being written has the seat to
        // set it on, which is what the claim left there.
        let cancel = self.held(&job_id).unwrap_or_default();

        let mut record = record;
        let context = Arc::new(JobContext {
            job_id: job_id.clone(),
            story_id: record.story_id.clone(),
            kind: record.kind,
            model: record.model.clone(),
        });
        let pending: Vec<usize> = record
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| !item.is_answered())
            .map(|(index, _)| index)
            .collect();
        let (sender, mut messages) = mpsc::channel::<ItemMessage>(pending.len().max(1) * 2);

        for index in &pending {
            if cancel.is_cancelled() {
                break;
            }
            let manager = Arc::clone(&self);
            let sender = sender.clone();
            let cancel = cancel.clone();
            let context = Arc::clone(&context);
            let position = *index;
            let item = record.items[position].clone();
            let placed = item.task_id.clone();
            tokio::spawn(async move {
                work(manager, context, position, item, placed, cancel, sender).await;
            });
        }
        // The driver's own sender is dropped, so the last piece finishing is
        // what ends the wait rather than a count that could be wrong.
        drop(sender);

        let mut written = Instant::now();
        while let Some(message) = messages.recv().await {
            match message {
                ItemMessage::Started { index } => {
                    let item = &mut record.items[index];
                    item.status = StoryJobStatus::Running;
                    item.started_at = Some(now_iso());
                    written = self.write(&record).await;
                }
                ItemMessage::Placed { index, task_id } => {
                    record.items[index].task_id = Some(task_id);
                    written = self.write(&record).await;
                }
                ItemMessage::Progress { index, fraction } => {
                    record.items[index].progress = Some(fraction);
                    // Written on a beat rather than on every look: a shot is
                    // looked at every few seconds, and the record is a file.
                    if written.elapsed() >= PROGRESS_INTERVAL {
                        written = self.write(&record).await;
                    }
                }
                ItemMessage::Done { index, outcome } => {
                    let outcome = *outcome;
                    let item = &mut record.items[index];
                    item.finished_at = Some(now_iso());
                    if outcome.cancelled {
                        // A cancel ends the batch, not the piece: this one
                        // never finished, and asking for it again asks for the
                        // work that was interrupted and not for the whole.
                        item.status = StoryJobStatus::Cancelled;
                        cancel.cancel();
                    } else if let Some(error) = outcome.error {
                        item.status = StoryJobStatus::Failed;
                        item.error = Some(error);
                        item.error_code = outcome.code;
                        item.error_details = outcome.details;
                        item.retryable = outcome.retryable;
                    } else {
                        item.status = StoryJobStatus::Succeeded;
                        item.progress = Some(1.0);
                        item.text = outcome.text;
                        item.asset_ids = outcome.asset_ids;
                    }
                    written = self.write(&record).await;
                }
            }
        }

        self.settle(&mut record, &cancel).await;
        self.release(&job_id);
    }

    /// Takes a job for driving, or says somebody already has it.
    ///
    /// The seat is taken before the record is read, so two drivers racing for
    /// one job cannot both be let through: the map is the lock, and the record
    /// is what a client reads.
    async fn claim(&self, job_id: &str) -> Option<StoryJobRecord> {
        {
            let mut active = self
                .active
                .lock()
                .expect("the story job registry is not held across a call");
            if active.contains_key(job_id) {
                return None;
            }
            active.insert(job_id.to_string(), Cancel::default());
        }

        // Only a batch that has not settled is worth driving: one that was
        // cancelled before a driver reached it is already over.
        match self.store.get_story_job(job_id).await {
            Ok(mut record) if !record.status.is_terminal() => {
                record.status = StoryJobStatus::Running;
                record.updated_at = now_iso();
                match self.store.update_story_job(record).await {
                    Ok(record) => Some(record),
                    Err(error) => {
                        tracing::warn!("story job {job_id}: could not be marked running: {error}");
                        self.release(job_id);
                        None
                    }
                }
            }
            Ok(_) => {
                self.release(job_id);
                None
            }
            Err(error) => {
                tracing::warn!("story job {job_id}: could not be read back: {error}");
                self.release(job_id);
                None
            }
        }
    }

    /// Writes the record, and says when it was written.
    async fn write(&self, record: &StoryJobRecord) -> Instant {
        if let Err(error) = self.store.update_story_job(record.clone()).await {
            tracing::warn!("story job {}: could not be written: {error}", record.id);
        }
        Instant::now()
    }

    /// What the batch says when no more pieces are coming.
    ///
    /// A cancel outranks the tally: a batch half asked for was not asked for,
    /// and calling it failed would send a reader to fix a provider that did
    /// nothing wrong. Otherwise every piece that answered makes it succeeded,
    /// and anything less is failed — with what did answer kept, so the room can
    /// offer to ask only for the rest.
    async fn settle(&self, record: &mut StoryJobRecord, cancel: &Cancel) {
        let stopped = cancel.is_cancelled();
        let failed = record
            .items
            .iter()
            .filter(|item| item.status == StoryJobStatus::Failed)
            .count();
        let total = record.items.len();
        for item in &mut record.items {
            // A piece whose task never reported — a driver that lost its
            // process, a task that panicked — is not left saying it is running,
            // which nothing would ever come back to change.
            if item.status != StoryJobStatus::Running {
                continue;
            }
            item.status = if stopped {
                StoryJobStatus::Cancelled
            } else {
                StoryJobStatus::Failed
            };
            if !stopped {
                item.error = Some("The piece stopped without an answer".to_string());
                item.retryable = Some(true);
            }
            item.finished_at = Some(now_iso());
        }
        record.status = if stopped {
            record.cancel_requested = true;
            StoryJobStatus::Cancelled
        } else if failed == 0 {
            StoryJobStatus::Succeeded
        } else {
            record.error = Some(format!("{failed} of {total} items failed"));
            StoryJobStatus::Failed
        };
        record.updated_at = now_iso();
        self.write(record).await;
    }
}

/// One piece of a batch, from the permit to the answer.
///
/// A free function rather than a method because it is what a task is made of:
/// everything it may touch arrives as an argument, and nothing of the manager
/// is borrowed across an await.
async fn work(
    manager: Arc<StoryJobManager>,
    context: Arc<JobContext>,
    index: usize,
    item: StoryJobItem,
    placed: Option<String>,
    cancel: Cancel,
    sender: mpsc::Sender<ItemMessage>,
) {
    let outcome = match manager
        .answer(&context, &item, placed, &cancel, &sender, index)
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => ItemOutcome::stopped(&error),
    };
    // A piece that never started says nothing: it is still queued, and an
    // ending written for it would be an ending for work that did not happen.
    if !outcome.started {
        return;
    }
    let _ = sender
        .send(ItemMessage::Done {
            index,
            outcome: Box::new(outcome),
        })
        .await;
}

impl StoryJobManager {
    /// Asks for one piece and files what comes back.
    ///
    /// The permit is taken here rather than by the driver so that a batch of
    /// twenty pieces waits its turn at the provider instead of opening twenty
    /// connections: what is bounded is how many generations are in flight, not
    /// how many pieces a batch has.
    async fn answer(
        &self,
        context: &JobContext,
        item: &StoryJobItem,
        placed: Option<String>,
        cancel: &Cancel,
        sender: &mpsc::Sender<ItemMessage>,
        index: usize,
    ) -> Result<ItemOutcome, ExecutionError> {
        if cancel.is_cancelled() {
            return Ok(ItemOutcome::never_ran());
        }
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| ExecutionError::failed("The generation ceiling is closed"))?;
        // Asked again once the permit is in hand: waiting for one may have been
        // the whole of what a cancel had to interrupt.
        if cancel.is_cancelled() {
            return Ok(ItemOutcome::never_ran());
        }
        // Said here rather than when the piece was handed to a task, because
        // this is the moment it is really under way: a piece waiting for its
        // turn at the provider is work nobody has asked for yet.
        if sender.send(ItemMessage::Started { index }).await.is_err() {
            return Ok(ItemOutcome::never_ran());
        }

        let request = GenerateRequest {
            capability: item.capability,
            model: context.model.clone(),
            prompt: item.prompt.clone(),
            system: item.system.clone(),
            params: item.params.as_object().cloned().unwrap_or_default(),
            inputs: item.inputs.clone(),
        };
        let progress = {
            let sender = sender.clone();
            ProgressReporter::new(Arc::new(move |fraction| {
                // A driver that has stopped listening is a cancel; progress
                // nobody reads is not worth an error of its own.
                let _ = sender.try_send(ItemMessage::Progress { index, fraction });
            }))
        };

        if item.capability == Capability::Video {
            // A shot is placed once and waited out. A handle already on the
            // record is one this batch placed before something stopped it, so
            // it is collected rather than paid for a second time.
            let task = match placed {
                Some(task_id) => task_id,
                None => {
                    let task = self.provider.shoot(request, cancel).await?;
                    if sender
                        .send(ItemMessage::Placed {
                            index,
                            task_id: task.id.clone(),
                        })
                        .await
                        .is_err()
                    {
                        return Err(ExecutionError::failed(
                            "The batch stopped while the shot was being placed",
                        ));
                    }
                    task.id
                }
            };
            let result = self.provider.collect(&task, cancel, &progress).await?;
            return self.file(context, item, result).await;
        }

        // A written answer is asked for as a stream even though nothing here
        // reads the pieces as they arrive: words are the long answer of the
        // two, and one a provider writes out as it goes is not the answer a
        // gateway gives up on for being held whole.
        let deltas = if item.capability == Capability::Text {
            DeltaSink::unwatched()
        } else {
            DeltaSink::default()
        };
        let result = self.provider.answer_once(request, &deltas, cancel).await?;
        if context.kind.is_words() {
            // Words are kept as they came: what they mean is read by the room,
            // which is where the document is.
            return Ok(ItemOutcome::answered(result.text, Vec::new()));
        }
        self.file(context, item, result).await
    }

    /// Files a media answer in the project and reports what it became.
    ///
    /// A piece with no file to point at — an answer that was refused, or one
    /// that carried nothing — is a failure rather than a success with nothing
    /// in it: the room would have no picture to confirm.
    async fn file(
        &self,
        context: &JobContext,
        item: &StoryJobItem,
        result: crate::generate::GenerateResult,
    ) -> Result<ItemOutcome, ExecutionError> {
        if result.is_empty() {
            return Err(ExecutionError {
                code: "PROVIDER_NO_OUTPUT",
                message: "The provider answered with nothing to keep".to_string(),
                details: None,
                retryable: true,
                cancelled: false,
            });
        }
        let entries = ingest_story_result(
            &*self.store,
            &context.job_id,
            &context.story_id,
            item,
            &result,
        )
        .await
        .map_err(|error| ExecutionError {
            code: error.code(),
            message: error.to_string(),
            details: None,
            retryable: false,
            cancelled: false,
        })?;
        let ids = entries.into_iter().map(|entry| entry.id).collect();
        Ok(ItemOutcome::answered(result.text, ids))
    }
}
