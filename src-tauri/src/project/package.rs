use crate::config::LimitsConfig;
use crate::domain::{id_tag, new_id, now_iso, AssetId, ASSET_CATEGORIES};
use crate::domain::{MokaFile, PACKAGE_MANIFEST_VERSION};
use crate::metadata::crypto;
use crate::metadata::docs;
use crate::project::codec::encode_moka_file;
use crate::project::store::normalize_relative;
use crate::project::{PackageReport, PackageScope, ProjectError};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifestEntry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

/// What a rule kept out of a package, counted as the walk went past it.
///
/// Collected rather than declared: a list of patterns stating what a package
/// never carries is a claim nobody checks, and the reason to name the skips at
/// all is that a receiver can hold them against what arrived.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSkip {
    /// The rule, stated as a path pattern where it has one. Not all of them do:
    /// which assets a small package leaves behind is decided by the document
    /// rather than by where they sit.
    pub rule: String,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    pub format_version: u32,
    pub app: String,
    pub exported_at: String,
    pub project_id: String,
    pub project_name: String,
    pub incomplete: bool,
    /// Whether the records of the runs that made this project travelled with it.
    ///
    /// Said outright rather than left to be noticed in the entries: a package
    /// carrying them carries the prompts they were asked with and the names of
    /// the models that answered, which is a thing the receiver is owed.
    #[serde(default)]
    pub personal_history: bool,
    #[serde(default)]
    pub skipped: Vec<PackageSkip>,
    pub entries: Vec<PackageManifestEntry>,
}

const MANIFEST_NAME: &str = "moka-package.json";
const OS_JUNK: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

/// The one file a package writes rather than copies.
const DOCUMENT_NAME: &str = "canvas.moka";

/// Where a job a provider is still running is noted, so the poll that collects
/// it can be placed again after a restart.
///
/// Local to the process that placed the job and to the machine it ran on: it is
/// addressed by a handle the far end issued, which a package opened somewhere
/// else could not ask after even if it were allowed to carry one.
const JOB_RECORDS: &str = "history/jobs/";

/// Where the record of each run this project made is kept.
///
/// Unlike a job, a record is finished and readable — it is also about this
/// machine's use of the project rather than about the project, so it travels
/// only in a package asked to carry it.
const RUN_RECORDS: &str = "history/runs/";

