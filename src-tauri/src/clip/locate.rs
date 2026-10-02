//! Finding the renderer, and asking it what it can do.
//!
//! Three places are looked in, in this order: the configured path, the
//! `MOKA_FFMPEG` environment variable, and the platform search path. One of
//! the first two naming a program is a decision, not a hint: a path that is
//! not there answers "unavailable" rather than quietly running a different
//! binary somebody else put on the path. That is also what makes a test
//! machine deterministic, where MOKA_FFMPEG points at a path that is never
//! there.
//!
//! Nothing here fails startup. A machine with no ffmpeg is a machine whose
//! export is unavailable: the process starts, the cutting room works, and the
//! dialog says what is missing.

use crate::config::ClipConfig;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

/// What a machine without a renderer is told. The whole sentence is what the
/// dialog shows, so it names every way out of the situation.
pub const UNAVAILABLE_REASON: &str =
    "ffmpeg was not found. Install it, set clip.ffmpegPath, or point MOKA_FFMPEG at it.";

/// The message when text cannot be burned in. It names the filter rather than
/// the program, because the program is there and the build is what is short.
pub const ASS_MISSING_REASON: &str =
    "This ffmpeg build has no ass filter, so text cannot be burned into the export.";

/// What the machine's ffmpeg can do, as the one place that says so.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipCapabilities {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The program that was found, for a reader who wants to know which one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    /// The H.264 encoder an export would be asked for, by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_encoder: Option<String>,
    /// Every `xfade` transition this build knows. Empty when unknown, which
    /// reads as "assume the modern set" rather than as "none of them".
    #[serde(default)]
    pub transitions: Vec<String>,
    /// Whether text can be burned in, which is whether `ass` is there.
    #[serde(default)]
    pub ass: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ClipCapabilities {
    /// What an unavailable renderer reports, with the full installation note.
    pub fn unavailable() -> Self {
        Self {
            available: false,
            version: None,
            path: None,
            video_encoder: None,
            transitions: Vec::new(),
            ass: false,
            reason: Some(UNAVAILABLE_REASON.to_string()),
        }
    }
}

/// The three-level search, with every input handed in so a test can drive it.
///
/// A level that names a path settles the question: the file is there or it is
/// not, and the search does not go on to find somebody else's ffmpeg.
pub fn locate(
    configured: Option<&Path>,
    from_env: Option<&Path>,
    path_var: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    if let Some(named) = configured {
        return named.is_file().then(|| named.to_path_buf());
    }
    if let Some(named) = from_env {
        return named.is_file().then(|| named.to_path_buf());
    }
    search_path(path_var)
}

/// The platform name of the program, which is what a search path holds.
fn program_names() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["ffmpeg.exe", "ffmpeg"]
    } else {
        vec!["ffmpeg"]
    }
}

