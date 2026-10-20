use crate::domain::{id_tag, AssetProbe, ASSET_CATEGORIES};
use crate::project::ProjectError;
use sha2::Digest;
use std::path::{Path, PathBuf};

pub mod audio;
pub mod probe;
pub mod thumbs;

/// Maps a sniffed MIME type to its asset category directory.
pub fn category_for_mime(mime: &str) -> Option<&'static str> {
    if mime.starts_with("image/") {
        Some("images")
    } else if mime.starts_with("video/") {
        Some("videos")
    } else if mime.starts_with("audio/") {
        Some("music")
    } else if mime == "model/gltf-binary" || mime == "model/gltf+json" {
        Some("models")
    } else if mime == "text/plain" || mime == "text/markdown" || mime == "application/json" {
        Some("texts")
    } else {
        None
    }
}

/// The model formats this build deliberately does not read.
///
/// Each is a real pipeline with its own exchange problems — external
/// textures, versioned binary layouts, proprietary encodings — and every one
/// of them can be exported as GLB from the tool that made it.
const REJECTED_MODEL_EXTENSIONS: [&str; 9] = [
    "fbx", "obj", "usdz", "usd", "vrm", "stl", "ply", "blend", "3mf",
];

/// The compression extensions this build has no decoder for.
const UNSUPPORTED_MODEL_EXTENSIONS: [&str; 3] = [
    "KHR_draco_mesh_compression",
    "EXT_meshopt_compression",
    "KHR_texture_basisu",
];

fn gltf_problem(document: &serde_json::Value) -> Option<String> {
    let version = document
        .get("asset")
        .and_then(|asset| asset.get("version"))
        .and_then(|version| version.as_str())
        .unwrap_or_default();
    if !version.starts_with('2') {
        return Some(format!(
            "the model says glTF version \"{version}\"; only glTF 2 is read"
        ));
    }
    for field in ["buffers", "images"] {
        if let Some(rows) = document.get(field).and_then(|rows| rows.as_array()) {
            for row in rows {
                if let Some(uri) = row.get("uri").and_then(|uri| uri.as_str()) {
                    if !uri.starts_with("data:") {
                        return Some(format!(
                            "the model reads {field} from an external address; export a self-contained GLB"
                        ));
                    }
                }
            }
        }
    }
    for field in ["extensionsUsed", "extensionsRequired"] {
        if let Some(rows) = document.get(field).and_then(|rows| rows.as_array()) {
            for name in rows.iter().filter_map(|name| name.as_str()) {
                if UNSUPPORTED_MODEL_EXTENSIONS.contains(&name) {
                    return Some(format!(
                        "the model uses the {name} extension, which this build does not decode"
                    ));
                }
            }
        }
    }
    None
}

fn parse_gltf(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let document: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("the GLTF is not valid JSON: {error}"))?;
    if let Some(problem) = gltf_problem(&document) {
        return Err(problem);
    }
    Ok(document)
}

/// Reads a GLB's header and JSON chunk; the binary payload is not decoded.
fn parse_glb(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 20 {
        return Err("the GLB is too short to hold a header and a JSON chunk".into());
    }
    if &bytes[0..4] != b"glTF" {
        return Err("the file does not start with the GLB magic".into());
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap_or_default());
    if version != 2 {
        return Err(format!(
            "the GLB says version {version}; only version 2 is read"
        ));
    }
    let declared = u32::from_le_bytes(bytes[8..12].try_into().unwrap_or_default()) as usize;
    if declared != bytes.len() {
        return Err(format!(
            "the GLB header says {declared} bytes but the file holds {}",
            bytes.len()
        ));
    }
    let chunk_length = u32::from_le_bytes(bytes[12..16].try_into().unwrap_or_default()) as usize;
    let chunk_type = u32::from_le_bytes(bytes[16..20].try_into().unwrap_or_default());
    if chunk_type != 0x4E4F_534A {
        return Err("the GLB's first chunk is not its JSON scene".into());
    }
    let end = 20usize.saturating_add(chunk_length);
    if end > bytes.len() {
        return Err("the GLB's JSON chunk runs past the end of the file".into());
    }
    let json = bytes[20..end]
        .iter()
        .copied()
        .take_while(|byte| *byte != 0)
        .collect::<Vec<u8>>();
    parse_gltf(&json)?;
    Ok(())
}

fn rejected_model_extension(path: &Path) -> Option<String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())?;
    if REJECTED_MODEL_EXTENSIONS.contains(&extension.as_str()) {
        Some(format!(
            ".{extension} is not a format this build reads; export GLB from the modelling tool"
        ))
    } else {
        None
    }
}

pub fn is_allowed_media(mime: &str, allowed: &[String]) -> bool {
    allowed
        .iter()
        .any(|prefix| mime.starts_with(&format!("{prefix}/")) || mime == *prefix)
}

pub struct StagedAnalysis {
    pub mime: String,
    pub bytes: u64,
    pub sha256: String,
    pub probe: AssetProbe,
}