/// Application-level metadata documents that sit at the project root only.
/// Matching the whole relative path keeps an asset that happens to share a
/// name — a project may well contain its own `meta.json` — in the package.
const METADATA_DOCUMENTS: [&str; 5] = [
    docs::META_DOC,
    docs::RECENT_DOC,
    docs::MODELS_DOC,
    docs::LEGACY_PROVIDERS_DOC,
    docs::PROMPT_SOURCES_DOC,
];

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Which rule kept a path out of a package.
///
/// A rule rather than a pattern string, so the walk can total what each one cost
/// and the manifest can state it afterwards. Ordered only so that a manifest
/// lists the same rules in the same order every time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Skip {
    /// Scratch space, holding whatever a half-finished write left behind.
    Scratch,
    /// Drawings of the work's pictures, made to draw them small: they are
    /// remade from the files themselves wherever the work arrives.
    Cache,
    /// Where exports were asked to land: a reader's own copies of the work,
    /// which the work itself does not hold and a package has no business
    /// carrying — least of all the package that was exported there before.
    Output,
    /// A job a provider on this machine is still running.
    Job,
    /// The record of a run this machine made.
    Run,
    /// A credential, at any depth: nothing in a project tree has a legitimate
    /// reason to carry one.
    Secret,
    /// The key the credentials are sealed with, at any depth.
    MasterKey,
    /// A document this app put aside as unreadable.
    Corrupt,
    /// An asset no canvas points at, left behind by a package asked to carry
    /// only what is placed. Decided by the document rather than by the path.
    Unreferenced,
    /// An application-level document, which belongs at a project root only.
    /// Matched on the whole relative path, so an asset that happens to share a
    /// name — a project may well contain its own `meta.json` — still ships.
    ApplicationDocument(&'static str),
    /// What an operating system leaves in a directory it was shown.
    SystemJunk(&'static str),
}

impl Skip {
    /// The rule as a manifest names it.
    fn rule(&self) -> String {
        match self {
            Self::Scratch => "tmp/**".into(),
            Self::Output => "output/**".into(),
            Self::Job => format!("{JOB_RECORDS}**"),
            Self::Run => format!("{RUN_RECORDS}**"),
            Self::Secret => format!("**/{}", docs::SECRETS_DOC),
            Self::MasterKey => format!("**/{}", crypto::MASTER_KEY_FILE),
            Self::Corrupt => "**/*.corrupt.*".into(),
            Self::Cache => "cache/**".into(),
            Self::Unreferenced => "assets no canvas points at".into(),
            Self::ApplicationDocument(document) => (*document).to_string(),
            Self::SystemJunk(name) => format!("**/{name}"),
        }
    }
}

fn skipped(relative: &str, scope: &PackageScope) -> Option<Skip> {
    if relative == "tmp" || relative.starts_with("tmp/") {
        return Some(Skip::Scratch);
    }
    if relative == "output" || relative.starts_with("output/") {
        return Some(Skip::Output);
    }
    if relative == "cache" || relative.starts_with("cache/") {
        return Some(Skip::Cache);
    }
    if relative.starts_with(JOB_RECORDS) {
        return Some(Skip::Job);
    }
    if !scope.personal_history && relative.starts_with(RUN_RECORDS) {
        return Some(Skip::Run);
    }
    let name = relative.rsplit('/').next().unwrap_or(relative);
    if name == docs::SECRETS_DOC {
        return Some(Skip::Secret);
    }
    if name == crypto::MASTER_KEY_FILE {
        return Some(Skip::MasterKey);
    }
    if name.contains(".corrupt.") {
        return Some(Skip::Corrupt);
    }
    if let Some(document) = METADATA_DOCUMENTS
        .iter()
        .copied()
        .find(|one| *one == relative)
    {
        return Some(Skip::ApplicationDocument(document));
    }
    OS_JUNK
        .iter()
        .copied()
        .find(|one| *one == name)
        .map(Skip::SystemJunk)
}

/// A path as the package would name it, which is always with forward slashes.
fn relative_to(root: &Path, path: &Path) -> Result<String, ProjectError> {
    Ok(path
        .strip_prefix(root)
        .map_err(|_| ProjectError::domain("INTERNAL", "Path outside root"))?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// How many files a path holds and what they add up to, without reading them.
///
/// A directory left out whole still has a size, and a manifest that reported
/// only the paths the walk itself reached would understate every one of them.
fn measure(path: &Path) -> (u64, u64) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (0, 0);
    };
    if meta.is_file() {
        return (1, meta.len());
    }
    let mut files = 0;
    let mut bytes = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(path);
            } else {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    (files, bytes)
}

/// What the walk of a project tree found, and what keeping the rest out cost.
struct Collected {
    files: Vec<PathBuf>,
    skips: BTreeMap<Skip, (u64, u64)>,
}

fn collect_files(
    root: &Path,
    scope: &PackageScope,
    left_behind: &BTreeSet<String>,
) -> Result<Collected, ProjectError> {
    let mut collected = Collected {
        files: Vec::new(),
        skips: BTreeMap::new(),
    };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let relative = relative_to(root, &path)?;
            let rule = skipped(&relative, scope).or_else(|| {
                left_behind
                    .contains(&relative)
                    .then_some(Skip::Unreferenced)
            });
            if let Some(rule) = rule {
                let (files, bytes) = measure(&path);
                let total = collected.skips.entry(rule).or_default();
                total.0 += files;
                total.1 += bytes;
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                collected.files.push(path);
            }
        }
    }
    collected.files.sort();
    Ok(collected)
}

