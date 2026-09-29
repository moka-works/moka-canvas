use crate::assets;
use crate::config::AppConfig;
use crate::domain::commands::{apply_commands, registry_errors};
use crate::domain::validate::{
    MAX_ASSET_KEYWORD_LENGTH, MAX_ASSET_NOTE_LENGTH, MAX_ASSET_TAGS, MAX_ASSET_TAG_LENGTH,
};
use crate::domain::{
    new_id, now_iso, AssetProvenance, CanvasDocument, DocumentCommand, MokaFile, NodeKind,
    ProjectMetadata, ResourceEntry, ResourceRegistry, RunRecord, RunStatus, SelfCheckIssue,
    SelfCheckNodeRef, SelfCheckReason, SelfCheckReport, MOKA_FILE_VERSION,
};
use crate::project::codec::{decode_moka_file, encode_moka_file};
use crate::project::{
    AssetChange, AssetFile, AssetShelfEdit, ByteRange, CreateProject, FiledAsset, OpenProject,
    PackageReport, PackageScope, ProjectError, ProjectStore, SaveResult, StagedAsset,
};
use crate::story::{StoryJobRecord, StoryJobStatus};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub struct FsProjectStore {
    config: Arc<AppConfig>,
    state: Arc<Mutex<Option<OpenState>>>,
    /// Bumped on every open, so a file check started for one project can never
    /// publish into the project opened after it.
    opens: AtomicU64,
}

struct OpenState {
    root: PathBuf,
    moka: MokaFile,
    /// Revision of the file as last written/read by this process.
    revision: i32,
    /// Filesystem identity of canvas.moka used to detect external edits.
    file_stamp: Option<std::time::SystemTime>,
    /// The latest check: what the sizes said at open, plus whatever the read
    /// behind it has found since.
    self_check: SelfCheckReport,
    /// The digest each issue the read found was found against, so a file that
    /// was replaced since does not keep an issue about the one that is gone.
    verified_against: std::collections::BTreeMap<String, String>,
    /// Whether that read has finished — true when there was nothing to read.
    self_check_verified: bool,
    /// Which open this state belongs to; the read carries the same number.
    open_token: u64,
}

/// One file the read behind an open still has to look at.
///
/// Built for the entries a stat could not already speak about: a file that is
/// there, is not empty, is the size the entry recorded, and carries the digest
/// it was filed with. What is left to learn is whether those bytes are still
/// the same bytes.
struct VerifyJob {
    asset_id: String,
    name: String,
    expected_path: String,
    path: PathBuf,
    sha256: String,
    referencing_nodes: Vec<SelfCheckNodeRef>,
}

