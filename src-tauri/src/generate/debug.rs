//! Every generation, written down where a person can read it afterwards.
//!
//! A generation that fails says why in the log, and one that succeeds says
//! nothing at all — which is the whole trouble this answers. An answer that
//! arrived and was the wrong thing cannot be diagnosed from a line saying the
//! call took nine seconds: a reader needs the words that were asked, the media
//! that travelled with them, and what came back.
//!
//! What lands on the disk is for a person, not for a replay tool. One
//! generation gets one directory, named for when it happened and which model
//! answered it. Inside it:
//!
//! - `request.json` — the capability, the model, the prompt, the conversation,
//!   the parameters, and every reference the request carried, each pointing at
//!   the file its bytes were written to.
//! - `request-<asset id>.<ext>` — those references, as real pictures, sounds,
//!   and films rather than base64 inside a document nobody can read.
//! - `calls.jsonl` — one line per HTTP exchange worth keeping: what was sent,
//!   what came back, and how long it took. Bodies are kept as text, with
//!   embedded media lifted out into files and replaced by a pointer. A video
//!   job's pending polls carry nothing a person can use, so they are skipped;
//!   the poll that finished the job stays.
//! - `response.json`, `response.txt`, `response-tools.json` — what the model
//!   answered: text, totals, tool calls, and the media items, each pointing at
//!   the file its bytes were written to.
//! - `response.sse.txt` — for a stream, the raw events beside the reading of
//!   them, because the interesting failure is the one where the two disagree;
//!   `response-thinking.txt` carries what could be lifted out of them as
//!   reasoning.
//! - `response-<n>.<ext>` — the pictures, sounds, and films the model made.
//!
//! It is off until somebody asks for it, and turning it on is a decision rather
//! than a setting: what lands on the disk is the prompt a reader typed. The
//! credential that carried it is always masked, and recordings always go to
//! the `records` subdirectory of the platform application data directory —
//! neither is a setting, because a setting somebody can get wrong is either a
//! key on the disk or a recording nobody can find. `docs/security.md` carries
//! the warning; this module carries the mechanism.
//!
//! Nothing here can fail a generation. Recordings are written by a task of
//! their own after the answer is already in hand, and a disk that will not take
//! one is complained about in the log rather than handed back to whoever asked.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine as _;
use reqwest::header::HeaderMap;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use super::adapters::ModelCall;
use super::error::ProviderError;
use super::media::MediaInput;
use super::{AsyncTask, GenerateRequest, GenerateResult, TaskState, ToolCall, Usage};
use crate::config::DebugConfig;
use crate::domain::{now_iso, Capability};
use crate::metadata::redact::masked;

/// What one call was for.
///
/// Two requests to the same address look alike afterwards, and the difference
/// between asking for a generation and looking at a job started an hour ago is
/// the first thing a reader wants to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// One generation, waited out.
    Generate,
    /// One generation, arriving in pieces.
    Stream,
    /// Starting a job that outlives the request.
    TaskCreate,
    /// One look at a job started earlier.
    TaskPoll,
    /// Fetching bytes a provider left at an address of its own.
    Media,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Generate => "generate",
            Self::Stream => "stream",
            Self::TaskCreate => "task-create",
            Self::TaskPoll => "task-poll",
            Self::Media => "media",
        }
    }
}

/// The model configuration a run was placed with, copied rather than borrowed.
///
/// Copied because a recording outlives the calls it describes: the task that
/// writes it runs after the answer is in hand, by which time the call that made
/// it may have been dropped.
#[derive(Debug, Clone)]
struct Who {
    config: String,
    model: String,
    display_name: String,
    protocol: String,
    /// The credential these calls carried, kept so that it can be taken back
    /// out of anything that echoes it. Never written down in full.
    api_key: String,
}

impl From<&ModelCall> for Who {
    fn from(call: &ModelCall) -> Self {
        Self {
            config: call.config_id.clone(),
            model: call.model.clone(),
            display_name: call.display_name.clone(),
            protocol: call.protocol.wire_name().to_string(),
            api_key: call.api_key.clone(),
        }
    }
}

/// One header, as a pair of strings.
type Header = (String, String);

fn headers_of(map: &HeaderMap) -> Vec<Header> {
    let mut headers: Vec<Header> = map
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or("<not text>").to_string(),
            )
        })
        .collect();
    // A provider sends its headers in whatever order suits it, and two runs of
    // the same call should read the same way side by side.
    headers.sort();
    headers
}

/// A body, held as it arrived.
#[derive(Debug, Clone)]
enum Body {
    /// Nothing was sent, or nothing came back.
    Empty,
    /// Text, which is what a provider answers with nearly every time.
    Text(String),
    /// Bytes that are not text: a picture, a sound, a video.
    Bytes(Vec<u8>),
    /// A body the client streamed rather than held, which cannot be read after
    /// the request has gone out.
    Streamed,
}

impl Body {
    fn of(bytes: Vec<u8>) -> Self {
        if bytes.is_empty() {
            return Self::Empty;
        }
        match String::from_utf8(bytes) {
            Ok(text) => Self::Text(text),
            Err(not_text) => Self::Bytes(not_text.into_bytes()),
        }
    }
}

/// One file a run's request carried, ready to be written beside the record.
struct InputFile {
    name: String,
    bytes: Vec<u8>,
}

/// One HTTP exchange, as it will be written to `calls.jsonl`.
struct Call {
    seq: u64,
    kind: Kind,
    method: String,
    url: String,
    /// What the request carried, with credentials still in them until written.
    headers: Vec<Header>,
    response_headers: Vec<Header>,
    status: Option<u16>,
    took: Duration,
    request: Body,
    response: Body,
    /// A media download's type and weight, kept instead of its bytes: the bytes
    /// are the answer's own item and are written as that item.
    media: Option<(String, u64)>,
    /// What a stream added up to, as counts and calls rather than raw events.
    stream: Option<StreamSummary>,
    error: Option<String>,
}

struct StreamSummary {
    text_chars: usize,
    thinking_chars: usize,
    tool_calls: Vec<ToolCall>,
    usage: Option<Usage>,
    finish_reason: Option<String>,
}

/// One exchange's request, read before it goes out.
///
/// The request is read here because sending it consumes the body, and the
/// answer is not there yet. A `Capture` with nothing recording is `None`, so a
/// call site pays only the branch.
pub struct Capture {
    run: Run,
    kind: Kind,
    started: Instant,
    seq: u64,
    method: String,
    url: String,
    headers: Vec<Header>,
    body: Body,
}

/// A generation being recorded: the directory it writes to and the exchanges
/// that belong in it.
#[derive(Clone)]
pub struct Run {
    state: Arc<RunState>,
}

struct RunState {
    /// The directory's own name under the records root.
    name: String,
    who: Who,
    started: Instant,
    /// What `request.json` will say, kept until the first write.
    request: Value,
    /// The line `index.jsonl` starts with, kept for a run whose directory is
    /// only made when it finishes.
    index: Value,
    /// Every reference digest, and the file it was written to.
    digests: HashMap<String, String>,
    calls: Mutex<Vec<Call>>,
    /// Which exchange this is, so two exchanges of one run can be put in order.
    sequence: AtomicU64,
    /// Whether the request and its references have been handed to the writer.
    started_job: AtomicBool,
    /// Whether this run has already been written once.
    finished: AtomicBool,
    /// The provider task this run started, when it started one. The binding is
    /// how a poll finds the directory its create made.
    task: Mutex<Option<String>>,
}

impl RunState {
    fn push(&self, call: Call) {
        self.calls
            .lock()
            .expect("the call list is not held across a write")
            .push(call);
    }

    fn take_calls(&self) -> Vec<Call> {
        std::mem::take(
            &mut *self
                .calls
                .lock()
                .expect("the call list is not held across a write"),
        )
    }
}

/// What a run ended as, in the shape a recording wants it.
pub enum Outcome<'a> {
    /// The answer, whole.
    Ok(&'a GenerateResult),
    /// A job the provider ran and ended badly.
    JobFailed { message: &'a str, retryable: bool },
    /// The call failed before there was an answer.
    Err(&'a ProviderError),
}

/// What a run ended as, owned by the writer.
enum Verdict {
    Ok(GenerateResult),
    JobFailed {
        message: String,
        retryable: bool,
    },
    Err {
        code: &'static str,
        message: String,
        retryable: bool,
    },
}

impl Verdict {
    fn status(&self) -> &'static str {
        match self {
            Self::Ok(_) => "ok",
            _ => "error",
        }
    }

    fn message(&self) -> Option<&str> {
        match self {
            Self::Ok(_) => None,
            Self::JobFailed { message, .. } | Self::Err { message, .. } => Some(message),
        }
    }
}

/// What the three sources said, settled into one answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    /// Where recordings are written: the `records` subdirectory of the platform
    /// application data directory, which is not a setting anybody can move.
    pub dir: PathBuf,
}

/// What the command line said, which is the outermost word because it is the one
/// somebody typed at the process being started.
static FROM_CLI: OnceLock<bool> = OnceLock::new();

/// The recorder, when recording is on. Absent when it is off, which is the
/// default and what every call site asks before it does any work at all.
static RECORDER: OnceLock<Recorder> = OnceLock::new();

struct Recorder {
    settings: Settings,
    /// Which run this is, so that two runs placed in the same millisecond still
    /// get two names and can be put back in order.
    sequence: AtomicU64,
    jobs: mpsc::UnboundedSender<Job>,
    /// Runs a poll can find by the task they started.
    live: Mutex<HashMap<String, Run>>,
}

