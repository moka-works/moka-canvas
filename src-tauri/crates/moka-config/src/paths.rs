//! Resolves the single on-disk location for application-level metadata.
//!
//! Metadata always lands in the operating system's application data
//! directory, never next to the executable, the bundled web assets, or the
//! process working directory. [`ensure_isolated`] turns that rule into a
//! startup assertion rather than a convention.

use std::path::{Component, Path, PathBuf};

use crate::{ConfigError, MetadataConfig, RuntimeMode};

/// Bundle identifier shared by the desktop app and the standalone server.
///
/// Names the app to the operating system — Tauri's `identifier`, the macOS
/// bundle ID, the keyring service in [`super::crypto`] — and must stay in
/// reverse-DNS form because those registries demand it. The directory on
/// disk is keyed to [`APP_DIR_NAME`] instead.
pub const APP_ID: &str = "app.mokacanvas";

/// Name of the directory, under the platform application data directory,
/// that everything the runtimes write lives in.
///
/// Deliberately not the bundle identifier: `app.mokacanvas` is the reverse-DNS
/// name Tauri and the OS registries demand, while this is the name a person
/// reading `Application Support` can recognize.
pub const APP_DIR_NAME: &str = "MokaCanvas";

/// Directory name appended to the platform application data directory.
pub const DIR_NAME: &str = "metadata";

/// Overrides the resolved directory; used by tests and container deployments
/// that mount a volume for configuration.
pub const DIR_ENV: &str = "MOKA_METADATA_DIR";

/// Overrides `metadata.store`; only `"file"` is accepted.
pub const STORE_ENV: &str = "MOKA_METADATA_STORE";

const APP_DATA_PLACEHOLDER: &str = "${appData}";

/// Resolves the metadata directory.
///
/// Precedence: `MOKA_METADATA_DIR`, then `metadata.dir` from configuration
/// (with `${appData}` expanded), then the platform default. `app_data` is the
/// desktop shell's own application data directory and is only consulted in
/// native mode.
pub fn resolve_dir(
    config: &MetadataConfig,
    mode: RuntimeMode,
    app_data: Option<&Path>,
) -> Result<PathBuf, ConfigError> {
    resolve_from(env_override(DIR_ENV), config, mode, app_data)
}

/// The precedence rule, with the environment read lifted out so it can be
/// asserted without mutating state every other test in the process shares.
fn resolve_from(
    override_dir: Option<String>,
    config: &MetadataConfig,
    mode: RuntimeMode,
    app_data: Option<&Path>,
) -> Result<PathBuf, ConfigError> {
    if let Some(dir) = override_dir {
        return Ok(PathBuf::from(dir));
    }
    if let Some(configured) = config.dir.as_ref() {
        return Ok(expand_app_data(configured, mode, app_data));
    }
    Ok(platform_default()?.join(DIR_NAME))
}

