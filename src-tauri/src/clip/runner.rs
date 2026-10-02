//! Placing the renderer, following it, and cleaning up after it.
//!
//! The scratch directory is created here and removed here, on every way out:
//! a render that failed, was cancelled, or ran out of its budget leaves
//! nothing behind, and neither does one that succeeded once its artifact has
//! been taken away. The process is killed rather than asked to stop — the
//! whole group of it, since the program may be a wrapper holding the pipes
//! with children of its own — and it is killed by being dropped too, so a
//! server that goes away does not leave an encoder running.
//!
//! The progress pipe is read in ffmpeg's own units: `out_time_ms` is
//! microseconds. That is a historical quirk of the progress protocol and the
//! one thing about it worth writing down twice.

use super::plan::num;
use super::PlanInput;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

/// The file the renderer writes inside the scratch directory.
pub const OUTPUT_FILE: &str = "out.mp4";
/// The burn-in script; the graph names it the same way.
pub const ASS_FILE: &str = "subs.ass";
/// How much of a failure's own words are kept for the message.
pub const MESSAGE_LIMIT: usize = 2_000;

/// Everything one render is placed with.
#[derive(Debug, Clone)]
pub struct RunSpec {
    pub program: PathBuf,
    pub inputs: Vec<PlanInput>,
    pub graph: String,
    pub ass: Option<String>,
    pub duration_ms: i64,
    pub fps: i32,
    pub encoder: String,
    pub audio: bool,
    /// The scratch directory: created here, and removed when the artifact goes.
    pub temp_dir: PathBuf,
    pub timeout: Duration,
}

/// How a render ended when it did not end well.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// Stopped because the reader asked for it.
    Cancelled,
    /// Stopped because it ran past its budget.
    TimedOut(String),
    /// Ended on its own with something to say.
    Failed(String),
    /// Never started, or its pipes could not be read.
    Unstartable(String),
}

impl RunError {
    /// The message a client reads.
    pub fn message(&self) -> String {
        match self {
            Self::Cancelled => "The export was cancelled.".to_string(),
            Self::TimedOut(message) | Self::Failed(message) | Self::Unstartable(message) => {
                message.clone()
            }
        }
    }
}

/// A finished render's file, and the scratch directory holding it. The
/// directory goes when this does, so the artifact has to be taken away — filed
/// into the project — before the guard is dropped.
#[derive(Debug)]
pub struct Artifact {
    pub path: PathBuf,
    dir: Scratch,
}

impl Artifact {
    pub fn dir(&self) -> &Path {
        &self.dir.0
    }
}

/// A directory that removes itself.
#[derive(Debug)]
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One line of the progress pipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressLine {
    /// The renderer's own clock. Microseconds, despite the name it is sent under.
    OutTimeUs(i64),
    /// The renderer has finished.
    End,
    /// Anything else the protocol sends, which is nothing to this side.
    Ignored,
}

/// Reads one progress line.
pub fn parse_progress_line(line: &str) -> ProgressLine {
    let line = line.trim();
    if line == "progress=end" {
        return ProgressLine::End;
    }
    for key in ["out_time_ms=", "out_time_us="] {
        if let Some(value) = line.strip_prefix(key) {
            // Both keys carry microseconds in every build that prints either;
            // what the protocol calls milliseconds is the older spelling.
            return match value.trim().parse::<i64>() {
                Ok(micros) => ProgressLine::OutTimeUs(micros),
                Err(_) => ProgressLine::Ignored,
            };
        }
    }
    ProgressLine::Ignored
}

/// The share of a render that a moment means, held inside 0..1.
pub fn progress01(out_time_us: i64, duration_ms: i64) -> f64 {
    if duration_ms <= 0 {
        return 1.0;
    }
    let total = duration_ms as f64 * 1_000.0;
    (out_time_us as f64 / total).clamp(0.0, 1.0)
}