/// One piece of work for the writer.
enum Job {
    /// A run's request and references, written before the first answer arrives
    /// so that a process which dies mid-call leaves the prompt behind.
    Started {
        name: String,
        request: Value,
        inputs: Vec<InputFile>,
        index: Value,
    },
    /// A job's create exchanges, written as soon as the job started rather than
    /// waiting minutes for the terminal poll.
    Calls {
        name: String,
        who: Who,
        calls: Vec<Call>,
        digests: HashMap<String, String>,
    },
    /// A stream's raw events and what could be lifted out of them as reasoning.
    RawSse {
        name: String,
        who: Who,
        raw: Vec<u8>,
        thinking: String,
    },
    /// The end of a run: what came back, and the exchanges not written yet.
    Finished(Box<FinishedJob>),
}

struct FinishedJob {
    name: String,
    who: Who,
    verdict: Verdict,
    calls: Vec<Call>,
    digests: HashMap<String, String>,
    /// Present when the directory was never started: a poll that found no
    /// create to attach to, or a call that failed before its first write.
    request: Option<Value>,
    index_start: Option<Value>,
    index_finish: Value,
    took: Duration,
}

/// Says what the command line asked for, before the server starts.
pub fn from_cli() {
    let _ = FROM_CLI.set(true);
}

/// The environment's word on recording, which is the one a reader sets without
/// editing a file.
const ENABLED_ENV: &str = "MOKA_LLM_DEBUG";

/// Subdirectory of the platform application data directory recordings go into.
pub const RECORDS_DIR_NAME: &str = "records";

/// Settles the three sources into one answer.
///
/// The directory is not settled, because it is not a setting: recordings go to
/// the `records` subdirectory of the platform application data directory, the
/// same root the metadata directory is resolved from.
pub fn resolve(file: &DebugConfig) -> Result<Settings> {
    let app_root = crate::metadata::paths::platform_default()
        .context("cannot determine the platform application data directory")?;
    Ok(settle(
        file,
        FROM_CLI.get().copied(),
        std::env::var(ENABLED_ENV).ok().as_deref(),
        &app_root,
    ))
}

/// Settles the three sources, in the order they are read: what somebody typed at
/// the process beats what the environment says, and what the environment says
/// beats what the configuration file says.
fn settle(
    file: &DebugConfig,
    cli: Option<bool>,
    env_flag: Option<&str>,
    app_root: &Path,
) -> Settings {
    let enabled = cli
        .filter(|on| *on)
        .or_else(|| env_flag.and_then(truthy))
        .or(file.enabled)
        .unwrap_or(false);
    Settings {
        enabled,
        dir: app_root.join(RECORDS_DIR_NAME),
    }
}

