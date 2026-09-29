//! A film's sound on its own, for the player that only wants to hear it.
//!
//! A clip's sound comes from the file its picture does — usually a whole
//! 27–37MB recording — and a media element pointed at it reads the file
//! through to keep its sound: dozens of small range requests a second while
//! the preview is reading the same file for its frames. What this makes is the
//! same sound alone in a file of its own, kept beside the project's other
//! derived bytes under `cache/audio/`, so the room's voices read a few hundred
//! kilobytes instead of a whole picture file.
//!
//! The work is a stream copy: nothing is decoded or re-encoded when the source
//! already carries a codec the container takes, and a sound that will not copy
//! is written once as AAC rather than left unplayable. A machine without a
//! renderer, a file without sound, or anything else that will not answer is
//! answered with the file itself — the same bytes the voice read before any of
//! this existed.

use crate::clip::runner::{tail_message, MESSAGE_LIMIT};
use crate::domain::ResourceEntry;
use crate::project::ProjectError;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long one rendition may take: a copy of minutes of sound with the demux
/// of the whole source behind it, generously.
const RENDITION_TIMEOUT: Duration = Duration::from_secs(120);

/// Where a project keeps the sound it has taken out of its films.
pub fn cache_dir(root: &Path) -> PathBuf {
    root.join("cache").join("audio")
}

/// Where one file's sound lives, when it can be keyed.
///
/// The key is the digest the entry carries rather than a time: a file that was
/// replaced has a new digest, so its sound is a new rendition and the old one
/// is only a file nothing will ask for again.
pub fn cached_path(root: &Path, entry: &ResourceEntry) -> Option<PathBuf> {
    let sha = entry.sha256.as_deref()?;
    let key = sha.get(..8)?;
    Some(cache_dir(root).join(format!("{}-{key}.m4a", entry.id)))
}

/// The sound of a file on its own, made if it is not there yet.
///
/// Answers with the file to serve: the rendition when one could be made, and
/// the file itself when it could not — nothing to key a rendition on, no
/// renderer on the machine, or a run of the renderer that failed for any
/// reason at all. A caller cannot tell the two apart by design: what it is
/// handed is the smallest file that plays the sound.
pub async fn audio_for(
    root: &Path,
    entry: &ResourceEntry,
    source: &Path,
    program: Option<&Path>,
) -> Result<PathBuf, ProjectError> {
    let Some(cached) = cached_path(root, entry) else {
        return Ok(source.to_path_buf());
    };
    if cached.is_file() {
        return Ok(cached);
    }
    let Some(program) = program else {
        return Ok(source.to_path_buf());
    };
    let Some(dir) = cached.parent() else {
        return Ok(source.to_path_buf());
    };
    std::fs::create_dir_all(dir)?;
    // A file of this process's own making, beside the key it is for; two
    // requests for one rendition write two files and the rename keeps one.
    let scratch = dir.join(format!("rendition-{}.m4a", crate::domain::new_id()));
    let outcome = run(program, &copy_args(source, &scratch)).await;
    // A sound the container will not hold as it stands — PCM, AC-3 — is
    // written the one way every player reads rather than left as it was.
    let outcome = match outcome {
        Ok(()) => Ok(()),
        Err(_) => run(program, &aac_args(source, &scratch)).await,
    };
    match outcome {
        Ok(()) => {
            if let Err(error) = std::fs::rename(&scratch, &cached) {
                let _ = std::fs::remove_file(&scratch);
                return Err(error.into());
            }
            Ok(cached)
        }
        Err(_) => {
            let _ = std::fs::remove_file(&scratch);
            Ok(source.to_path_buf())
        }
    }
}

/// Runs one rendition and waits for it, or gives up on the clock.
async fn run(program: &Path, args: &[String]) -> Result<(), String> {
    let ran = tokio::time::timeout(
        RENDITION_TIMEOUT,
        tokio::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| format!("took longer than {} seconds", RENDITION_TIMEOUT.as_secs()))?
    .map_err(|error| format!("could not run it: {error}"))?;
    if ran.status.success() {
        return Ok(());
    }
    Err(tail_message(
        String::from_utf8_lossy(&ran.stderr).trim(),
        MESSAGE_LIMIT,
    ))
}

/// The command a sound is taken out with when the copy may work.
///
/// The output format is named outright rather than left to the extension,
/// because the name is this process's own; the faststart flag puts the index
/// at the front, which is what lets the element that reads it begin with the
/// first request instead of one at either end of the file.
pub fn copy_args(source: &Path, into: &Path) -> Vec<String> {
    args(source, into, &["-c:a", "copy"])
}

/// The same, for a sound the container will not take as it stands.
pub fn aac_args(source: &Path, into: &Path) -> Vec<String> {
    args(source, into, &["-c:a", "aac", "-b:a", "192k"])
}

fn args(source: &Path, into: &Path, codec: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        &source.to_string_lossy(),
        // No picture, and the first sound track when a file carries more than
        // one: what a room's voice reads is the sound the film plays.
        "-vn",
        "-map",
        "0:a:0",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    args.extend(codec.iter().map(|arg| arg.to_string()));
    args.extend(
        ["-movflags", "+faststart", "-f", "ipod"]
            .iter()
            .map(|arg| arg.to_string()),
    );
    args.push(into.to_string_lossy().into_owned());
    args
}