/// The document as a package carries it.
///
/// Named field by field rather than found by walking the encoded bytes for
/// names to strike out: somebody's prompt may well contain the word `runId`,
/// and what they typed is not this function's to judge.
///
/// A full backup keeps the record of how the project was made. A package asked
/// to hold only what is placed keeps the registry down to the assets a canvas
/// points at, which is a choice about size rather than about anybody's history,
/// so the two are decided separately and can be asked for together.
///
/// The same rule reads in both directions. An export asks it what to write; an
/// import asks it what an arriving package is allowed to have brought, since a
/// build older than this one may have written more than today's rule keeps.
fn carried_document(moka: &MokaFile, scope: &PackageScope) -> MokaFile {
    let mut document = moka.clone();
    if !scope.personal_history {
        for entry in document.resources.all_mut() {
            if let Some(provenance) = entry.provenance.as_mut() {
                // The one reference a package cannot honour: the record of the run
                // stayed on the machine that made it. Which canvas and which node
                // asked, what was handed over and what came back all still resolve
                // inside the package, and asking the same way again is built from
                // them — so only the dangling one goes.
                provenance.run_id = None;
                // The conversation that asked for it went with the run, so the
                // reference to it goes for the same reason.
                provenance.assistant_session_id = None;
            }
        }
        // What was said over a board is not part of the work on it: a package
        // holds the cards, the wires and the assets, and whoever opens it starts
        // their own conversation. The making of the cards survives in what is
        // placed, which is the part worth handing over.
        for canvas in &mut document.canvas {
            canvas.sessions = None;
        }
    }
    if scope.referenced_assets_only {
        let placed = document.asset_references();
        for category in ASSET_CATEGORIES {
            if let Some(entries) = document.resources.category_mut(category) {
                entries.retain(|entry| placed.contains_key(&entry.id));
            }
        }
        // An asset left behind is a reference the package cannot honour either,
        // so the ones that stay stop naming it.
        for entry in document.resources.all_mut() {
            let Some(provenance) = entry.provenance.as_mut() else {
                continue;
            };
            let Some(inputs) = provenance.input_asset_ids.as_ref() else {
                continue;
            };
            let kept: Vec<AssetId> = inputs
                .iter()
                .filter(|id| placed.contains_key(*id))
                .cloned()
                .collect();
            provenance.input_asset_ids = (!kept.is_empty()).then_some(kept);
        }
    }
    document
}

/// The paths of assets a package leaves on this machine.
///
/// Empty unless the package was asked to be small. Both the registry entry and
/// the file have to go together: an entry whose file is missing reads as damage
/// to whoever opens the package next, and a file nobody listed reads as nothing
/// at all.
fn left_behind(moka: &MokaFile, document: &MokaFile) -> BTreeSet<String> {
    let kept: BTreeSet<&str> = document
        .resources
        .all()
        .map(|entry| entry.path.as_str())
        .collect();
    moka.resources
        .all()
        .map(|entry| entry.path.clone())
        .filter(|path| !kept.contains(path.as_str()))
        .collect()
}

/// The bytes a package carries for a path.
///
/// Everything is read off disk except the document, which is written from the
/// copy above. The sizes and hashes in the manifest are computed from these
/// same bytes, so what a package says it carries and what it carries cannot
/// drift apart.
fn entry_bytes(root: &Path, relative: &str, document: &[u8]) -> Result<Vec<u8>, ProjectError> {
    if relative == DOCUMENT_NAME {
        return Ok(document.to_vec());
    }
    Ok(std::fs::read(root.join(relative))?)
}

