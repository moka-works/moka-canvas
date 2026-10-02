//! The exports this process is running, and the driver that runs one.
//!
//! One at a time: a second render would compete for the same disk and the
//! same machine, and there is one person waiting in front of the dialog. The
//! entry a client polls is kept for a while after it ends, so a dialog that
//! was reopened still reads the answer it was waiting for, and is then
//! forgotten — an export has no life outside this process.

use super::plan::RenderPlan;
use super::runner::{self, RunError, RunSpec};
use super::ClipError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// How long a finished export is still worth reading.
///
/// A render ends in minutes and a dialog is answered by a poll that is already
/// in flight; what this bounds is an entry nobody will ever look at again.
const TRACKED_FOR: Duration = Duration::from_secs(60 * 60);

/// Where an export has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl ExportStatus {
    /// Whether this is a place an export stays: a terminal status is never
    /// moved again by the driver, only read by a client.
    pub fn terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

/// What a client polls for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTask {
    pub id: String,
    pub timeline_id: String,
    pub status: ExportStatus,
    /// How far along, 0..1, never going backwards.
    pub progress01: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Where the finished render was written, which is where the reader asked
    /// for it and nowhere else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_to: Option<String>,
}

/// One export, and how to stop it.
#[derive(Debug)]
struct Tracked {
    task: ExportTask,
    /// Taken when the render ends or is cancelled, so a stop request reaches
    /// a process that is still running or nobody at all.
    cancel: Option<oneshot::Sender<()>>,
    forget_after: Instant,
}

/// The one export this process may be running, looked up by its handle.
#[derive(Debug, Default)]
pub struct ExportRegistry {
    tasks: RwLock<HashMap<String, Tracked>>,
}

/// The place one export takes, and how it hears that it should stop.
#[derive(Debug)]
pub struct Reservation {
    pub task: ExportTask,
    pub cancel: oneshot::Receiver<()>,
}

impl ExportRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the one place, or refuses because somebody is in it.
    ///
    /// Entries that have grown old are dropped here rather than on a timer:
    /// the only thing this table's size depends on is exports, so that is when
    /// it is cleaned.
    pub fn begin(&self, timeline_id: &str) -> Result<Reservation, ClipError> {
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        let now = Instant::now();
        tasks.retain(|_, entry| entry.forget_after > now);
        if tasks.values().any(|entry| !entry.task.status.terminal()) {
            return Err(ClipError::Busy);
        }
        let id = crate::domain::new_id();
        let (cancel, receiver) = oneshot::channel();
        let task = ExportTask {
            id: id.clone(),
            timeline_id: timeline_id.to_string(),
            status: ExportStatus::Queued,
            progress01: 0.0,
            message: None,
            saved_to: None,
        };
        tasks.insert(
            id,
            Tracked {
                task: task.clone(),
                cancel: Some(cancel),
                forget_after: now + TRACKED_FOR,
            },
        );
        Ok(Reservation {
            task,
            cancel: receiver,
        })
    }

    /// What has become of a handle.
    pub fn snapshot(&self, id: &str) -> Result<ExportTask, ClipError> {
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        let now = Instant::now();
        match tasks.get(id) {
            Some(entry) if entry.forget_after > now => Ok(entry.task.clone()),
            Some(_) => {
                tasks.remove(id);
                Err(ClipError::ExportMissing { id: id.to_string() })
            }
            None => Err(ClipError::ExportMissing { id: id.to_string() }),
        }
    }

    /// Asks an export to stop. One that already ended is answered as it ended,
    /// since a stop request and a finish can cross in flight.
    pub fn cancel(&self, id: &str) -> Result<ExportTask, ClipError> {
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        let now = Instant::now();
        let Some(entry) = tasks.get_mut(id) else {
            return Err(ClipError::ExportMissing { id: id.to_string() });
        };
        if entry.forget_after <= now {
            tasks.remove(id);
            return Err(ClipError::ExportMissing { id: id.to_string() });
        }
        if !entry.task.status.terminal() {
            if let Some(cancel) = entry.cancel.take() {
                let _ = cancel.send(());
            }
        }
        Ok(entry.task.clone())
    }

    /// Says the render has started.
    pub fn set_running(&self, id: &str) {
        self.edit(id, |task| {
            if !task.status.terminal() {
                task.status = ExportStatus::Running;
            }
        });
    }

    /// Writes down how far along the render is, never backwards.
    pub fn set_progress(&self, id: &str, progress01: f64) {
        self.edit(id, |task| {
            task.progress01 = task.progress01.max(progress01.clamp(0.0, 1.0));
        });
    }

    /// Puts an export in its final place and stops offering to cancel it.
    pub fn finish(
        &self,
        id: &str,
        status: ExportStatus,
        message: Option<String>,
        saved_to: Option<String>,
    ) {
        debug_assert!(status.terminal());
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        let Some(entry) = tasks.get_mut(id) else {
            return;
        };
        entry.task.status = status;
        entry.task.message = message;
        entry.task.saved_to = saved_to;
        if status == ExportStatus::Done {
            entry.task.progress01 = 1.0;
        }
        entry.cancel = None;
        // Read for a while rather than forgotten at once: the dialog that
        // started this is still polling.
        entry.forget_after = Instant::now() + TRACKED_FOR;
    }

    pub fn len(&self) -> usize {
        self.tasks.read().expect("a panic left this unlocked").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Applies one write to one entry, ignoring a handle that is not there.
    fn edit(&self, id: &str, write: impl FnOnce(&mut ExportTask)) {
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        if let Some(entry) = tasks.get_mut(id) {
            write(&mut entry.task);
        }
    }
}