/// Sniffs the MIME type from bytes, hashes the file, and probes cheap
/// metadata: image dimensions, and duration/sample details for WAV, MP3,
/// and MP4-family media. Probing is best-effort — malformed media still
/// imports, just without the missing fields.
pub fn analyze_staged(path: &Path) -> Result<StagedAnalysis, ProjectError> {
    let bytes = std::fs::read(path)?;
    if bytes.is_empty() {
        return Err(ProjectError::domain("ASSET_INVALID", "The file is empty"));
    }
    if let Some(problem) = rejected_model_extension(path) {
        return Err(ProjectError::domain("ASSET_INVALID", problem));
    }
    // infer does not recognise GLB, and a GLTF would otherwise be filed as
    // text. Both are checked before the generic sniff, by the bytes rather
    // than only by the extension: a model renamed to .bin is still a model.
    let is_glb = bytes.len() >= 4 && &bytes[0..4] == b"glTF";
    let looks_gltf = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("gltf"));
    let mime = if is_glb {
        parse_glb(&bytes).map_err(|problem| ProjectError::domain("ASSET_INVALID", problem))?;
        "model/gltf-binary".to_string()
    } else if looks_gltf {
        parse_gltf(&bytes).map_err(|problem| ProjectError::domain("ASSET_INVALID", problem))?;
        "model/gltf+json".to_string()
    } else {
        infer::get(&bytes)
            .map(|kind| kind.mime_type().to_string())
            .unwrap_or_else(|| {
                if std::str::from_utf8(&bytes[..bytes.len().min(8192)]).is_ok() {
                    "text/plain".to_string()
                } else {
                    "application/octet-stream".to_string()
                }
            })
    };

    let mut hasher = sha2::Sha256::new();
    hasher.update(&bytes);
    let sha256 = hex::encode(hasher.finalize());

    let mut probe = AssetProbe {
        mime: mime.clone(),
        bytes: bytes.len() as i64,
        sha256: sha256.clone(),
        width: None,
        height: None,
        duration_ms: None,
        sample_rate: None,
        channels: None,
        codec_summary: None,
        poster_asset_id: None,
    };
    if mime.starts_with("image/") {
        if let Ok(reader) = image::ImageReader::open(path) {
            if let Ok(reader) = reader.with_guessed_format().map_err(|_| ()) {
                if let Ok((width, height)) = reader.into_dimensions() {
                    probe.width = Some(width as i32);
                    probe.height = Some(height as i32);
                }
            }
        }
    } else if mime.starts_with("audio/") || mime.starts_with("video/") {
        let media = probe::probe_media(&mime, &bytes);
        probe.duration_ms = media.duration_ms;
        probe.sample_rate = media.sample_rate;
        probe.channels = media.channels;
        probe.codec_summary = media.codec_summary;
        if probe.width.is_none() {
            probe.width = media.width;
            probe.height = media.height;
        }
    }

    Ok(StagedAnalysis {
        mime,
        bytes: bytes.len() as u64,
        sha256,
        probe,
    })
}

/// A name made safe for one path segment, keeping the words it is made of.
///
/// Letters and digits of any script survive — a project named 中文项目 names
/// its folder in Chinese rather than in a word of this function's invention —
/// and every other character is kept as a separator, turned into one, or
/// dropped, which is what keeps the result a single segment.
pub fn slugify(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("asset");
    let mut slug = String::with_capacity(stem.len());
    for ch in stem.chars() {
        if ch.is_alphanumeric() {
            slug.extend(ch.to_lowercase());
        } else if ch == '-' || ch == '_' {
            slug.push(ch);
        } else if ch.is_whitespace() || ch == '.' {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        // Nothing a name can be read back from; the caller still needs one
        // segment, and this is the one word every caller knows.
        "asset".to_string()
    } else {
        slug.chars().take(60).collect()
    }
}

pub fn extension_for(name: &str, mime: &str) -> String {
    if let Some(ext) = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .filter(|ext| ext.chars().all(|c| c.is_ascii_alphanumeric()) && ext.len() <= 8)
    {
        return ext;
    }
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/mp4" => "m4a",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "model/gltf-binary" => "glb",
        "model/gltf+json" => "gltf",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "application/json" => "json",
        _ => "bin",
    }
    .to_string()
}

/// Collision-safe filename: slug derived from the display name plus a short
/// id suffix, never the raw user-supplied path. The suffix is the id's own
/// end, since two drawings of one batch are made in the same minute and share
/// their id's head.
pub fn asset_filename(name: &str, mime: &str, id: &str) -> String {
    let short = id_tag(id, 8);
    format!("{}-{}.{}", slugify(name), short, extension_for(name, mime))
}