/// An override that is set but blank means "not set", so an empty value in a
/// container environment file cannot accidentally pin the directory to "".
fn env_override(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The backend named by configuration, after the environment override.
pub fn resolve_store(config: &MetadataConfig) -> String {
    env_override(STORE_ENV).unwrap_or_else(|| config.store.clone())
}

fn expand_app_data(dir: &Path, mode: RuntimeMode, app_data: Option<&Path>) -> PathBuf {
    let raw = dir.to_string_lossy();
    if !raw.contains(APP_DATA_PLACEHOLDER) {
        return dir.to_path_buf();
    }
    let base = match (mode, app_data) {
        (RuntimeMode::Native, Some(app_data)) => app_data.to_path_buf(),
        _ => platform_default().unwrap_or_else(|_| PathBuf::from(".")),
    };
    PathBuf::from(raw.replace(APP_DATA_PLACEHOLDER, &base.to_string_lossy()))
}

/// The platform application data directory, without the [`DIR_NAME`] suffix.
///
/// Derived from [`APP_DIR_NAME`] rather than [`APP_ID`]: the desktop shell's
/// `app_data_dir()` is keyed to the bundle identifier, and this deliberately
/// is not, so that what lands on disk carries the product name.
pub fn platform_default() -> Result<PathBuf, ConfigError> {
    directories::ProjectDirs::from("", "", APP_DIR_NAME)
        .map(|dirs| dirs.data_dir().to_path_buf())
        .ok_or_else(|| {
            ConfigError::MetadataDirInvalid(
                "cannot determine the platform application data directory".to_string(),
            )
        })
}

/// Rejects metadata directories that sit inside the program's own tree, that
/// are relative, or that cannot be created and written.
pub fn ensure_isolated(dir: &Path, static_dir: &Path) -> Result<PathBuf, ConfigError> {
    if dir.is_relative() {
        return Err(ConfigError::MetadataDirInvalid(format!(
            "{} is relative; metadata requires an absolute directory outside the program tree",
            dir.display()
        )));
    }
    let resolved = normalize(dir);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for forbidden in forbidden_roots(static_dir, &cwd) {
        if is_within(&resolved, &forbidden) {
            return Err(ConfigError::MetadataDirInvalid(format!(
                "{} must not live inside {}",
                dir.display(),
                forbidden.display()
            )));
        }
    }
    std::fs::create_dir_all(dir)
        .map_err(|error| ConfigError::MetadataDirInvalid(format!("{}: {error}", dir.display())))?;
    let probe = dir.join(".moka-write-probe");
    std::fs::write(&probe, b"")
        .and_then(|_| std::fs::remove_file(&probe))
        .map_err(|error| {
            ConfigError::MetadataDirInvalid(format!("{} is not writable: {error}", dir.display()))
        })?;
    Ok(resolved)
}

/// The directories the metadata directory may not sit inside.
///
/// A filesystem root is deliberately absent from the result: it is not the
/// program's tree, and since every absolute path starts with it, keeping it
/// would reject the one directory the app always resolves to. That is not
/// hypothetical — Finder launches the app with the working directory set to
/// `/`, so a root kept as a forbidden root turns every launch from the Dock,
/// a DMG, or Spotlight into a startup failure.
fn forbidden_roots(static_dir: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut roots = vec![normalize(static_dir)];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(normalize(parent));
        }
    }
    roots.push(normalize(cwd));
    roots.retain(|root| !is_filesystem_root(root));
    roots
}

/// Whether `path` is the top of its filesystem — `/` on Unix, `C:\` on
/// Windows. A root has no parent, which is exactly the property that makes it
/// useless as a boundary: nothing is outside it.
fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

fn is_within(candidate: &Path, root: &Path) -> bool {
    candidate.starts_with(root)
}