/// Everything one run needs that is not in the plan.
#[derive(Debug, Clone)]
pub struct ExportRun {
    pub id: String,
    pub timeline_id: String,
    pub plan: RenderPlan,
    pub program: PathBuf,
    /// The H.264 encoder the capability probe chose, by name.
    pub encoder: String,
    /// The project's scratch directory: `export-<id>/` is made inside it.
    pub temp_root: PathBuf,
    /// Where the reader asked for the finished file.
    pub destination: PathBuf,
    pub timeout: Duration,
}

/// Drives one export from queued to a place it stays, and leaves nothing on
/// the disk whichever way it ends.
pub async fn drive(registry: Arc<ExportRegistry>, run: ExportRun, cancel: oneshot::Receiver<()>) {
    registry.set_running(&run.id);
    let spec = RunSpec {
        program: run.program,
        inputs: run.plan.inputs.clone(),
        graph: run.plan.graph.clone(),
        ass: run.plan.ass.clone(),
        duration_ms: run.plan.duration_ms,
        fps: run.plan.fps,
        encoder: run.encoder.clone(),
        audio: run.plan.audio,
        temp_dir: run.temp_root.join(format!("export-{}", run.id)),
        timeout: run.timeout,
    };
    let progress_registry = Arc::clone(&registry);
    let progress_id = run.id.clone();
    let outcome = runner::run(spec, cancel, move |progress01| {
        progress_registry.set_progress(&progress_id, progress01);
    })
    .await;

    match outcome {
        Ok(artifact) => {
            // The copy has to land before the guard goes: the scratch
            // directory leaves with the artifact.
            match place(&artifact.path, &run.destination).await {
                Ok(()) => registry.finish(
                    &run.id,
                    ExportStatus::Done,
                    None,
                    Some(run.destination.to_string_lossy().into_owned()),
                ),
                Err(error) => registry.finish(
                    &run.id,
                    ExportStatus::Failed,
                    Some(format!(
                        "Could not save the render to {}: {error}",
                        run.destination.display()
                    )),
                    None,
                ),
            }
        }
        Err(RunError::Cancelled) => registry.finish(&run.id, ExportStatus::Cancelled, None, None),
        Err(error) => registry.finish(&run.id, ExportStatus::Failed, Some(error.message()), None),
    }
}

/// Copies a finished render where the reader asked for it.
///
/// The copy lands under a temporary name beside its destination and is renamed
/// into place, so a destination that already held something is replaced whole
/// or not at all — a half-written file at a reader's own path is not something
/// a failed copy may leave behind.
async fn place(artifact: &Path, destination: &Path) -> std::io::Result<()> {
    let staging = staging_name(destination);
    let outcome = async {
        tokio::fs::copy(artifact, &staging).await?;
        tokio::fs::rename(&staging, destination).await
    }
    .await;
    if outcome.is_err() {
        let _ = tokio::fs::remove_file(&staging).await;
    }
    outcome
}