/// Reads a switch the way a shell writes one.
fn truthy(words: &str) -> Option<bool> {
    match words.trim().to_ascii_lowercase().as_str() {
        "" => None,
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Opens the directory and starts the task that writes into it, or does nothing
/// at all when recording is off.
pub fn init(file: &DebugConfig) -> Result<Option<Settings>> {
    let settings = resolve(file)?;
    if !settings.enabled {
        return Ok(None);
    }
    start(settings).map(Some)
}

/// Starts the recorder into a directory handed in, for a test that needs a
/// directory of its own rather than the one the platform says.
#[doc(hidden)]
pub fn init_in(dir: &Path) -> Result<Option<Settings>> {
    start(Settings {
        enabled: true,
        dir: dir.to_path_buf(),
    })
    .map(Some)
}

fn start(settings: Settings) -> Result<Settings> {
    std::fs::create_dir_all(&settings.dir)
        .with_context(|| format!("cannot create {}", settings.dir.display()))?;
    private_directory(&settings.dir);
    let (sender, receiver) = mpsc::unbounded_channel();
    let recorder = Recorder {
        settings: settings.clone(),
        sequence: AtomicU64::new(1),
        jobs: sender,
        live: Mutex::new(HashMap::new()),
    };
    // Settled before the writer is started, so that a process which already has
    // a recorder keeps it and starts nothing.
    if let Err(unused) = RECORDER.set(recorder) {
        drop(unused);
        let active = active().expect("a recorder was already set");
        tracing::warn!(
            "provider call recording was already started; calls keep going to {}",
            active.dir.display()
        );
        return Ok(active.clone());
    }
    tokio::spawn(write_all(settings.dir.clone(), receiver));
    tracing::info!(
        "recording every provider call to {}",
        settings.dir.display()
    );
    Ok(settings)
}

/// What is being recorded and where, or nothing when recording is off.
pub fn active() -> Option<&'static Settings> {
    RECORDER.get().map(|recorder| &recorder.settings)
}

/// Starts recording one logical generation: the request, its references, and
/// the exchanges that follow.
pub fn begin_run(
    kind: Kind,
    call: &ModelCall,
    request: &GenerateRequest,
    inputs: &[MediaInput],
) -> Option<Run> {
    Some(RECORDER.get()?.begin(kind, call, request, inputs))
}

/// Finds the run a task's create started, or opens a run for a poll that has no
/// create to attach to — one from before a restart, whose request is gone.
pub fn resume(
    kind: Kind,
    call: &ModelCall,
    capability: Capability,
    task: &AsyncTask,
) -> Option<Run> {
    let recorder = RECORDER.get()?;
    if let Some(run) = recorder
        .live
        .lock()
        .expect("the live runs are not held across a write")
        .get(&task.id)
        .cloned()
    {
        return Some(run);
    }
    Some(recorder.lazy(kind, call, capability, task))
}

/// Records that a job started, binds its task to the run's directory, and
/// writes the create exchanges now rather than minutes later.
pub fn task_started(run: Option<Run>, task: &AsyncTask) {
    let Some(run) = run else { return };
    let Some(recorder) = RECORDER.get() else {
        return;
    };
    *run.state
        .task
        .lock()
        .expect("the task binding is not held across a write") = Some(task.id.clone());
    recorder
        .live
        .lock()
        .expect("the live runs are not held across a write")
        .insert(task.id.clone(), run.clone());
    let calls = filter_polls(run.state.take_calls());
    if !calls.is_empty() {
        let _ = recorder.jobs.send(Job::Calls {
            name: run.state.name.clone(),
            who: run.state.who.clone(),
            calls,
            digests: run.state.digests.clone(),
        });
    }
}

impl Recorder {
    fn begin(
        &self,
        kind: Kind,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
    ) -> Run {
        let started = Instant::now();
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let placed = now_iso();
        let name = name_of(&placed, sequence, call);
        let who = Who::from(call);
        let (files, references, digests) = input_files(inputs);
        let prompt = prompt_of(request);
        let record = request_record(kind, &who, &placed, call, request, references);
        let index = start_index(&name, &placed, kind, request.capability, &who, &prompt);
        let started_job = self
            .jobs
            .send(Job::Started {
                name: name.clone(),
                request: record,
                inputs: files,
                index: index.clone(),
            })
            .is_ok();
        Run {
            state: Arc::new(RunState {
                name,
                who,
                started,
                // Already handed to the writer; a job may live for minutes and
                // there is no reason to keep a second copy of its prompt.
                request: Value::Null,
                index,
                digests,
                calls: Mutex::new(Vec::new()),
                sequence: AtomicU64::new(1),
                started_job: AtomicBool::new(started_job),
                finished: AtomicBool::new(false),
                task: Mutex::new(None),
            }),
        }
    }

    fn lazy(&self, kind: Kind, call: &ModelCall, capability: Capability, task: &AsyncTask) -> Run {
        let started = Instant::now();
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let placed = now_iso();
        let name = name_of(&placed, sequence, call);
        let who = Who::from(call);
        let record = poll_record(&who, &placed, call, capability, task);
        let index = start_index(&name, &placed, kind, capability, &who, "");
        Run {
            state: Arc::new(RunState {
                name,
                who,
                started,
                request: record,
                index,
                digests: HashMap::new(),
                calls: Mutex::new(Vec::new()),
                sequence: AtomicU64::new(1),
                started_job: AtomicBool::new(false),
                finished: AtomicBool::new(false),
                task: Mutex::new(Some(task.id.clone())),
            }),
        }
    }
}

/// Reads a request that is about to go out, or nothing when recording is off.
pub fn capture(run: Option<&Run>, kind: Kind, request: &reqwest::Request) -> Option<Capture> {
    let run = run?;
    let seq = run.state.sequence.fetch_add(1, Ordering::Relaxed);
    // A media download's bytes are the answer's own item, written as that item:
    // keeping a second copy in a call would only double it.
    let body = if kind == Kind::Media {
        Body::Empty
    } else {
        body_of(request.body())
    };
    Some(Capture {
        run: run.clone(),
        kind,
        started: Instant::now(),
        seq,
        method: request.method().to_string(),
        url: request.url().to_string(),
        headers: headers_of(request.headers()),
        body,
    })
}

/// The body a request carries, read out of the client's own shape.
fn body_of(body: Option<&reqwest::Body>) -> Body {
    match body.and_then(|body| body.as_bytes()) {
        Some(bytes) => Body::of(bytes.to_vec()),
        None if body.is_some() => Body::Streamed,
        None => Body::Empty,
    }
}

/// Records an answer that arrived whole.
pub fn answered(capture: Option<Capture>, status: u16, headers: &HeaderMap, body: &[u8]) {
    let Some(capture) = capture else { return };
    let response_headers = headers_of(headers);
    let media = (capture.kind == Kind::Media).then(|| {
        let mime = content_type(&response_headers)
            .map(str::to_string)
            .or_else(|| sniff(body))
            .unwrap_or_else(|| "application/octet-stream".to_string());
        (mime, body.len() as u64)
    });
    let response = if capture.kind == Kind::Media {
        Body::Empty
    } else {
        Body::of(body.to_vec())
    };
    capture.run.state.push(Call {
        seq: capture.seq,
        kind: capture.kind,
        method: capture.method,
        url: capture.url,
        headers: capture.headers,
        response_headers,
        status: Some(status),
        took: capture.started.elapsed(),
        request: capture.body,
        response,
        media,
        stream: None,
        error: None,
    });
}

/// How much of a body that did not arrive whole is worth writing down: enough
/// for a provider's own explanation, not enough for an answer that was never
/// going to be kept.
const PARTIAL_BODY_BYTES: usize = 64 * 1024;

/// Records a call that reached the provider and could not be read whole.
///
/// What had arrived by then is kept beside the reason the reading stopped: a
/// provider that fails in the middle of its answer has usually already said
/// why, and the part is often the only explanation there is.
pub fn broken(
    capture: Option<Capture>,
    error: &str,
    status: u16,
    headers: &HeaderMap,
    body: &[u8],
) {
    let Some(capture) = capture else { return };
    let response = if capture.kind == Kind::Media {
        // The bytes of a media download are the answer's own item; half of one
        // is not a file anybody can open, and the call already says how far it
        // got.
        Body::Empty
    } else {
        partial(body)
    };
    capture.run.state.push(Call {
        seq: capture.seq,
        kind: capture.kind,
        method: capture.method,
        url: capture.url,
        headers: capture.headers,
        response_headers: headers_of(headers),
        status: Some(status),
        took: capture.started.elapsed(),
        request: capture.body,
        response,
        media: None,
        stream: None,
        error: Some(error.to_string()),
    });
}

/// The part of a body that arrived, as text a person can read, with the cut
/// marked where it was one.
fn partial(body: &[u8]) -> Body {
    if body.is_empty() {
        return Body::Empty;
    }
    let kept = &body[..body.len().min(PARTIAL_BODY_BYTES)];
    let mut text = String::from_utf8_lossy(kept).into_owned();
    if kept.len() < body.len() {
        text.push_str(&format!("\n…[{} of {} bytes kept]", kept.len(), body.len()));
    }
    Body::Text(text)
}

/// Records a call that never left, which has no answer of any kind.
pub fn unsent(capture: Option<Capture>, error: &str) {
    let Some(capture) = capture else { return };
    capture.run.state.push(Call {
        seq: capture.seq,
        kind: capture.kind,
        method: capture.method,
        url: capture.url,
        headers: capture.headers,
        response_headers: Vec::new(),
        status: None,
        took: capture.started.elapsed(),
        request: capture.body,
        response: Body::Empty,
        media: None,
        stream: None,
        error: Some(error.to_string()),
    });
}

/// Records a stream that ended, with its raw events and what they added up to.
pub fn streamed(
    capture: Option<Capture>,
    status: u16,
    headers: &HeaderMap,
    result: &GenerateResult,
    raw: Vec<u8>,
) {
    let Some(capture) = capture else { return };
    let thinking = thinking_of_sse(&raw);
    capture.run.write_raw(&raw, &thinking);
    let summary = StreamSummary {
        text_chars: result.text.as_deref().map(str::len).unwrap_or_default(),
        thinking_chars: thinking.chars().count(),
        tool_calls: result.tool_calls.clone(),
        usage: result.usage,
        finish_reason: result.finish_reason.clone(),
    };
    capture.run.state.push(Call {
        seq: capture.seq,
        kind: capture.kind,
        method: capture.method,
        url: capture.url,
        headers: capture.headers,
        response_headers: headers_of(headers),
        status: Some(status),
        took: capture.started.elapsed(),
        request: capture.body,
        response: Body::Empty,
        media: None,
        stream: Some(summary),
        error: None,
    });
}

/// Records a stream that ended in the middle, with what had arrived by then.
pub fn stream_broken(
    capture: Option<Capture>,
    error: &str,
    status: u16,
    headers: &HeaderMap,
    raw: Vec<u8>,
) {
    let Some(capture) = capture else { return };
    let thinking = thinking_of_sse(&raw);
    capture.run.write_raw(&raw, &thinking);
    capture.run.state.push(Call {
        seq: capture.seq,
        kind: capture.kind,
        method: capture.method,
        url: capture.url,
        headers: capture.headers,
        response_headers: headers_of(headers),
        status: Some(status),
        took: capture.started.elapsed(),
        request: capture.body,
        response: Body::Empty,
        media: None,
        stream: Some(StreamSummary {
            text_chars: 0,
            thinking_chars: thinking.chars().count(),
            tool_calls: Vec::new(),
            usage: None,
            finish_reason: None,
        }),
        error: Some(error.to_string()),
    });
}

/// Writes a run down with what it ended as.
pub fn finish(run: Option<Run>, outcome: Outcome<'_>) {
    let Some(run) = run else { return };
    let Some(recorder) = RECORDER.get() else {
        return;
    };
    if run.state.finished.swap(true, Ordering::SeqCst) {
        return;
    }
    let verdict = match outcome {
        Outcome::Ok(result) => Verdict::Ok(result.clone()),
        Outcome::JobFailed { message, retryable } => Verdict::JobFailed {
            message: message.to_string(),
            retryable,
        },
        Outcome::Err(error) => Verdict::Err {
            code: error.code(),
            message: error.to_string(),
            retryable: error.retryable(),
        },
    };
    let calls = filter_polls(run.state.take_calls());
    let took = run.state.started.elapsed();
    let started = run.state.started_job.load(Ordering::SeqCst);
    let error = verdict
        .message()
        .map(|message| scrubbed_text(message, &run.state.who));
    let index_finish = json!({
        "event": "finish",
        "dir": run.state.name,
        "status": verdict.status(),
        "tookMs": took.as_millis() as u64,
        "error": error,
    });
    let job = Job::Finished(Box::new(FinishedJob {
        name: run.state.name.clone(),
        who: run.state.who.clone(),
        verdict,
        calls,
        digests: run.state.digests.clone(),
        request: (!started).then(|| run.state.request.clone()),
        index_start: (!started).then(|| run.state.index.clone()),
        index_finish,
        took,
    }));
    if let Err(error) = recorder.jobs.send(job) {
        tracing::warn!(%error, "a provider call could not be recorded");
    }
    let task = run
        .state
        .task
        .lock()
        .expect("the task binding is not held across a write")
        .take();
    if let Some(task) = task {
        recorder
            .live
            .lock()
            .expect("the live runs are not held across a write")
            .remove(&task);
    }
}

/// Forgets a job the caller has given up on, so that the recording handle and
/// the credential it was scrubbing do not outlive the job. A poll that arrives
/// afterwards opens a directory of its own, which is what a poll after a
/// restart does too.
pub fn forget(task: &str) {
    let Some(recorder) = RECORDER.get() else {
        return;
    };
    recorder
        .live
        .lock()
        .expect("the live runs are not held across a write")
        .remove(task);
}

/// Settles one look at a job: a job still running writes nothing, and one that
/// ended — or a look that failed — finishes the run.
pub fn settle_poll(run: Option<Run>, state: &Result<TaskState, ProviderError>) {
    match state {
        Ok(TaskState::Pending { .. }) => {}
        Ok(TaskState::Succeeded(result)) => finish(run, Outcome::Ok(result)),
        Ok(TaskState::Failed { message, retryable }) => finish(
            run,
            Outcome::JobFailed {
                message,
                retryable: *retryable,
            },
        ),
        Err(error) => finish(run, Outcome::Err(error)),
    }
}

impl Run {
    /// Hands a stream's raw events to the writer, since a person reading the
    /// reading afterwards may want to see what it was made of.
    fn write_raw(&self, raw: &[u8], thinking: &str) {
        if raw.is_empty() && thinking.is_empty() {
            return;
        }
        let Some(recorder) = RECORDER.get() else {
            return;
        };
        let _ = recorder.jobs.send(Job::RawSse {
            name: self.state.name.clone(),
            who: self.state.who.clone(),
            raw: raw.to_vec(),
            thinking: thinking.to_string(),
        });
    }
}

/// Pending polls carry nothing a person can use, so only the poll that ended a
/// job is kept. Everything else the run did — an upload, the create, a media
/// download — stays in the order it happened.
fn filter_polls(calls: Vec<Call>) -> Vec<Call> {
    let last_poll = calls.iter().rposition(|call| call.kind == Kind::TaskPoll);
    calls
        .into_iter()
        .enumerate()
        .filter(|(at, call)| call.kind != Kind::TaskPoll || Some(*at) == last_poll)
        .map(|(_, call)| call)
        .collect()
}

/// The name every file of one run shares.
///
/// The moment first, so that a directory lists itself in order; then the
/// configuration and the model, which are the two things a reader filters by;
/// then which run it was, so two placed in the same moment still pair up.
fn name_of(placed: &str, sequence: u64, call: &ModelCall) -> String {
    format!(
        "{}_{}_{}_{sequence:04}",
        placed.replace(':', "-"),
        safe_name(&call.config_id),
        safe_name(&call.model)
    )
}

/// One name a reader typed, made safe to put in a path.
fn safe_name(words: &str) -> String {
    let mut safe: String = words
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    if safe.is_empty() {
        safe.push_str("unnamed");
    }
    safe
}

/// The references a request carried, each written as the file its bytes are.
///
/// A reference is named for the asset it came from rather than for where it
/// sits in the request: a reader looking at a folder wants to recognise the
/// picture the request named, and the role it played is in `request.json`.
fn input_files(inputs: &[MediaInput]) -> (Vec<InputFile>, Vec<Value>, HashMap<String, String>) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut files = Vec::with_capacity(inputs.len());
    let mut references = Vec::with_capacity(inputs.len());
    let mut digests = HashMap::new();
    for (at, input) in inputs.iter().enumerate() {
        let id = if input.asset_id.is_empty() {
            (at + 1).to_string()
        } else {
            safe_name(&input.asset_id)
        };
        let count = seen.entry(id.clone()).or_insert(0);
        *count += 1;
        let base = if *count == 1 {
            format!("request-{id}")
        } else {
            format!("request-{id}-{count}")
        };
        let name = format!(
            "{base}.{}",
            crate::assets::extension_for(&input.name, &input.mime)
        );
        digests.insert(digest_hex(&input.bytes), name.clone());
        references.push(json!({
            "role": input.role.as_str(),
            "name": input.name,
            "assetId": input.asset_id,
            "mime": input.mime,
            "bytes": input.bytes.len(),
            "file": name,
        }));
        files.push(InputFile {
            name,
            bytes: input.bytes.clone(),
        });
    }
    (files, references, digests)
}