/// Runs one render to its end, following its progress.
///
/// The artifact must be taken away before it is dropped; a render that failed
/// leaves nothing at all.
pub async fn run(
    spec: RunSpec,
    cancel: oneshot::Receiver<()>,
    on_progress: impl Fn(f64) + Send + Sync + 'static,
) -> Result<Artifact, RunError> {
    std::fs::create_dir_all(&spec.temp_dir)
        .map_err(|error| RunError::Unstartable(error.to_string()))?;
    let scratch = Scratch(spec.temp_dir.clone());
    if let Some(ass) = &spec.ass {
        std::fs::write(spec.temp_dir.join(ASS_FILE), ass.as_bytes())
            .map_err(|error| RunError::Unstartable(error.to_string()))?;
        // The faces travel beside the script and are named by the graph: the
        // renderer resolves them from this directory rather than from
        // whatever the machine happens to have installed.
        super::fonts::install(&spec.temp_dir.join(super::fonts::FONTS_DIR)).map_err(|error| {
            RunError::Unstartable(format!("Could not write the burn-in fonts: {error}"))
        })?;
    }
    let args = ffmpeg_args(&spec);
    run_command(
        &spec.program,
        &args,
        &spec.temp_dir,
        spec.duration_ms,
        spec.timeout,
        cancel,
        on_progress,
    )
    .await?;

    let path = spec.temp_dir.join(OUTPUT_FILE);
    if !path.is_file() {
        return Err(RunError::Failed(
            "The renderer finished without writing a file.".to_string(),
        ));
    }
    Ok(Artifact { path, dir: scratch })
}

/// Runs one process and follows it.
///
/// Split from `run` so a test can hand it a stand-in that knows nothing about
/// graphs: what is being followed is a process and its pipes, whoever wrote it.
pub async fn run_command(
    program: &Path,
    args: &[String],
    cwd: &Path,
    duration_ms: i64,
    timeout: Duration,
    cancel: oneshot::Receiver<()>,
    on_progress: impl Fn(f64) + Send + Sync + 'static,
) -> Result<(), RunError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A server that goes away must not leave an encoder behind.
        .kill_on_drop(true);
    // A group of its own, so stopping the renderer stops whatever it spawned:
    // killing the child alone would leave a wrapper's own children holding
    // the pipes open and the readers waiting them out.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| RunError::Unstartable(format!("Could not run ffmpeg: {error}")))?;
    let mut group = GroupGuard::new(&child);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RunError::Unstartable("The renderer's output was not readable.".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| {
        RunError::Unstartable("The renderer's error output was not readable.".into())
    })?;
    let progress = tokio::spawn(read_progress(stdout, duration_ms, on_progress));
    let errors = tokio::spawn(read_stderr(stderr));

    let mut cancel = cancel;
    enum Ending {
        Exited(std::process::ExitStatus),
        Cancelled,
        TimedOut,
    }
    let ending = tokio::select! {
        status = child.wait() => match status {
            Ok(status) => Ending::Exited(status),
            Err(error) => return Err(RunError::Unstartable(error.to_string())),
        },
        _ = &mut cancel => Ending::Cancelled,
        _ = tokio::time::sleep(timeout) => Ending::TimedOut,
    };
    let ending = match ending {
        Ending::Exited(status) => {
            group.disarm();
            Ending::Exited(status)
        }
        Ending::Cancelled => {
            stop(&mut child).await;
            group.disarm();
            Ending::Cancelled
        }
        Ending::TimedOut => {
            stop(&mut child).await;
            group.disarm();
            Ending::TimedOut
        }
    };

    // The readers end when the pipes close, which stopping the process does.
    let _ = progress.await;
    let message = errors.await.unwrap_or_default();
    match ending {
        Ending::Exited(status) if status.success() => Ok(()),
        Ending::Exited(status) => Err(RunError::Failed(failure_message(&message, status))),
        Ending::Cancelled => Err(RunError::Cancelled),
        Ending::TimedOut => Err(RunError::TimedOut(format!(
            "Export ran too long and was stopped ({} seconds).",
            timeout.as_secs()
        ))),
    }
}

