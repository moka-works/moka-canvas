//! What one directory holds, and where a save lands, for the runtime that has
//! no file dialog of its own.
//!
//! A desktop asks the operating system which folder a reader means. A browser
//! cannot ask anything, and a reader who has to type a path out by hand is a
//! reader who has to know it already — so the listing that stands in for the
//! dialog is served from here instead.
//!
//! What leaves this module by the listing is names and where they lead. Nothing
//! is read, and no question about a file's contents is answered: a listing says
//! what a directory holds and stops there. Two rules keep it that small:
//!
//! - an entry whose name begins with a dot is left out, which keeps the
//!   dot-directories a home is full of out of a list meant for choosing a
//!   project from, and keeps a listing from being a way of reading what
//!   configuration a machine holds;
//! - a file is listed only when its extension was asked for, so a listing with
//!   no extensions asked for is a listing of folders — which is what a dialog
//!   choosing somewhere to put a new project wants, and why the answer then
//!   carries no file at all rather than every file there is.
//!
//! Only the web runtime is served a listing. The desktop one has a real dialog,
//! and a loopback server answering a question nobody there needs to ask is a
//! wider surface than a narrower one for the same price.
//!
//! A write is the other half of the same question, and it is served to both
//! runtimes: whichever dialog named the path, the window holding the bytes
//! cannot put them on this machine's disk itself. It writes only into a folder
//! that is already there, under a temporary name that is renamed into place, so
//! a save that fails leaves nothing behind.

use std::path::{Path, PathBuf};

use thiserror::Error;
use tokio::io::AsyncWriteExt;

use super::dto::{FilesystemEntry, FilesystemListing};

/// How many entries one listing carries.
///
/// A directory with more in it than this is not one anybody reads as a list,
/// and the answer would be a wall of names for a screen showing forty of them.
/// The listing says it stopped rather than looking as though it finished.
pub const MAX_ENTRIES: usize = 1000;

/// What a listing could not be.
#[derive(Debug, Error)]
pub enum BrowseError {
    /// A path that is not absolute, so there is nothing to resolve it against.
    #[error("{0} is not an absolute path")]
    Relative(String),
    /// A path that is there, and is not a directory.
    #[error("{0} is not a directory")]
    NotADirectory(String),
    /// A directory that would not open, or a path that resolves to nothing.
    #[error("{path}: {reason}")]
    Unreadable { path: String, reason: String },
    /// Neither a home directory nor a working one to open the dialog at.
    #[error("no directory to start from could be found")]
    NoStartingPoint,
}

impl BrowseError {
    /// The code an answer is given.
    ///
    /// A directory that would not open answers as one that is not there. Which
    /// of the two it is says something about this machine's filesystem to
    /// whoever asked, and nothing they need: all the dialog can show either way
    /// is that it cannot go there.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Relative(_) | Self::NotADirectory(_) => "VALIDATION_FAILED",
            Self::Unreadable { .. } | Self::NoStartingPoint => "NOT_FOUND",
        }
    }
}

/// Lists one directory: the folders in it, and the files whose extension was
/// asked for.
///
/// A `path` left empty opens the listing at the reader's home directory, which
/// is where a folder somebody means by "mine" usually is. The answer names the
/// directory it settled on either way, so a dialog shows where it is rather
/// than guessing.
pub async fn list(
    path: Option<&str>,
    extensions: Option<&str>,
) -> Result<FilesystemListing, BrowseError> {
    let directory = resolve(path).await?;
    let wanted = wanted_extensions(extensions);
    let mut read = tokio::fs::read_dir(&directory)
        .await
        .map_err(|source| unreadable(&directory, source))?;

    let mut entries: Vec<FilesystemEntry> = Vec::new();
    let mut truncated = false;
    loop {
        let found = read
            .next_entry()
            .await
            .map_err(|source| unreadable(&directory, source))?;
        let Some(found) = found else { break };
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        if let Some(entry) = listed(&found, &wanted).await {
            entries.push(entry);
        }
    }

    // Folders before files, and each in the order a name is read rather than
    // the order a directory happens to keep them in: a listing that changes
    // order between two visits is one nobody can find their way back into.
    entries.sort_by(|one, other| {
        (one.kind != DIRECTORY)
            .cmp(&(other.kind != DIRECTORY))
            .then_with(|| {
                one.name
                    .to_lowercase()
                    .cmp(&other.name.to_lowercase())
                    .then_with(|| one.name.cmp(&other.name))
            })
    });

    Ok(FilesystemListing {
        parent: directory.parent().map(displayed),
        path: displayed(&directory),
        entries,
        truncated,
    })
}