/// Atomically promotes a staged tmp file into its category directory.
/// Returns the project-relative POSIX path.
///
/// The name it was handed is the name it takes wherever that name is free, and
/// a name already taken is stepped aside from rather than written over: the
/// file already there is another asset's work, and a name meant to be unique is
/// not a name that cannot collide. The name is reserved with an exclusive
/// create before the staged file is renamed onto it, so two promotes racing for
/// one name end up in two files rather than one.
pub fn promote(
    project_root: &Path,
    tmp_path: &Path,
    category: &str,
    filename: &str,
) -> Result<String, ProjectError> {
    if !ASSET_CATEGORIES.contains(&category) {
        return Err(ProjectError::domain(
            "ASSET_INVALID",
            format!("Unknown asset category: {category}"),
        ));
    }
    let category_dir = project_root.join("assets").join(category);
    std::fs::create_dir_all(&category_dir)?;
    let mut attempt = 0usize;
    loop {
        let candidate = stepped_aside(filename, attempt);
        let target = category_dir.join(&candidate);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(_) => {
                if let Err(error) = std::fs::rename(tmp_path, &target) {
                    // Only the name was taken; nothing of this asset is here.
                    let _ = std::fs::remove_file(&target);
                    return Err(error.into());
                }
                return Ok(format!("assets/{category}/{candidate}"));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                attempt += 1;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

/// The name a file takes when the one it was handed is already somebody's: the
/// same name with a count in front of its extension, counted from the name it
/// was asked for rather than from the name before it, so the same request ends
/// up in the same name however the names around it are taken.
fn stepped_aside(filename: &str, attempt: usize) -> String {
    if attempt == 0 {
        return filename.to_string();
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(filename);
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) => format!("{stem}-{attempt}.{extension}"),
        None => format!("{stem}-{attempt}"),
    }
}

pub fn tmp_dir(project_root: &Path) -> PathBuf {
    project_root.join("tmp")
}

pub fn new_tmp_path(project_root: &Path) -> std::io::Result<PathBuf> {
    let dir = tmp_dir(project_root);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("upload-{}.bin", uuid::Uuid::now_v7())))
}

#[cfg(test)]
mod tests {
    use super::{asset_filename, promote, slugify};

    #[test]
    fn a_name_already_taken_is_stepped_aside_from() {
        let root = tempfile::tempdir().unwrap();
        let held = root.path().join("held.bin");
        std::fs::write(&held, b"the drawing already there").unwrap();
        let arriving = root.path().join("arriving.bin");
        std::fs::write(&arriving, b"the drawing that arrives later").unwrap();

        let first = promote(root.path(), &held, "images", "element-art-019b2f3c.png").unwrap();
        let second = promote(root.path(), &arriving, "images", "element-art-019b2f3c.png").unwrap();

        assert_eq!(first, "assets/images/element-art-019b2f3c.png");
        assert_eq!(second, "assets/images/element-art-019b2f3c-1.png");
        assert_eq!(
            std::fs::read(root.path().join(&first)).unwrap(),
            b"the drawing already there"
        );
        assert_eq!(
            std::fs::read(root.path().join(&second)).unwrap(),
            b"the drawing that arrives later"
        );

        // A name nobody holds is the name it takes, count and all left off.
        let alone = root.path().join("alone.bin");
        std::fs::write(&alone, b"alone").unwrap();
        assert_eq!(
            promote(root.path(), &alone, "images", "element-art-7d1e4b2a.png").unwrap(),
            "assets/images/element-art-7d1e4b2a.png"
        );
    }

    #[test]
    fn two_ids_that_share_a_head_still_name_two_files() {
        // Two ids issued in the same minute agree in their first characters:
        // an id spells when it was made. A tag taken from there is one tag for
        // both, which files one drawing over another.
        let one = asset_filename(
            "element art-019b2f3c",
            "image/png",
            "019b2f3c-1234-7abc-9def-0123456789ab",
        );
        let other = asset_filename(
            "element art-019b2f3c",
            "image/png",
            "019b2f3c-1234-7abc-9def-0123456789cd",
        );
        assert_ne!(one, other, "one batch's drawings are not one file");
        assert!(one.starts_with("element-art-019b2f3c-"), "{one}");
    }

    #[test]
    fn a_slug_keeps_the_words_of_its_name() {
        assert_eq!(slugify("My Film"), "my-film");
        assert_eq!(slugify("clip.png"), "clip");
        assert_eq!(slugify("_kept-as_is"), "_kept-as_is");
        assert_eq!(slugify("  padded  "), "padded");
    }

    #[test]
    fn letters_of_any_script_survive() {
        assert_eq!(slugify("中文项目"), "中文项目");
        assert_eq!(slugify("发布 预告片"), "发布-预告片");
        assert_eq!(slugify("Über Äpfel"), "über-äpfel");
    }

    #[test]
    fn a_slug_is_one_segment_and_never_a_way_out_of_it() {
        for name in ["../etc/passwd", "..\\..\\windows", "a/b", "!/$%"] {
            let slug = slugify(name);
            assert!(
                slug.chars()
                    .all(|ch| ch.is_alphanumeric() || ch == '-' || ch == '_'),
                "{name} became {slug}"
            );
        }
    }

    #[test]
    fn a_name_with_nothing_to_read_back_falls_back_to_one_word() {
        assert_eq!(slugify("!!! ???"), "asset");
        assert_eq!(slugify(""), "asset");
    }

    #[test]
    fn a_long_name_is_cut_to_what_a_folder_can_hold() {
        let slug = slugify(&"é".repeat(100));
        assert_eq!(slug.chars().count(), 60);
    }
}