/// Kills the process and waits for it, so nothing is left running or half-read.
pub(crate) async fn stop(child: &mut tokio::process::Child) {
    // The whole group, not just the child: the pipes close for good when
    // everything the renderer started is gone.
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        kill_group(pid as i32);
    }
    // And the child itself, which covers the moment before it has joined the
    // group; a second kill lands on a process already gone and is ignored.
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// Kills the whole process group until the run's ending has been seen.
///
/// Dropping the child alone kills the child; a wrapper's own children would
/// live on, holding the pipes and running an encoder the server no longer
/// follows. Disarmed once the child has been reaped, since from then on
/// nothing in the group is this run's to end — and the id may yet be reused.
pub(crate) struct GroupGuard {
    #[cfg(unix)]
    pgid: Option<i32>,
}

impl GroupGuard {
    pub(crate) fn new(child: &tokio::process::Child) -> Self {
        #[cfg(unix)]
        {
            Self {
                pgid: child.id().map(|pid| pid as i32),
            }
        }
        #[cfg(not(unix))]
        {
            let _ = child;
            Self {}
        }
    }

    pub(crate) fn disarm(&mut self) {
        #[cfg(unix)]
        {
            self.pgid = None;
        }
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pgid) = self.pgid {
            kill_group(pgid);
        }
    }
}

/// Kills every process in one group, the leader included.
#[cfg(unix)]
fn kill_group(pgid: i32) {
    // An id that no longer names a live group is answered with `ESRCH`; there
    // is nothing else this call can disturb.
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
}

/// Reads the progress pipe, reporting every moment the renderer sends.
async fn read_progress<R: AsyncRead + Unpin>(
    reader: R,
    duration_ms: i64,
    on_progress: impl Fn(f64),
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        match parse_progress_line(&line) {
            ProgressLine::OutTimeUs(micros) => on_progress(progress01(micros, duration_ms)),
            ProgressLine::End => on_progress(1.0),
            ProgressLine::Ignored => {}
        }
    }
}

/// Collects the renderer's own words, bounded: an encoder can be extremely
/// talkative and a log is not a message.
pub(crate) async fn read_stderr<R: AsyncRead + Unpin>(mut reader: R) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4_096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                bytes.extend_from_slice(&buffer[..read]);
                if bytes.len() > MESSAGE_LIMIT * 4 {
                    // Keep the tail: ffmpeg's summary is what it says last.
                    let keep = bytes.len() - MESSAGE_LIMIT;
                    bytes.drain(..keep);
                }
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// What a failed render is reported with: its own last words, cut to length.
fn failure_message(stderr: &str, status: std::process::ExitStatus) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return format!("The renderer stopped with {status}.");
    }
    tail_message(trimmed, MESSAGE_LIMIT)
}

/// The end of a message, with a mark where it was cut.
pub fn tail_message(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_string();
    }
    let keep = limit.saturating_sub(1);
    let tail: String = chars[chars.len() - keep..].iter().collect();
    format!("…{tail}")
}

/// The complete argument list one render is placed with, in order.
pub fn ffmpeg_args(spec: &RunSpec) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-y".into(),
    ];
    for input in &spec.inputs {
        if input.image {
            // A still picture is read once and held; the graph asks for the
            // window it needs.
            args.push("-loop".into());
            args.push("1".into());
        }
        if let Some(seek) = input.seek_ms {
            args.push("-ss".into());
            args.push(num(seek as f64 / 1000.0));
        }
        if let Some(duration) = input.duration_ms {
            args.push("-t".into());
            args.push(num(duration as f64 / 1000.0));
        }
        args.push("-i".into());
        args.push(input.path.to_string_lossy().into_owned());
    }
    // The graph travels as the argument itself: the newest ffmpeg builds no
    // longer read it from a file (`-filter_complex_script` is gone), and it
    // holds nothing but fixed spellings and names relative to the working
    // directory the command is placed in.
    args.push("-filter_complex".into());
    args.push(spec.graph.clone());
    args.push("-map".into());
    args.push("[vout]".into());
    if spec.audio {
        args.push("-map".into());
        args.push("[aout]".into());
    }
    args.push("-t".into());
    args.push(num(spec.duration_ms as f64 / 1000.0));
    args.push("-r".into());
    args.push(spec.fps.to_string());
    args.push("-c:v".into());
    args.push(spec.encoder.clone());
    args.extend(encoder_args(&spec.encoder));
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-movflags".into());
    args.push("+faststart".into());
    if spec.audio {
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
    }
    args.push(OUTPUT_FILE.into());
    args
}

