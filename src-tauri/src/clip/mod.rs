//! Rendering a timeline to a video file.
//!
//! The pipeline is four pieces with one job each: `locate` finds the renderer
//! and asks what it can do, `plan` reads a document into the exact command it
//! would be rendered with, `ass` writes the burn-in script for the words, and
//! `runner`/`jobs` place the process, follow it, and file what it made.
//!
//! Only the first and the last touch the machine. The middle two are pure, so
//! what would be rendered can be read and asserted before anything runs.
//!
//! Nothing here can be named from a request: the program comes from the
//! configuration, the environment, or the search path, and an export body
//! carries a timeline id and nothing else.

pub mod ass;
pub mod audio;
pub mod fonts;
pub mod jobs;
pub mod locate;
pub mod plan;
pub mod runner;

#[cfg(test)]
pub(crate) mod fixtures;

use crate::domain::{MokaFile, TimelineClip, TimelineDocument, TrackKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// What can be wrong with an export before a render is even placed.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ClipError {
    #[error("No export is known under that id")]
    ExportMissing { id: String },
    /// One at a time: a second render would compete for the disk and the
    /// machine, and there is one person waiting in front of the dialog.
    #[error("An export is already running.")]
    Busy,
}

impl ClipError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ExportMissing { .. } => "EXPORT_NOT_FOUND",
            Self::Busy => "CONFLICT",
        }
    }
}

/// One file the command hands ffmpeg, and how it is handed over.
///
/// The input-side window is what keeps a long recording from being decoded
/// from its head: a clip that is the only one reading a file asks the demuxer
/// for just its window. A file several clips read cannot be asked for one
/// window, so it is read whole and trimmed in the graph instead.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanInput {
    pub path: PathBuf,
    /// Input-side seek, in milliseconds, when the material needs none of its head.
    pub seek_ms: Option<i64>,
    /// How much of the file to read, when the whole of it is not wanted.
    pub duration_ms: Option<i64>,
    /// A still picture: read once, held, and cut by the graph's window.
    pub image: bool,
    /// Several clips read this file, so the graph trims rather than the input.
    pub shared: bool,
    /// Whether the file carries a sound track. Probed, never guessed: a video
    /// without sound must not be mapped as though it had one, and one with
    /// sound must not be rendered silent.
    pub has_audio: bool,
}

/// What the planner is allowed to know about one asset.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanAsset {
    /// Where the file is, already resolved against the project root.
    pub path: PathBuf,
    /// The project's own reading of what the file is.
    pub mime: String,
    pub has_audio: bool,
}

/// The project's files, as the planner reads them.
///
/// The pure planner is handed this rather than a store: the reading of a file
/// is the caller's business, and everything the graph decides from it is then
/// a plain function of the document.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlanSources {
    pub root: PathBuf,
    pub assets: HashMap<String, PlanAsset>,
}

impl PlanSources {
    /// What is known about an asset, or nothing when the timeline never named it.
    pub fn asset(&self, id: &str) -> Option<&PlanAsset> {
        self.assets.get(id)
    }

    /// The file, when the project holds one for this asset and it is there.
    pub fn file_of(&self, id: &str) -> Option<&Path> {
        self.assets
            .get(id)
            .map(|asset| asset.path.as_path())
            .filter(|path| path.is_file())
    }
}

/// Reads what the graph needs about every file a timeline's clips name.
///
/// A file that is not there is still recorded: the planner is what refuses a
/// missing asset, and it should say so in the document's own terms rather than
/// fail this reading.
pub fn sources_for(root: &Path, moka: &MokaFile, timeline: &TimelineDocument) -> PlanSources {
    let mut sources = PlanSources {
        root: root.to_path_buf(),
        assets: HashMap::new(),
    };
    for clip in &timeline.clips {
        let Some(asset_id) = named_asset(clip) else {
            continue;
        };
        if sources.assets.contains_key(asset_id) {
            continue;
        }
        let Some(entry) = moka.resources.find(asset_id) else {
            continue;
        };
        let path = root.join(&entry.path);
        let mime = entry.mime.clone().unwrap_or_default();
        let has_audio = media_has_audio(&path, &mime);
        sources.assets.insert(
            asset_id.to_string(),
            PlanAsset {
                path,
                mime,
                has_audio,
            },
        );
    }
    sources
}