/// What a listing calls the two kinds of thing it can hold.
pub const DIRECTORY: &str = "directory";
pub const FILE: &str = "file";

/// The extensions worth showing beside the folders, from one comma-separated
/// question mark's worth of query string.
///
/// Compared in lower case, since an extension is not the one place where
/// capital letters mean something, and a `.MOKA` is a `.moka`.
pub fn wanted_extensions(asked: Option<&str>) -> Vec<String> {
    let Some(asked) = asked else {
        return Vec::new();
    };
    asked
        .split(',')
        .map(|one| one.trim().trim_start_matches('.').to_lowercase())
        .filter(|one| !one.is_empty())
        .collect()
}

/// The directory a listing is of, resolved.
///
/// A path that was typed is taken as it stands — a reader who typed one means
/// that one — with `~` expanded, because it is the one shorthand a home
/// directory is universally known by and the one a browser's own address bar
/// taught everybody. A relative path is refused rather than resolved against
/// the server's working directory, which is wherever the process happened to
/// be started and nothing a reader can see.
async fn resolve(path: Option<&str>) -> Result<PathBuf, BrowseError> {
    let Some(typed) = path.map(str::trim).filter(|typed| !typed.is_empty()) else {
        return starting_point().await;
    };
    let asked = expand_home(typed);
    let asked_display = displayed(&asked);
    if asked.is_relative() {
        return Err(BrowseError::Relative(asked_display));
    }
    // Resolved through the filesystem rather than by hand: a symlinked home
    // (`/var` for `/private/var` on a Mac) has to come back as the one path it
    // is, or the listing's own parent would lead somewhere else each time.
    let resolved =
        tokio::fs::canonicalize(&asked)
            .await
            .map_err(|source| BrowseError::Unreadable {
                path: asked_display.clone(),
                reason: source.to_string(),
            })?;
    if !is_directory(&resolved).await {
        return Err(BrowseError::NotADirectory(displayed(&resolved)));
    }
    Ok(resolved)
}

/// Where a listing opens when nobody named one.
async fn starting_point() -> Result<PathBuf, BrowseError> {
    let home = directories::UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
    if let Some(home) = home {
        if is_directory(&home).await {
            return Ok(tokio::fs::canonicalize(&home).await.unwrap_or(home));
        }
    }
    // A server with no home directory of its own — a container run as a user
    // that has none — still has somewhere to start: where it was started.
    let Some(cwd) = tokio::fs::canonicalize(".").await.ok() else {
        return Err(BrowseError::NoStartingPoint);
    };
    Ok(cwd)
}

async fn is_directory(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|meta| meta.is_dir())
}

/// One entry of a directory, when it is one the listing offers.
///
/// `None` is an entry left out rather than an entry gone wrong: a name that
/// begins with a dot, a file of a kind nobody asked for, a symlink pointing at
/// nothing, and a name this cannot say in text are all left out quietly. A
/// directory holding one unreadable thing is still a directory worth listing,
/// and a dialog that failed because of a single odd file in it would be a
/// dialog nobody could use.
async fn listed(found: &tokio::fs::DirEntry, wanted: &[String]) -> Option<FilesystemEntry> {
    let name = found.file_name().into_string().ok()?;
    if name.starts_with('.') {
        return None;
    }
    let path = found.path();
    // A symlink is answered as what it points at, since that is what a reader
    // means by it; one that points at nothing is left out, because a row that
    // cannot be opened is a row that should not be offered.
    let meta = tokio::fs::metadata(&path).await.ok()?;
    let kind = if meta.is_dir() {
        DIRECTORY
    } else if meta.is_file() {
        // A file is offered only when its extension was asked for, so a
        // listing that asked for none — a folder picker's question — carries
        // no file at all rather than every file a directory happens to hold.
        if !extension_of(&path).is_some_and(|one| wanted.contains(&one)) {
            return None;
        }
        FILE
    } else {
        return None;
    };
    Some(FilesystemEntry {
        kind,
        name,
        path: displayed(&path),
    })
}

/// The extension a file is filed under, in the case the comparison is made in.
fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|one| one.to_str())
        .map(|one| one.to_lowercase())
}

