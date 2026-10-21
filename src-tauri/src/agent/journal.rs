//! What a tool did, kept on disk.
//!
//! A command tool writes document commands, and those have an inverse: the
//! change can be undone. An effect tool deletes a file, starts a paid run, or
//! writes a package, and nothing can put those back — so it gets an audit
//! record and no undo button. Keeping the two apart is the point: an inverse
//! that claimed to restore a deleted file would be a lie.
//!
//! Idempotency lives here too, because it is the same question as a change:
//! what did this exact request already do?

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::domain::DocumentCommand;

use super::error::ToolError;

pub const CHANGE_SCHEMA_VERSION: u32 = 1;
pub const KEEP_CHANGES: usize = 500;
pub const KEEP_DAYS: i64 = 30;
pub const CHANGE_BYTES_CEILING: u64 = 20 * 1024 * 1024;
const IDEMPOTENCY_TTL_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub kind: String,
    pub schema_version: u32,
    pub id: String,
    pub tool: String,
    pub tool_version: u32,
    pub actor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub base_revision: i32,
    pub revision: i32,
    pub created_at: String,
    pub summary: String,
    pub forward_commands: Vec<DocumentCommand>,
    pub inverse_commands: Vec<DocumentCommand>,
    pub digest_before: String,
    pub digest_after: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undone_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    pub kind: String,
    pub schema_version: u32,
    pub id: String,
    pub tool: String,
    pub tool_version: u32,
    pub actor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub input_hash: String,
    pub summary: String,
    pub result: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default)]
    pub assets_added: Vec<String>,
    #[serde(default)]
    pub assets_updated: Vec<String>,
    #[serde(default)]
    pub assets_removed: Vec<String>,
    pub undoable: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyRecord {
    pub key: String,
    pub tool: String,
    pub input_hash: String,
    pub response: Value,
    pub created_at: String,
    pub expires_at: String,
}

fn agent_dir(root: &Path) -> PathBuf {
    root.join("history").join("agent")
}

fn changes_dir(root: &Path) -> PathBuf {
    agent_dir(root).join("changes")
}

fn audit_dir(root: &Path) -> PathBuf {
    agent_dir(root).join("audit")
}

fn idempotency_dir(root: &Path) -> PathBuf {
    agent_dir(root).join("idempotency")
}

/// A digest of the document as the server holds it, used to refuse an undo
/// whose starting point has moved.
pub fn digest_of(moka: &crate::domain::MokaFile) -> String {
    let bytes = serde_json::to_vec(moka).unwrap_or_default();
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

/// Writes one record, whole or not at all.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    let Some(dir) = path.parent() else {
        return Err(ToolError::internal("the record path has no directory"));
    };
    std::fs::create_dir_all(dir)
        .map_err(|error| ToolError::internal(format!("the record could not be kept: {error}")))?;
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("record");
    let tmp = dir.join(format!(".{stem}.{}.tmp", uuid::Uuid::now_v7()));
    let outcome = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if let Err(error) = outcome {
        let _ = std::fs::remove_file(&tmp);
        return Err(ToolError::internal(format!(
            "the record could not be written: {error}"
        )));
    }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub struct ChangeRequest<'a> {
    pub tool: &'a str,
    pub tool_version: u32,
    pub actor: &'a str,
    pub session_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub base_revision: i32,
    pub revision: i32,
    pub summary: &'a str,
    pub forward: Vec<DocumentCommand>,
    pub inverse: Vec<DocumentCommand>,
    pub digest_before: String,
    pub digest_after: String,
}

/// Writes a change set and returns its id.
pub fn record_change(root: &Path, request: ChangeRequest<'_>) -> Result<String, ToolError> {
    let id = format!("cs_{}", crate::domain::new_id());
    let change = ChangeSet {
        kind: "change".into(),
        schema_version: CHANGE_SCHEMA_VERSION,
        id: id.clone(),
        tool: request.tool.into(),
        tool_version: request.tool_version,
        actor: request.actor.into(),
        session_id: request.session_id.map(str::to_string),
        turn_id: request.turn_id.map(str::to_string),
        base_revision: request.base_revision,
        revision: request.revision,
        created_at: crate::domain::now_iso(),
        summary: request.summary.into(),
        forward_commands: request.forward,
        inverse_commands: request.inverse,
        digest_before: request.digest_before,
        digest_after: request.digest_after,
        undone_at: None,
    };
    let bytes = serde_json::to_vec_pretty(&change)
        .map_err(|error| ToolError::internal(error.to_string()))?;
    write_atomic(&changes_dir(root).join(format!("{id}.json")), &bytes)?;
    let _ = prune_changes(root);
    Ok(id)
}