/// The asset a clip reads: a text clip reads none.
pub fn named_asset(clip: &TimelineClip) -> Option<&str> {
    if clip.kind == TrackKind::Text {
        return None;
    }
    clip.asset_id.as_deref().filter(|id| !id.is_empty())
}

/// Whether a file carries sound, read from its own headers.
///
/// The preview hands a video element the file and lets the browser find what
/// it finds; the exporter has to name the streams it maps, so it has to know
/// beforehand. The ISO base media family — mp4 and mov — is read box by box,
/// which is enough to tell a rendered picture with sound from a silent one.
/// Anything else is assumed to carry sound: a file whose reading fails is
/// quieter than somebody hoped, while one wrongly assumed silent would lose
/// what was put on the timeline.
pub fn media_has_audio(path: &Path, mime: &str) -> bool {
    if mime.starts_with("audio/") {
        return true;
    }
    if mime.starts_with("image/") || mime.starts_with("text/") || mime.is_empty() {
        return false;
    }
    let iso_bmff = matches!(
        mime,
        "video/mp4" | "video/quicktime" | "video/x-m4v" | "audio/mp4"
    );
    if !iso_bmff {
        return true;
    }
    // Unreadable or malformed boxes mean "assume there is sound", which is
    // what the preview's element would do with a file it can play.
    iso_bmff_has_audio_track(path).unwrap_or(true)
}

/// Walks the top-level boxes to the movie box and looks for a sound track.
///
/// Boxes are walked by seeking rather than reading: a video's payload is
/// arbitrarily large and none of it matters here.
fn iso_bmff_has_audio_track(path: &Path) -> Option<bool> {
    use std::io::{Read, Seek, SeekFrom};

    /// A movie box bigger than this is not one this reading will hold in memory.
    const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;
    const MAX_BOXES: usize = 64;

    let mut file = std::fs::File::open(path).ok()?;
    let total = file.metadata().ok()?.len();
    let mut at = 0u64;
    for _ in 0..MAX_BOXES {
        if at + 8 > total {
            return None;
        }
        file.seek(SeekFrom::Start(at)).ok()?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header).ok()?;
        let size32 = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
        let kind = &header[4..8];
        let (size, header_len) = if size32 == 1 {
            let mut extended = [0u8; 8];
            file.read_exact(&mut extended).ok()?;
            (u64::from_be_bytes(extended), 16u64)
        } else if size32 == 0 {
            (total - at, 8)
        } else {
            (size32 as u64, 8)
        };
        if size < header_len || at + size > total {
            return None;
        }
        if kind == b"moov" {
            let body = size - header_len;
            if body > MAX_MOOV_BYTES {
                return None;
            }
            let mut bytes = vec![0u8; body as usize];
            file.read_exact(&mut bytes).ok()?;
            return moov_has_sound_track(&bytes);
        }
        at += size;
    }
    None
}