impl FsProjectStore {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self {
            config,
            state: Arc::new(Mutex::new(None)),
            opens: AtomicU64::new(0),
        }
    }

    fn moka_path(root: &Path) -> PathBuf {
        root.join("canvas.moka")
    }

    fn scaffold(root: &Path) -> Result<(), ProjectError> {
        std::fs::create_dir_all(root)?;
        for category in crate::domain::ASSET_CATEGORIES {
            std::fs::create_dir_all(root.join("assets").join(category))?;
        }
        std::fs::create_dir_all(root.join("output"))?;
        std::fs::create_dir_all(root.join("history").join("runs"))?;
        std::fs::create_dir_all(root.join("history").join("story-jobs"))?;
        std::fs::create_dir_all(root.join("tmp"))?;
        Ok(())
    }

    fn clean_tmp(root: &Path) {
        let tmp = root.join("tmp");
        if let Ok(entries) = std::fs::read_dir(&tmp) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    /// The root of the open project, or the reason there is nothing to write to.
    fn open_root(&self) -> Result<PathBuf, ProjectError> {
        let guard = self.state.lock().expect("store poisoned");
        guard
            .as_ref()
            .map(|state| state.root.clone())
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))
    }

    fn runs_dir(root: &Path) -> PathBuf {
        root.join("history").join("runs")
    }

    /// Run ids are uuids; anything else can never resolve to a record file.
    fn run_path(root: &Path, id: &str) -> Result<PathBuf, ProjectError> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(ProjectError::domain("RUN_NOT_FOUND", "Run not found"));
        }
        Ok(Self::runs_dir(root).join(format!("{id}.json")))
    }

    /// One JSON file, written so a process that stops mid-write leaves the
    /// previous contents in place rather than half of the new ones.
    fn write_json(dir: &Path, id: &str, bytes: &[u8]) -> Result<(), ProjectError> {
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".{id}.{}.tmp", uuid::Uuid::now_v7()));
        Self::write_and_rename(&tmp, &dir.join(format!("{id}.json")), bytes)?;
        if let Ok(dir_handle) = std::fs::File::open(dir) {
            let _ = dir_handle.sync_all();
        }
        Ok(())
    }

    /// Writes a scratch file, flushes it, and renames it into place; a failure
    /// leaves the target as it was and takes the scratch file with it.
    ///
    /// The flush goes through the handle that wrote the bytes. A read-only
    /// reopen cannot be flushed on Windows — the operation requires write
    /// access there, unlike on Unix — so the rename would never be reached.
    fn write_and_rename(tmp: &Path, target: &Path, bytes: &[u8]) -> Result<(), ProjectError> {
        use std::io::Write;

        let outcome = (|| -> std::io::Result<()> {
            let mut file = std::fs::File::create(tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(tmp, target)
        })();
        if outcome.is_err() {
            let _ = std::fs::remove_file(tmp);
        }
        outcome.map_err(ProjectError::Io)
    }

    fn write_run(root: &Path, run: &RunRecord) -> Result<(), ProjectError> {
        let bytes = serde_json::to_vec_pretty(run)
            .map_err(|error| ProjectError::domain("INTERNAL", error.to_string()))?;
        Self::write_json(&Self::runs_dir(root), &run.id, &bytes)
    }

    /// The records of story jobs, one file each, beside the runs.
    ///
    /// A job is a batch of generations rather than a run of a graph, and the
    /// two are read by different rooms, so they are kept apart rather than
    /// told apart by a field that everything reading runs would have to know
    /// about.
    fn story_jobs_dir(root: &Path) -> PathBuf {
        root.join("history").join("story-jobs")
    }

    /// Job ids are uuids; anything else can never resolve to a record file.
    fn story_job_path(root: &Path, id: &str) -> Result<PathBuf, ProjectError> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(ProjectError::domain(
                "STORY_JOB_NOT_FOUND",
                "Story job not found",
            ));
        }
        Ok(Self::story_jobs_dir(root).join(format!("{id}.json")))
    }

    fn write_story_job(root: &Path, job: &StoryJobRecord) -> Result<(), ProjectError> {
        let bytes = serde_json::to_vec_pretty(job)
            .map_err(|error| ProjectError::domain("INTERNAL", error.to_string()))?;
        Self::write_json(&Self::story_jobs_dir(root), &job.id, &bytes)
    }

    /// Whether a story job left in progress can be picked up again rather than
    /// failed.
    ///
    /// Only a batch waiting on a shot can be: the provider is still filming it
    /// and the handle to ask again with is on the record. Anything else was in
    /// the middle of something this process was doing, which stopped with it.
    fn is_resumable_story_job(job: &StoryJobRecord) -> bool {
        job.items.iter().any(|item| {
            matches!(
                item.status,
                StoryJobStatus::Queued | StoryJobStatus::Running
            ) && item.task_id.is_some()
        })
    }

    /// Story jobs left running by a dead process are failed on open, unless one
    /// is waiting on a shot that is still out there — that one is left as it is
    /// and picked up again, because failing it would throw away an answer
    /// already paid for.
    fn sweep_interrupted_story_jobs(root: &Path) {
        let dir = Self::story_jobs_dir(root);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(mut job) = serde_json::from_str::<StoryJobRecord>(&raw) else {
                continue;
            };
            if job.status.is_terminal() {
                continue;
            }
            if Self::is_resumable_story_job(&job) {
                continue;
            }
            job.status = StoryJobStatus::Failed;
            job.error = Some("The app stopped while this job was in progress".to_string());
            for item in &mut job.items {
                if matches!(
                    item.status,
                    StoryJobStatus::Queued | StoryJobStatus::Running
                ) {
                    item.status = StoryJobStatus::Failed;
                    item.error = Some("Interrupted before completion".to_string());
                    item.retryable = Some(true);
                }
            }
            job.updated_at = now_iso();
            let _ = Self::write_story_job(root, &job);
        }
    }

    /// Keeps the records worth keeping: the recent ones, every batch that has
    /// not settled, and every answer the story has not been given yet.
    ///
    /// A record that has ended *and been read in* is a note about work already
    /// applied, so the old ones are clutter. One still in progress is what a
    /// client is following; one whose answer no room has read is a piece of
    /// writing the story is missing. Neither is dropped, however old it looks:
    /// a record thrown away is that answer lost, or — worse — one that comes
    /// back later and is written over whatever the reader has said since.
    fn prune_story_jobs(root: &Path, keep: usize) {
        let dir = Self::story_jobs_dir(root);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        let mut jobs: Vec<(PathBuf, StoryJobRecord)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(job) = serde_json::from_str::<StoryJobRecord>(&raw) else {
                continue;
            };
            jobs.push((path, job));
        }
        // Newest first, so everything past the ceiling is the oldest.
        jobs.sort_by(|a, b| b.1.created_at.cmp(&a.1.created_at));
        for (index, (path, job)) in jobs.iter().enumerate() {
            if job.status.is_terminal() && job.read_at.is_some() && index >= keep {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    /// The records of jobs a provider is still running, kept beside the runs
    /// that are waiting on them.
    ///
    /// Apart from the run record on purpose. A job is addressed by a handle the
    /// far end issued, which is not this app's to hand out: run records are
    /// served to clients and carried into exported packages, and nothing here
    /// is either.
    fn jobs_dir(root: &Path) -> PathBuf {
        root.join("history").join("jobs")
    }

    fn job_path(root: &Path, id: &str) -> Result<PathBuf, ProjectError> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(ProjectError::domain("JOB_NOT_FOUND", "Job not found"));
        }
        Ok(Self::jobs_dir(root).join(format!("{id}.json")))
    }

    /// Whether a run left in progress can be picked up again rather than failed.
    ///
    /// Only a step waiting on a job can be: the job is being worked on by
    /// somebody else and outlived this process, so the answer is still coming
    /// and the handle to ask again with is on the record. Anything else was in
    /// the middle of something this process was doing, which stopped with it.
    fn is_resumable(run: &RunRecord) -> bool {
        run.steps
            .iter()
            .any(|step| step.status == RunStatus::Running && step.task_id.is_some())
    }

    /// Runs left queued/running by a dead process are failed on open, unless
    /// one is waiting on a job that is still out there — that one is left as it
    /// is and picked up again, because failing it would throw away an answer
    /// already paid for.
    fn sweep_interrupted_runs(root: &Path) {
        let dir = Self::runs_dir(root);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(mut run) = serde_json::from_str::<RunRecord>(&raw) else {
                continue;
            };
            if !matches!(run.status, RunStatus::Queued | RunStatus::Running) {
                continue;
            }
            if Self::is_resumable(&run) {
                continue;
            }
            run.status = RunStatus::Failed;
            run.error = Some("The app stopped while this run was in progress".to_string());
            for step in &mut run.steps {
                if matches!(step.status, RunStatus::Queued | RunStatus::Running) {
                    step.status = RunStatus::Failed;
                    step.error = Some("Interrupted before completion".to_string());
                }
            }
            run.updated_at = now_iso();
            let _ = Self::write_run(root, &run);
        }
    }

    /// The runs a previous process left mid-flight, which is to say the ones
    /// the sweep just declined to fail.
    ///
    /// Read after a project is open and only there: the sweep has already
    /// failed everything that cannot be picked up again, so what is still in
    /// progress is waiting on a job a provider is still running.
    pub async fn interrupted_runs(&self) -> Result<Vec<String>, ProjectError> {
        Ok(self
            .list_runs()
            .await?
            .into_iter()
            .filter(|run| matches!(run.status, RunStatus::Queued | RunStatus::Running))
            .map(|run| run.id)
            .collect())
    }

    /// The story jobs a previous process left mid-flight, which is to say the
    /// ones the sweep just declined to fail.
    ///
    /// Read after a project is open and only there, for the same reason runs
    /// are: what is still in progress is waiting on a shot somebody else is
    /// still filming.
    pub async fn interrupted_story_jobs(&self) -> Result<Vec<String>, ProjectError> {
        Ok(self
            .list_story_jobs()
            .await?
            .into_iter()
            .filter(|job| !job.status.is_terminal())
            .map(|job| job.id)
            .collect())
    }

    /// Resolves a project-relative path and verifies it stays inside the
    /// canonical project root (no `..`, no absolute, no symlink escape).
    fn resolve_in_root(root: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
        if !crate::domain::validate::resource_path_valid(relative) {
            return Err(ProjectError::domain(
                "PATH_ESCAPE",
                format!("Path escapes the project root: {relative}"),
            ));
        }
        let candidate = root.join(relative);
        let canonical_root = root.canonicalize()?;
        // Canonicalize the deepest existing ancestor to defeat symlink escapes.
        let mut probe = candidate.clone();
        let existing = loop {
            if probe.exists() {
                break probe.canonicalize()?;
            }
            match probe.parent() {
                Some(parent) => probe = parent.to_path_buf(),
                None => break canonical_root.clone(),
            }
        };
        if !existing.starts_with(&canonical_root) {
            return Err(ProjectError::domain(
                "PATH_ESCAPE",
                format!("Path escapes the project root: {relative}"),
            ));
        }
        Ok(candidate)
    }

    fn atomic_write(&self, root: &Path, moka: &MokaFile) -> Result<(), ProjectError> {
        let bytes = encode_moka_file(moka, Some(self.config.projects.max_moka_file_bytes))?;
        let tmp = root
            .join("tmp")
            .join(format!("canvas.moka.{}.tmp", uuid::Uuid::now_v7()));
        Self::write_and_rename(&tmp, &Self::moka_path(root), &bytes)?;
        if let Ok(dir) = std::fs::File::open(root) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    fn load_from_disk(
        &self,
        root: &Path,
    ) -> Result<(MokaFile, Option<std::time::SystemTime>), ProjectError> {
        let path = Self::moka_path(root);
        let bytes = std::fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectError::domain(
                    "PROJECT_NOT_FOUND",
                    format!("No canvas.moka in {}", root.display()),
                )
            } else {
                ProjectError::Io(error)
            }
        })?;
        if bytes.len() as u64 > self.config.projects.max_moka_file_bytes {
            return Err(ProjectError::domain(
                "MOKA_TOO_LARGE",
                "canvas.moka exceeds the configured size limit",
            ));
        }
        let moka = decode_moka_file(&bytes)?;
        let stamp = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        Ok((moka, stamp))
    }

    /// What the sizes alone say about the project's files, and what is left to read.
    ///
    /// Answering from `metadata` is what keeps an open flat as a project grows:
    /// every question this can answer — is the file there, is it a file, is it
    /// empty, is it the length the entry recorded — is answered without opening
    /// it. The one thing a size cannot see, a file edited in place at the same
    /// length, is left to the jobs this returns, which are read behind the room
    /// and reported when they land.
    fn stat_check(root: &Path, moka: &MokaFile) -> (SelfCheckReport, Vec<VerifyJob>) {
        let mut issues = Vec::new();
        let mut jobs = Vec::new();
        let references = moka.asset_references();
        for entry in moka.resources.all() {
            let resolved = Self::resolve_in_root(root, &entry.path).ok();
            let meta = resolved
                .as_ref()
                .and_then(|path| std::fs::metadata(path).ok());
            if let Some(reason) = Self::stat_reason(meta.as_ref(), entry) {
                issues.push(SelfCheckIssue {
                    asset_id: entry.id.clone(),
                    name: entry.name.clone(),
                    expected_path: entry.path.clone(),
                    reason,
                    referencing_nodes: Self::referencing_nodes(moka, &references, &entry.id),
                });
                continue;
            }
            if let (Some(path), Some(sha256)) = (resolved, entry.sha256.clone()) {
                jobs.push(VerifyJob {
                    asset_id: entry.id.clone(),
                    name: entry.name.clone(),
                    expected_path: entry.path.clone(),
                    path,
                    sha256,
                    referencing_nodes: Self::referencing_nodes(moka, &references, &entry.id),
                });
            }
        }
        (
            SelfCheckReport {
                ok: issues.is_empty(),
                issues,
            },
            jobs,
        )
    }

    /// Makes an opened document the one this store serves, and starts the read
    /// behind it.
    ///
    /// Everything a caller is answered with is already known when this returns:
    /// the sizes have been read and the document is in place. What is still
    /// going on is the part nobody waits for.
    fn publish(
        &self,
        root: PathBuf,
        moka: MokaFile,
        revision: i32,
        stamp: Option<std::time::SystemTime>,
    ) -> OpenProject {
        let (report, jobs) = Self::stat_check(&root, &moka);
        let verified = jobs.is_empty();
        let token = self.opens.fetch_add(1, Ordering::Relaxed) + 1;
        // Whatever was drawn of files this project no longer holds has nothing
        // left to be asked for.
        crate::assets::thumbs::prune(&root, &moka);
        {
            let mut guard = self.state.lock().expect("store poisoned");
            *guard = Some(OpenState {
                root: root.clone(),
                moka: moka.clone(),
                revision,
                file_stamp: stamp,
                self_check: report.clone(),
                verified_against: std::collections::BTreeMap::new(),
                self_check_verified: verified,
                open_token: token,
            });
        }
        if !jobs.is_empty() {
            Self::spawn_verify(Arc::clone(&self.state), token, jobs);
        }
        OpenProject {
            root,
            moka,
            self_check: report,
            self_check_verified: verified,
        }
    }

    /// Reads the files the sizes could not speak about, behind the open room.
    ///
    /// On threads of the store's own rather than on the runtime's: this is
    /// blocking work on somebody's disk, and a request that arrives meanwhile —
    /// a save, an upload — has no business queueing behind a check nobody is
    /// waiting for. A few threads, not one per file: the point is to leave the
    /// machine room to work, not to finish first.
    fn spawn_verify(state: Arc<Mutex<Option<OpenState>>>, token: u64, jobs: Vec<VerifyJob>) {
        let threads = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(1)
            .clamp(1, 4)
            .min(jobs.len());
        let remaining = Arc::new(AtomicUsize::new(jobs.len()));
        let queue = Arc::new(jobs);
        let next = Arc::new(AtomicUsize::new(0));
        for _ in 0..threads {
            let state = Arc::clone(&state);
            let remaining = Arc::clone(&remaining);
            let queue = Arc::clone(&queue);
            let next = Arc::clone(&next);
            std::thread::spawn(move || loop {
                let at = next.fetch_add(1, Ordering::Relaxed);
                let Some(job) = queue.get(at) else { break };
                match sha256_of(&job.path) {
                    // The file the entry spoke of is the file that is there.
                    Ok(actual) if actual == job.sha256 => {}
                    Ok(_) => publish_verified_issue(
                        &state,
                        token,
                        job,
                        verify_issue(job, SelfCheckReason::Changed),
                    ),
                    // A file that cannot be read now is reported the way the
                    // open would have reported it: it is not there to the check.
                    Err(_) => publish_verified_issue(
                        &state,
                        token,
                        job,
                        verify_issue(job, SelfCheckReason::Missing),
                    ),
                }
                if remaining.fetch_sub(1, Ordering::AcqRel) == 1 {
                    finish_verification(&state, token);
                }
            });
        }
    }

    /// What one entry's file says about itself, from its metadata alone.
    fn stat_reason(
        meta: Option<&std::fs::Metadata>,
        entry: &crate::domain::ResourceEntry,
    ) -> Option<SelfCheckReason> {
        match meta {
            None => Some(SelfCheckReason::Missing),
            Some(meta) if !meta.is_file() => Some(SelfCheckReason::Missing),
            Some(meta) if meta.len() == 0 => Some(SelfCheckReason::Empty),
            Some(meta) => match entry.bytes {
                Some(bytes) if bytes as u64 != meta.len() => Some(SelfCheckReason::Changed),
                _ => None,
            },
        }
    }

    /// How much of a report still stands, asked again where that is cheap.
    ///
    /// A report is about the files as they were found, and a reader who puts a
    /// missing file back — through the very dialog this report raised — has
    /// made it wrong. So every issue is looked at again before a report is
    /// handed out: one whose file passes a stat now is dropped, and one the
    /// read found by content is kept only while the entry still carries the
    /// digest it was found against — a file that was replaced since is not the
    /// file that was complained about.
    fn refresh_report(&self, state: &mut OpenState) {
        if state.self_check.issues.is_empty() {
            return;
        }
        let root = state.root.clone();
        let moka = &state.moka;
        let mut kept = Vec::with_capacity(state.self_check.issues.len());
        for mut issue in std::mem::take(&mut state.self_check.issues) {
            let Some(entry) = moka.resources.find(&issue.asset_id) else {
                // The file is not the project's any more; nothing holds the
                // issue up.
                state.verified_against.remove(&issue.asset_id);
                continue;
            };
            if let Some(against) = state.verified_against.get(&issue.asset_id) {
                if entry.sha256.as_deref() == Some(against.as_str()) {
                    kept.push(issue);
                } else {
                    state.verified_against.remove(&issue.asset_id);
                }
                continue;
            }
            let meta = Self::resolve_in_root(&root, &entry.path)
                .ok()
                .and_then(|path| std::fs::metadata(path).ok());
            if let Some(reason) = Self::stat_reason(meta.as_ref(), entry) {
                issue.reason = reason;
                kept.push(issue);
            }
        }
        state.self_check.issues = kept;
        state.self_check.ok = state.self_check.issues.is_empty();
    }

    /// The nodes pointing at one asset, as a report names them.
    fn referencing_nodes(
        moka: &MokaFile,
        references: &std::collections::BTreeMap<String, Vec<String>>,
        asset_id: &str,
    ) -> Vec<SelfCheckNodeRef> {
        references
            .get(asset_id)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|node_id| {
                moka.canvas.iter().find_map(|canvas| {
                    canvas.node(node_id).map(|node| SelfCheckNodeRef {
                        canvas_id: canvas.id.clone(),
                        node_id: node.id.clone(),
                        title: node.title.clone(),
                    })
                })
            })
            .collect()
    }

    fn detect_external_edit(state: &OpenState) -> Result<(), ProjectError> {
        let path = Self::moka_path(&state.root);
        let stamp = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if let (Some(previous), Some(current)) = (state.file_stamp, stamp) {
            if previous != current {
                return Err(ProjectError::domain(
                    "REVISION_CONFLICT",
                    "canvas.moka changed on disk; reload the project before saving",
                ));
            }
        }
        Ok(())
    }

    /// Writes `next` as the document and publishes it in one step.
    ///
    /// The write comes first and the in-memory document is replaced only when
    /// it succeeded. A failed write therefore leaves the store serving exactly
    /// what the file holds, revision included, so the caller's next save is
    /// compared against the document that is really there — and a batch that
    /// was rejected was never visible to anyone.
    fn commit(&self, state: &mut OpenState, next: MokaFile) -> Result<SaveResult, ProjectError> {
        Self::detect_external_edit(state)?;
        if let Some(code) = registry_errors(&next) {
            return Err(ProjectError::domain(code, "Resource registry is invalid"));
        }
        let mut next = next;
        next.metadata.revision = state.revision + 1;
        next.metadata.updated_at = now_iso();
        self.atomic_write(&state.root, &next)?;
        state.moka = next;
        state.revision = state.moka.metadata.revision;
        state.file_stamp = std::fs::metadata(Self::moka_path(&state.root))
            .and_then(|m| m.modified())
            .ok();
        Ok(SaveResult {
            revision: state.revision,
            updated_at: state.moka.metadata.updated_at.clone(),
        })
    }

    /// Keeps the file a node already holds.
    ///
    /// This is what a picture, a piece of music, or a video has to offer the
    /// shelf: there is no second copy to write, so the entry the file is
    /// already registered under is marked as one to hand.
    fn keep_node_file(
        &self,
        state: &mut OpenState,
        asset_id: &Option<String>,
        asked: &str,
    ) -> Result<FiledAsset, ProjectError> {
        let asset_id = asset_id.as_deref().ok_or_else(|| {
            ProjectError::domain(
                "VALIDATION_FAILED",
                "The node holds nothing that can be filed",
            )
        })?;
        let said = opening_for_search(asked, MAX_ASSET_KEYWORD_LENGTH);
        let mut next = state.moka.clone();
        let entry = next.resources.find_mut(asset_id).ok_or_else(|| {
            ProjectError::domain("NOT_FOUND", "The node's file is not in the project")
        })?;
        entry.favorite = Some(true);
        if entry.keyword.is_none() {
            entry.keyword = said;
        }
        entry.updated_at = now_iso();
        let updated = entry.clone();
        let saved = self.commit(state, next)?;
        Ok(FiledAsset {
            change: AssetChange {
                entry: updated,
                revision: saved.revision,
                updated_at: saved.updated_at,
            },
            created: false,
        })
    }
}

