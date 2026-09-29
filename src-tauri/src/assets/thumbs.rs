//! Small copies of a project's pictures, for the places that draw them small.
//!
//! A list — the shelf's rows, the board's cards — draws a picture a few hundred
//! pixels wide, and pulling the file that was filed to draw it means decoding
//! megabytes to paint a stamp of them. What these make is the same picture at
//! the size it is drawn, kept beside the project's other derived bytes under
//! `cache/` and keyed by the digest the entry was filed with, so a file that is
//! replaced gets new drawings and nothing has to be invalidated.
//!
//! The cache is derived and never the work: an export carries the files, not
//! the drawings of them (`Skip::Cache`), a drawing that cannot be made is
//! answered with the file itself, and the open prunes what no longer has an
//! entry to be a drawing of.

use crate::domain::{MokaFile, ResourceEntry};
use crate::imaging::MAX_OPERATED_PIXELS;
use crate::project::ProjectError;
use image::imageops::FilterType;
use std::path::{Path, PathBuf};

/// The widest a list may ask for. Past this a caller is asking for the picture,
/// and the route serves the file itself.
pub const THUMB_MAX_WIDTH: u32 = 1024;

/// The narrowest a list may ask for: below this the answer is a smudge, and a
/// caller asking for one has made a mistake rather than a small list.
pub const THUMB_MIN_WIDTH: u32 = 32;

/// How hard a thumbnail is squeezed.
///
/// Below Lanczos on purpose: a list draws these at a fraction of the size they
/// are made at, and a resample nobody looks at twice is cost for its own sake.
const FILTER: FilterType = FilterType::CatmullRom;

/// The quality a thumbnail is written at. It is a drawing of a picture that is
/// still there, so it is written to be looked at, not kept.
const QUALITY: u8 = 82;

pub fn clamp_width(width: u32) -> u32 {
    width.clamp(THUMB_MIN_WIDTH, THUMB_MAX_WIDTH)
}

/// Where a project keeps the drawings made of its files.
pub fn cache_dir(root: &Path) -> PathBuf {
    root.join("cache").join("thumbs")
}

/// Where the drawing of one picture at one width lives, when it can be keyed.
///
/// The key is the digest the entry carries rather than a time: a file that was
/// replaced has a new digest, so its drawings are new drawings and the old ones
/// are only files nothing will ask for again.
pub fn cached_path(root: &Path, entry: &ResourceEntry, width: u32) -> Option<PathBuf> {
    let sha = entry.sha256.as_deref()?;
    let key = sha.get(..8)?;
    Some(cache_dir(root).join(format!("{}-{width}-{key}.jpg", entry.id)))
}

/// The drawing of a picture at a width, made if it is not there yet.
///
/// Answers with the file to serve: the drawing when one could be made, and the
/// picture itself when it could not — an entry with nothing to key a drawing
/// on, a file that is not a picture the decoder reads, or one whose pixels are
/// past the ceiling the picture tools hold to. A list is not the place a broken
/// file is reported; it draws what it always drew.
pub fn thumb_for(
    root: &Path,
    entry: &ResourceEntry,
    source: &Path,
    width: u32,
) -> Result<PathBuf, ProjectError> {
    let width = clamp_width(width);
    let Some(cached) = cached_path(root, entry, width) else {
        return Ok(source.to_path_buf());
    };
    if cached.is_file() {
        return Ok(cached);
    }
    let Ok(bytes) = std::fs::read(source) else {
        return Ok(source.to_path_buf());
    };
    let Ok(picture) = image::load_from_memory(&bytes) else {
        return Ok(source.to_path_buf());
    };
    let (wide, tall) = (picture.width() as u64, picture.height() as u64);
    if wide.saturating_mul(tall) > MAX_OPERATED_PIXELS {
        return Ok(source.to_path_buf());
    }
    let drawn = if wide > width as u64 {
        let tall = ((tall * width as u64) / wide).max(1);
        picture.resize_exact(width, tall as u32, FILTER)
    } else {
        picture
    };
    let Some(written) = encode(&drawn) else {
        return Ok(source.to_path_buf());
    };
    write_cached(&cached, &written)?;
    Ok(cached)
}