/// Whether a movie box holds a track whose handler says it is sound.
///
/// `None` means the box could not be walked to its end, which is different
/// from a walk that finished and found nothing: one file may be silent, while
/// the other is a reading this code does not understand.
fn moov_has_sound_track(bytes: &[u8]) -> Option<bool> {
    /// `Some(true)` is a sound track found below, `Some(false)` a clean walk
    /// that found none, `None` a box list that does not add up.
    fn walk(bytes: &[u8], depth: usize) -> Option<bool> {
        if depth > 4 {
            return None;
        }
        let mut at = 0usize;
        while at + 8 <= bytes.len() {
            let size32 =
                u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
            let kind = &bytes[at + 4..at + 8];
            let (size, header) = if size32 == 1 {
                if at + 16 > bytes.len() {
                    return None;
                }
                let mut extended = [0u8; 8];
                extended.copy_from_slice(&bytes[at + 8..at + 16]);
                (u64::from_be_bytes(extended), 16usize)
            } else if size32 == 0 {
                ((bytes.len() - at) as u64, 8usize)
            } else {
                (size32 as u64, 8usize)
            };
            let end = at as u64 + size;
            if size < header as u64 || end > bytes.len() as u64 {
                return None;
            }
            let body = &bytes[at + header..end as usize];
            match kind {
                // A track with no sound in it says nothing about the next
                // track, so only finding one ends the walk early. The handler
                // lives two boxes down, inside the track's media box.
                b"trak" | b"mdia" => match walk(body, depth + 1) {
                    Some(true) => return Some(true),
                    Some(false) => {}
                    None => return None,
                },
                // hdlr: version/flags, a pre-defined word, then the type.
                b"hdlr" if body.len() >= 12 && &body[8..12] == b"soun" => return Some(true),
                _ => {}
            }
            at = end as usize;
        }
        Some(false)
    }
    walk(bytes, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip::fixtures;

    #[test]
    fn whether_a_file_carries_sound_is_read_from_the_file() {
        let root = tempfile::tempdir().unwrap();
        // The document's own reading of a file settles the easy cases.
        assert!(media_has_audio(Path::new("/nope"), "audio/wav"));
        assert!(!media_has_audio(Path::new("/nope"), "image/png"));
        assert!(!media_has_audio(Path::new("/nope"), "text/plain"));
        assert!(!media_has_audio(Path::new("/nope"), ""));
        // A container this reading does not know is assumed to carry sound.
        assert!(media_has_audio(Path::new("/nope"), "video/webm"));

        // An ISO base media file is read box by box.
        let with_sound = fixtures::write_file(root.path(), "sound.mp4", &fixtures::mp4_bytes(true));
        let silent = fixtures::write_file(root.path(), "silent.mp4", &fixtures::mp4_bytes(false));
        assert!(media_has_audio(&with_sound, "video/mp4"));
        assert!(!media_has_audio(&silent, "video/mp4"));
        // A file that cannot be walked is assumed to carry sound: the
        // preview's element would play it, and a silent export of a picture
        // that had sound is the worse mistake.
        let junk = fixtures::write_file(root.path(), "junk.mp4", b"not a container at all");
        assert!(media_has_audio(&junk, "video/mp4"));
    }

    #[test]
    fn the_sources_record_what_each_file_is_and_whether_it_is_there() {
        let root = tempfile::tempdir().unwrap();
        let file = fixtures::write_file(
            root.path(),
            "assets/videos/a.mp4",
            &fixtures::mp4_bytes(true),
        );
        let gone = root.path().join("assets/videos/gone.mp4");
        let project = fixtures::moka(
            vec![
                fixtures::entry("a1", "a", "assets/videos/a.mp4", "video/mp4"),
                fixtures::entry("a2", "gone", "assets/videos/gone.mp4", "video/mp4"),
                fixtures::entry("a3", "words", "assets/texts/w.txt", "text/plain"),
            ],
            Vec::new(),
        );
        let clip = fixtures::material("c1", "t1", TrackKind::Video, "a1", 0, 1_000);
        let words = fixtures::text("c2", "t2", 0, 1_000, "Hello", fixtures::text_style());
        let missing = fixtures::material("c3", "t1", TrackKind::Video, "a2", 2_000, 1_000);
        let project = crate::domain::MokaFile {
            resources: crate::domain::ResourceRegistry {
                videos: vec![
                    project.resources.videos[0].clone(),
                    project.resources.videos[1].clone(),
                ],
                texts: vec![project.resources.texts[0].clone()],
                ..Default::default()
            },
            ..project
        };
        let timeline = fixtures::timeline(
            "Cut",
            vec![
                fixtures::track("t1", TrackKind::Video),
                fixtures::track("t2", TrackKind::Text),
            ],
            vec![clip, words, missing],
            Vec::new(),
        );
        let sources = sources_for(root.path(), &project, &timeline);
        let asset = sources.asset("a1").expect("the material is recorded");
        assert_eq!(asset.path, file);
        assert!(asset.has_audio);
        assert_eq!(sources.file_of("a1"), Some(file.as_path()));
        // A file that is not there is recorded as what the document says and
        // refused by the planner, not by this reading.
        assert!(sources.asset("a2").is_some());
        assert_eq!(sources.file_of("a2"), None);
        let _ = gone;
        // Words name no file at all.
        assert!(sources.asset("a3").is_none());
    }
}