/// What `request.json` says about one generation.
fn request_record(
    kind: Kind,
    who: &Who,
    placed: &str,
    call: &ModelCall,
    request: &GenerateRequest,
    references: Vec<Value>,
) -> Value {
    json!({
        "placed": placed,
        "kind": kind.as_str(),
        "capability": request.capability.as_str(),
        "config": who.config,
        "model": who.model,
        "displayName": who.display_name,
        "protocol": who.protocol,
        "endpoint": scrubbed_url(&call.url, who),
        "prompt": scrubbed_text(&request.prompt, who),
        "system": request.system.as_deref().map(|system| scrubbed_text(system, who)),
        "params": scrub_value(&Value::Object(request.params.clone()), who),
        "messages": serde_json::to_value(&request.messages)
            .map(|value| scrub_value(&value, who))
            .unwrap_or(Value::Null),
        "tools": serde_json::to_value(&request.tools)
            .map(|value| scrub_value(&value, who))
            .unwrap_or(Value::Null),
        "toolChoice": request.tool_choice.as_deref().map(|choice| scrubbed_text(choice, who)),
        "references": references,
    })
}

/// What `request.json` says about a poll that has no create to attach to.
fn poll_record(
    who: &Who,
    placed: &str,
    call: &ModelCall,
    capability: Capability,
    task: &AsyncTask,
) -> Value {
    json!({
        "placed": placed,
        "kind": Kind::TaskPoll.as_str(),
        "capability": capability.as_str(),
        "config": who.config,
        "model": who.model,
        "displayName": who.display_name,
        "protocol": who.protocol,
        "endpoint": scrubbed_url(&call.url, who),
        "task": { "id": task.id, "reference": task.reference },
    })
}

/// The words a reader would look for when scanning the index: a prompt, or the
/// last thing said to the model when the request is a conversation.
fn prompt_of(request: &GenerateRequest) -> String {
    if !request.prompt.trim().is_empty() {
        return request.prompt.clone();
    }
    request
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.text.clone())
        .unwrap_or_default()
}

fn start_index(
    name: &str,
    placed: &str,
    kind: Kind,
    capability: Capability,
    who: &Who,
    prompt: &str,
) -> Value {
    json!({
        "event": "start",
        "dir": name,
        "placed": placed,
        "kind": kind.as_str(),
        "capability": capability.as_str(),
        "config": who.config,
        "model": who.model,
        "protocol": who.protocol,
        "prompt": scrubbed_text(&excerpt(prompt), who),
        "promptChars": prompt.chars().count(),
    })
}

/// The first stretch of a prompt on one line, so an index stays scannable while
/// the whole of it is in the directory the line points at.
fn excerpt(text: &str) -> String {
    let one_line: String = text
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let cut: String = one_line.trim().chars().take(160).collect();
    if cut.len() < one_line.trim().len() {
        format!("{cut}…")
    } else {
        cut
    }
}

/// Writes every job the process records, one at a time.
async fn write_all(root: PathBuf, mut jobs: mpsc::UnboundedReceiver<Job>) {
    while let Some(job) = jobs.recv().await {
        // Blocking work in a task of its own, so that a body the size of a
        // picture is not written on a thread the rest of the application is
        // waiting on.
        let root = root.clone();
        let outcome = tokio::task::spawn_blocking(move || write_one(&root, job)).await;
        match outcome {
            Err(cancelled) => tracing::warn!(%cancelled, "a recording task did not finish"),
            Ok(Err(error)) => tracing::warn!(%error, "a provider call could not be recorded"),
            Ok(Ok(())) => {}
        }
    }
}

fn write_one(root: &Path, job: Job) -> Result<()> {
    match job {
        Job::Started {
            name,
            request,
            inputs,
            index,
        } => {
            let dir = root.join(&name);
            ensure_dir(&dir)?;
            write_json(&dir, "request.json", &request)?;
            for input in inputs {
                write_binary(&dir, &input.name, &input.bytes)?;
            }
            append_index(root, &index)?;
        }
        Job::Calls {
            name,
            who,
            calls,
            digests,
        } => {
            let dir = root.join(&name);
            ensure_dir(&dir)?;
            write_calls(&dir, &who, calls, &digests, &HashMap::new())?;
        }
        Job::RawSse {
            name,
            who,
            raw,
            thinking,
        } => {
            let dir = root.join(&name);
            ensure_dir(&dir)?;
            if !raw.is_empty() {
                let events = String::from_utf8_lossy(&raw);
                write_text(&dir, "response.sse.txt", &scrubbed_text(&events, &who))?;
            }
            if !thinking.trim().is_empty() {
                write_text(
                    &dir,
                    "response-thinking.txt",
                    &scrubbed_text(&thinking, &who),
                )?;
            }
        }
        Job::Finished(job) => write_finished(root, *job)?,
    }
    Ok(())
}

fn write_finished(root: &Path, job: FinishedJob) -> Result<()> {
    let FinishedJob {
        name,
        who,
        verdict,
        calls,
        digests,
        request,
        index_start,
        index_finish,
        took,
    } = job;
    let dir = root.join(&name);
    ensure_dir(&dir)?;
    if let Some(request) = request {
        write_json(&dir, "request.json", &request)?;
    }
    if let Some(line) = index_start {
        append_index(root, &line)?;
    }
    // The answer's media is written before the calls, so a body that carried
    // the same bytes can point at the file instead of repeating them.
    let mut outputs = HashMap::new();
    let mut media = Vec::new();
    if let Verdict::Ok(result) = &verdict {
        for (at, item) in result.items.iter().enumerate() {
            let file = format!(
                "response-{}.{}",
                at + 1,
                crate::assets::extension_for("", &item.mime)
            );
            write_binary(&dir, &file, &item.bytes)?;
            outputs.insert(digest_hex(&item.bytes), file.clone());
            media.push(json!({
                "file": file,
                "mime": item.mime,
                "bytes": item.bytes.len(),
                "width": item.width,
                "height": item.height,
                "durationMs": item.duration_ms,
            }));
        }
    }
    write_calls(&dir, &who, calls, &digests, &outputs)?;
    write_response(&dir, &who, &verdict, &media, took)?;
    let mut index_finish = index_finish;
    index_finish["files"] = json!(files_in(&dir));
    append_index(root, &index_finish)?;
    Ok(())
}

/// One line per exchange, and the files a body's media was lifted into.
fn write_calls(
    dir: &Path,
    who: &Who,
    calls: Vec<Call>,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
) -> Result<()> {
    if calls.is_empty() {
        return Ok(());
    }
    let path = dir.join("calls.jsonl");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("cannot open {}", path.display()))?;
    for call in calls {
        let mut sidecars = Vec::new();
        let line = call_line(call, who, inputs, outputs, &mut sidecars);
        for (name, bytes) in sidecars {
            write_binary(dir, &name, &bytes)?;
        }
        use std::io::Write;
        writeln!(file, "{}", serde_json::to_string(&line)?)
            .with_context(|| format!("cannot write {}", path.display()))?;
    }
    private_file(&path);
    Ok(())
}

fn call_line(
    call: Call,
    who: &Who,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
    sidecars: &mut Vec<(String, Vec<u8>)>,
) -> Value {
    let request_type = header_value(&call.headers, "content-type");
    let response_type = header_value(&call.response_headers, "content-type");
    let mut line = json!({
        "seq": call.seq,
        "kind": call.kind.as_str(),
        "method": call.method,
        "url": scrubbed_url(&call.url, who),
        "status": call.status,
        "tookMs": call.took.as_millis() as u64,
        "headers": scrubbed_headers(&call.headers, who),
    });
    if let Some(body) = body_value(
        &call.request,
        call.seq,
        "request",
        request_type,
        inputs,
        outputs,
        sidecars,
        who,
    ) {
        line["request"] = body;
    }
    if let Some(body) = body_value(
        &call.response,
        call.seq,
        "response",
        response_type,
        inputs,
        outputs,
        sidecars,
        who,
    ) {
        line["response"] = body;
    }
    if let Some((mime, bytes)) = &call.media {
        line["media"] = json!({ "mime": mime, "bytes": bytes });
    }
    if let Some(stream) = &call.stream {
        line["stream"] = json!({
            "textChars": stream.text_chars,
            "thinkingChars": stream.thinking_chars,
            "finishReason": stream.finish_reason,
            "usage": serde_json::to_value(stream.usage).unwrap_or(Value::Null),
            "toolCalls": serde_json::to_value(&stream.tool_calls).unwrap_or(Value::Null),
        });
    }
    if let Some(error) = &call.error {
        line["error"] = json!(scrubbed_text(error, who));
    }
    line
}