/// One file of the read behind an open, as an issue.
fn verify_issue(job: &VerifyJob, reason: SelfCheckReason) -> SelfCheckIssue {
    SelfCheckIssue {
        asset_id: job.asset_id.clone(),
        name: job.name.clone(),
        expected_path: job.expected_path.clone(),
        reason,
        referencing_nodes: job.referencing_nodes.clone(),
    }
}

/// Writes one finding of the read behind an open into the state it belongs to.
///
/// A read that finishes after another project was opened publishes nothing: the
/// report it was making is about a document nobody is being shown. A read whose
/// file was replaced while it was going publishes nothing either: the entry has
/// moved on to other bytes, and what was found is about a file that is gone.
fn publish_verified_issue(
    state: &Arc<Mutex<Option<OpenState>>>,
    token: u64,
    job: &VerifyJob,
    issue: SelfCheckIssue,
) {
    let mut guard = state.lock().expect("store poisoned");
    let Some(open) = guard.as_mut() else { return };
    if open.open_token != token {
        return;
    }
    let filed = open
        .moka
        .resources
        .find(&job.asset_id)
        .and_then(|entry| entry.sha256.clone());
    if filed.as_deref() != Some(job.sha256.as_str()) {
        return;
    }
    open.verified_against
        .insert(job.asset_id.clone(), job.sha256.clone());
    open.self_check.ok = false;
    open.self_check.issues.push(issue);
}