pub fn export_project(
    root: &Path,
    moka: &MokaFile,
    destination: &Path,
    limits: &LimitsConfig,
    allow_incomplete: bool,
    scope: PackageScope,
) -> Result<PackageReport, ProjectError> {
    let document = carried_document(moka, &scope);
    let collected = collect_files(root, &scope, &left_behind(moka, &document))?;

    // Completeness: everything the package carries must be there to carry. An
    // asset left behind because no canvas points at it is not missing from a
    // package that never claimed it.
    let mut missing = Vec::new();
    for entry in document.resources.all() {
        if !root.join(&entry.path).is_file() {
            missing.push(entry.path.clone());
        }
    }
    if !missing.is_empty() && !allow_incomplete {
        return Err(ProjectError::domain(
            "ASSET_MISSING",
            format!(
                "Export blocked: {} referenced asset(s) are missing",
                missing.len()
            ),
        ));
    }

    let encoded = encode_moka_file(&document, None)?;
    let mut entries = Vec::new();
    for file in &collected.files {
        let relative = relative_to(root, file)?;
        let bytes = entry_bytes(root, &relative, &encoded)?;
        entries.push(PackageManifestEntry {
            path: relative,
            bytes: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
        });
        if entries.len() > limits.max_package_entries {
            return Err(ProjectError::domain(
                "PAYLOAD_TOO_LARGE",
                "The project has too many files to export",
            ));
        }
    }
    let total: u64 = entries.iter().map(|entry| entry.bytes).sum();
    if total > limits.max_package_bytes {
        return Err(ProjectError::domain(
            "PAYLOAD_TOO_LARGE",
            "The project is too large to export",
        ));
    }

    let manifest = PackageManifest {
        format_version: PACKAGE_MANIFEST_VERSION,
        app: format!("moka-canvas/{}", env!("CARGO_PKG_VERSION")),
        exported_at: now_iso(),
        project_id: moka.metadata.id.clone(),
        project_name: moka.metadata.name.clone(),
        incomplete: !missing.is_empty(),
        personal_history: scope.personal_history,
        // A rule that found nothing to keep out has nothing to say: which kind
        // of package this is is the flag above, not a row of zeroes.
        skipped: collected
            .skips
            .into_iter()
            .filter(|(_, (files, _))| *files > 0)
            .map(|(skip, (files, bytes))| PackageSkip {
                rule: skip.rule(),
                files,
                bytes,
            })
            .collect(),
        entries,
    };

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = destination.with_extension("zip.tmp");
    let outcome = (|| -> Result<PackageReport, ProjectError> {
        let file = std::fs::File::create(&tmp)?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest_json = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| ProjectError::domain("INTERNAL", error.to_string()))?;
        writer.start_file(MANIFEST_NAME, options)?;
        writer.write_all(&manifest_json)?;
        for entry in &manifest.entries {
            writer.start_file(&entry.path, options)?;
            writer.write_all(&entry_bytes(root, &entry.path, &encoded)?)?;
        }
        writer.finish()?;
        Ok(PackageReport {
            destination: destination.to_path_buf(),
            entries: manifest.entries.len(),
            bytes: total,
            incomplete: manifest.incomplete,
        })
    })();
    if outcome.is_ok() {
        std::fs::rename(&tmp, destination)?;
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
    outcome
}

fn staging_dir_for(target_root: &Path) -> PathBuf {
    target_root
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".moka-import-{}", id_tag(&new_id(), 8)))
}