/// Walks the search path for the program's own name.
fn search_path(path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let path_var = path_var?;
    for directory in std::env::split_paths(path_var) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        for name in program_names() {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The MOKA_FFMPEG variable, as a path.
pub fn env_program() -> Option<PathBuf> {
    std::env::var_os("MOKA_FFMPEG")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// Runs one probe and reads its output, or nothing when the program will not
/// run at all. Probes are small and synchronous, and there are four of them
/// once per process.
fn output_of(program: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Some(text)
}

/// The version token out of `ffmpeg -version`'s first line, e.g. `6.1.1`.
pub fn parse_version(output: &str) -> Option<String> {
    let line = output.lines().next()?;
    let rest = line.strip_prefix("ffmpeg version ")?;
    let token = rest.split_whitespace().next()?;
    (!token.is_empty()).then(|| token.to_string())
}

/// The `xfade` transition names out of `ffmpeg -h filter=xfade`.
///
/// Two spellings of the same list are read, because ffmpeg has printed it both
/// ways: the modern table of `name <int> ..FV.......` rows, and the older
/// sentence ending "Must be one of the following: custom, fade, …". A build
/// that does not know `zoomin` simply does not list it, which is how the
/// fallback in the plan hears about it.
pub fn parse_transitions(output: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for line in output.lines() {
        if let Some((_, tail)) = line.split_once("Must be one of the following:") {
            for name in tail.split(',') {
                push_transition(&mut names, name.trim());
            }
            continue;
        }
        let mut fields = line.split_whitespace();
        let Some(name) = fields.next() else { continue };
        let Some(_index) = fields
            .next()
            .filter(|field| field.chars().all(|ch| ch.is_ascii_digit()))
        else {
            continue;
        };
        let Some(flags) = fields.next() else { continue };
        if !flags.starts_with("..") {
            continue;
        }
        push_transition(&mut names, name);
    }
    names
}

/// Keeps a transition name that could be one, dropping the row header and the
/// help's prose — where the last name is followed by a colon rather than a
/// comma.
fn push_transition(names: &mut Vec<String>, name: &str) {
    let name = name.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
    let plausible = !name.is_empty()
        && name.chars().all(|ch| ch.is_ascii_alphanumeric())
        && !name.chars().all(|ch| ch.is_ascii_digit())
        && name != "transition";
    if plausible && !names.iter().any(|held| held == name) {
        names.push(name.to_string());
    }
}

/// Whether `ffmpeg -h filter=ass` describes a filter rather than an error.
pub fn parse_ass(output: &str) -> bool {
    if output.contains("Unknown filter") {
        return false;
    }
    output.contains("Burn subtitles")
        || output.contains("Filter ass")
        || output.lines().any(|line| line.trim() == "ass")
}

/// The H.264 encoder an export would use, by name: `libx264` first, then the
/// two hardware encoders that are asked for a bitrate rather than a quality.
pub fn parse_encoder(output: &str) -> Option<String> {
    const PREFERENCE: [&str; 3] = ["libx264", "h264_videotoolbox", "h264_nvenc"];
    for wanted in PREFERENCE {
        let found = output
            .lines()
            .any(|line| line.split_whitespace().any(|token| token == wanted));
        if found {
            return Some(wanted.to_string());
        }
    }
    None
}

/// Asks one program what it is and what it can do.
pub fn probe(program: &Path) -> ClipCapabilities {
    let Some(version_output) = output_of(program, &["-version"]) else {
        return ClipCapabilities::unavailable();
    };
    let version = parse_version(&version_output);
    if version.is_none() {
        // Something ran and did not answer as ffmpeg. Refusing here rather
        // than half-trusting it keeps the failure at the capability line
        // instead of at the end of a render.
        return ClipCapabilities::unavailable();
    }
    let transitions = output_of(program, &["-h", "filter=xfade"])
        .map(|output| parse_transitions(&output))
        .unwrap_or_default();
    let ass = output_of(program, &["-h", "filter=ass"])
        .map(|output| parse_ass(&output))
        .unwrap_or(false);
    let encoder = output_of(program, &["-encoders"]).and_then(|output| parse_encoder(&output));
    let Some(encoder) = encoder else {
        let mut caps = ClipCapabilities::unavailable();
        caps.version = version;
        caps.path = Some(program.to_path_buf());
        caps.reason = Some(
            "This ffmpeg build has no H.264 encoder, so a video cannot be written.".to_string(),
        );
        return caps;
    };
    ClipCapabilities {
        available: true,
        version,
        path: Some(program.to_path_buf()),
        video_encoder: Some(encoder),
        transitions,
        ass,
        reason: None,
    }
}

/// The resolved program and the one probe its process will ever make.
///
/// The path is settled when the state is built, because that is when the
/// configuration is read; the probe itself waits for the first request that
/// needs it, so a server nobody exports from never spawns anything.
#[derive(Debug)]
pub struct CapabilityProbe {
    program: Option<PathBuf>,
    cached: Mutex<Option<ClipCapabilities>>,
}

impl CapabilityProbe {
    pub fn new(config: &ClipConfig) -> Self {
        let program = locate(
            config.ffmpeg_path.as_deref(),
            env_program().as_deref(),
            std::env::var_os("PATH").as_deref(),
        );
        Self {
            program,
            cached: Mutex::new(None),
        }
    }

    /// The program every export of this process uses, once there is one.
    pub fn program(&self) -> Option<&Path> {
        self.program.as_deref()
    }

    /// What the renderer can do, probed once and remembered — a missing one
    /// is answered from memory too, so a machine without ffmpeg does not look
    /// for it on every request.
    pub fn capabilities(&self) -> ClipCapabilities {
        let mut cached = self.cached.lock().expect("a panic left this unlocked");
        if let Some(caps) = cached.as_ref() {
            return caps.clone();
        }
        let caps = match self.program.as_deref() {
            Some(program) => probe(program),
            None => ClipCapabilities::unavailable(),
        };
        *cached = Some(caps.clone());
        caps
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A recorded `-version` line, as a build really prints it.
    const VERSION_OUTPUT: &str =
        "ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers\n\
        built with Apple clang version 15.0.0\n";

    /// A recorded `-h filter=xfade` for a modern build, with `zoomin` in it.
    const XFADE_MODERN: &str = "\
Filter xfade\n\
  Cross fade one video with another video.\n\
    Inputs:\n\
       #0: main (video)\n\
    Options:\n\
    transition        <int>        ..FV....... set transition effect (from 0 to 57) (default fade)\n\
       custom          0            ..FV....... custom transition\n\
       fade            1            ..FV....... fade transition\n\
       wipeleft        2            ..FV....... wipe left transition\n\
       slideleft       3            ..FV....... slide left transition\n\
       slideup         4            ..FV....... slide up transition\n\
       zoomin          5            ..FV....... zoom in transition\n\
       fadeblack       6            ..FV....... fade to black transition\n\
       fadewhite       7            ..FV....... fade to white transition\n";

    /// A recorded `-h filter=xfade` for a build from before `zoomin` landed.
    const XFADE_OLD: &str = "\
Filter xfade\n\
  Cross fade one video with another video.\n\
    Options:\n\
    transition <int> ..FV....... set transition effect (from 0 to 12) (default fade)\n\
       fade 1 ..FV....... fade transition\n\
       wipeleft 2 ..FV....... wipe left transition\n\
       slideleft 3 ..FV....... slide left transition\n\
       slideup 4 ..FV....... slide up transition\n\
       fadeblack 5 ..FV....... fade to black transition\n\
       fadewhite 6 ..FV....... fade to white transition\n";

    /// The prose spelling an older release used for the same list.
    const XFADE_PROSE: &str = "\
Filter xfade\n\
  Cross fade one video with another video.\n\
  Transition effect type. Default is fade. Must be one of the following: custom, fade, \
  wipeleft, wiperight, slideleft, slideup, zoomin:\n";

    const ASS_PRESENT: &str = "\
Filter ass\n\
  Burn subtitles into video with libass.\n\
    Inputs:\n\
       #0: main (video)\n";

    const ASS_MISSING: &str = "Unknown filter 'ass'.\n";

    const ENCODERS: &str = "\
Encoders:\n\
 V..... = Video\n\
 ------\n\
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)\n\
 V....D libx265              libx265 H.265 / HEVC (codec hevc)\n";

    fn write_script(directory: &Path, name: &str, body: &str) -> PathBuf {
        // Written by a helper process so no descriptor of this process is
        // ever open on the file: a fork in any other thread would copy one,
        // and the exec that follows could answer ETXTBSY while the copy
        // lives.
        let path = directory.join(name);
        #[cfg(unix)]
        {
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
        }
        #[cfg(not(unix))]
        {
            let mut file = std::fs::File::create(&path).expect("script");
            file.write_all(body.as_bytes()).expect("script body");
        }
        path
    }

    #[test]
    fn a_version_line_yields_its_version_token() {
        assert_eq!(parse_version(VERSION_OUTPUT).as_deref(), Some("6.1.1"));
        assert_eq!(parse_version("not ffmpeg at all").as_deref(), None);
    }

    #[test]
    fn a_transition_table_is_read_name_by_name() {
        let names = parse_transitions(XFADE_MODERN);
        assert!(names.contains(&"zoomin".to_string()), "{names:?}");
        assert!(!names.contains(&"crossfade".to_string()));
        assert!(names.contains(&"fade".to_string()));
        assert!(names.contains(&"wipeleft".to_string()));
    }

    #[test]
    fn an_older_build_simply_lacks_zoomin() {
        // The fallback in the plan is decided from this list, so a missing
        // name has to be a missing name rather than an error.
        let names = parse_transitions(XFADE_OLD);
        assert!(names.contains(&"fade".to_string()));
        assert!(!names.contains(&"zoomin".to_string()), "{names:?}");
    }

    #[test]
    fn the_prose_spelling_of_the_list_is_read_too() {
        let names = parse_transitions(XFADE_PROSE);
        assert!(names.contains(&"zoomin".to_string()), "{names:?}");
        assert!(names.contains(&"wipeleft".to_string()));
    }

    #[test]
    fn an_ass_filter_is_told_from_an_unknown_one() {
        assert!(parse_ass(ASS_PRESENT));
        assert!(!parse_ass(ASS_MISSING));
    }

    #[test]
    fn the_encoder_is_chosen_by_name_in_order_of_preference() {
        assert_eq!(parse_encoder(ENCODERS).as_deref(), Some("libx264"));
        let hardware = " V....D h264_videotoolbox   VideoToolbox H.264 Encoder\n";
        assert_eq!(
            parse_encoder(hardware).as_deref(),
            Some("h264_videotoolbox")
        );
        let nvenc = " V....D h264_nvenc  NVIDIA NVENC H.264 encoder\n";
        assert_eq!(parse_encoder(nvenc).as_deref(), Some("h264_nvenc"));
        assert_eq!(parse_encoder(" V....D libx265  libx265\n"), None);
    }

    #[test]
    fn a_configured_path_wins_over_the_environment_and_the_path() {
        let root = tempfile::tempdir().unwrap();
        let configured = write_script(root.path(), "configured", "#!/bin/sh\nexit 0\n");
        let from_env = write_script(root.path(), "from-env", "#!/bin/sh\nexit 0\n");
        write_script(root.path(), "ffmpeg", "#!/bin/sh\nexit 0\n");

        let found = locate(
            Some(&configured),
            Some(&from_env),
            Some(root.path().as_os_str()),
        );
        assert_eq!(found.as_deref(), Some(configured.as_path()));
    }

    #[test]
    fn the_environment_is_next_and_the_search_path_is_last() {
        let root = tempfile::tempdir().unwrap();
        let env_dir = tempfile::tempdir().unwrap();
        let from_env = write_script(env_dir.path(), "ffmpeg", "#!/bin/sh\nexit 0\n");
        let on_path = write_script(root.path(), "ffmpeg", "#!/bin/sh\nexit 0\n");

        let found = locate(None, Some(&from_env), Some(root.path().as_os_str()));
        assert_eq!(found.as_deref(), Some(from_env.as_path()));

        let found = locate(None, None, Some(root.path().as_os_str()));
        assert_eq!(found.as_deref(), Some(on_path.as_path()));
    }

    #[test]
    fn a_named_path_that_is_not_there_does_not_fall_through() {
        // The whole point of naming one is that this one is meant: a machine
        // with a different ffmpeg on its search path must not run it instead.
        let root = tempfile::tempdir().unwrap();
        let on_path = write_script(root.path(), "ffmpeg", "#!/bin/sh\nexit 0\n");
        let missing = root.path().join("nowhere/ffmpeg");
        assert_eq!(
            locate(Some(&missing), None, Some(root.path().as_os_str())),
            None
        );
        assert_eq!(
            locate(None, Some(&missing), Some(root.path().as_os_str())),
            None
        );
        // And with nothing named, the search path answers as it always did.
        assert_eq!(
            locate(None, None, Some(root.path().as_os_str())).as_deref(),
            Some(on_path.as_path())
        );
    }

    #[test]
    fn a_probe_of_a_real_script_reads_every_answer() {
        let root = tempfile::tempdir().unwrap();
        // A stand-in that answers each question the way a real build would.
        let script = write_script(
            root.path(),
            "ffmpeg",
            &format!(
                "#!/bin/sh\n\
                 case \"$*\" in\n\
                 *\"-version\"*) printf '%b' \"{version}\" ;;\n\
                 *\"filter=xfade\"*) printf '%b' \"{xfade}\" ;;\n\
                 *\"filter=ass\"*) printf '%b' \"{ass}\" ;;\n\
                 *\"-encoders\"*) printf '%b' \"{encoders}\" ;;\n\
                 esac\nexit 0\n",
                version = VERSION_OUTPUT.replace('\n', "\\n").replace('"', "\\\""),
                xfade = XFADE_MODERN.replace('\n', "\\n").replace('"', "\\\""),
                ass = ASS_PRESENT.replace('\n', "\\n").replace('"', "\\\""),
                encoders = ENCODERS.replace('\n', "\\n").replace('"', "\\\""),
            ),
        );
        let caps = probe(&script);
        assert!(caps.available);
        assert_eq!(caps.version.as_deref(), Some("6.1.1"));
        assert_eq!(caps.video_encoder.as_deref(), Some("libx264"));
        assert!(caps.ass);
        assert!(caps.transitions.contains(&"zoomin".to_string()));
        assert_eq!(caps.path.as_deref(), Some(script.as_path()));
    }

    #[test]
    fn a_probe_of_something_that_is_not_ffmpeg_is_unavailable() {
        let root = tempfile::tempdir().unwrap();
        let script = write_script(root.path(), "junk", "#!/bin/sh\necho hello\n");
        let caps = probe(&script);
        assert!(!caps.available);
        assert_eq!(caps.reason.as_deref(), Some(UNAVAILABLE_REASON));
    }
}