/// Marks the read behind an open as done, wherever it ended.
fn finish_verification(state: &Arc<Mutex<Option<OpenState>>>, token: u64) {
    let mut guard = state.lock().expect("store poisoned");
    if let Some(open) = guard.as_mut() {
        if open.open_token == token {
            open.self_check_verified = true;
        }
    }
}

/// A file's digest, read in windows rather than whole.
///
/// A project's files are videos and pictures of tens of megabytes each; reading
/// one into memory to hash it would put the whole file on the heap to say
/// sixteen bytes about the front of it.
fn sha256_of(path: &Path) -> std::io::Result<String> {
    use sha2::Digest;
    use std::io::Read;

    const WINDOW: usize = 1 << 20;
    let mut file = std::io::BufReader::with_capacity(WINDOW, std::fs::File::open(path)?);
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0u8; WINDOW];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// One of the reader's phrases about an asset, pared to what the shelf holds.
///
/// Blank once trimmed is a phrase taken back rather than a phrase never said,
/// which is why the caller decides whether to write the answer down at all.
fn shelf_phrase(text: &str, limit: usize, what: &str) -> Result<Option<String>, ProjectError> {
    let trimmed = text.trim();
    if trimmed.chars().count() > limit {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            format!("A {what} of more than {limit} characters will not fit on the shelf"),
        ));
    }
    Ok(if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    })
}