pub fn get_change(root: &Path, id: &str) -> Option<ChangeSet> {
    if !safe_id(id) {
        return None;
    }
    read_json(&changes_dir(root).join(format!("{id}.json")))
}

pub fn mark_undone(root: &Path, change: &ChangeSet) -> Result<(), ToolError> {
    let mut change = change.clone();
    change.undone_at = Some(crate::domain::now_iso());
    let bytes = serde_json::to_vec_pretty(&change)
        .map_err(|error| ToolError::internal(error.to_string()))?;
    write_atomic(
        &changes_dir(root).join(format!("{}.json", change.id)),
        &bytes,
    )
}

pub struct AuditRequest<'a> {
    pub tool: &'a str,
    pub tool_version: u32,
    pub actor: &'a str,
    pub session_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub input_hash: String,
    pub summary: &'a str,
    pub result: Value,
    pub task_id: Option<String>,
    pub assets_added: Vec<String>,
    pub assets_updated: Vec<String>,
    pub assets_removed: Vec<String>,
}

pub fn record_audit(root: &Path, request: AuditRequest<'_>) -> Result<String, ToolError> {
    let id = format!("au_{}", crate::domain::new_id());
    let audit = AuditRecord {
        kind: "audit".into(),
        schema_version: CHANGE_SCHEMA_VERSION,
        id: id.clone(),
        tool: request.tool.into(),
        tool_version: request.tool_version,
        actor: request.actor.into(),
        session_id: request.session_id.map(str::to_string),
        turn_id: request.turn_id.map(str::to_string),
        input_hash: request.input_hash,
        summary: request.summary.into(),
        result: request.result,
        task_id: request.task_id,
        assets_added: request.assets_added,
        assets_updated: request.assets_updated,
        assets_removed: request.assets_removed,
        undoable: false,
        created_at: crate::domain::now_iso(),
    };
    let bytes = serde_json::to_vec_pretty(&audit)
        .map_err(|error| ToolError::internal(error.to_string()))?;
    write_atomic(&audit_dir(root).join(format!("{id}.json")), &bytes)?;
    Ok(id)
}

pub fn list_audit(root: &Path, limit: usize) -> Vec<AuditRecord> {
    let mut records: Vec<AuditRecord> = std::fs::read_dir(audit_dir(root))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                })
                .filter_map(|entry| read_json(&entry.path()))
                .collect()
        })
        .unwrap_or_default();
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    records.truncate(limit.clamp(1, 200));
    records
}

/// The digest a request is fingerprinted by. Keys are sorted so the same
/// object always hashes the same, whichever order a client wrote it in.
pub fn input_hash(input: &Value) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(canonical(input).as_bytes()))
    )
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn idempotency_path(root: &Path, key: &str) -> PathBuf {
    let digest = hex::encode(Sha256::digest(key.as_bytes()));
    idempotency_dir(root).join(format!("{digest}.json"))
}

/// The answer a prior identical request already received, or the refusal that
/// this key was used for something else.
pub fn idempotent_answer(
    root: &Path,
    key: &str,
    tool: &str,
    hash: &str,
) -> Result<Option<Value>, ToolError> {
    if key.trim().is_empty() {
        return Ok(None);
    }
    let path = idempotency_path(root, key);
    let Some(record): Option<IdempotencyRecord> = read_json(&path) else {
        return Ok(None);
    };
    if record.tool != tool || record.input_hash != hash {
        return Err(ToolError::new(
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used for a different request",
        ));
    }
    Ok(Some(record.response))
}

pub fn remember_answer(
    root: &Path,
    key: &str,
    tool: &str,
    hash: &str,
    response: &Value,
) -> Result<(), ToolError> {
    if key.trim().is_empty() {
        return Ok(());
    }
    let now = time::OffsetDateTime::now_utc();
    let expires = now + time::Duration::seconds(IDEMPOTENCY_TTL_SECONDS);
    let format = time::format_description::well_known::Rfc3339;
    let record = IdempotencyRecord {
        key: key.to_string(),
        tool: tool.to_string(),
        input_hash: hash.to_string(),
        response: response.clone(),
        created_at: now.format(&format).unwrap_or_default(),
        expires_at: expires.format(&format).unwrap_or_default(),
    };
    let bytes = serde_json::to_vec_pretty(&record)
        .map_err(|error| ToolError::internal(error.to_string()))?;
    write_atomic(&idempotency_path(root, key), &bytes)
}

