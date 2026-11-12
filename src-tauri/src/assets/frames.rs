//! The first and last pictures of a film, kept beside it.
//!
//! A video plays from its own file, but before it plays there is nothing to
//! look at: a browser may paint the first frame, and on some machines it paints
//! black. Both ends are taken out of the film and kept under
//! `cache/frames/{assetId}/` — not as registry entries, since nobody put them
//! on a shelf, and not as work either: the cache stays out of a package, and a
//! project opened somewhere else takes the pictures again.
//!
//! The files are named after the digest the entry was filed with. A file
//! replaced under the same id gets new pictures, and the old ones are left for
//! the next open to collect.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::domain::{MokaFile, ResourceEntry};
use crate::project::ProjectError;

use super::thumbs;

/// How long one extraction may take. A frame is a seek and a single decode;
/// a machine that cannot do that inside half a minute is not going to.
const FRAME_TIMEOUT: Duration = Duration::from_secs(30);

/// The largest edge an attachment keeps. A 4K film's still is several
/// megabytes of PNG, and every use of it — a preview, a reference for a video
/// model — is smaller than that.
const MAX_EDGE: u32 = 1920;

/// Which end of a film a picture is taken from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameEdge {
    First,
    Last,
}

impl FrameEdge {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Last => "last",
        }
    }
}

/// Taking pictures out of films, with the renderer the deployment resolved.
#[derive(Debug, Clone)]
pub struct Frames {
    program: Option<PathBuf>,
}

impl Frames {
    pub fn new(program: Option<PathBuf>) -> Self {
        Self { program }
    }

    pub fn program(&self) -> Option<&Path> {
        self.program.as_deref()
    }

    /// Where one video's pictures live, among the project's derived bytes.
    pub fn folder(root: &Path, asset_id: &str) -> PathBuf {
        root.join("cache").join("frames").join(asset_id)
    }

    /// Where one end of one video lives, as the entry it was taken from.
    fn cached_path(root: &Path, entry: &ResourceEntry, edge: FrameEdge) -> PathBuf {
        let key = entry
            .sha256
            .as_deref()
            .and_then(|sha| sha.get(..8))
            .filter(|key| key.len() == 8)
            .unwrap_or("00000000");
        Self::folder(root, &entry.id).join(format!("{key}-{}.png", edge.as_str()))
    }