/// The opening of a longer piece of text, kept so the shelf can be searched by
/// what a file says without the whole file being read.
///
/// Unlike a phrase a reader typed, this is clipped rather than refused: a long
/// text node is filed all the same, and a summary shorter than the file it
/// describes is no reason to turn it away.
fn opening_for_search(text: &str, limit: usize) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let opening: String = trimmed.chars().take(limit).collect();
    Some(opening.trim_end().to_string())
}

/// The words one asset is filed under. Two spellings of one word are kept as
/// one, since a reader asking for `Lantern` means what a reader asking for
/// `lantern` means.
fn shelf_tags(tags: &[String]) -> Result<Vec<String>, ProjectError> {
    let mut kept: Vec<String> = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > MAX_ASSET_TAG_LENGTH {
            return Err(ProjectError::domain(
                "VALIDATION_FAILED",
                format!(
                    "A tag of more than {MAX_ASSET_TAG_LENGTH} characters will not fit on the shelf"
                ),
            ));
        }
        if !kept.iter().any(|seen| seen.eq_ignore_ascii_case(trimmed)) {
            kept.push(trimmed.to_string());
        }
    }
    if kept.len() > MAX_ASSET_TAGS {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            format!("An asset carries at most {MAX_ASSET_TAGS} tags"),
        ));
    }
    Ok(kept)
}

/// What a new project's first canvas wears: the name the interface gave it, so
/// a document made in Chinese says 画布 1 rather than Canvas 1. A caller with
/// no language to give keeps the scaffold's own English name.
fn first_canvas_name(given: Option<String>) -> String {
    given
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Canvas 1".to_string())
}

#[async_trait::async_trait]
impl ProjectStore for FsProjectStore {
    async fn create_project(
        &self,
        root: &Path,
        input: CreateProject,
    ) -> Result<OpenProject, ProjectError> {
        if input.name.trim().is_empty() {
            return Err(ProjectError::domain(
                "VALIDATION_FAILED",
                "Project name is empty",
            ));
        }
        Self::scaffold(root)?;

        // Reopening an existing valid root is idempotent.
        if Self::moka_path(root).exists() {
            return self.open_project(root).await;
        }

        let now = now_iso();
        let moka = MokaFile {
            version: MOKA_FILE_VERSION.to_string(),
            metadata: ProjectMetadata {
                id: new_id(),
                name: input.name.trim().to_string(),
                description: None,
                cover_path: None,
                revision: 0,
                created_at: now.clone(),
                updated_at: now,
            },
            resources: ResourceRegistry::default(),
            folders: None,
            timelines: None,
            stories: None,
            canvas: vec![CanvasDocument::empty(
                new_id(),
                first_canvas_name(input.first_canvas_name),
            )],
        };
        self.atomic_write(root, &moka)?;
        Self::clean_tmp(root);
        let stamp = std::fs::metadata(Self::moka_path(root))
            .and_then(|m| m.modified())
            .ok();
        let revision = moka.metadata.revision;
        Ok(self.publish(root.to_path_buf(), moka, revision, stamp))
    }

    async fn open_project(&self, entry: &Path) -> Result<OpenProject, ProjectError> {
        let root = if entry.is_dir() {
            entry.to_path_buf()
        } else if entry.extension().and_then(|ext| ext.to_str()) == Some("moka") {
            entry.parent().map(Path::to_path_buf).ok_or_else(|| {
                ProjectError::domain("PROJECT_NOT_FOUND", "No containing directory")
            })?
        } else {
            return Err(ProjectError::domain(
                "PROJECT_NOT_FOUND",
                format!("Not a project directory or .moka file: {}", entry.display()),
            ));
        };
        let (moka, stamp) = self.load_from_disk(&root)?;
        Self::clean_tmp(&root);
        // A project made before saves asked where to go has no output folder
        // yet, and the save dialogs open at it: made here rather than left to
        // the first export, which never invents one.
        std::fs::create_dir_all(root.join("output"))?;
        Self::sweep_interrupted_runs(&root);
        Self::sweep_interrupted_story_jobs(&root);
        let revision = moka.metadata.revision;
        Ok(self.publish(root, moka, revision, stamp))
    }

    async fn current(&self) -> Result<Option<OpenProject>, ProjectError> {
        let mut guard = self.state.lock().expect("store poisoned");
        Ok(guard.as_mut().map(|state| {
            // The report a reader was shown when the project opened, not a
            // blank one: a reader who reads the document again is looking at
            // the same files, and a check that has found something since is
            // still what is true about them. What is no longer true is asked
            // again here rather than handed out.
            self.refresh_report(state);
            OpenProject {
                root: state.root.clone(),
                moka: state.moka.clone(),
                self_check: state.self_check.clone(),
                self_check_verified: state.self_check_verified,
            }
        }))
    }