/// The drawing as JPEG bytes, on white where the picture was see-through.
///
/// JPEG has no alpha, and what a transparent pixel's colour channel holds is
/// nothing anybody chose — drawn straight it comes out black. White is what a
/// page and this interface's panels are; a drawing that is put over something
/// else is not what a list asks for.
fn encode(picture: &image::DynamicImage) -> Option<Vec<u8>> {
    let subject = picture.to_rgba8();
    let mut canvas = image::RgbImage::new(subject.width(), subject.height());
    for (x, y, pixel) in subject.enumerate_pixels() {
        let [red, green, blue, alpha] = pixel.0;
        let over = |channel: u8| -> u8 {
            let alpha = u32::from(alpha);
            ((u32::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        };
        canvas.put_pixel(x, y, image::Rgb([over(red), over(green), over(blue)]));
    }
    let mut bytes = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, QUALITY);
    image::DynamicImage::ImageRgb8(canvas)
        .write_with_encoder(encoder)
        .ok()?;
    Some(bytes)
}

/// Writes one drawing where its key says, through a scratch file and a rename.
///
/// Two requests for the same drawing can be in flight at once — a list asks for
/// the same picture twice — and both write the same bytes for the same key, so
/// the race is a wasted write rather than a wrong file.
fn write_cached(target: &Path, bytes: &[u8]) -> Result<(), ProjectError> {
    let Some(dir) = target.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(dir)?;
    let scratch = dir.join(format!("drawing-{}.tmp", uuid::Uuid::now_v7()));
    std::fs::write(&scratch, bytes)?;
    if let Err(error) = std::fs::rename(&scratch, target) {
        let _ = std::fs::remove_file(&scratch);
        return Err(error.into());
    }
    Ok(())
}

/// Drops the drawings (and the sound) of files the project no longer has.
///
/// One directory read on open, against the registry the document just gave: a
/// file removed, or replaced by one filed under a new name, leaves drawings
/// whose key nothing will ever ask for. Ignored on error — a cache that cannot
/// be tidied is still a cache.
pub fn prune(root: &Path, moka: &MokaFile) {
    let held: std::collections::BTreeSet<&str> = moka
        .resources
        .all()
        .map(|entry| entry.id.as_str())
        .collect();
    // A drawing is `{id}-{width}-{key}.jpg`; a rendition is `{id}-{key}.m4a`.
    prune_dir(&cache_dir(root), &held, 2);
    prune_dir(&crate::assets::audio::cache_dir(root), &held, 1);
}

/// Drops the files of one cache directory whose id the project no longer holds.
///
/// The id comes first in a cached file's name and carries dashes of its own —
/// it is read back from the right, where the fields the cache appended are,
/// rather than from the left, where the id is not yet whole. A name that is
/// not a cached file's at all is left where it is.
fn prune_dir(dir: &Path, held: &std::collections::BTreeSet<&str>, trailing: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
        let Some(id) = stem.rsplitn(trailing + 1, '-').nth(trailing) else {
            continue;
        };
        if !held.contains(id) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{cached_path, clamp_width, prune, thumb_for, THUMB_MAX_WIDTH, THUMB_MIN_WIDTH};
    use crate::domain::{MokaFile, ProjectMetadata, ResourceEntry, ResourceRegistry};

    fn entry(id: &str, sha: Option<&str>) -> ResourceEntry {
        ResourceEntry {
            id: id.to_string(),
            name: "picture.png".into(),
            path: format!("assets/images/{id}.png"),
            mime: Some("image/png".into()),
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

    /// A document holding one picture an id names, and nothing else.
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
                images: ids
                    .iter()
                    .map(|id| entry(id, Some("0123456789abcdef")))
                    .collect(),
                ..Default::default()
            },
            folders: None,
            timelines: None,
            stories: None,
            canvas: Vec::new(),
        }
    }

    #[test]
    fn a_width_is_held_between_what_a_list_may_ask_and_what_a_smudge_is() {
        assert_eq!(clamp_width(0), THUMB_MIN_WIDTH);
        assert_eq!(clamp_width(320), 320);
        assert_eq!(clamp_width(99_999), THUMB_MAX_WIDTH);
    }

    #[test]
    fn a_drawing_is_keyed_by_the_digest_the_entry_was_filed_with() {
        let root = std::path::Path::new("/tmp/project");
        let keyed = cached_path(root, &entry("a1", Some("0123456789abcdef")), 320).unwrap();
        assert!(keyed.ends_with("a1-320-01234567.jpg"), "{keyed:?}");
        // Nothing to key on: the caller draws per request instead.
        assert!(cached_path(root, &entry("a1", None), 320).is_none());
    }

    #[test]
    fn a_file_that_is_not_a_picture_is_answered_with_itself() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = root.join("not-a-picture.png");
        std::fs::write(&source, b"this is not a picture").unwrap();
        let drawn = thumb_for(root, &entry("a1", Some("0123456789abcdef")), &source, 320).unwrap();
        assert_eq!(drawn, source);
    }

    #[test]
    fn a_picture_is_drawn_once_and_then_read_from_the_cache() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = root.join("picture.png");
        let mut png = image::RgbaImage::new(64, 48);
        for pixel in png.pixels_mut() {
            *pixel = image::Rgba([200, 120, 60, 255]);
        }
        png.write_to(
            &mut std::fs::File::create(&source).unwrap(),
            image::ImageFormat::Png,
        )
        .unwrap();

        let filed = entry("a1", Some("0123456789abcdef"));
        let drawn = thumb_for(root, &filed, &source, 32).unwrap();
        assert!(drawn.ends_with("a1-32-01234567.jpg"), "{drawn:?}");
        assert!(drawn.is_file());
        let first = std::fs::read(&drawn).unwrap();
        assert_eq!(&first[..2], &[0xff, 0xd8], "a JPEG comes out");

        // Asked for again it is the file that is there, not made again.
        let stamp = std::fs::metadata(&drawn).unwrap().modified().unwrap();
        let again = thumb_for(root, &filed, &source, 32).unwrap();
        assert_eq!(again, drawn);
        assert_eq!(
            std::fs::metadata(&again).unwrap().modified().unwrap(),
            stamp
        );
    }

    /// The id of a real asset carries dashes of its own, so the fields the
    /// cache appended are what a name is read back from.
    #[test]
    fn an_id_with_dashes_in_it_still_reads_back() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let dir = super::cache_dir(root);
        std::fs::create_dir_all(&dir).unwrap();
        let id = "01a0e375-b769-75c1-8f83-cb6c8434be52";
        let kept = format!("{id}-320-338dcc79.jpg");
        let gone = "01a0eaaa-b769-75c1-8f83-cb6c8434be52-320-11111111.jpg";
        std::fs::write(dir.join(&kept), b"drawing").unwrap();
        std::fs::write(dir.join(gone), b"drawing").unwrap();

        prune(root, &moka_holding(&[id]));

        assert!(dir.join(&kept).is_file(), "the held file's drawing stays");
        assert!(!dir.join(gone).exists());
    }

    #[test]
    fn an_open_drops_the_drawings_of_files_the_project_no_longer_holds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let dir = super::cache_dir(root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kept-32-01234567.jpg"), b"drawing").unwrap();
        std::fs::write(dir.join("gone-32-01234567.jpg"), b"drawing").unwrap();

        prune(root, &moka_holding(&["kept"]));

        assert!(dir.join("kept-32-01234567.jpg").is_file());
        assert!(!dir.join("gone-32-01234567.jpg").exists());
    }

    #[test]
    fn an_open_drops_the_sound_of_files_the_project_no_longer_holds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let dir = crate::assets::audio::cache_dir(root);
        std::fs::create_dir_all(&dir).unwrap();
        let id = "01a0e375-b769-75c1-8f83-cb6c8434be52";
        let kept = format!("{id}-338dcc79.m4a");
        std::fs::write(dir.join(&kept), b"sound").unwrap();
        std::fs::write(
            dir.join("01a0eaaa-b769-75c1-8f83-cb6c8434be52-11111111.m4a"),
            b"sound",
        )
        .unwrap();
        // A name that is not a rendition's is left where it is.
        std::fs::write(dir.join("notes.txt"), b"not ours").unwrap();

        prune(root, &moka_holding(&[id]));

        assert!(dir.join(&kept).is_file());
        assert!(!dir
            .join("01a0eaaa-b769-75c1-8f83-cb6c8434be52-11111111.m4a")
            .exists());
        assert!(dir.join("notes.txt").is_file());
    }
}