/// Resolves symlinks for the parts of `path` that already exist so that
/// `/var/...` and `/private/var/...` compare equal.
fn normalize(path: &Path) -> PathBuf {
    let mut existing = PathBuf::new();
    let mut rest = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            other => {
                let candidate = existing.join(other.as_os_str());
                if candidate.symlink_metadata().is_ok() && rest.is_empty() {
                    existing = candidate;
                } else {
                    rest.push(other.as_os_str().to_os_string());
                }
            }
        }
    }
    let base = std::fs::canonicalize(&existing).unwrap_or(existing);
    rest.iter().fold(base, |acc, part| acc.join(part))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn web_config(dir: Option<PathBuf>) -> MetadataConfig {
        MetadataConfig {
            store: "file".to_string(),
            dir,
            max_document_bytes: 1024,
        }
    }

    #[test]
    fn native_and_web_resolve_to_the_same_directory() {
        let app_data = platform_default().expect("platform app data");
        let native = resolve_dir(&web_config(None), RuntimeMode::Native, Some(&app_data))
            .expect("native resolution");
        let web = resolve_dir(&web_config(None), RuntimeMode::Web, None).expect("web resolution");
        assert_eq!(native, web);
        assert!(web.ends_with(DIR_NAME));
    }

    #[test]
    fn configured_directory_expands_the_app_data_placeholder() {
        let config = web_config(Some(PathBuf::from("${appData}/metadata")));
        let resolved = resolve_dir(&config, RuntimeMode::Web, None).expect("resolution");
        assert_eq!(resolved, platform_default().unwrap().join("metadata"));
    }

    #[test]
    fn an_explicit_override_wins_over_configuration() {
        let config = web_config(Some(PathBuf::from("${appData}/metadata")));
        let resolved = resolve_from(
            Some("/var/lib/moka".to_string()),
            &config,
            RuntimeMode::Web,
            None,
        )
        .expect("resolution");
        assert_eq!(resolved, PathBuf::from("/var/lib/moka"));
    }

    #[test]
    fn without_an_override_configuration_wins_over_the_platform_default() {
        let configured = resolve_from(
            None,
            &web_config(Some(PathBuf::from("/var/lib/moka"))),
            RuntimeMode::Web,
            None,
        )
        .expect("resolution");
        assert_eq!(configured, PathBuf::from("/var/lib/moka"));

        let fallback = resolve_from(None, &web_config(None), RuntimeMode::Web, None)
            .expect("the platform default resolves");
        assert_eq!(fallback, platform_default().unwrap().join(DIR_NAME));
    }

    #[test]
    fn rejects_a_relative_directory() {
        let error = ensure_isolated(Path::new("data/metadata"), Path::new("/tmp")).unwrap_err();
        assert!(matches!(error, ConfigError::MetadataDirInvalid(_)));
    }

    #[test]
    fn rejects_a_directory_inside_the_static_assets() {
        let root = tempfile::tempdir().unwrap();
        let static_dir = root.path().join("static");
        std::fs::create_dir_all(&static_dir).unwrap();
        let candidate = static_dir.join("metadata");
        let error = ensure_isolated(&candidate, &static_dir).unwrap_err();
        assert_eq!(error.code(), "CONFIG_METADATA_DIR_INVALID");
    }

    #[test]
    fn rejects_a_directory_that_cannot_be_written() {
        let root = tempfile::tempdir().unwrap();
        let blocker = root.path().join("blocker");
        std::fs::write(&blocker, b"file").unwrap();
        let static_dir = root.path().join("static");
        let error = ensure_isolated(&blocker.join("metadata"), &static_dir).unwrap_err();
        assert!(matches!(error, ConfigError::MetadataDirInvalid(_)));
    }

    #[test]
    fn a_filesystem_root_is_not_a_forbidden_root() {
        // What Finder hands the app as its working directory.
        assert!(is_filesystem_root(Path::new("/")));
        // What a shell in the repository hands it.
        assert!(!is_filesystem_root(Path::new("/tmp")));

        let roots = forbidden_roots(Path::new("/tmp"), Path::new("/"));
        assert!(
            !roots.iter().any(|root| root == Path::new("/")),
            "a launch from / must not forbid every absolute directory: {roots:?}"
        );
        assert!(
            roots
                .iter()
                .any(|root| root.as_os_str() == normalize(Path::new("/tmp")).as_os_str()),
            "the static assets stay forbidden wherever the launch comes from: {roots:?}"
        );
    }

    #[test]
    fn a_launch_from_the_filesystem_root_still_isolates_metadata() {
        let root = tempfile::tempdir().unwrap();
        let static_dir = root.path().join("static");
        std::fs::create_dir_all(&static_dir).unwrap();

        // The whole rule, evaluated as a launch from `/` sees it.
        let resolved = normalize(&root.path().join("metadata"));
        for forbidden in forbidden_roots(&static_dir, Path::new("/")) {
            assert!(
                !is_within(&resolved, &forbidden),
                "{} was rejected as inside {}",
                resolved.display(),
                forbidden.display()
            );
        }
    }

    #[test]
    fn accepts_a_directory_outside_the_program_tree() {
        let root = tempfile::tempdir().unwrap();
        let static_dir = root.path().join("static");
        std::fs::create_dir_all(&static_dir).unwrap();
        let resolved = ensure_isolated(&root.path().join("metadata"), &static_dir).unwrap();
        assert!(resolved.is_absolute());
    }
}