/// Drops expired idempotency records. A failure to clean is not a failure to
/// work: the file is simply read and found expired later.
pub fn prune_idempotency(root: &Path) {
    let Ok(entries) = std::fs::read_dir(idempotency_dir(root)) else {
        return;
    };
    let now = time::OffsetDateTime::now_utc();
    let format = time::format_description::well_known::Rfc3339;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(record): Option<IdempotencyRecord> = read_json(&path) else {
            continue;
        };
        let expired = time::OffsetDateTime::parse(&record.expires_at, &format)
            .map(|expires| expires < now)
            .unwrap_or(true);
        if expired {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Keeps the change history to its ceiling: the newest 500, nothing older than
/// 30 days, and no more than 20 MB of them.
fn prune_changes(root: &Path) -> std::io::Result<()> {
    let dir = changes_dir(root);
    let mut files: Vec<(PathBuf, String, u64)> = Vec::new();
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(change): Option<ChangeSet> = read_json(&path) else {
            continue;
        };
        let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        files.push((path, change.created_at, bytes));
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let now = time::OffsetDateTime::now_utc();
    let format = time::format_description::well_known::Rfc3339;
    let mut total: u64 = 0;
    for (index, (path, created_at, bytes)) in files.iter().enumerate() {
        let too_old = time::OffsetDateTime::parse(created_at, &format)
            .map(|at| (now - at) > time::Duration::days(KEEP_DAYS))
            .unwrap_or(false);
        total += bytes;
        if index >= KEEP_CHANGES || too_old || total > CHANGE_BYTES_CEILING {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The retention age, exposed for a documentation page rather than a caller.
pub fn retention() -> Duration {
    Duration::from_secs(KEEP_DAYS as u64 * 86_400)
}

/// A one-line account of a change, as an undo list reads it.
pub fn list_changes(root: &Path, limit: usize) -> Vec<Value> {
    let mut records: Vec<ChangeSet> = std::fs::read_dir(changes_dir(root))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                })
                .filter_map(|entry| read_json(&entry.path()))
                .collect()
        })
        .unwrap_or_default();
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    records.truncate(limit.clamp(1, 200));
    records
        .into_iter()
        .map(|change| {
            json!({
                "id": change.id,
                "tool": change.tool,
                "summary": change.summary,
                "createdAt": change.created_at,
                "revision": change.revision,
                "undoneAt": change.undone_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> DocumentCommand {
        DocumentCommand::UpdateProjectMetadata {
            name: "A".into(),
            description: String::new(),
        }
    }

    #[test]
    fn a_change_is_written_with_its_inverse_and_marked_undone() {
        let dir = tempfile::tempdir().unwrap();
        let id = record_change(
            dir.path(),
            ChangeRequest {
                tool: "project.update",
                tool_version: 1,
                actor: "ui",
                session_id: None,
                turn_id: None,
                base_revision: 1,
                revision: 2,
                summary: "renamed",
                forward: vec![command()],
                inverse: vec![command()],
                digest_before: "sha256:a".into(),
                digest_after: "sha256:b".into(),
            },
        )
        .unwrap();
        let change = get_change(dir.path(), &id).expect("a change");
        assert_eq!(change.kind, "change");
        assert!(change.undone_at.is_none());
        mark_undone(dir.path(), &change).unwrap();
        assert!(get_change(dir.path(), &id).unwrap().undone_at.is_some());
    }

    #[test]
    fn an_audit_has_no_inverse_and_says_it_cannot_be_undone() {
        let dir = tempfile::tempdir().unwrap();
        let id = record_audit(
            dir.path(),
            AuditRequest {
                tool: "asset.delete",
                tool_version: 1,
                actor: "ui",
                session_id: None,
                turn_id: None,
                input_hash: "sha256:x".into(),
                summary: "deleted",
                result: json!({"deleted": true}),
                task_id: None,
                assets_added: vec![],
                assets_updated: vec![],
                assets_removed: vec!["a_1".into()],
            },
        )
        .unwrap();
        let audit: AuditRecord =
            read_json(&audit_dir(dir.path()).join(format!("{id}.json"))).unwrap();
        assert!(!audit.undoable);
        assert_eq!(audit.assets_removed, ["a_1"]);
    }

    #[test]
    fn the_same_key_with_a_different_request_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        remember_answer(
            dir.path(),
            "k",
            "canvas.run",
            "sha256:a",
            &json!({"ok": true}),
        )
        .unwrap();
        assert_eq!(
            idempotent_answer(dir.path(), "k", "canvas.run", "sha256:a")
                .unwrap()
                .unwrap()["ok"],
            true
        );
        let error = idempotent_answer(dir.path(), "k", "canvas.run", "sha256:b").unwrap_err();
        assert_eq!(error.code, "IDEMPOTENCY_KEY_REUSED");
    }

    #[test]
    fn a_request_hash_ignores_key_order() {
        let first = input_hash(&json!({"a": 1, "b": 2}));
        let second = input_hash(&json!({"b": 2, "a": 1}));
        assert_eq!(first, second);
        assert_ne!(first, input_hash(&json!({"a": 1, "b": 3})));
    }
}