/// `~` at the front of a typed path, as the home directory it stands for.
///
/// A path with no home directory to expand against is returned as it was
/// rather than failed: what it means is then the filesystem's answer, and the
/// listing says which one it got.
fn expand_home(typed: &str) -> PathBuf {
    let Some(rest) = typed.strip_prefix('~') else {
        return PathBuf::from(typed);
    };
    // `~` alone, `~/Movies`, and the Windows `~\Movies` all mean the same
    // place; anything else that begins with the character is a name and not a
    // shorthand, and is left for the filesystem to refuse.
    if !rest.is_empty() && !rest.starts_with(['/', '\\']) {
        return PathBuf::from(typed);
    }
    let Some(home) = directories::UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf()) else {
        return PathBuf::from(typed);
    };
    home.join(rest.trim_start_matches(['/', '\\']))
}

fn displayed(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn unreadable(directory: &Path, source: std::io::Error) -> BrowseError {
    BrowseError::Unreadable {
        path: displayed(directory),
        reason: source.to_string(),
    }
}

/// What a write could not be.
#[derive(Debug, Error)]
pub enum WriteError {
    /// A path that is not absolute, so there is nothing to resolve it against.
    #[error("{0} is not an absolute path")]
    Relative(String),
    /// A path that names a directory rather than a file to write.
    #[error("{0} is a directory")]
    IsADirectory(String),
    /// A folder the destination would have to land in that is not there.
    ///
    /// A save never invents a folder: every dialog that produces a destination
    /// only offers folders that already exist, so a missing one is a caller's
    /// mistake rather than a case to paper over.
    #[error("{} does not exist", .0.display())]
    NoParent(PathBuf),
    /// A file that would not be written.
    #[error("{path}: {reason}")]
    Io { path: String, reason: String },
}

impl WriteError {
    /// The code an answer is given.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Relative(_) | Self::IsADirectory(_) => "VALIDATION_FAILED",
            Self::NoParent(_) => "NOT_FOUND",
            Self::Io { .. } => "INTERNAL",
        }
    }
}

/// Writes bytes where a save dialog said, whole or not at all.
///
/// The bytes land under the destination's own name with `.tmp` behind it and
/// are renamed into place, so a file already there is replaced in one move: a
/// save that fails halfway leaves whatever was there as it was, and a reader's
/// own folder with nothing new in it.
pub async fn write(destination: &Path, bytes: &[u8]) -> Result<u64, WriteError> {
    write_with_mode(destination, bytes, false).await
}

/// Writes a file only its owner can read.
///
/// Used for an export that carries credentials under a passphrase: the file is
/// still sealed, but a sealed key is as sensitive as the key itself, and a
/// world-readable copy is not what "sealed" promised.
pub async fn write_private(destination: &Path, bytes: &[u8]) -> Result<u64, WriteError> {
    write_with_mode(destination, bytes, true).await
}

async fn write_with_mode(
    destination: &Path,
    bytes: &[u8],
    private: bool,
) -> Result<u64, WriteError> {
    if destination.is_relative() {
        return Err(WriteError::Relative(displayed(destination)));
    }
    if tokio::fs::metadata(destination)
        .await
        .is_ok_and(|meta| meta.is_dir())
    {
        return Err(WriteError::IsADirectory(displayed(destination)));
    }
    let folder = destination
        .parent()
        .filter(|folder| !folder.as_os_str().is_empty())
        .map(Path::to_path_buf);
    match folder {
        Some(folder) if is_directory(&folder).await => {}
        _ => return Err(WriteError::NoParent(destination.to_path_buf())),
    }

    let staging = staging_name(destination);
    let written = async {
        let mut file = create_staging(&staging, private).await?;
        file.write_all(bytes).await?;
        file.sync_all().await
    }
    .await;
    let outcome = match written {
        Ok(()) => tokio::fs::rename(&staging, destination).await,
        Err(source) => Err(source),
    };
    if let Err(source) = outcome {
        let _ = tokio::fs::remove_file(&staging).await;
        return Err(WriteError::Io {
            path: displayed(destination),
            reason: source.to_string(),
        });
    }
    if private {
        restrict_to_owner(destination)
            .await
            .map_err(|source| WriteError::Io {
                path: displayed(destination),
                reason: format!("the file was written but could not be made private: {source}"),
            })?;
    }
    Ok(bytes.len() as u64)
}

async fn create_staging(path: &Path, private: bool) -> std::io::Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        options.mode(if private { 0o600 } else { 0o666 });
    }
    options.open(path).await
}