/// The final answer, written in the shape a person reads it.
fn write_response(
    dir: &Path,
    who: &Who,
    verdict: &Verdict,
    media: &[Value],
    took: Duration,
) -> Result<()> {
    let record = match verdict {
        Verdict::Ok(result) => {
            let text = result.text.as_deref().map(|text| scrubbed_text(text, who));
            if let Some(text) = text.as_deref().filter(|text| !text.trim().is_empty()) {
                write_text(dir, "response.txt", text)?;
            }
            if !result.tool_calls.is_empty() {
                let tools = serde_json::to_value(&result.tool_calls)?;
                let tools = scrub_value(&tools, who);
                write_json(dir, "response-tools.json", &tools)?;
            }
            json!({
                "ok": true,
                "tookMs": took.as_millis() as u64,
                "text": text,
                "usage": serde_json::to_value(result.usage).unwrap_or(Value::Null),
                "finishReason": result.finish_reason,
                "toolCalls": serde_json::to_value(&result.tool_calls).unwrap_or(Value::Null),
                "media": media,
            })
        }
        Verdict::JobFailed { message, retryable } => json!({
            "ok": false,
            "tookMs": took.as_millis() as u64,
            "error": {
                "code": "GENERATION_JOB_FAILED",
                "message": scrubbed_text(message, who),
                "retryable": retryable,
            },
        }),
        Verdict::Err {
            code,
            message,
            retryable,
        } => json!({
            "ok": false,
            "tookMs": took.as_millis() as u64,
            "error": {
                "code": code,
                "message": scrubbed_text(message, who),
                "retryable": retryable,
            },
        }),
    };
    write_json(dir, "response.json", &record)?;
    Ok(())
}

/// One body, as the line that describes it carries it.
///
/// JSON is kept as JSON so that a reader can fold it open; text that is not
/// JSON is kept as text; media is lifted into a file of its own and pointed at,
/// because a document holding a megabyte of base64 is one nobody can read.
#[allow(clippy::too_many_arguments)]
fn body_value(
    body: &Body,
    seq: u64,
    which: &str,
    content_type: Option<&str>,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
    sidecars: &mut Vec<(String, Vec<u8>)>,
    who: &Who,
) -> Option<Value> {
    match body {
        Body::Empty => None,
        Body::Streamed => Some(json!({
            "kind": "streamed",
            "note": "the body was streamed out and cannot be read twice",
        })),
        Body::Text(text) => {
            if is_multipart(content_type) {
                return Some(multipart_value(
                    text.as_bytes(),
                    content_type.expect("a multipart body named its type"),
                    seq,
                    which,
                    inputs,
                    outputs,
                    sidecars,
                    who,
                ));
            }
            match serde_json::from_str::<Value>(text) {
                Ok(value) => {
                    let mut counter = 0;
                    Some(sanitize_json(
                        &value,
                        seq,
                        which,
                        inputs,
                        outputs,
                        sidecars,
                        &mut counter,
                        who,
                    ))
                }
                Err(_) => Some(json!({
                    "kind": "text",
                    "text": scrubbed_text(text, who),
                })),
            }
        }
        Body::Bytes(bytes) => {
            if is_multipart(content_type) {
                return Some(multipart_value(
                    bytes,
                    content_type.expect("a multipart body named its type"),
                    seq,
                    which,
                    inputs,
                    outputs,
                    sidecars,
                    who,
                ));
            }
            Some(binary_value(
                bytes,
                seq,
                which,
                content_type,
                inputs,
                outputs,
                sidecars,
            ))
        }
    }
}

/// Bytes that are not text: pointed at where they were already written, or
/// written here when they are media somebody could open. Anything else is
/// described by its weight and type rather than copied: a blob nobody can read
/// is exactly what a recording is meant to keep off the disk.
fn binary_value(
    bytes: &[u8],
    seq: u64,
    which: &str,
    content_type: Option<&str>,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
    sidecars: &mut Vec<(String, Vec<u8>)>,
) -> Value {
    let digest = digest_hex(bytes);
    if let Some(file) = inputs.get(&digest).or_else(|| outputs.get(&digest)) {
        return json!({
            "kind": "binary",
            "bytes": bytes.len(),
            "mime": content_type.unwrap_or("application/octet-stream"),
            "file": file,
        });
    }
    let declared = content_type
        .filter(|mime| is_media(mime))
        .map(str::to_string);
    let media = sniff(bytes).or(declared);
    let Some(mime) = media else {
        return json!({
            "kind": "binary",
            "bytes": bytes.len(),
            "mime": content_type.unwrap_or("application/octet-stream"),
        });
    };
    let file = format!(
        "call-{seq}-{which}.{}",
        crate::assets::extension_for("", &mime)
    );
    sidecars.push((file.clone(), bytes.to_vec()));
    json!({
        "kind": "binary",
        "bytes": bytes.len(),
        "mime": mime,
        "file": file,
    })
}

fn is_media(mime: &str) -> bool {
    mime.starts_with("image/") || mime.starts_with("audio/") || mime.starts_with("video/")
}