pub fn import_project(
    archive: &Path,
    target_root: &Path,
    limits: &LimitsConfig,
) -> Result<(), ProjectError> {
    let file = std::fs::File::open(archive).map_err(|error| {
        ProjectError::domain(
            "PACKAGE_INVALID",
            format!("Cannot open package {}: {error}", archive.display()),
        )
    })?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|error| ProjectError::domain("PACKAGE_INVALID", error.to_string()))?;

    if zip.len() > limits.max_package_entries {
        return Err(ProjectError::domain(
            "PAYLOAD_TOO_LARGE",
            "Package has too many entries",
        ));
    }

    // Validate all entry names before writing anything.
    let mut names = Vec::new();
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|error| ProjectError::domain("PACKAGE_INVALID", error.to_string()))?;
        let name = entry.name().replace('\\', "/");
        if entry.is_dir() {
            continue;
        }
        if normalize_relative(&name).is_none() || name.starts_with('/') || name.contains(':') {
            return Err(ProjectError::domain(
                "PACKAGE_INVALID",
                format!("Package entry escapes the target: {name}"),
            ));
        }
        if entry.size() > limits.max_package_bytes {
            return Err(ProjectError::domain(
                "PAYLOAD_TOO_LARGE",
                format!("Package entry is too large: {name}"),
            ));
        }
        names.push(name);
    }

    let staging = staging_dir_for(target_root);
    let outcome = (|| -> Result<(), ProjectError> {
        std::fs::create_dir_all(&staging)?;
        let mut manifest: Option<PackageManifest> = None;
        let mut total: u64 = 0;
        for name in &names {
            let mut entry = zip
                .by_name(name)
                .map_err(|error| ProjectError::domain("PACKAGE_INVALID", error.to_string()))?;
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes)?;
            total += bytes.len() as u64;
            if total > limits.max_package_bytes {
                return Err(ProjectError::domain(
                    "PAYLOAD_TOO_LARGE",
                    "Package expands beyond the configured limit",
                ));
            }
            if name == MANIFEST_NAME {
                manifest = Some(serde_json::from_slice(&bytes).map_err(|error| {
                    ProjectError::domain(
                        "PACKAGE_INVALID",
                        format!("Package manifest is invalid: {error}"),
                    )
                })?);
                continue;
            }
            let target = staging.join(name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&target, &bytes)?;
        }

        let manifest = manifest.ok_or_else(|| {
            ProjectError::domain(
                "PACKAGE_INVALID",
                "Package has no moka-package.json manifest",
            )
        })?;
        // A range rather than an equality: a package made by an earlier build is
        // still a package, and refusing it would refuse work somebody has on
        // disk. What an older one may carry that a newer one may not is dealt
        // with below, not by turning it away at the door.
        if manifest.format_version == 0 || manifest.format_version > PACKAGE_MANIFEST_VERSION {
            return Err(ProjectError::domain(
                "MOKA_VERSION_UNSUPPORTED",
                format!(
                    "Package format {} is not supported: this build reads 1 to {}",
                    manifest.format_version, PACKAGE_MANIFEST_VERSION
                ),
            ));
        }

        // Verify manifest hashes against the staged content.
        for entry in &manifest.entries {
            if entry.path == MANIFEST_NAME {
                continue;
            }
            let staged = staging.join(&entry.path);
            let bytes = std::fs::read(&staged).map_err(|_| {
                ProjectError::domain(
                    "PACKAGE_INVALID",
                    format!("Package entry is missing: {}", entry.path),
                )
            })?;
            if bytes.len() as u64 != entry.bytes || sha256_hex(&bytes) != entry.sha256 {
                return Err(ProjectError::domain(
                    "PACKAGE_INVALID",
                    format!("Package entry failed verification: {}", entry.path),
                ));
            }
        }

        // The staged tree must itself be a valid project before committing.
        let moka_path = staging.join(DOCUMENT_NAME);
        let moka_bytes = std::fs::read(&moka_path).map_err(|_| {
            ProjectError::domain("PACKAGE_INVALID", "Package contains no canvas.moka")
        })?;
        let document = crate::project::codec::decode_moka_file(&moka_bytes)?;

        // Cleaning comes after verification rather than during staging: the
        // hashes prove what arrived is what was sent, and that question is worth
        // answering about the package as it was made. What is kept is a separate
        // question, asked of this build's rule. A manifest that does not say it
        // carried the runs is taken at its word — including one old enough to
        // have no such field, which is what the range check above is for.
        if !manifest.personal_history {
            let runs = staging.join(RUN_RECORDS);
            if runs.is_dir() {
                std::fs::remove_dir_all(&runs)?;
            }
            let carried = carried_document(&document, &PackageScope::default());
            if carried != document {
                std::fs::write(&moka_path, encode_moka_file(&carried, None)?)?;
            }
        }

        if target_root.exists() && target_root.read_dir()?.next().is_some() {
            return Err(ProjectError::domain(
                "CONFLICT",
                format!("Target directory is not empty: {}", target_root.display()),
            ));
        }
        if target_root.exists() {
            std::fs::remove_dir(target_root)?;
        }
        std::fs::rename(&staging, target_root)?;
        Ok(())
    })();

    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    outcome
}