    /// The picture of one end, made now if it is not there yet.
    pub async fn ensure(
        &self,
        root: &Path,
        entry: &ResourceEntry,
        source: &Path,
        edge: FrameEdge,
    ) -> Result<PathBuf, ProjectError> {
        let target = Self::cached_path(root, entry, edge);
        if target.is_file() {
            return Ok(target);
        }
        let program = self.program.as_deref().ok_or_else(|| {
            ProjectError::domain(
                "FFMPEG_UNAVAILABLE",
                crate::clip::locate::UNAVAILABLE_REASON,
            )
        })?;
        let Some(folder) = target.parent() else {
            return Err(ProjectError::domain(
                "FRAME_EXTRACTION_FAILED",
                "the attachment has nowhere to go",
            ));
        };
        std::fs::create_dir_all(folder)?;
        let scratch = folder.join(format!("frame-{}.tmp", uuid::Uuid::now_v7()));

        let mut command = tokio::process::Command::new(program);
        command
            .arg("-y")
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error");
        if edge == FrameEdge::Last {
            // The end of a film is reached from a little before it: seeking to
            // the exact duration lands past the last frame in most muxers.
            match entry
                .probe
                .as_ref()
                .and_then(|probe| probe.duration_ms)
                .filter(|ms| *ms > 150)
            {
                Some(ms) => {
                    command
                        .arg("-ss")
                        .arg(format!("{:.3}", (ms - 100) as f64 / 1000.0));
                }
                None => {
                    command.arg("-sseof").arg("-0.15");
                }
            }
        }
        command
            .arg("-i")
            .arg(source)
            .arg("-frames:v")
            .arg("1")
            .arg("-vf")
            .arg(format!("scale=w='min({MAX_EDGE},iw)':h=-2"))
            .arg("-an")
            .arg("-sn")
            .arg("-dn")
            .arg("-c:v")
            .arg("png")
            .arg("-f")
            .arg("image2")
            .arg("-update")
            .arg("1")
            .arg(&scratch)
            .kill_on_drop(true);

        let completed = tokio::time::timeout(FRAME_TIMEOUT, command.output()).await;
        let result = match completed {
            Err(_) => {
                let _ = std::fs::remove_file(&scratch);
                return Err(ProjectError::domain(
                    "FRAME_EXTRACTION_FAILED",
                    format!(
                        "ffmpeg did not cut the {} frame out of \"{}\" within {} seconds",
                        edge.as_str(),
                        entry.name,
                        FRAME_TIMEOUT.as_secs()
                    ),
                ));
            }
            Ok(Err(error)) => {
                let _ = std::fs::remove_file(&scratch);
                return Err(ProjectError::domain(
                    "FRAME_EXTRACTION_FAILED",
                    format!("ffmpeg could not be run: {error}"),
                ));
            }
            Ok(Ok(output)) => output,
        };
        if !result.status.success() {
            let _ = std::fs::remove_file(&scratch);
            let said = String::from_utf8_lossy(&result.stderr);
            return Err(ProjectError::domain(
                "FRAME_EXTRACTION_FAILED",
                format!(
                    "ffmpeg could not cut the {} frame out of \"{}\": {}",
                    edge.as_str(),
                    entry.name,
                    crate::clip::runner::tail_message(
                        said.trim(),
                        crate::clip::runner::MESSAGE_LIMIT
                    )
                ),
            ));
        }
        let written = std::fs::metadata(&scratch)
            .map(|meta| meta.len())
            .unwrap_or(0);
        if written == 0 {
            let _ = std::fs::remove_file(&scratch);
            return Err(ProjectError::domain(
                "FRAME_EXTRACTION_FAILED",
                format!(
                    "ffmpeg finished without writing a frame out of \"{}\"",
                    entry.name
                ),
            ));
        }
        // Two requests for the same picture may be in flight at once; both
        // write the same bytes, so a lost race is a wasted write rather than a
        // wrong file.
        match std::fs::rename(&scratch, &target) {
            Ok(()) => Ok(target),
            Err(_) if target.is_file() => {
                let _ = std::fs::remove_file(&scratch);
                Ok(target)
            }
            Err(error) => {
                let _ = std::fs::remove_file(&scratch);
                Err(error.into())
            }
        }
    }

    /// Takes both ends of every film among `entries`, off the caller's thread.
    ///
    /// Best effort on purpose: a preview that cannot be made is a preview the
    /// browser draws for itself, and a provider ask that needs a frame asks for
    /// one again where it can report what went wrong.
    pub fn keep_in_background(self: &Arc<Self>, root: PathBuf, entries: Vec<ResourceEntry>) {
        let frames = Arc::clone(self);
        tokio::spawn(async move {
            for entry in entries {
                if !entry
                    .mime
                    .as_deref()
                    .is_some_and(|mime| mime.starts_with("video/"))
                {
                    continue;
                }
                let source = root.join(&entry.path);
                for edge in [FrameEdge::First, FrameEdge::Last] {
                    if let Err(error) = frames.ensure(&root, &entry, &source, edge).await {
                        tracing::warn!(
                            "the {} frame of {} was not kept: {error}",
                            edge.as_str(),
                            entry.name
                        );
                    }
                }
            }
        });
    }
}

/// One attachment at the width a list draws it, as JPEG bytes.
pub fn picture(path: &Path, width: u32) -> Result<(Vec<u8>, &'static str), ProjectError> {
    let bytes = std::fs::read(path)?;
    let picture = image::load_from_memory(&bytes).map_err(|error| {
        ProjectError::domain(
            "FRAME_EXTRACTION_FAILED",
            format!("the frame at {} is not readable: {error}", path.display()),
        )
    })?;
    let width = thumbs::clamp_width(width);
    let (wide, tall) = (picture.width() as u64, picture.height() as u64);
    let drawn = if wide > width as u64 {
        let tall = ((tall * width as u64) / wide).max(1);
        picture.resize_exact(width, tall as u32, image::imageops::FilterType::CatmullRom)
    } else {
        picture
    };
    let encoded = thumbs::encode(&drawn).ok_or_else(|| {
        ProjectError::domain(
            "FRAME_EXTRACTION_FAILED",
            "the frame could not be written as a picture",
        )
    })?;
    Ok((encoded, "image/jpeg"))
}