/// One JSON document with its media lifted out and its strings scrubbed.
#[allow(clippy::too_many_arguments)]
fn sanitize_json(
    value: &Value,
    seq: u64,
    which: &str,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
    sidecars: &mut Vec<(String, Vec<u8>)>,
    counter: &mut usize,
    who: &Who,
) -> Value {
    match value {
        Value::String(text) => {
            sanitize_string(text, seq, which, inputs, outputs, sidecars, counter, who)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| {
                    sanitize_json(item, seq, which, inputs, outputs, sidecars, counter, who)
                })
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(name, item)| {
                    (
                        name.clone(),
                        sanitize_json(item, seq, which, inputs, outputs, sidecars, counter, who),
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// One string inside a body: a data URL or a long base64 blob becomes a file
/// pointer, and everything else is scrubbed and left as it was.
#[allow(clippy::too_many_arguments)]
fn sanitize_string(
    text: &str,
    seq: u64,
    which: &str,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
    sidecars: &mut Vec<(String, Vec<u8>)>,
    counter: &mut usize,
    who: &Who,
) -> Value {
    if let Some((mime, bytes)) = data_url(text) {
        let sniffed = sniff(&bytes);
        let media = mime
            .as_deref()
            .filter(|mime| is_media(mime))
            .map(str::to_string)
            .or(sniffed);
        if let Some(mime) = media {
            return lift(
                &bytes,
                Some(&mime),
                seq,
                which,
                inputs,
                outputs,
                sidecars,
                counter,
            );
        }
        if mime
            .as_deref()
            .is_some_and(|mime| mime.starts_with("text/"))
        {
            return Value::String(scrubbed_text(&String::from_utf8_lossy(&bytes), who));
        }
        return json!({
            "dataUrlChars": text.len(),
            "mime": mime,
            "note": "unrecognised binary is not written",
        });
    }
    if let Some(bytes) = base64_blob(text) {
        if let Some(mime) = sniff(&bytes) {
            return lift(
                &bytes,
                Some(&mime),
                seq,
                which,
                inputs,
                outputs,
                sidecars,
                counter,
            );
        }
        // A long blob nothing recognises is not worth a file nobody can open,
        // and is certainly not worth leaving in the middle of a document.
        return json!({
            "base64Chars": text.len(),
            "note": "unrecognised base64 is not written",
        });
    }
    Value::String(scrubbed_text(text, who))
}

/// The file a piece of media was written to: one of the request's own, one of
/// the answer's own, or a file made for this body alone.
#[allow(clippy::too_many_arguments)]
fn lift(
    bytes: &[u8],
    mime: Option<&str>,
    seq: u64,
    which: &str,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
    sidecars: &mut Vec<(String, Vec<u8>)>,
    counter: &mut usize,
) -> Value {
    let digest = digest_hex(bytes);
    if let Some(file) = inputs.get(&digest).or_else(|| outputs.get(&digest)) {
        return json!({
            "file": file,
            "mime": mime.map(str::to_string),
            "bytes": bytes.len(),
        });
    }
    let mime = mime
        .map(str::to_string)
        .or_else(|| sniff(bytes))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    *counter += 1;
    let file = format!(
        "call-{seq}-{which}-{counter}.{}",
        crate::assets::extension_for("", &mime)
    );
    sidecars.push((file.clone(), bytes.to_vec()));
    json!({
        "file": file,
        "mime": mime,
        "bytes": bytes.len(),
    })
}

/// A form's fields and file parts, without the bytes that would make it
/// unreadable.
#[allow(clippy::too_many_arguments)]
fn multipart_value(
    bytes: &[u8],
    content_type: &str,
    seq: u64,
    which: &str,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
    sidecars: &mut Vec<(String, Vec<u8>)>,
    who: &Who,
) -> Value {
    let Some(boundary) = boundary_of(content_type) else {
        return json!({
            "kind": "binary",
            "bytes": bytes.len(),
            "note": "a multipart body named no boundary",
        });
    };
    let parts = multipart_parts(bytes, &boundary);
    if parts.is_empty() {
        return json!({
            "kind": "binary",
            "bytes": bytes.len(),
            "note": "a multipart body could not be read",
        });
    }
    let mut fields = Map::new();
    let mut files = Vec::new();
    for part in parts {
        let headers = part_headers(part);
        let name = part_param(&headers, "content-disposition", "name");
        let filename = part_param(&headers, "content-disposition", "filename");
        let mime = headers
            .iter()
            .find(|(header, _)| header == "content-type")
            .map(|(_, value)| value.as_str());
        let body = part_body(part);
        if filename.is_some() || mime.is_some() {
            let digest = digest_hex(body);
            let part_mime = mime
                .map(str::to_string)
                .or_else(|| sniff(body))
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let file = match inputs.get(&digest).or_else(|| outputs.get(&digest)) {
                Some(file) => file.clone(),
                None => {
                    let part_name = safe_name(name.as_deref().unwrap_or("file"));
                    let file = format!(
                        "call-{seq}-{which}-{part_name}.{}",
                        crate::assets::extension_for(filename.as_deref().unwrap_or(""), &part_mime)
                    );
                    sidecars.push((file.clone(), body.to_vec()));
                    file
                }
            };
            files.push(json!({
                "part": name,
                "filename": filename,
                "mime": part_mime,
                "bytes": body.len(),
                "file": file,
            }));
        } else {
            let name = name.unwrap_or_else(|| "field".to_string());
            fields.insert(
                name,
                Value::String(scrubbed_text(&String::from_utf8_lossy(body), who)),
            );
        }
    }
    json!({
        "kind": "multipart",
        "fields": fields,
        "files": files,
    })
}

/// Splits a multipart body into its parts, on the boundary the header named.
fn multipart_parts<'a>(bytes: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let marker = format!("--{boundary}");
    let marker = marker.as_bytes();
    let mut parts = Vec::new();
    let mut cursor = 0;
    while let Some(found) = find(&bytes[cursor..], marker) {
        let mut start = cursor + found + marker.len();
        if bytes.get(start..start + 2) == Some(b"--") {
            break;
        }
        if bytes.get(start..start + 2) == Some(b"\r\n") {
            start += 2;
        }
        let Some(end) = find(&bytes[start..], marker) else {
            break;
        };
        let end = start + end;
        parts.push(
            bytes[start..end]
                .strip_suffix(b"\r\n")
                .unwrap_or(&bytes[start..end]),
        );
        cursor = end;
    }
    parts
}

fn part_headers(part: &[u8]) -> Vec<(String, String)> {
    let Some(split) = find(part, b"\r\n\r\n") else {
        return Vec::new();
    };
    String::from_utf8_lossy(&part[..split])
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect()
}

fn part_body(part: &[u8]) -> &[u8] {
    find(part, b"\r\n\r\n")
        .map(|split| &part[split + 4..])
        .unwrap_or(part)
}

fn part_param(headers: &[(String, String)], header: &str, param: &str) -> Option<String> {
    let value = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(header))
        .map(|(_, value)| value.as_str())?;
    value.split(';').skip(1).find_map(|piece| {
        let piece = piece.trim();
        let (name, value) = piece.split_once('=')?;
        if !name.trim().eq_ignore_ascii_case(param) {
            return None;
        }
        Some(value.trim().trim_matches('"').to_string())
    })
}

fn boundary_of(content_type: &str) -> Option<String> {
    content_type.split(';').skip(1).find_map(|piece| {
        let (name, value) = piece.trim().split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("boundary")
            .then(|| value.trim().trim_matches('"').to_string())
    })
}

fn is_multipart(content_type: Option<&str>) -> bool {
    content_type
        .map(|value| {
            value
                .to_ascii_lowercase()
                .starts_with("multipart/form-data")
        })
        .unwrap_or(false)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|part| part == needle)
}

fn header_value<'a>(headers: &'a [Header], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(header, _)| header.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn content_type(headers: &[Header]) -> Option<&str> {
    header_value(headers, "content-type")
}

/// What kind of media these bytes are, when they are media this recording
/// knows how to name.
fn sniff(bytes: &[u8]) -> Option<String> {
    infer::get(bytes)
        .map(|kind| kind.mime_type().to_string())
        .filter(|mime| {
            mime.starts_with("image/") || mime.starts_with("audio/") || mime.starts_with("video/")
        })
}

/// The bytes inside a `data:` URL, and the mime it named if it named one.
fn data_url(text: &str) -> Option<(Option<String>, Vec<u8>)> {
    let rest = text.strip_prefix("data:")?;
    let (header, encoded) = rest.split_once(',')?;
    if !header.to_ascii_lowercase().contains("base64") {
        return None;
    }
    let mime = header
        .split(';')
        .next()
        .map(str::trim)
        .filter(|mime| !mime.is_empty() && !mime.eq_ignore_ascii_case("base64"))
        .map(str::to_string);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    Some((mime, bytes))
}

/// A string that is a long base64 blob rather than words. A threshold keeps an
/// ordinary answer from being decoded just because it happens to use the same
/// letters.
fn base64_blob(text: &str) -> Option<Vec<u8>> {
    const LEAST: usize = 512;
    if text.len() < LEAST
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// Everything an SSE stream said about its reasoning, gathered into one
/// readable stretch.
///
/// Providers name a thought differently — `reasoning_content`, a reasoning
/// text delta, a Gemini part flagged as a thought — and none of them is the
/// answer, so none of them reaches a converter. A person diagnosing a
/// generation still wants to see it, which is what this is for.
fn thinking_of_sse(raw: &[u8]) -> String {
    let events = String::from_utf8_lossy(raw);
    let mut out = String::new();
    for line in events.lines() {
        let Some(payload) = line.strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            if let Some(thought) = thinking_of(&value) {
                out.push_str(&thought);
            }
        }
    }
    out
}

fn thinking_of(value: &Value) -> Option<String> {
    let mut out = String::new();
    gather_thinking(value, &mut out);
    (!out.is_empty()).then_some(out)
}

/// Walks one event looking for what a provider calls a thought, whichever of
/// its shapes the event uses: a reasoning delta, a thought part, or the
/// reasoning field beside a chat choice.
fn gather_thinking(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let kind = map.get("type").and_then(Value::as_str);
            let mut handled = false;
            if kind == Some("thinking_delta") {
                if let Some(text) = map.get("thinking").and_then(Value::as_str) {
                    out.push_str(text);
                    handled = true;
                }
            }
            if let Some(kind) = kind {
                if kind.ends_with("reasoning_text.delta")
                    || kind.ends_with("reasoning_summary_text.delta")
                {
                    if let Some(text) = map.get("delta").and_then(Value::as_str) {
                        out.push_str(text);
                        handled = true;
                    }
                }
            }
            // A Gemini candidate carries a thought as a part of its own,
            // flagged rather than named.
            if map.get("thought").and_then(Value::as_bool) == Some(true) {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    out.push_str(text);
                    handled = true;
                }
            }
            if !handled {
                for key in ["reasoning_content", "reasoning", "thinking"] {
                    if let Some(text) = map.get(key).and_then(Value::as_str) {
                        if !text.is_empty() {
                            out.push_str(text);
                            break;
                        }
                    }
                }
            }
            for child in map.values() {
                gather_thinking(child, out);
            }
        }
        Value::Array(items) => {
            for child in items {
                gather_thinking(child, out);
            }
        }
        _ => {}
    }
}

/// The headers a call carried, with the credential taken out of them.
fn scrubbed_headers(headers: &[Header], who: &Who) -> Value {
    let mut out = serde_json::Map::new();
    for (name, value) in headers {
        let value = if is_credential(name) {
            masked_credential(value, who)
        } else {
            scrubbed_text(value, who)
        };
        out.insert(name.clone(), Value::String(value));
    }
    Value::Object(out)
}

fn is_credential(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "proxy-authorization"
            | "x-goog-api-key"
            | "x-api-key"
            | "api-key"
            | "cookie"
    )
}

fn masked_credential(value: &str, who: &Who) -> String {
    match value.split_once(' ') {
        Some((scheme, secret)) if !secret.contains(' ') => format!("{scheme} {}", masked(secret)),
        None if !who.api_key.is_empty() && value == who.api_key => masked(value),
        _ => masked(value),
    }
}

/// An address with any credential in its query taken out.
fn scrubbed_url(url: &str, who: &Who) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return scrubbed_text(url, who);
    };
    let kept: Vec<String> = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((name, value)) if is_credential(name) => format!("{name}={}", masked(value)),
            _ => pair.to_string(),
        })
        .collect();
    let joined = format!("{base}?{}", kept.join("&"));
    scrubbed_text(&joined, who)
}

/// Any echo of the key this call carried, wherever it turns up.
fn scrubbed_text(text: &str, who: &Who) -> String {
    if who.api_key.len() < MIN_SCRUBBED_CHARS || !text.contains(&who.api_key) {
        return text.to_string();
    }
    text.replace(&who.api_key, &masked(&who.api_key))
}