#[cfg(test)]
mod tests {
    use super::{aac_args, audio_for, cache_dir, cached_path, copy_args};
    use crate::domain::ResourceEntry;
    use std::path::{Path, PathBuf};

    fn entry(id: &str, sha: Option<&str>) -> ResourceEntry {
        ResourceEntry {
            id: id.to_string(),
            name: "act video.mp4".into(),
            path: format!("assets/videos/{id}.mp4"),
            mime: Some("video/mp4".into()),
            bytes: Some(1024),
            sha256: sha.map(str::to_string),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            probe: None,
            provenance: None,
            tags: None,
            note: None,
            favorite: None,
            origin: None,
            keyword: None,
        }
    }

    fn source_file(root: &Path) -> PathBuf {
        let source = root.join("act.mp4");
        std::fs::write(&source, b"a film with its sound inside").unwrap();
        source
    }

    /// A renderer that writes a stub rendition where the command says to.
    ///
    /// `fail_first` makes the first run fail the way a sound the container
    /// will not copy does, so the retry is what gets to write.
    #[cfg(unix)]
    fn write_script(root: &Path, name: &str, body: &str) -> PathBuf {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let path = root.join(name);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn a_rendition_is_keyed_by_the_digest_and_ends_in_m4a() {
        let root = Path::new("/tmp/project");
        let keyed = cached_path(root, &entry("01a0ea83-37dd", Some("0123456789abcdef"))).unwrap();
        assert!(keyed.ends_with("01a0ea83-37dd-01234567.m4a"), "{keyed:?}");
        assert!(cached_path(root, &entry("a1", None)).is_none());
        assert_eq!(cache_dir(root), root.join("cache").join("audio"));
    }

    #[test]
    fn the_copy_comes_first_and_the_re_encode_is_the_retry() {
        let source = Path::new("/proj/assets/videos/a.mp4");
        let into = Path::new("/proj/cache/audio/rendition.m4a");
        let copy = copy_args(source, into);
        assert!(copy.windows(2).any(|pair| pair == ["-c:a", "copy"]));
        assert!(copy.windows(2).any(|pair| pair == ["-f", "ipod"]));
        assert!(copy.iter().any(|arg| arg == "-map"));
        assert_eq!(copy.last().unwrap(), &into.to_string_lossy());
        let aac = aac_args(source, into);
        assert!(aac.windows(2).any(|pair| pair == ["-c:a", "aac"]));
    }

    #[tokio::test]
    async fn without_a_renderer_the_file_itself_is_answered() {
        let root = tempfile::tempdir().unwrap();
        let source = source_file(root.path());
        let filed = entry("a1", Some("0123456789abcdef"));
        let answered = audio_for(root.path(), &filed, &source, None).await.unwrap();
        assert_eq!(answered, source);
        assert!(!cache_dir(root.path()).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_rendition_is_made_once_and_then_read_from_the_cache() {
        let root = tempfile::tempdir().unwrap();
        let source = source_file(root.path());
        let ran = root.path().join("ran.txt");
        let program = write_script(
            root.path(),
            "ffmpeg",
            &format!(
                "#!/bin/sh\nprintf 'run\\n' >> {}\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\nprintf 'M4A ' > \"$out\"\n",
                ran.display()
            ),
        );
        let filed = entry("a1", Some("0123456789abcdef"));

        let made = audio_for(root.path(), &filed, &source, Some(&program))
            .await
            .unwrap();
        assert!(made.ends_with("a1-01234567.m4a"), "{made:?}");
        assert_eq!(std::fs::read(&made).unwrap(), b"M4A ");
        assert_eq!(std::fs::read_to_string(&ran).unwrap().lines().count(), 1);

        // Asked for again it is the file that is there, not made again.
        let again = audio_for(root.path(), &filed, &source, Some(&program))
            .await
            .unwrap();
        assert_eq!(again, made);
        assert_eq!(std::fs::read_to_string(&ran).unwrap().lines().count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_sound_that_will_not_copy_is_written_again_as_aac() {
        let root = tempfile::tempdir().unwrap();
        let source = source_file(root.path());
        let log = root.path().join("log.txt");
        let program = write_script(
            root.path(),
            "ffmpeg",
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\ncase \"$*\" in\n  *'copy'*) exit 1 ;;\nesac\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\nprintf 'AAC ' > \"$out\"\n",
                log.display()
            ),
        );
        let filed = entry("a1", Some("0123456789abcdef"));

        let made = audio_for(root.path(), &filed, &source, Some(&program))
            .await
            .unwrap();
        assert!(made.ends_with("a1-01234567.m4a"), "{made:?}");
        assert_eq!(std::fs::read(&made).unwrap(), b"AAC ");
        let lines: Vec<String> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("copy"), "{:?}", lines[0]);
        assert!(lines[1].contains("aac"), "{:?}", lines[1]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_renderer_that_keeps_failing_leaves_the_file_itself() {
        let root = tempfile::tempdir().unwrap();
        let source = source_file(root.path());
        let program = write_script(root.path(), "ffmpeg", "#!/bin/sh\nexit 1\n");
        let filed = entry("a1", Some("0123456789abcdef"));

        let answered = audio_for(root.path(), &filed, &source, Some(&program))
            .await
            .unwrap();
        assert_eq!(answered, source);
        assert_eq!(
            std::fs::read_dir(cache_dir(root.path()))
                .map(|entries| entries.count())
                .unwrap_or(0),
            0,
            "a run that failed leaves nothing behind"
        );
    }
}