/// The name a copy takes while it is being made: its destination's own name
/// with `.tmp` behind it, so it sits in the same folder and never looks like
/// the file a reader asked for.
fn staging_name(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_os_string();
    name.push(".tmp");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_stub() -> RenderPlan {
        RenderPlan {
            inputs: Vec::new(),
            graph: "color=c=#000000:s=1920x1080:r=30:d=2,format=yuv420p[vout]\n".to_string(),
            ass: None,
            duration_ms: 2_000,
            fps: 30,
            audio: false,
        }
    }

    #[cfg(unix)]
    fn write_script(directory: &Path, name: &str, body: &str) -> PathBuf {
        use std::io::Write;
        // Written by a helper process so no descriptor of this process is
        // ever open on the file: a fork in any other thread would copy one,
        // and the exec that follows could answer ETXTBSY while the copy
        // lives.
        let path = directory.join(name);
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("cat > \"$1\" && chmod 755 \"$1\"")
            .arg("sh")
            .arg(&path)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("script");
        child
            .stdin
            .take()
            .expect("script body")
            .write_all(body.as_bytes())
            .expect("script body");
        assert!(child.wait().expect("script").success(), "script is written");
        path
    }

    #[test]
    fn one_export_runs_at_a_time() {
        let registry = ExportRegistry::new();
        let first = registry.begin("tl-1").expect("the place is free");
        assert_eq!(first.task.status, ExportStatus::Queued);
        assert_eq!(first.task.timeline_id, "tl-1");

        let error = registry
            .begin("tl-1")
            .expect_err("somebody is in the place");
        assert_eq!(error.code(), "CONFLICT");
        assert_eq!(error.to_string(), "An export is already running.");

        registry.finish(
            &first.task.id,
            ExportStatus::Done,
            None,
            Some("/tmp/Cut.mp4".into()),
        );
        assert!(registry.begin("tl-1").is_ok(), "the place is free again");
    }

    #[test]
    fn a_handle_nobody_issued_is_missing() {
        let registry = ExportRegistry::new();
        assert_eq!(
            registry.snapshot("nothing").unwrap_err().code(),
            "EXPORT_NOT_FOUND"
        );
        assert_eq!(
            registry.cancel("nothing").unwrap_err().code(),
            "EXPORT_NOT_FOUND"
        );
    }

    #[test]
    fn progress_never_goes_backwards_and_never_leaves_its_range() {
        let registry = ExportRegistry::new();
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        registry.set_running(&id);
        registry.set_progress(&id, 0.5);
        registry.set_progress(&id, 0.2);
        registry.set_progress(&id, 4.0);
        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Running);
        assert_eq!(task.progress01, 1.0);

        registry.set_progress(&id, -3.0);
        assert_eq!(registry.snapshot(&id).unwrap().progress01, 1.0);
    }

    #[tokio::test]
    async fn cancelling_reaches_the_render_and_the_status_follows_it() {
        let registry = ExportRegistry::new();
        let mut reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        registry.set_running(&id);

        let asked = registry.cancel(&id).expect("the handle is known");
        assert_eq!(
            asked.status,
            ExportStatus::Running,
            "the answer is the status as it stands"
        );
        reservation
            .cancel
            .try_recv()
            .expect("the stop request reached the process");

        registry.finish(&id, ExportStatus::Cancelled, None, None);
        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Cancelled);
        // A stop request for something that already ended is answered with
        // how it ended rather than refused.
        assert_eq!(
            registry.cancel(&id).unwrap().status,
            ExportStatus::Cancelled
        );
    }

    #[test]
    fn a_finished_export_is_read_for_a_while_and_then_forgotten() {
        let registry = ExportRegistry::new();
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        registry.finish(&id, ExportStatus::Done, None, Some("/tmp/Cut.mp4".into()));
        // A done render reports as done, at the end of its progress.
        let task = registry.snapshot(&id).unwrap();
        assert_eq!(task.status, ExportStatus::Done);
        assert_eq!(task.saved_to.as_deref(), Some("/tmp/Cut.mp4"));
        assert_eq!(task.progress01, 1.0);

        // Aged out: the same handle then reads as one that was never issued,
        // which is what tells the dialog to start over.
        {
            let mut tasks = registry.tasks.write().unwrap();
            let entry = tasks.get_mut(&id).unwrap();
            entry.forget_after = Instant::now() - Duration::from_secs(1);
        }
        assert_eq!(
            registry.snapshot(&id).unwrap_err().code(),
            "EXPORT_NOT_FOUND"
        );
        assert!(registry.is_empty());
    }

    #[test]
    fn starting_an_export_drops_the_ones_nobody_is_coming_back_for() {
        let registry = ExportRegistry::new();
        let first = registry.begin("tl-1").expect("the place is free");
        registry.finish(
            &first.task.id,
            ExportStatus::Failed,
            Some("no".into()),
            None,
        );
        {
            let mut tasks = registry.tasks.write().unwrap();
            let entry = tasks.get_mut(&first.task.id).unwrap();
            entry.forget_after = Instant::now() - Duration::from_secs(1);
        }
        registry
            .begin("tl-1")
            .expect("an old entry is not in the way");
        assert_eq!(registry.len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_is_driven_to_done_and_saved_where_it_was_told() {
        let root = tempfile::tempdir().unwrap();
        let script = write_script(
            root.path(),
            "fake-ffmpeg.sh",
            "#!/bin/sh\n\
             printf 'out_time_ms=1000000\\nprogress=continue\\n'\n\
             printf 'progress=end\\n'\n\
             printf 'artifact' > out.mp4\n\
             exit 0\n",
        );
        let registry = Arc::new(ExportRegistry::new());
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        let destination = root.path().join("out").join("Cut.mp4");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let run = ExportRun {
            id: id.clone(),
            timeline_id: "tl-1".to_string(),
            plan: plan_stub(),
            program: script,
            encoder: "libx264".to_string(),
            temp_root: root.path().join("tmp"),
            destination: destination.clone(),
            timeout: Duration::from_secs(10),
        };
        let _cancel = reservation.cancel;

        drive(Arc::clone(&registry), run, oneshot::channel().1).await;

        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Done);
        assert_eq!(
            task.saved_to.as_deref(),
            Some(destination.to_string_lossy().as_ref())
        );
        assert_eq!(task.progress01, 1.0);
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"artifact",
            "the finished render lands where it was asked for"
        );
        assert!(
            !staging_name(&destination).exists(),
            "no staging file is left beside it"
        );
        // The scratch directory went with the artifact.
        assert!(!root
            .path()
            .join("tmp")
            .join(format!("export-{id}"))
            .exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_that_fails_is_reported_with_its_own_words_and_no_scratch() {
        let root = tempfile::tempdir().unwrap();
        let script = write_script(
            root.path(),
            "fake-fail.sh",
            "#!/bin/sh\nprintf 'the encoder gave up\\n' >&2\nexit 1\n",
        );
        let registry = Arc::new(ExportRegistry::new());
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        let destination = root.path().join("Cut.mp4");
        let run = ExportRun {
            id: id.clone(),
            timeline_id: "tl-1".to_string(),
            plan: plan_stub(),
            program: script,
            encoder: "libx264".to_string(),
            temp_root: root.path().join("tmp"),
            destination,
            timeout: Duration::from_secs(10),
        };
        let _cancel = reservation.cancel;

        drive(Arc::clone(&registry), run, oneshot::channel().1).await;

        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Failed);
        assert!(
            task.message
                .as_deref()
                .is_some_and(|message| message.contains("gave up")),
            "{:?}",
            task.message
        );
        assert!(!root.path().join("Cut.mp4").exists());
        assert!(!root
            .path()
            .join("tmp")
            .join(format!("export-{id}"))
            .exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_whose_save_fails_is_failed_rather_than_lost() {
        let root = tempfile::tempdir().unwrap();
        let script = write_script(
            root.path(),
            "fake-ffmpeg.sh",
            "#!/bin/sh\nprintf 'progress=end\\n'\nprintf 'artifact' > out.mp4\nexit 0\n",
        );
        let registry = Arc::new(ExportRegistry::new());
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        // A folder that is not there: the copy has nowhere to land, and the
        // render is reported rather than quietly lost.
        let destination = root.path().join("nowhere").join("Cut.mp4");
        let run = ExportRun {
            id: id.clone(),
            timeline_id: "tl-1".to_string(),
            plan: plan_stub(),
            program: script,
            encoder: "libx264".to_string(),
            temp_root: root.path().join("tmp"),
            destination: destination.clone(),
            timeout: Duration::from_secs(10),
        };
        let _cancel = reservation.cancel;

        drive(Arc::clone(&registry), run, oneshot::channel().1).await;

        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Failed);
        assert!(task.saved_to.is_none());
        assert!(
            task.message.as_deref().unwrap().contains("nowhere"),
            "{:?}",
            task.message
        );
        assert!(!staging_name(&destination).exists());
        assert!(!root
            .path()
            .join("tmp")
            .join(format!("export-{id}"))
            .exists());
    }
}