    async fn project_root(&self) -> Result<PathBuf, ProjectError> {
        self.open_root()
    }

    async fn self_check_status(&self) -> Result<Option<(SelfCheckReport, bool)>, ProjectError> {
        let mut guard = self.state.lock().expect("store poisoned");
        Ok(guard.as_mut().map(|state| {
            self.refresh_report(state);
            (state.self_check.clone(), state.self_check_verified)
        }))
    }

    async fn apply_commands(
        &self,
        expected_revision: i32,
        commands: Vec<DocumentCommand>,
    ) -> Result<SaveResult, ProjectError> {
        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        if state.revision != expected_revision {
            return Err(ProjectError::domain(
                "REVISION_CONFLICT",
                format!(
                    "Expected revision {expected_revision} but the document is at {}",
                    state.revision
                ),
            ));
        }
        let (next, _inverse) = apply_commands(&state.moka, &commands)
            .map_err(|error| ProjectError::domain(error.code, error.to_string()))?;
        self.commit(state, next)
    }

    async fn add_asset(&self, staged: StagedAsset) -> Result<AssetChange, ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };

        let analysis = assets::analyze_staged(&staged.tmp_path).inspect_err(|_| {
            let _ = std::fs::remove_file(&staged.tmp_path);
        })?;
        if !assets::is_allowed_media(&analysis.mime, &self.config.public.allowed_media_types) {
            let _ = std::fs::remove_file(&staged.tmp_path);
            return Err(ProjectError::domain(
                "UNSUPPORTED_MEDIA_TYPE",
                format!("Media type {} is not allowed", analysis.mime),
            ));
        }

        // Audio lands in music/ or voice/ per the caller's explicit hint.
        let mut category = assets::category_for_mime(&analysis.mime).ok_or_else(|| {
            ProjectError::domain(
                "UNSUPPORTED_MEDIA_TYPE",
                format!("Media type {} has no asset category", analysis.mime),
            )
        })?;
        if analysis.mime.starts_with("audio/") {
            if let Some(hint) = staged.category_hint.as_deref() {
                if hint == "voice" {
                    category = "voice";
                }
            }
        }

        let id = new_id();
        let filename = assets::asset_filename(&staged.name, &analysis.mime, &id);
        let relative = match assets::promote(&root, &staged.tmp_path, category, &filename) {
            Ok(relative) => relative,
            Err(error) => {
                let _ = std::fs::remove_file(&staged.tmp_path);
                return Err(error);
            }
        };

        let now = now_iso();
        let entry = ResourceEntry {
            id: id.clone(),
            name: staged.name,
            path: relative,
            mime: Some(analysis.mime.clone()),
            bytes: Some(analysis.bytes as i64),
            sha256: Some(analysis.sha256),
            created_at: now.clone(),
            updated_at: now,
            probe: Some(analysis.probe),
            origin: if staged.provenance.is_some() {
                None
            } else {
                Some("brought".into())
            },
            provenance: staged.provenance,
            tags: None,
            note: None,
            favorite: None,
            keyword: None,
        };

        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let mut next = state.moka.clone();
        next.resources
            .category_mut(category)
            .expect("category checked above")
            .push(entry.clone());
        match self.commit(state, next) {
            Ok(saved) => Ok(AssetChange {
                entry,
                revision: saved.revision,
                updated_at: saved.updated_at,
            }),
            Err(error) => {
                // The document never took the entry, but the file was already
                // promoted into the project: it goes back out of it.
                let _ = std::fs::remove_file(root.join(&entry.path));
                Err(error)
            }
        }
    }

    async fn remove_asset(&self, id: &str) -> Result<SaveResult, ProjectError> {
        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let references = state.moka.asset_references();
        if let Some(held) = references.get(id) {
            // Where it is held is the client's to say, in the reader's own
            // language: it knows which of the holds the reader can empty, and
            // this guard only knows the document still points at the file.
            return Err(ProjectError::domain(
                "ASSET_IN_USE",
                format!("The asset is still in use ({} places)", held.len()),
            ));
        }
        let mut next = state.moka.clone();
        let entry = next
            .resources
            .remove(id)
            .ok_or_else(|| ProjectError::domain("NOT_FOUND", "Asset not found"))?;
        let path = Self::resolve_in_root(&state.root, &entry.path)?;
        let _ = std::fs::remove_file(path);
        self.commit(state, next)
    }

    async fn replace_asset_bytes(
        &self,
        id: &str,
        staged: StagedAsset,
    ) -> Result<AssetChange, ProjectError> {
        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let analysis = assets::analyze_staged(&staged.tmp_path).inspect_err(|_| {
            let _ = std::fs::remove_file(&staged.tmp_path);
        })?;
        let index_entry = state
            .moka
            .resources
            .find(id)
            .ok_or_else(|| ProjectError::domain("NOT_FOUND", "Asset not found"))?
            .clone();
        let target = Self::resolve_in_root(&state.root, &index_entry.path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&staged.tmp_path, &target)?;

        let mut next = state.moka.clone();
        let entry = next.resources.find_mut(id).expect("entry checked above");
        entry.mime = Some(analysis.mime.clone());
        entry.bytes = Some(analysis.bytes as i64);
        entry.sha256 = Some(analysis.sha256);
        entry.probe = Some(analysis.probe);
        entry.updated_at = now_iso();
        let updated = entry.clone();
        let saved = self.commit(state, next)?;
        Ok(AssetChange {
            entry: updated,
            revision: saved.revision,
            updated_at: saved.updated_at,
        })
    }

    async fn update_asset_shelf(
        &self,
        id: &str,
        edit: AssetShelfEdit,
    ) -> Result<AssetChange, ProjectError> {
        let said_tags = match &edit.tags {
            Some(tags) => Some(shelf_tags(tags)?),
            None => None,
        };
        let said_note = match &edit.note {
            Some(text) => Some(shelf_phrase(text, MAX_ASSET_NOTE_LENGTH, "note")?),
            None => None,
        };
        let said_keyword = match &edit.keyword {
            Some(text) => Some(shelf_phrase(text, MAX_ASSET_KEYWORD_LENGTH, "summary")?),
            None => None,
        };

        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let mut next = state.moka.clone();
        let entry = next
            .resources
            .find_mut(id)
            .ok_or_else(|| ProjectError::domain("NOT_FOUND", "Asset not found"))?;
        if let Some(tags) = said_tags {
            entry.tags = Some(tags);
        }
        if let Some(note) = said_note {
            entry.note = note;
        }
        if let Some(keyword) = said_keyword {
            entry.keyword = keyword;
        }
        if let Some(favorite) = edit.favorite {
            entry.favorite = Some(favorite);
        }
        entry.updated_at = now_iso();
        let updated = entry.clone();
        let saved = self.commit(state, next)?;
        Ok(AssetChange {
            entry: updated,
            revision: saved.revision,
            updated_at: saved.updated_at,
        })
    }

    async fn file_node_as_asset(
        &self,
        canvas_id: &str,
        node_id: &str,
    ) -> Result<FiledAsset, ProjectError> {
        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let root = state.root.clone();

        // The node is read out before anything is written so the borrow of the
        // document ends here: what follows edits the registry.
        let (kind, title, content, asset_id, asked) = {
            let canvas = state
                .moka
                .canvas
                .iter()
                .find(|canvas| canvas.id == canvas_id)
                .ok_or_else(|| ProjectError::domain("NOT_FOUND", "Canvas not found"))?;
            let node = canvas
                .node(node_id)
                .ok_or_else(|| ProjectError::domain("NOT_FOUND", "Node not found"))?;
            (
                node.kind,
                node.title.clone(),
                node.data.content.clone().unwrap_or_default(),
                node.data.asset_id.clone(),
                node.data
                    .generation
                    .as_ref()
                    .map(|spec| spec.prompt.clone())
                    .unwrap_or_default(),
            )
        };

        if kind != NodeKind::Text {
            return self.keep_node_file(state, &asset_id, &asked);
        }
        if content.trim().is_empty() {
            return Err(ProjectError::domain(
                "VALIDATION_FAILED",
                "The node holds nothing that can be filed",
            ));
        }

        let bytes = content.as_bytes();
        let sha256 = {
            use sha2::Digest;
            let mut hasher = sha2::Sha256::new();
            hasher.update(bytes);
            hex::encode(hasher.finalize())
        };

        // The same words from the same node are one file, however many times
        // they are filed.
        let already = state
            .moka
            .resources
            .all()
            .find(|entry| {
                entry.sha256.as_deref() == Some(sha256.as_str())
                    && entry
                        .provenance
                        .as_ref()
                        .and_then(|origin| origin.operation_node_id.as_deref())
                        == Some(node_id)
            })
            .cloned();
        if let Some(entry) = already {
            return Ok(FiledAsset {
                change: AssetChange {
                    entry,
                    revision: state.revision,
                    updated_at: state.moka.metadata.updated_at.clone(),
                },
                created: false,
            });
        }

        let id = new_id();
        let name = if title.trim().is_empty() {
            "text".to_string()
        } else {
            title.trim().to_string()
        };
        let filename = assets::asset_filename(&name, "text/markdown", &id);
        let tmp_path = assets::new_tmp_path(&root)?;
        if let Err(error) = std::fs::write(&tmp_path, bytes) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(error.into());
        }
        let relative = match assets::promote(&root, &tmp_path, "texts", &filename) {
            Ok(relative) => relative,
            Err(error) => {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(error);
            }
        };

        let now = now_iso();
        let entry = ResourceEntry {
            id,
            name: format!("{name}.md"),
            path: relative,
            mime: Some("text/markdown".into()),
            bytes: Some(bytes.len() as i64),
            sha256: Some(sha256),
            created_at: now.clone(),
            updated_at: now.clone(),
            probe: None,
            provenance: Some(AssetProvenance {
                run_id: None,
                canvas_id: Some(canvas_id.to_string()),
                operation_node_id: Some(node_id.to_string()),
                assistant_session_id: None,
                story_job_id: None,
                story_id: None,
                input_asset_ids: None,
                parameter_snapshot: None,
                created_at: now,
            }),
            tags: None,
            note: None,
            favorite: Some(true),
            origin: Some("filed".into()),
            keyword: opening_for_search(&content, MAX_ASSET_KEYWORD_LENGTH),
        };
        let mut next = state.moka.clone();
        next.resources
            .category_mut("texts")
            .expect("texts is an asset category")
            .push(entry.clone());
        match self.commit(state, next) {
            Ok(saved) => Ok(FiledAsset {
                change: AssetChange {
                    entry,
                    revision: saved.revision,
                    updated_at: saved.updated_at,
                },
                created: true,
            }),
            Err(error) => {
                // The document never took the entry, but the file was already
                // written into the project: it goes back out of it.
                let _ = std::fs::remove_file(root.join(&entry.path));
                Err(error)
            }
        }
    }

    async fn asset_file(
        &self,
        id: &str,
        range: Option<ByteRange>,
    ) -> Result<AssetFile, ProjectError> {
        let guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_ref()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let entry = state
            .moka
            .resources
            .find(id)
            .ok_or_else(|| ProjectError::domain("NOT_FOUND", "Asset not found"))?
            .clone();
        let path = Self::resolve_in_root(&state.root, &entry.path)?;
        if !path.is_file() {
            return Err(ProjectError::domain(
                "ASSET_MISSING",
                format!("Asset file is missing: {}", entry.path),
            ));
        }
        Ok(AssetFile { entry, path, range })
    }

    async fn export_package(
        &self,
        destination: &Path,
        allow_incomplete: bool,
        scope: PackageScope,
    ) -> Result<PackageReport, ProjectError> {
        let (root, moka) = {
            let guard = self.state.lock().expect("store poisoned");
            let state = guard
                .as_ref()
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
            (state.root.clone(), state.moka.clone())
        };
        crate::project::package::export_project(
            &root,
            &moka,
            destination,
            &self.config.limits,
            allow_incomplete,
            scope,
        )
    }

    async fn import_package(
        &self,
        archive: &Path,
        target_root: &Path,
    ) -> Result<OpenProject, ProjectError> {
        crate::project::package::import_project(archive, target_root, &self.config.limits)?;
        self.open_project(target_root).await
    }

    async fn list_runs(&self) -> Result<Vec<RunRecord>, ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };
        let runs_dir = root.join("history").join("runs");
        let mut runs = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&runs_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    if let Ok(run) = serde_json::from_str::<RunRecord>(&raw) {
                        runs.push(run);
                    }
                }
            }
        }
        runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(runs)
    }

    async fn create_run(&self, run: RunRecord) -> Result<RunRecord, ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };
        Self::write_run(&root, &run)?;
        Ok(run)
    }

    async fn get_run(&self, id: &str) -> Result<RunRecord, ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };
        let path = Self::run_path(&root, id)?;
        let raw = std::fs::read_to_string(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectError::domain("RUN_NOT_FOUND", "Run not found")
            } else {
                ProjectError::Io(error)
            }
        })?;
        serde_json::from_str(&raw).map_err(|error| {
            ProjectError::domain("INTERNAL", format!("Run record is corrupt: {error}"))
        })
    }

    async fn update_run(&self, run: RunRecord) -> Result<RunRecord, ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };
        Self::write_run(&root, &run)?;
        Ok(run)
    }

    async fn record_job(&self, id: &str, record: serde_json::Value) -> Result<(), ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };
        // Checked before anything is written, so a handle that is not one can
        // never name a path.
        Self::job_path(&root, id)?;
        let bytes = serde_json::to_vec_pretty(&record)
            .map_err(|error| ProjectError::domain("INTERNAL", error.to_string()))?;
        Self::write_json(&Self::jobs_dir(&root), id, &bytes)?;
        Ok(())
    }

    async fn drop_job(&self, id: &str) -> Result<(), ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };
        let path = Self::job_path(&root, id)?;
        match std::fs::remove_file(&path) {
            // A job ending and the run that waited on it ending can happen in
            // either order, and the second one to arrive has nothing to drop.
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(ProjectError::Io(error)),
        }
    }

    async fn job(&self, id: &str) -> Result<Option<serde_json::Value>, ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };
        let path = Self::job_path(&root, id)?;
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(ProjectError::Io(error)),
        };
        // A record that cannot be read is a record that is not there: what it
        // named is gone either way, and saying so lets the caller answer once.
        Ok(serde_json::from_str(&raw).ok())
    }

    async fn list_story_jobs(&self) -> Result<Vec<StoryJobRecord>, ProjectError> {
        let root = self.open_root()?;
        Self::prune_story_jobs(&root, self.config.story.keep_records);
        let dir = Self::story_jobs_dir(&root);
        let mut jobs = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    if let Ok(job) = serde_json::from_str::<StoryJobRecord>(&raw) {
                        jobs.push(job);
                    }
                }
            }
        }
        jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(jobs)
    }

    async fn create_story_job(&self, job: StoryJobRecord) -> Result<StoryJobRecord, ProjectError> {
        let root = self.open_root()?;
        Self::write_story_job(&root, &job)?;
        Ok(job)
    }

    async fn get_story_job(&self, id: &str) -> Result<StoryJobRecord, ProjectError> {
        let root = self.open_root()?;
        let path = Self::story_job_path(&root, id)?;
        let raw = std::fs::read_to_string(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectError::domain("STORY_JOB_NOT_FOUND", "Story job not found")
            } else {
                ProjectError::Io(error)
            }
        })?;
        serde_json::from_str(&raw).map_err(|error| {
            ProjectError::domain("INTERNAL", format!("Story job record is corrupt: {error}"))
        })
    }

    async fn update_story_job(&self, job: StoryJobRecord) -> Result<StoryJobRecord, ProjectError> {
        let root = self.open_root()?;
        Self::write_story_job(&root, &job)?;
        Ok(job)
    }
}