/// Every string inside a document, scrubbed. Used for the request summary,
/// whose media is in its own files rather than in its fields.
fn scrub_value(value: &Value, who: &Who) -> Value {
    match value {
        Value::String(text) => Value::String(scrubbed_text(text, who)),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| scrub_value(item, who)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(name, item)| (name.clone(), scrub_value(item, who)))
                .collect(),
        ),
        other => other.clone(),
    }
}

const MIN_SCRUBBED_CHARS: usize = 8;

/// A body's digest, so two recordings can be compared without reading either,
/// and the same bytes inside two documents can point at one file.
fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn ensure_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("cannot create {}", path.display()))?;
    private_directory(path);
    Ok(())
}

/// One document, written whole and readable only by whoever owns the directory.
fn write_json(root: &Path, name: &str, value: &Value) -> Result<u64> {
    // Pretty rather than packed: this is read by a person in an editor.
    let bytes = serde_json::to_vec_pretty(value)?;
    write_binary(root, name, &bytes)?;
    Ok(bytes.len() as u64)
}

fn write_text(root: &Path, name: &str, text: &str) -> Result<()> {
    write_binary(root, name, text.as_bytes())
}

fn write_binary(root: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let path = root.join(name);
    std::fs::write(&path, bytes).with_context(|| format!("cannot write {}", path.display()))?;
    private_file(&path);
    Ok(())
}

fn append_index(root: &Path, line: &Value) -> Result<()> {
    use std::io::Write;

    let path = root.join("index.jsonl");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("cannot append to {}", path.display()))?;
    let text = serde_json::to_string(line)?;
    writeln!(file, "{text}").with_context(|| format!("cannot write {}", path.display()))?;
    private_file(&path);
    Ok(())
}

/// The files a directory holds, in the order a reader lists them.
fn files_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[cfg(unix)]
fn private_directory(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)) {
        tracing::warn!(%error, "cannot protect the recording directory");
    }
}

#[cfg(not(unix))]
fn private_directory(path: &Path) {
    let _ = path;
}

#[cfg(unix)]
fn private_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        tracing::warn!(%error, "cannot protect {}", path.display());
    }
}