/// The encoder's own parameters, which differ by family: the software encoder
/// is asked for a quality, and the two hardware ones do not take one — they
/// are asked for a bitrate instead.
pub fn encoder_args(encoder: &str) -> Vec<String> {
    match encoder {
        "libx264" => ["-preset", "medium", "-crf", "18"]
            .iter()
            .map(|value| value.to_string())
            .collect(),
        _ => ["-b:v", "12M"]
            .iter()
            .map(|value| value.to_string())
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[test]
    fn the_progress_pipe_counts_in_microseconds() {
        assert_eq!(
            parse_progress_line("out_time_ms=500000"),
            ProgressLine::OutTimeUs(500_000)
        );
        assert_eq!(
            parse_progress_line("out_time_us=250000"),
            ProgressLine::OutTimeUs(250_000)
        );
        assert_eq!(parse_progress_line("progress=end"), ProgressLine::End);
        assert_eq!(
            parse_progress_line("progress=continue"),
            ProgressLine::Ignored
        );
        assert_eq!(
            parse_progress_line("out_time=00:00:01.000000"),
            ProgressLine::Ignored
        );
        assert_eq!(
            parse_progress_line("out_time_ms=not a number"),
            ProgressLine::Ignored
        );
        assert_eq!(parse_progress_line("frame=12"), ProgressLine::Ignored);

        // Half a second of a one-second render, in the unit the field really
        // carries: 500000 microseconds.
        assert_eq!(progress01(500_000, 1_000), 0.5);
        assert_eq!(progress01(2_000_000, 1_000), 1.0, "clamped at the end");
        assert_eq!(progress01(-100, 1_000), 0.0, "and at the head");
        assert_eq!(progress01(500_000, 0), 1.0, "a cut of no length is done");
    }

    #[test]
    fn a_message_keeps_its_own_tail_when_it_is_cut_to_length() {
        assert_eq!(tail_message("short", 10), "short");
        let long = "x".repeat(50) + "the real reason";
        let cut = tail_message(&long, 20);
        assert_eq!(cut.chars().count(), 20);
        assert!(cut.ends_with("the real reason"), "{cut}");
        assert!(cut.starts_with('…'), "{cut}");
    }

    #[test]
    fn the_encoder_branch_asks_for_quality_rather_than_bitrate() {
        assert_eq!(
            encoder_args("libx264"),
            vec!["-preset", "medium", "-crf", "18"]
        );
        // The hardware encoders do not take the software encoder's private
        // options; they are asked for a bitrate instead.
        assert_eq!(encoder_args("h264_videotoolbox"), vec!["-b:v", "12M"]);
        assert_eq!(encoder_args("h264_nvenc"), vec!["-b:v", "12M"]);
    }

    fn spec(program: PathBuf, temp_dir: PathBuf, audio: bool) -> RunSpec {
        RunSpec {
            program,
            inputs: vec![PlanInput {
                path: PathBuf::from("/tmp/does-not-matter.mp4"),
                seek_ms: Some(500),
                duration_ms: Some(2_000),
                image: false,
                shared: false,
                has_audio: audio,
            }],
            graph: "color=c=#000000:s=1920x1080:r=30:d=2,format=yuv420p[vout]\n".to_string(),
            ass: None,
            duration_ms: 2_000,
            fps: 30,
            encoder: "libx264".to_string(),
            audio,
            temp_dir,
            timeout: Duration::from_secs(10),
        }
    }

    #[test]
    fn the_command_hands_the_window_to_the_input_and_asks_for_a_quality() {
        let spec = spec(
            PathBuf::from("/usr/bin/ffmpeg"),
            PathBuf::from("/tmp"),
            true,
        );
        let args = ffmpeg_args(&spec);
        let joined = args.join(" ");
        assert!(joined.contains("-ss 0.5 -t 2 -i /tmp/does-not-matter.mp4"));
        // The graph is the argument after the option, not a file beside it:
        // the newest ffmpeg builds have no script-file spelling left.
        let at = args
            .iter()
            .position(|arg| arg == "-filter_complex")
            .expect("the graph is handed over");
        assert_eq!(args[at + 1], spec.graph);
        assert!(!joined.contains("filter_complex_script"), "{joined}");
        assert!(joined.contains("-map [vout]"));
        assert!(joined.contains("-map [aout]"));
        assert!(joined.contains("-t 2 -r 30"));
        assert!(joined.contains("-c:v libx264 -preset medium -crf 18"));
        assert!(joined.contains("-pix_fmt yuv420p -movflags +faststart"));
        assert!(joined.contains("-c:a aac -b:a 192k"));
        assert!(joined.ends_with("out.mp4"));

        let hardware = RunSpec {
            encoder: "h264_nvenc".to_string(),
            audio: false,
            ..spec
        };
        let joined = ffmpeg_args(&hardware).join(" ");
        assert!(joined.contains("-c:v h264_nvenc -b:v 12M"));
        assert!(!joined.contains("-crf"), "{joined}");
        assert!(!joined.contains("[aout]"), "nothing to map: {joined}");
    }

    /// A stand-in for the renderer: it answers the progress protocol and
    /// writes the artifact where the real one would.
    #[cfg(unix)]
    fn write_script(directory: &Path, name: &str, body: &str) -> PathBuf {
        use std::io::Write;
        let path = directory.join(name);
        let mut file = std::fs::File::create(&path).expect("script");
        file.write_all(body.as_bytes()).expect("script body");
        drop(file);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("script is executable");
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_is_followed_to_its_artifact_and_leaves_nothing_behind() {
        let root = tempfile::tempdir().unwrap();
        let script = write_script(
            root.path(),
            "fake-ffmpeg.sh",
            "#!/bin/sh\n\
             printf '%s\\n' \"$@\" > args.txt\n\
             printf 'out_time_ms=500000\\nprogress=continue\\n'\n\
             printf 'out_time_ms=1000000\\nprogress=continue\\n'\n\
             printf 'progress=continue\\nout_time_ms=1500000\\n'\n\
             printf 'progress=end\\n'\n\
             printf 'artifact' > out.mp4\n\
             exit 0\n",
        );
        let temp_dir = root.path().join("export-1");
        let spec = spec(script, temp_dir.clone(), false);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        let (_cancel, cancel_rx) = oneshot::channel();
        let artifact = run(spec, cancel_rx, move |progress01| {
            recorder.lock().unwrap().push(progress01);
        })
        .await
        .expect("the stand-in answers");

        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen, vec![0.25, 0.5, 0.75, 1.0], "{seen:?}");
        assert!(
            seen.windows(2).all(|pair| pair[0] <= pair[1]),
            "progress never goes backwards: {seen:?}"
        );
        // What the renderer was handed is the plan's own graph, as the
        // argument itself rather than a file beside it.
        let handed = std::fs::read_to_string(temp_dir.join("args.txt")).expect("the arguments");
        assert!(handed.contains("-filter_complex\n"), "{handed}");
        assert!(
            handed.contains("color=c=#000000:s=1920x1080:r=30:d=2,format=yuv420p[vout]"),
            "{handed}"
        );
        assert!(!handed.contains("filter_complex_script"), "{handed}");
        assert_eq!(std::fs::read(&artifact.path).unwrap(), b"artifact");

        // The scratch directory leaves with the artifact, once it has been
        // taken away.
        let held = artifact.dir().to_path_buf();
        drop(artifact);
        assert!(!held.exists(), "the scratch directory is gone");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_that_fails_reports_its_own_last_words() {
        let root = tempfile::tempdir().unwrap();
        let script = write_script(
            root.path(),
            "fake-fail.sh",
            "#!/bin/sh\n\
             printf 'out_time_ms=250000\\nprogress=continue\\n'\n\
             printf 'the encoder gave up on frame 3\\n' >&2\n\
             exit 1\n",
        );
        let temp_dir = root.path().join("export-2");
        let spec = spec(script, temp_dir.clone(), false);
        let (_cancel, cancel_rx) = oneshot::channel();
        let error = run(spec, cancel_rx, |_| {}).await.unwrap_err();
        match error {
            RunError::Failed(message) => {
                assert!(message.contains("gave up on frame 3"), "{message}");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
        assert!(!temp_dir.exists(), "a failed render leaves no scratch");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_with_words_gets_its_script_and_faces_beside_it() {
        // The renderer resolves the burn-in's faces from its working
        // directory, so both the script and the faces have to be there before
        // it starts — and the faces are the bundled ones, not the machine's.
        let root = tempfile::tempdir().unwrap();
        let script = write_script(
            root.path(),
            "fake-ffmpeg.sh",
            "#!/bin/sh\n\
             ls fonts > fonts.txt\n\
             printf 'progress=end\\n'\n\
             printf 'artifact' > out.mp4\n\
             exit 0\n",
        );
        let temp_dir = root.path().join("export-fonts");
        let spec = RunSpec {
            ass: Some("[Script Info]\n".to_string()),
            ..spec(script, temp_dir.clone(), false)
        };
        let (_cancel, cancel_rx) = oneshot::channel();
        let artifact = run(spec, cancel_rx, |_| {})
            .await
            .expect("the stand-in answers");
        let listing = std::fs::read_to_string(temp_dir.join("fonts.txt")).expect("the listing");
        assert!(listing.contains("Inter-Regular.ttf"), "{listing}");
        assert!(listing.contains("NotoSansSC-Regular.ttf"), "{listing}");
        assert!(temp_dir.join(ASS_FILE).is_file(), "the script is there too");
        drop(artifact);
        assert!(!temp_dir.exists(), "the faces leave with the scratch");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_that_is_cancelled_is_stopped_rather_than_waited_for() {
        let root = tempfile::tempdir().unwrap();
        let (cancel, cancel_rx) = oneshot::channel();
        let cwd = root.path().to_path_buf();
        let started = Instant::now();
        let handle = tokio::spawn(async move {
            run_command(
                Path::new("sh"),
                &["-c".to_string(), "sleep 5".to_string()],
                &cwd,
                1_000,
                Duration::from_secs(60),
                cancel_rx,
                |_| {},
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        cancel.send(()).expect("the follower is still there");
        let error = handle
            .await
            .expect("the follower did not panic")
            .unwrap_err();
        assert_eq!(error, RunError::Cancelled);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the process was killed rather than waited out: {:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_that_runs_too_long_is_stopped_and_says_so() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().to_path_buf();
        let started = Instant::now();
        let (_cancel, cancel_rx) = oneshot::channel();
        let error = run_command(
            Path::new("sh"),
            &["-c".to_string(), "sleep 5".to_string()],
            &cwd,
            1_000,
            Duration::from_millis(200),
            cancel_rx,
            |_| {},
        )
        .await
        .unwrap_err();
        match error {
            RunError::TimedOut(message) => {
                assert!(message.contains("ran too long"), "{message}");
            }
            other => panic!("expected a timeout, got {other:?}"),
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the process was killed rather than waited out: {:?}",
            started.elapsed()
        );
    }
}