/// Drops one video's attachments. Called where the video leaves or changes.
pub fn forget(root: &Path, asset_id: &str) {
    let _ = std::fs::remove_dir_all(Frames::folder(root, asset_id));
}

/// Drops attachments the project no longer has a video for.
///
/// One directory read on open, against the registry the document just gave: a
/// video removed, or one replaced by a file with a new digest, leaves pictures
/// nothing will ever ask for.
pub fn prune(root: &Path, moka: &MokaFile) {
    let held: std::collections::BTreeMap<&str, Option<&str>> = moka
        .resources
        .all()
        .map(|entry| (entry.id.as_str(), entry.sha256.as_deref()))
        .collect();
    let Ok(entries) = std::fs::read_dir(root.join("cache").join("frames")) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str() else { continue };
        if !entry.path().is_dir() {
            continue;
        }
        let Some(sha) = held.get(id) else {
            let _ = std::fs::remove_dir_all(entry.path());
            continue;
        };
        let key = sha
            .and_then(|sha| sha.get(..8))
            .filter(|key| key.len() == 8)
            .unwrap_or("00000000");
        let expected = [format!("{key}-first.png"), format!("{key}-last.png")];
        let Ok(files) = std::fs::read_dir(entry.path()) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name();
            let Some(name) = name.to_str() else { continue };
            if !expected.iter().any(|held| held == name) {
                let _ = std::fs::remove_file(file.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{prune, FrameEdge, Frames};
    use crate::domain::{MokaFile, ProjectMetadata, ResourceEntry, ResourceRegistry};
    use std::path::Path;

    fn entry(id: &str, sha: Option<&str>) -> ResourceEntry {
        ResourceEntry {
            id: id.to_string(),
            name: "shot.mp4".into(),
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

    fn moka_holding(ids: &[&str]) -> MokaFile {
        MokaFile {
            version: crate::domain::MOKA_FILE_VERSION.to_string(),
            metadata: ProjectMetadata {
                id: "p1".into(),
                name: "Demo".into(),
                description: None,
                cover_path: None,
                revision: 0,
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
            },
            resources: ResourceRegistry {
                videos: ids
                    .iter()
                    .map(|id| entry(id, Some("0123456789abcdef")))
                    .collect(),
                ..Default::default()
            },
            folders: None,
            timelines: None,
            stories: None,
            director_scenes: None,
            canvas: Vec::new(),
        }
    }

    #[test]
    fn a_picture_is_keyed_by_the_digest_the_entry_was_filed_with() {
        let root = Path::new("/tmp/project");
        let keyed = Frames::cached_path(
            root,
            &entry("a1", Some("0123456789abcdef")),
            FrameEdge::First,
        );
        assert!(
            keyed.ends_with("cache/frames/a1/01234567-first.png"),
            "{keyed:?}"
        );
        // An entry with no digest still gets a name of the same shape.
        let bare = Frames::cached_path(root, &entry("a1", None), FrameEdge::Last);
        assert!(
            bare.ends_with("cache/frames/a1/00000000-last.png"),
            "{bare:?}"
        );
    }

    #[test]
    fn forgetting_a_video_takes_its_pictures_with_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let folder = Frames::folder(root, "a1");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("01234567-first.png"), b"frame").unwrap();

        super::forget(root, "a1");

        assert!(!folder.exists());
    }

    #[test]
    fn an_open_drops_frames_of_videos_the_project_no_longer_has() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let dir = root.join("cache").join("frames");
        std::fs::create_dir_all(dir.join("kept")).unwrap();
        std::fs::create_dir_all(dir.join("gone")).unwrap();
        std::fs::write(dir.join("kept").join("01234567-first.png"), b"frame").unwrap();
        std::fs::write(dir.join("kept").join("01234567-last.png"), b"frame").unwrap();
        // The same video at another digest is another file's pictures.
        std::fs::write(dir.join("kept").join("deadbeef-first.png"), b"old").unwrap();
        std::fs::write(dir.join("gone").join("01234567-first.png"), b"frame").unwrap();

        prune(root, &moka_holding(&["kept"]));

        assert!(dir.join("kept").join("01234567-first.png").is_file());
        assert!(dir.join("kept").join("01234567-last.png").is_file());
        assert!(!dir.join("kept").join("deadbeef-first.png").exists());
        assert!(!dir.join("gone").exists());
    }
}