#[cfg(not(unix))]
fn private_file(path: &Path) {
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::{GeneratedItem, InputRole};
    use crate::metadata::Protocol;

    fn who() -> Who {
        Who {
            config: "chan".into(),
            model: "painter".into(),
            display_name: "Painter".into(),
            protocol: "openaiChat".into(),
            api_key: "sk-secret-value-1234".into(),
        }
    }

    fn model() -> ModelCall {
        ModelCall::new(
            &crate::generate::models::ResolvedModel {
                config_id: "chan".into(),
                model: "painter".into(),
                display_name: "Painter".into(),
                protocol: Protocol::from_wire_name("openaiChat"),
                url: "https://api.example.invalid/v1/chat/completions".into(),
                category: Capability::Text,
                scene: None,
            },
            "sk-secret-value-1234".into(),
            crate::config::GenerateConfig::default(),
        )
        .expect("a call")
    }

    fn input(bytes: Vec<u8>) -> MediaInput {
        MediaInput {
            role: InputRole::FirstFrame,
            asset_id: "frame-1".into(),
            name: "opening".into(),
            bytes,
            mime: "image/png".into(),
        }
    }

    fn call(kind: Kind, request: Body, response: Body) -> Call {
        Call {
            seq: 1,
            kind,
            method: "POST".into(),
            url: "https://api.example.invalid/v1?key=sk-secret-value-1234".into(),
            headers: vec![
                ("authorization".into(), "Bearer sk-secret-value-1234".into()),
                ("content-type".into(), "application/json".into()),
            ],
            response_headers: vec![("content-type".into(), "application/json".into())],
            status: Some(200),
            took: Duration::from_millis(5),
            request,
            response,
            media: None,
            stream: None,
            error: None,
        }
    }

    fn read(root: &Path, name: &str) -> Vec<u8> {
        std::fs::read(root.join(name)).unwrap_or_else(|_| panic!("{name} is there"))
    }

    fn read_json(root: &Path, name: &str) -> Value {
        serde_json::from_slice(&read(root, name)).expect("the file is JSON")
    }

    #[test]
    fn recording_is_off_until_somebody_asks_for_it() {
        let settled = settle(
            &DebugConfig { enabled: None },
            None,
            None,
            Path::new("/appdata"),
        );
        assert!(!settled.enabled);
        assert_eq!(settled.dir, PathBuf::from("/appdata/records"));
    }

    #[test]
    fn what_somebody_typed_at_the_process_beats_the_environment() {
        let settled = settle(
            &DebugConfig {
                enabled: Some(false),
            },
            Some(true),
            Some("0"),
            Path::new("/appdata"),
        );
        assert!(settled.enabled);
    }

    #[test]
    fn a_switch_is_read_the_way_a_shell_writes_one() {
        for word in ["1", "true", "TRUE", " yes ", "on"] {
            assert_eq!(truthy(word), Some(true), "{word} means on");
        }
        for word in ["0", "false", "No", "off"] {
            assert_eq!(truthy(word), Some(false), "{word} means off");
        }
        assert_eq!(truthy("maybe"), None);
    }

    #[test]
    fn a_name_a_reader_typed_cannot_write_somewhere_else() {
        assert_eq!(safe_name("my/channel"), "my_channel");
        assert_eq!(safe_name("../../etc"), ".._.._etc");
        assert_eq!(safe_name(""), "unnamed");
        assert_eq!(safe_name(&"x".repeat(60)).len(), 40);
    }

    #[test]
    fn a_run_is_named_for_when_it_happened_and_which_model_answered() {
        assert_eq!(
            name_of("2026-11-16T10:15:00.123Z", 7, &model()),
            "2026-11-16T10-15-00.123Z_chan_painter_0007"
        );
    }

    #[test]
    fn a_reference_is_written_under_the_asset_it_came_from() {
        let (files, references, digests) = input_files(&[input(vec![1, 2, 3])]);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "request-frame-1.png");
        assert_eq!(files[0].bytes, vec![1, 2, 3]);
        assert_eq!(references[0]["role"], "firstFrame");
        assert_eq!(references[0]["file"], "request-frame-1.png");
        assert_eq!(
            digests[&digest_hex(&[1, 2, 3])],
            "request-frame-1.png",
            "the bytes are recognised wherever they turn up again"
        );
    }

    #[test]
    fn the_same_asset_twice_gets_two_names() {
        let (files, _, _) = input_files(&[input(vec![1]), input(vec![2])]);
        assert_eq!(files[0].name, "request-frame-1.png");
        assert_eq!(files[1].name, "request-frame-1-2.png");
    }

    #[test]
    fn media_inside_a_body_is_lifted_into_a_file_and_pointed_at() {
        let mut sidecars = Vec::new();
        let mut counter = 0;
        let value = json!({
            "prompt": "a lantern",
            "image": "data:image/png;base64,AQID",
        });
        let sanitized = sanitize_json(
            &value,
            1,
            "request",
            &HashMap::new(),
            &HashMap::new(),
            &mut sidecars,
            &mut counter,
            &who(),
        );
        assert_eq!(sanitized["prompt"], "a lantern");
        assert_eq!(sanitized["image"]["file"], "call-1-request-1.png");
        assert_eq!(sanitized["image"]["mime"], "image/png");
        assert_eq!(sidecars.len(), 1);
        assert_eq!(sidecars[0].0, "call-1-request-1.png");
        assert_eq!(sidecars[0].1, vec![1, 2, 3]);
    }

    #[test]
    fn a_data_url_nothing_can_open_is_described_rather_than_written() {
        let mut sidecars = Vec::new();
        let mut counter = 0;
        let sanitized = sanitize_json(
            &json!({ "doc": "data:application/pdf;base64,JVBERi0=" }),
            1,
            "request",
            &HashMap::new(),
            &HashMap::new(),
            &mut sidecars,
            &mut counter,
            &who(),
        );
        assert!(sanitized["doc"]["dataUrlChars"].is_number());
        assert!(sidecars.is_empty(), "there is nothing to open");
    }

    #[test]
    fn media_that_was_already_written_points_at_that_file() {
        let inputs = HashMap::from([(digest_hex(&[1, 2, 3]), "request-frame-1.png".to_string())]);
        let mut sidecars = Vec::new();
        let mut counter = 0;
        let sanitized = sanitize_json(
            &json!({ "image": "data:image/png;base64,AQID" }),
            1,
            "request",
            &inputs,
            &HashMap::new(),
            &mut sidecars,
            &mut counter,
            &who(),
        );
        assert_eq!(sanitized["image"]["file"], "request-frame-1.png");
        assert!(sidecars.is_empty(), "nothing is written twice");
    }

    #[test]
    fn a_blob_nothing_recognises_is_not_written_in_full() {
        let mut sidecars = Vec::new();
        let mut counter = 0;
        let blob = "A".repeat(600);
        let sanitized = sanitize_json(
            &json!({ "blob": blob }),
            1,
            "response",
            &HashMap::new(),
            &HashMap::new(),
            &mut sidecars,
            &mut counter,
            &who(),
        );
        assert_eq!(sanitized["blob"]["base64Chars"], 600);
        assert!(sidecars.is_empty());
    }

    #[test]
    fn a_form_is_written_as_its_fields_and_files() {
        let body = "--BOUND\r\n\
Content-Disposition: form-data; name=\"prompt\"\r\n\r\n\
A lantern\r\n\
--BOUND\r\n\
Content-Disposition: form-data; name=\"image\"; filename=\"opening.png\"\r\n\
Content-Type: image/png\r\n\r\n\
\x01\x02\x03\r\n\
--BOUND--\r\n";
        let mut sidecars = Vec::new();
        let value = multipart_value(
            body.as_bytes(),
            "multipart/form-data; boundary=BOUND",
            1,
            "request",
            &HashMap::new(),
            &HashMap::new(),
            &mut sidecars,
            &who(),
        );
        assert_eq!(value["kind"], "multipart");
        assert_eq!(value["fields"]["prompt"], "A lantern");
        assert_eq!(value["files"][0]["part"], "image");
        assert_eq!(value["files"][0]["file"], "call-1-request-image.png");
        assert_eq!(sidecars.len(), 1);
        assert_eq!(sidecars[0].1, vec![1, 2, 3]);

        let inputs = HashMap::from([(digest_hex(&[1, 2, 3]), "request-frame-1.png".to_string())]);
        let mut sidecars = Vec::new();
        let matched = multipart_value(
            body.as_bytes(),
            "multipart/form-data; boundary=BOUND",
            1,
            "request",
            &inputs,
            &HashMap::new(),
            &mut sidecars,
            &who(),
        );
        assert_eq!(matched["files"][0]["file"], "request-frame-1.png");
        assert!(sidecars.is_empty());
    }

    #[test]
    fn raw_bytes_are_pointed_at_where_they_were_already_written() {
        let inputs = HashMap::from([(digest_hex(&[1, 2, 3]), "request-frame-1.png".to_string())]);
        let mut sidecars = Vec::new();
        let value = binary_value(
            &[1, 2, 3],
            1,
            "request",
            Some("image/png"),
            &inputs,
            &HashMap::new(),
            &mut sidecars,
        );
        assert_eq!(value["file"], "request-frame-1.png");
        assert!(sidecars.is_empty());
    }

    #[test]
    fn a_blob_nobody_can_open_is_described_rather_than_copied() {
        let mut sidecars = Vec::new();
        let value = binary_value(
            &[0, 1, 2, 3],
            1,
            "response",
            Some("application/octet-stream"),
            &HashMap::new(),
            &HashMap::new(),
            &mut sidecars,
        );
        assert_eq!(value["kind"], "binary");
        assert_eq!(value["bytes"], 4);
        assert!(value.get("file").is_none(), "there is nothing to open");
        assert!(sidecars.is_empty());
    }

    #[test]
    fn a_thought_is_gathered_whichever_way_the_provider_names_it() {
        let raw = b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think \"}}]}\n\n\
data: {\"type\":\"response.reasoning_text.delta\",\"delta\":\"more\"}\n\n\
data: {\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\" end\"}}\n\n\
data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"plan\",\"thought\":true}]}}]}\n\n\
[DONE]\n\n";
        assert_eq!(thinking_of_sse(raw), "think more endplan");
    }

    #[test]
    fn only_the_poll_that_ended_a_job_is_kept() {
        let placeholder = |seq: u64, kind: Kind| {
            let mut recorded = call(kind, Body::Empty, Body::Empty);
            recorded.seq = seq;
            recorded
        };
        let calls = vec![
            placeholder(1, Kind::TaskPoll),
            placeholder(2, Kind::TaskPoll),
            placeholder(3, Kind::Media),
        ];
        let kept = filter_polls(calls);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].kind, Kind::TaskPoll);
        assert_eq!(kept[0].seq, 2, "the last poll, not the first");
        assert_eq!(kept[1].kind, Kind::Media);
    }

    #[test]
    fn one_run_is_one_directory_of_readable_files() {
        let dir = tempfile::tempdir().expect("a directory to record into");
        let root = dir.path();
        let name = "2026-11-16T10-15-00.123Z_chan_painter_0001";
        let started = Job::Started {
            name: name.into(),
            request: json!({ "prompt": "a lantern", "capability": "image" }),
            inputs: vec![InputFile {
                name: "request-frame-1.png".into(),
                bytes: vec![1, 2, 3],
            }],
            index: json!({ "event": "start", "dir": name }),
        };
        write_one(root, started).expect("the request is written");

        let answer = GenerateResult {
            text: Some("A lantern.".into()),
            items: vec![GeneratedItem {
                bytes: vec![1, 2, 3],
                mime: "image/png".into(),
                kind: Capability::Image,
                width: Some(1),
                height: Some(1),
                duration_ms: None,
            }],
            ..GenerateResult::default()
        };
        let finished = Job::Finished(Box::new(FinishedJob {
            name: name.into(),
            who: who(),
            verdict: Verdict::Ok(answer),
            calls: vec![call(
                Kind::Generate,
                Body::Text(
                    json!({ "prompt": "a lantern", "image": "data:image/png;base64,AQID" })
                        .to_string(),
                ),
                Body::Text(json!({ "output_text": "A lantern." }).to_string()),
            )],
            digests: HashMap::from([(digest_hex(&[1, 2, 3]), "request-frame-1.png".to_string())]),
            request: None,
            index_start: None,
            index_finish: json!({ "event": "finish", "dir": name, "status": "ok" }),
            took: Duration::from_millis(12),
        }));
        write_one(root, finished).expect("the answer is written");

        let run = root.join(name);
        let request = read_json(&run, "request.json");
        assert_eq!(request["prompt"], "a lantern");
        assert_eq!(read(&run, "request-frame-1.png"), vec![1, 2, 3]);

        let calls = std::fs::read_to_string(run.join("calls.jsonl")).expect("the calls are there");
        let line: Value = serde_json::from_str(calls.trim()).expect("one JSON line");
        assert_eq!(line["request"]["image"]["file"], "request-frame-1.png");
        assert_eq!(line["response"]["output_text"], "A lantern.");

        let response = read_json(&run, "response.json");
        assert_eq!(response["ok"], true);
        assert_eq!(response["text"], "A lantern.");
        assert_eq!(response["media"][0]["file"], "response-1.png");
        assert_eq!(read(&run, "response.txt"), b"A lantern.");
        assert_eq!(read(&run, "response-1.png"), vec![1, 2, 3]);

        let index = std::fs::read_to_string(root.join("index.jsonl")).expect("an index");
        let lines: Vec<Value> = index
            .lines()
            .map(|line| serde_json::from_str(line).expect("one JSON line"))
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["event"], "start");
        assert_eq!(lines[1]["event"], "finish");
        assert_eq!(lines[1]["files"][0], "calls.jsonl");
    }

    #[test]
    fn a_failure_says_what_went_wrong_and_still_writes_the_request() {
        let dir = tempfile::tempdir().expect("a directory to record into");
        let root = dir.path();
        let name = "2026-11-16T10-15-00.123Z_chan_painter_0001";
        let finished = Job::Finished(Box::new(FinishedJob {
            name: name.into(),
            who: who(),
            verdict: Verdict::Err {
                code: "PROVIDER_RATE_LIMIT",
                message: "slow down, sk-secret-value-1234".into(),
                retryable: true,
            },
            calls: Vec::new(),
            digests: HashMap::new(),
            request: Some(json!({ "prompt": "a lantern" })),
            index_start: Some(json!({ "event": "start", "dir": name })),
            index_finish: json!({ "event": "finish", "dir": name, "status": "error" }),
            took: Duration::from_millis(12),
        }));
        write_one(root, finished).expect("the failure is written");

        let run = root.join(name);
        assert_eq!(read_json(&run, "request.json")["prompt"], "a lantern");
        let response = read_json(&run, "response.json");
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "PROVIDER_RATE_LIMIT");
        let message = response["error"]["message"].as_str().expect("a message");
        assert!(message.contains("slow down"));
        assert!(!message.contains("secret-value"), "the key is masked");
    }

    #[test]
    fn every_text_file_is_scrubbed_of_the_credential() {
        let dir = tempfile::tempdir().expect("a directory to record into");
        let root = dir.path();
        let name = "2026-11-16T10-15-00.123Z_chan_painter_0001";
        write_one(
            root,
            Job::Finished(Box::new(FinishedJob {
                name: name.into(),
                who: who(),
                verdict: Verdict::Ok(GenerateResult {
                    text: Some("a key echoed: sk-secret-value-1234".into()),
                    ..GenerateResult::default()
                }),
                calls: vec![call(
                    Kind::Generate,
                    Body::Text(r#"{"prompt":"a lantern"}"#.into()),
                    Body::Text(r#"{"error":"bad key sk-secret-value-1234"}"#.into()),
                )],
                digests: HashMap::new(),
                request: Some(json!({ "prompt": "a lantern" })),
                index_start: None,
                index_finish: json!({ "event": "finish", "dir": name }),
                took: Duration::from_millis(4),
            })),
        )
        .expect("the run is written");

        for entry in std::fs::read_dir(root.join(name)).expect("the directory is readable") {
            let path = entry.expect("an entry").path();
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            assert!(
                !text.contains("sk-secret-value-1234"),
                "{} leaks the credential",
                path.display()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_recording_is_readable_by_nobody_but_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("a directory to record into");
        let root = dir.path();
        let name = "2026-11-16T10-15-00.123Z_chan_painter_0001";
        write_one(
            root,
            Job::Started {
                name: name.into(),
                request: json!({ "prompt": "a lantern" }),
                inputs: Vec::new(),
                index: json!({ "event": "start", "dir": name }),
            },
        )
        .expect("the request is written");

        let run = root.join(name);
        assert_eq!(
            std::fs::metadata(&run)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(run.join("request.json"))
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
