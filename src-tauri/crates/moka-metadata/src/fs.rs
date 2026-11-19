//! The one implementation of the atomic write protocol, plus the
//! cross-process directory lock.
//!
//! No other module writes metadata documents directly: a partial file on disk
//! is the failure mode this protocol exists to prevent.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Permissions for the document that holds ciphertext.
pub const SECRET_MODE: u32 = 0o600;
/// Permissions for every other document.
pub const DOCUMENT_MODE: u32 = 0o644;

/// Scratch area for in-flight writes; cleared on startup.
pub const TMP_DIR: &str = "tmp";
/// Cross-process advisory lock, holding the pid of the owner.
pub const LOCK_FILE: &str = ".lock";

/// Writes `bytes` to `path` so that readers only ever see the complete
/// previous document or the complete new one.
///
/// The temporary file lives in `<root>/tmp`, which is on the same filesystem
/// as the documents, so the final rename is atomic. On any failure the
/// temporary file is removed and the target is left untouched.
pub fn atomic_write(root: &Path, path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let tmp_dir = root.join(TMP_DIR);
    std::fs::create_dir_all(&tmp_dir)?;
    let tmp = tmp_dir.join(unique_name(path));

    let result = write_and_rename(&tmp, path, bytes, mode);
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn write_and_rename(tmp: &Path, path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let mut file = create_with_mode(tmp, mode)?;
    file.write_all(bytes)?;
    // The rename is only durable once the contents have reached the platter;
    // without this a crash can leave a zero-length document behind.
    file.sync_all()?;
    drop(file);
    std::fs::rename(tmp, path)?;
    sync_parent(path);
    Ok(())
}

#[cfg(unix)]
fn create_with_mode(path: &Path, mode: u32) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
}

#[cfg(not(unix))]
fn create_with_mode(path: &Path, _mode: u32) -> std::io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// Flushes the directory entry itself so the rename survives a power loss.
/// Windows has no equivalent in `std`; this is a known gap there.
#[cfg(unix)]
fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) {}

fn unique_name(path: &Path) -> String {
    let stem = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".to_string());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("{stem}.{}.{nanos}", std::process::id())
}

/// Removes leftovers from a previous crash. Temp files are never read, so
/// anything here is by definition garbage.
pub fn clear_tmp(root: &Path) -> std::io::Result<()> {
    let tmp_dir = root.join(TMP_DIR);
    if !tmp_dir.is_dir() {
        return std::fs::create_dir_all(&tmp_dir);
    }
    for entry in std::fs::read_dir(&tmp_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Runs the full write protocol against a scratch file. Used by the readiness
/// probe so that "read-only disk" is reported instead of silently dropping
/// every later write.
pub fn probe_write(root: &Path) -> std::io::Result<()> {
    let target = root.join(TMP_DIR).join(".probe");
    atomic_write(root, &target, b"probe", DOCUMENT_MODE)?;
    std::fs::remove_file(&target)
}

/// Exclusive advisory lock on the metadata directory.
///
/// Held for the lifetime of the process. The desktop app is already single
/// instance; this catches the case where a hand-started standalone server
/// points at the same directory.
#[derive(Debug)]
pub struct DirLock {
    file: File,
    path: PathBuf,
}

impl DirLock {
    /// Fails with `io::ErrorKind::WouldBlock` when another process holds it.
    pub fn acquire(root: &Path) -> std::io::Result<Self> {
        let path = root.join(LOCK_FILE);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        // Fully qualified because `File` has since grown inherent methods of the
        // same name, and those would resolve first and break the declared MSRV.
        fs2::FileExt::try_lock_exclusive(&file)?;
        // Truncating before the lock is held would erase the current holder's
        // pid, which is what the "directory is in use" error reports.
        file.set_len(0)?;
        let mut writer = &file;
        writeln!(writer, "{}", std::process::id())?;
        writer.flush()?;
        Ok(Self { file, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DirLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_are_visible_as_a_complete_document() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("recent-projects.json");
        atomic_write(root.path(), &target, b"{\"revision\":1}", DOCUMENT_MODE).unwrap();
        atomic_write(root.path(), &target, b"{\"revision\":2}", DOCUMENT_MODE).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"revision\":2}");
        assert!(std::fs::read_dir(root.path().join(TMP_DIR))
            .unwrap()
            .next()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn applies_the_requested_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("secrets.json");
        atomic_write(root.path(), &target, b"{}", SECRET_MODE).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, SECRET_MODE);
    }

    #[test]
    fn a_failure_leaves_the_previous_document_intact() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("providers.json");
        atomic_write(root.path(), &target, b"original", DOCUMENT_MODE).unwrap();
        // A target whose parent is a regular file cannot be renamed into
        // place. Which error kind that produces is platform-specific, so only
        // the outcome is asserted.
        let blocked = root.path().join("blocker");
        std::fs::write(&blocked, b"file").unwrap();
        let unreachable = blocked.join("providers.json");
        atomic_write(root.path(), &unreachable, b"replacement", DOCUMENT_MODE)
            .expect_err("write must fail");
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        let leftovers = std::fs::read_dir(root.path().join("tmp")).unwrap().count();
        assert_eq!(
            leftovers, 0,
            "a failed write must clean up its scratch file"
        );
    }

    #[test]
    fn clear_tmp_removes_crash_leftovers() {
        let root = tempfile::tempdir().unwrap();
        let tmp_dir = root.path().join(TMP_DIR);
        std::fs::create_dir_all(&tmp_dir).unwrap();
        std::fs::write(tmp_dir.join("recent-projects.json.9.1"), b"partial").unwrap();
        clear_tmp(root.path()).unwrap();
        assert!(std::fs::read_dir(&tmp_dir).unwrap().next().is_none());
    }

    #[test]
    fn probe_write_round_trips() {
        let root = tempfile::tempdir().unwrap();
        probe_write(root.path()).unwrap();
    }

    #[test]
    fn the_second_lock_holder_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let first = DirLock::acquire(root.path()).unwrap();
        let error = DirLock::acquire(root.path()).expect_err("lock must be held");
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        drop(first);
        DirLock::acquire(root.path()).unwrap();
    }
}