/// Normalizes a path without touching the filesystem (used by package entry checks).
pub fn normalize_relative(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::RunStepRecord;

    /// A run a process stopped in the middle of, with or without a job it was
    /// waiting on: the two look the same on the record apart from that.
    fn left_running(id: &str, task_id: Option<&str>) -> RunRecord {
        RunRecord {
            id: id.to_string(),
            project_id: "project-1".to_string(),
            canvas_id: "canvas-1".to_string(),
            requested_node_ids: vec!["n-shot".to_string()],
            status: RunStatus::Running,
            executor_key: "provider".to_string(),
            graph_hash: "abc".to_string(),
            parameters: serde_json::Value::Null,
            retry_of_run_id: None,
            assistant_session_id: None,
            steps: vec![RunStepRecord {
                node_id: "n-shot".to_string(),
                status: RunStatus::Running,
                started_at: Some("2026-01-01T00:00:00Z".to_string()),
                finished_at: None,
                error: None,
                error_code: None,
                error_details: None,
                output_asset_ids: None,
                output_text: None,
                task_id: task_id.map(str::to_string),
                task_created_at: task_id.map(|_| "2026-01-01T00:00:00Z".to_string()),
                progress: None,
            }],
            error: None,
            error_code: None,
            error_details: None,
            cancel_requested: false,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn recorded(root: &Path, id: &str) -> RunRecord {
        let raw =
            std::fs::read_to_string(FsProjectStore::runs_dir(root).join(format!("{id}.json")))
                .expect("the run is on disk");
        serde_json::from_str(&raw).expect("the run is readable")
    }

    #[test]
    fn only_a_run_waiting_on_a_job_is_left_for_the_process_that_comes_next() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let waiting = left_running("run-waiting", Some("0192b7d4-0000-7000-8000-000000000001"));
        let stranded = left_running("run-stranded", None);
        for run in [&waiting, &stranded] {
            FsProjectStore::write_run(root.path(), run).expect("the run is written");
        }

        FsProjectStore::sweep_interrupted_runs(root.path());

        // The job is being worked on by somebody else and outlived the process,
        // so the answer is still coming and failing the run would throw away a
        // shot that has already been paid for.
        let resumed = recorded(root.path(), "run-waiting");
        assert_eq!(resumed.status, RunStatus::Running);
        assert_eq!(resumed.steps[0].status, RunStatus::Running);
        assert!(resumed.error.is_none());

        // What was in the middle of something this process was doing stopped
        // with it, and there is nothing to pick up.
        let failed = recorded(root.path(), "run-stranded");
        assert_eq!(failed.status, RunStatus::Failed);
        assert_eq!(failed.steps[0].status, RunStatus::Failed);
        assert_eq!(
            failed.steps[0].error.as_deref(),
            Some("Interrupted before completion")
        );
    }

    #[test]
    fn a_job_is_named_by_its_handle_and_by_nothing_that_could_name_a_path() {
        let root = Path::new("/a/project");
        assert_eq!(
            FsProjectStore::job_path(root, "0192b7d4-0000-7000-8000-000000000001")
                .expect("a handle names a note"),
            root.join("history/jobs/0192b7d4-0000-7000-8000-000000000001.json")
        );
        // Checked before anything touches the disk, so a handle that is not one
        // can never reach a path.
        for handle in [
            "",
            ".",
            "..",
            "../secrets",
            "a/b",
            "a\\b",
            "note.json",
            "../../etc/passwd",
        ] {
            assert!(
                FsProjectStore::job_path(root, handle).is_err(),
                "{handle} must not name a note"
            );
        }
    }
}