async fn restrict_to_owner(destination: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o600)).await
    }
    #[cfg(not(unix))]
    {
        let _ = destination;
        Ok(())
    }
}

/// The name a save takes while it is being made: its destination's own name
/// with `.tmp` behind it, so it sits in the same folder and never looks like
/// the file a reader asked for.
fn staging_name(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_os_string();
    name.push(".tmp");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory to list, with the things a listing has to tell apart in it.
    fn scratch() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("beta")).unwrap();
        std::fs::create_dir(root.path().join("Alpha")).unwrap();
        std::fs::create_dir(root.path().join(".hidden")).unwrap();
        std::fs::write(root.path().join("launch.moka"), b"").unwrap();
        std::fs::write(root.path().join("NOTES.MOKA"), b"").unwrap();
        std::fs::write(root.path().join("picture.png"), b"").unwrap();
        std::fs::write(root.path().join(".secret"), b"").unwrap();
        root
    }

    fn names(listing: &FilesystemListing) -> Vec<&str> {
        listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect()
    }

    #[test]
    fn extensions_are_read_out_of_one_comma_separated_question() {
        assert_eq!(wanted_extensions(None), Vec::<String>::new());
        assert_eq!(wanted_extensions(Some("")), Vec::<String>::new());
        assert_eq!(wanted_extensions(Some("moka")), vec!["moka".to_string()]);
        assert_eq!(
            wanted_extensions(Some(" zip , .MOKA ")),
            vec!["zip".to_string(), "moka".to_string()]
        );
        // A dot on its own is not an extension anybody could be asking for.
        assert_eq!(wanted_extensions(Some(".")), Vec::<String>::new());
    }

    #[test]
    fn a_home_directory_shorthand_is_the_one_path_that_expands() {
        assert_eq!(expand_home("/tmp/here"), PathBuf::from("/tmp/here"));
        assert_eq!(expand_home("relative"), PathBuf::from("relative"));
        // A name that happens to begin with the character is not a shorthand.
        assert_eq!(expand_home("~backup"), PathBuf::from("~backup"));
        if let Some(home) = directories::UserDirs::new() {
            let home = home.home_dir();
            assert_eq!(expand_home("~"), home);
            assert_eq!(expand_home("~/Movies"), home.join("Movies"));
            assert_eq!(expand_home("~\\Movies"), home.join("Movies"));
        }
    }

    #[tokio::test]
    async fn folders_come_first_and_in_the_order_a_name_is_read() {
        let root = scratch();
        let listing = list(Some(&root.path().display().to_string()), Some("moka"))
            .await
            .unwrap();
        assert_eq!(
            names(&listing),
            vec!["Alpha", "beta", "launch.moka", "NOTES.MOKA"]
        );
        assert!(!listing.truncated);
        assert_eq!(
            PathBuf::from(&listing.path),
            std::fs::canonicalize(root.path()).unwrap()
        );
        assert_eq!(
            listing.parent.as_deref(),
            std::fs::canonicalize(root.path())
                .unwrap()
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned())
                .as_deref()
        );
    }

    /// What a listing leaves out, and why each is left out quietly rather than
    /// failing the whole directory it sits in.
    #[tokio::test]
    async fn a_dot_entry_and_an_unasked_for_file_are_left_out() {
        let root = scratch();
        let listing = list(Some(&root.path().display().to_string()), Some("moka"))
            .await
            .unwrap();
        let names = names(&listing);
        assert!(!names.contains(&".hidden"), "{names:?}");
        assert!(!names.contains(&".secret"), "{names:?}");
        assert!(!names.contains(&"picture.png"), "{names:?}");
    }

    /// No extension asked for is a folder picker's question, and the answer
    /// carries nothing else: a dialog choosing where to put a new project has
    /// no use for the files that happen to be there.
    #[tokio::test]
    async fn a_listing_with_no_extension_asked_for_is_a_listing_of_folders() {
        let root = scratch();
        let listing = list(Some(&root.path().display().to_string()), None)
            .await
            .unwrap();
        assert_eq!(names(&listing), vec!["Alpha", "beta"]);
        assert!(listing.entries.iter().all(|entry| entry.kind == DIRECTORY));
    }

    /// Every path handed back is one a later request can be made with, which
    /// is the whole point of carrying it beside the name.
    #[tokio::test]
    async fn an_entry_carries_the_absolute_path_it_leads_to() {
        let root = scratch();
        let asked = root.path().display().to_string();
        let listing = list(Some(&asked), Some("moka")).await.unwrap();
        let folder = listing
            .entries
            .iter()
            .find(|entry| entry.name == "Alpha")
            .expect("the folder is listed");
        assert_eq!(folder.kind, DIRECTORY);
        assert!(PathBuf::from(&folder.path).is_absolute());
        let deeper = list(Some(&folder.path), None).await.unwrap();
        assert_eq!(deeper.entries.len(), 0);
        // Up from a folder that was listed is the folder it was listed in.
        assert_eq!(deeper.parent.as_deref(), Some(listing.path.as_str()));
    }

    /// A path that cannot be a listing says so rather than answering with an
    /// empty one that looks like an empty directory.
    #[tokio::test]
    async fn what_cannot_be_listed_is_refused_saying_which_of_the_ways_it_is() {
        let root = scratch();
        let file = root.path().join("picture.png");
        let error = list(Some(&file.display().to_string()), None)
            .await
            .unwrap_err();
        assert!(matches!(error, BrowseError::NotADirectory(_)), "{error:?}");
        assert_eq!(error.code(), "VALIDATION_FAILED");

        // Relative to the server's working directory is not a place a reader
        // can see, so it is refused rather than quietly resolved there.
        let error = list(Some("data"), None).await.unwrap_err();
        assert!(matches!(error, BrowseError::Relative(_)), "{error:?}");

        let error = list(Some("/does/not/exist/anywhere"), None)
            .await
            .unwrap_err();
        assert!(matches!(error, BrowseError::Unreadable { .. }), "{error:?}");
        assert_eq!(error.code(), "NOT_FOUND");
    }

    /// A directory too big to read as a list says it stopped, rather than
    /// handing back a wall of names that looks like the whole of it.
    #[tokio::test]
    async fn a_directory_bigger_than_a_listing_says_it_stopped() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..=MAX_ENTRIES {
            std::fs::create_dir(root.path().join(format!("folder-{index:04}"))).unwrap();
        }
        let listing = list(Some(&root.path().display().to_string()), None)
            .await
            .unwrap();
        assert_eq!(listing.entries.len(), MAX_ENTRIES);
        assert!(listing.truncated);
    }

    /// An empty question opens at the reader's own home, and says which
    /// directory that turned out to be rather than leaving a dialog to guess.
    #[tokio::test]
    async fn a_listing_nobody_named_a_directory_for_opens_at_home() {
        for asked in [None, Some(""), Some("   ")] {
            let listing = list(asked, None).await.expect("a starting point");
            assert!(PathBuf::from(&listing.path).is_absolute());
            assert!(
                listing.parent.is_some(),
                "{} has somewhere up leads",
                listing.path
            );
        }
    }

    /// A save lands whole, replacing what was there, and leaves no staging
    /// file behind.
    #[tokio::test]
    async fn a_save_replaces_what_was_there_in_one_move() {
        let root = scratch();
        let target = root.path().join("Cut.mp4");
        std::fs::write(&target, b"old").unwrap();

        let written = write(&target, b"artifact").await.unwrap();
        assert_eq!(written, 8);
        assert_eq!(std::fs::read(&target).unwrap(), b"artifact");
        assert!(!staging_name(&target).exists());
    }

    /// What a save refuses: a path with no root to resolve it against, a folder
    /// that is not there, and a destination that is a folder itself.
    #[tokio::test]
    async fn a_save_refuses_a_path_it_cannot_write() {
        let root = scratch();

        let error = write(Path::new("relative/Cut.mp4"), b"artifact")
            .await
            .unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");

        let error = write(&root.path().join("nowhere").join("Cut.mp4"), b"artifact")
            .await
            .unwrap_err();
        assert_eq!(error.code(), "NOT_FOUND");

        let error = write(root.path(), b"artifact").await.unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
        assert_eq!(
            error.to_string(),
            format!("{} is a directory", root.path().display())
        );
    }

    /// A save that cannot land leaves what was at the destination as it was.
    #[tokio::test]
    async fn a_save_that_fails_leaves_the_destination_alone() {
        let root = scratch();
        let target = root.path().join("Cut.mp4");
        std::fs::write(&target, b"old").unwrap();
        // Something in the way of the staging name: the bytes have nowhere to
        // land, and the file that was there stands as it was.
        std::fs::create_dir(staging_name(&target)).unwrap();

        let error = write(&target, b"artifact").await.unwrap_err();
        assert_eq!(error.code(), "INTERNAL");
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
    }
}