pub fn asset_categories() -> &'static [&'static str] {
    &ASSET_CATEGORIES
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        derive_ports, AssetProvenance, AssistantMessage, AssistantReference, AssistantRole,
        AssistantSession, AssistantToolCall, CanvasDocument, NodeData, NodeKind, ProjectMetadata,
        Rect, ResourceEntry, ResourceRegistry, WorkflowNode, MOKA_FILE_VERSION,
    };

    /// The package an export makes unless it is asked for more.
    const WORK: PackageScope = PackageScope {
        personal_history: false,
        referenced_assets_only: false,
    };

    /// The package a user asks for when moving their own project elsewhere.
    const BACKUP: PackageScope = PackageScope {
        personal_history: true,
        referenced_assets_only: false,
    };

    fn ships(relative: &str, scope: &PackageScope) -> bool {
        skipped(relative, scope).is_none()
    }

    #[test]
    fn application_metadata_is_never_collected() {
        for relative in [
            "meta.json",
            "recent-projects.json",
            "providers.json",
            "prompts/sources.json",
            "secrets.json",
            "master.key",
            "assets/secrets.json",
            "nested/master.key",
            "recent-projects.corrupt.20260101T000000Z.json",
        ] {
            // Under either kind of package: a credential is not this machine's
            // history to carry, and asking for that history does not ask for one.
            for scope in [&WORK, &BACKUP] {
                assert!(!ships(relative, scope), "{relative} must not be packaged");
            }
        }
    }

    #[test]
    fn an_asset_sharing_a_metadata_name_still_ships() {
        // Only the credential documents are excluded at any depth; the rest are
        // matched on the whole relative path so project content is untouched.
        for relative in [
            "assets/meta.json",
            "assets/providers.json",
            "notes/sources.json",
        ] {
            assert!(ships(relative, &WORK), "{relative} is project content");
        }
    }

    #[test]
    fn scratch_and_os_junk_are_never_collected() {
        for relative in [
            "tmp/partial",
            "tmp",
            ".DS_Store",
            "assets/.DS_Store",
            "Thumbs.db",
        ] {
            assert!(!ships(relative, &WORK), "{relative} must not be packaged");
        }
    }

    /// Drawings of the work's pictures are made for the lists that draw them
    /// small, and are made again from the files wherever the work arrives.
    #[test]
    fn drawings_of_the_work_are_not_the_work() {
        for relative in ["cache", "cache/thumbs/a1-320-01234567.jpg"] {
            assert!(!ships(relative, &WORK), "{relative} must not be packaged");
            assert!(!ships(relative, &BACKUP), "{relative} must not be packaged");
        }
        assert_eq!(
            skipped("cache/thumbs/a1-320-01234567.jpg", &WORK),
            Some(Skip::Cache)
        );
    }

    /// Where exports were saved is a reader's own copy of the work, and a
    /// package carries the work: never a copy, and least of all the package
    /// that was exported there before.
    #[test]
    fn an_export_never_lands_in_a_package() {
        for relative in [
            "output",
            "output/Cut.mokapkg.zip",
            "output/Cut.mp4",
            "output/nested/picture.png",
        ] {
            assert!(!ships(relative, &WORK), "{relative} must not be packaged");
            assert!(!ships(relative, &BACKUP), "{relative} must not be packaged");
        }
        // A folder that merely shares the name is project content, wherever it
        // sits — the exclusion is the project root's own output folder.
        for relative in ["assets/output.png", "notes/output/notes.txt"] {
            assert!(ships(relative, &WORK), "{relative} is project content");
        }
    }

    #[test]
    fn a_run_this_machine_made_travels_only_in_a_package_that_asked_for_it() {
        let record = "history/runs/0192b7d4-0000-7000-8000-000000000000.json";
        assert_eq!(skipped(record, &WORK), Some(Skip::Run));
        assert!(ships(record, &BACKUP), "a backup carries its own history");
        // A job is a handle on a provider only this machine could ask after, so
        // it stays behind whichever way the package was asked for.
        assert_eq!(
            skipped(
                "history/jobs/0192b7d4-0000-7000-8000-000000000000.json",
                &BACKUP
            ),
            Some(Skip::Job)
        );
    }

    /// The run that made one of the fixture's assets.
    const RUN: &str = "0192b7d4-0000-7000-8000-000000000001";

    /// The conversation that asked for it.
    const SESSION: &str = "0192b7d4-0000-7000-8000-000000000002";

    fn entry(id: &str, name: &str, provenance: Option<AssetProvenance>) -> ResourceEntry {
        ResourceEntry {
            id: id.to_string(),
            name: name.to_string(),
            path: format!("assets/{name}"),
            mime: Some("image/png".to_string()),
            bytes: Some(12),
            sha256: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            probe: None,
            provenance,
            tags: None,
            note: None,
            favorite: None,
            origin: None,
            keyword: None,
        }
    }

    fn line(id: &str, role: AssistantRole, text: &str, second: u32) -> AssistantMessage {
        AssistantMessage {
            id: id.to_string(),
            role,
            text: text.to_string(),
            created_at: format!("2026-01-01T00:00:{second:02}Z"),
            references: None,
            tool_calls: None,
            failure: None,
        }
    }

    /// A project holding an asset a run made and placed on a canvas, one
    /// somebody brought in and left on the shelf, and the conversation the work
    /// was asked for in.
    fn fixture() -> MokaFile {
        let made = entry(
            "asset-made",
            "made.png",
            Some(AssetProvenance {
                run_id: Some(RUN.to_string()),
                canvas_id: Some("canvas-1".to_string()),
                operation_node_id: Some("node-1".to_string()),
                assistant_session_id: Some(SESSION.to_string()),
                story_job_id: None,
                story_id: None,
                input_asset_ids: Some(vec!["asset-brought".to_string()]),
                parameter_snapshot: Some(serde_json::json!({
                    "model": "a-model",
                    "prompt": "a lake at dusk, exactly as it was typed",
                })),
                created_at: "2026-01-01T00:00:00Z".to_string(),
            }),
        );
        let brought = entry("asset-brought", "brought.png", None);
        let now = now_iso();
        let mut canvas = CanvasDocument::empty("canvas-1".to_string(), "Canvas 1".to_string());
        canvas.nodes = vec![WorkflowNode {
            id: "node-1".to_string(),
            kind: NodeKind::Image,
            title: "Lake".to_string(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 280.0,
                height: 200.0,
            },
            z_index: 0,
            ports: derive_ports(NodeKind::Image),
            data: NodeData {
                asset_id: Some("asset-made".to_string()),
                ..NodeData::default()
            },
            created_at: now.clone(),
            updated_at: now.clone(),
        }];
        canvas.sessions = Some(vec![AssistantSession {
            id: SESSION.to_string(),
            title: "The lake at dusk".to_string(),
            messages: vec![
                line(
                    "message-asked",
                    AssistantRole::User,
                    "Paint the lake at dusk",
                    0,
                ),
                AssistantMessage {
                    references: Some(vec![AssistantReference {
                        node_id: "node-1".to_string(),
                        title: "Lake".to_string(),
                        kind: NodeKind::Image,
                        asset_id: Some("asset-made".to_string()),
                    }]),
                    tool_calls: Some(vec![AssistantToolCall {
                        run_id: RUN.to_string(),
                        node_id: Some("node-1".to_string()),
                        summary: "Painted the lake".to_string(),
                    }]),
                    ..line(
                        "message-answered",
                        AssistantRole::Assistant,
                        "Here is the lake, at dusk.",
                        1,
                    )
                },
            ],
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:01Z".to_string(),
        }]);
        MokaFile {
            version: MOKA_FILE_VERSION.to_string(),
            metadata: ProjectMetadata {
                id: "project-1".to_string(),
                name: "Project".to_string(),
                description: None,
                cover_path: None,
                revision: 1,
                created_at: now.clone(),
                updated_at: now,
            },
            resources: ResourceRegistry {
                images: vec![made, brought],
                ..ResourceRegistry::default()
            },
            folders: None,
            timelines: None,
            stories: None,
            canvas: vec![canvas],
        }
    }

    /// Whether a name reaches the bytes a package writes.
    ///
    /// Read off the encoding rather than off the fields: what is not in the
    /// bytes did not travel, whichever field it might have been hiding in.
    fn carries(document: &MokaFile, scope: &PackageScope, needle: &str) -> bool {
        let bytes = encode_moka_file(&carried_document(document, scope), None).unwrap();
        bytes
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    }

    #[test]
    fn a_package_of_the_work_keeps_the_making_but_not_the_run() {
        let fixture = fixture();
        for (needle, work, backup) in [
            // The run is the one thing a package cannot point back at: its
            // record stayed on the machine that made it.
            ("runId", false, true),
            (RUN, false, true),
            // What was said over the board is the record of asking rather than
            // part of what was asked for, and it goes with the run.
            ("sessions", false, true),
            (SESSION, false, true),
            ("assistantSessionId", false, true),
            ("Paint the lake at dusk", false, true),
            // How it was asked for is the reusable part, which is the reason a
            // package of the work is worth handing over at all.
            ("parameterSnapshot", true, true),
            ("a lake at dusk, exactly as it was typed", true, true),
            ("a-model", true, true),
            // Which canvas and which node asked both still resolve inside the
            // package, so asking the same way again survives the move.
            ("canvasId", true, true),
            ("operationNodeId", true, true),
            ("inputAssetIds", true, true),
            ("asset-brought", true, true),
            // The work, and the project it belongs to.
            ("assets/made.png", true, true),
            ("project-1", true, true),
        ] {
            assert_eq!(
                carries(&fixture, &WORK, needle),
                work,
                "{needle} in a package of the work"
            );
            assert_eq!(
                carries(&fixture, &BACKUP, needle),
                backup,
                "{needle} in a full backup"
            );
        }
    }

    #[test]
    fn a_prompt_that_says_the_word_is_not_a_reference_to_strike_out() {
        let mut fixture = fixture();
        let provenance = fixture
            .resources
            .find_mut("asset-made")
            .unwrap()
            .provenance
            .as_mut()
            .unwrap();
        provenance.parameter_snapshot =
            Some(serde_json::json!({ "prompt": "a sign that reads runId, at dusk" }));

        let redacted = carried_document(&fixture, &WORK);
        let snapshot = &redacted
            .resources
            .find("asset-made")
            .unwrap()
            .provenance
            .as_ref()
            .unwrap()
            .parameter_snapshot;
        assert_eq!(
            snapshot.as_ref().and_then(|one| one["prompt"].as_str()),
            Some("a sign that reads runId, at dusk"),
            "what somebody typed is not this function's to edit"
        );
        assert_eq!(
            redacted
                .resources
                .find("asset-made")
                .unwrap()
                .provenance
                .as_ref()
                .unwrap()
                .run_id,
            None,
            "the field itself still goes"
        );
    }

    #[test]
    fn a_full_backup_writes_the_document_it_was_given() {
        let fixture = fixture();
        assert_eq!(carried_document(&fixture, &BACKUP), fixture);
    }

    #[test]
    fn redacting_a_copy_leaves_the_project_on_this_machine_alone() {
        let fixture = fixture();
        let _ = carried_document(&fixture, &WORK);
        assert_eq!(
            fixture
                .resources
                .find("asset-made")
                .unwrap()
                .provenance
                .as_ref()
                .unwrap()
                .run_id
                .as_deref(),
            Some(RUN),
            "what is known here is not a package's to forget"
        );
    }

    /// The package a user asks for when the size of it matters more than the
    /// shelf of material nobody has placed yet.
    const PLACED_ONLY: PackageScope = PackageScope {
        personal_history: false,
        referenced_assets_only: true,
    };

    #[test]
    fn a_small_package_drops_the_shelf_and_the_names_pointing_at_it() {
        let fixture = fixture();
        let small = carried_document(&fixture, &PLACED_ONLY);

        let carried: Vec<&str> = small
            .resources
            .all()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(
            carried,
            vec!["asset-made"],
            "what no canvas points at stays"
        );
        assert_eq!(
            left_behind(&fixture, &small)
                .into_iter()
                .collect::<Vec<_>>(),
            vec!["assets/brought.png".to_string()],
            "and its file goes with the entry, or the package opens as damaged"
        );
        let provenance = small
            .resources
            .find("asset-made")
            .unwrap()
            .provenance
            .as_ref()
            .unwrap();
        assert_eq!(
            provenance.input_asset_ids, None,
            "what stays stops naming what went"
        );
        assert_eq!(
            provenance.run_id, None,
            "asking for a small package does not ask for anybody's history"
        );
    }

    #[test]
    fn a_package_nobody_asked_to_be_small_keeps_the_whole_shelf() {
        let fixture = fixture();
        assert!(left_behind(&fixture, &carried_document(&fixture, &WORK)).is_empty());
    }

    #[test]
    fn the_two_choices_are_made_separately() {
        let fixture = fixture();
        let small_backup = carried_document(
            &fixture,
            &PackageScope {
                personal_history: true,
                referenced_assets_only: true,
            },
        );
        let provenance = small_backup
            .resources
            .find("asset-made")
            .unwrap()
            .provenance
            .as_ref()
            .unwrap();
        assert_eq!(
            provenance.run_id.as_deref(),
            Some(RUN),
            "a backup keeps the record of how it was made"
        );
        assert_eq!(
            small_backup.resources.all().count(),
            1,
            "and can still be asked to travel light"
        );
    }
}
