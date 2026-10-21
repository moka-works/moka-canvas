//! Conversations, kept beside the document rather than inside it.
//!
//! A conversation is not project content: it does not belong in `canvas.moka`,
//! it does not move the document revision, and an old version of the app must
//! still be able to open a project that has one. So each session is a file of
//! its own under `<project>/agent/sessions/`, written through the same atomic
//! pattern as the document, and searched from a scan of that directory.
//!
//! A scan is the index. A local project has tens of conversations rather than
//! millions, and a derived index that disagrees with the files is a worse
//! answer than a directory read that cannot.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

pub const SESSION_SCHEMA_VERSION: u32 = 1;
pub const MAX_AGENT_MESSAGES_PER_SESSION: usize = 200;
pub const MAX_AGENT_SESSION_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_AGENT_MESSAGE_LENGTH: usize = 8_000;
pub const MAX_AGENT_TITLE_LENGTH: usize = 80;
pub const MAX_AGENT_TOOL_CALLS_BYTES: usize = 64 * 1024;
const SNIPPET_CHARS: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionFile {
    pub schema_version: u32,
    pub session: AgentSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub title: String,
    pub messages: Vec<AgentMessage>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_scope: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub text: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_scope: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionList {
    pub sessions: Vec<AgentSessionSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SessionError {
    pub code: &'static str,
    pub message: String,
    pub status: u16,
}

impl SessionError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "VALIDATION_FAILED",
            message: message.into(),
            status: 422,
        }
    }

    fn not_found(id: &str) -> Self {
        Self {
            code: "SESSION_NOT_FOUND",
            message: format!("session {id} does not exist"),
            status: 404,
        }
    }

    fn too_large() -> Self {
        Self {
            code: "SESSION_TOO_LARGE",
            message: "The session is larger than 2 MB even after trimming; delete some messages"
                .into(),
            status: 422,
        }
    }

    fn io(error: std::io::Error) -> Self {
        Self {
            code: "INTERNAL",
            message: format!("the session could not be written: {error}"),
            status: 500,
        }
    }
}

pub type SessionResult<T> = Result<T, SessionError>;

/// The sessions of every project this process serves.
///
/// One lock for all of them: a session write is a file write in a local
/// project, and serialising those costs nothing a reader can notice while
/// removing a whole class of interleaved rename.
pub struct AgentSessionStore {
    write: Mutex<()>,
}

impl Default for AgentSessionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentSessionStore {
    pub fn new() -> Self {
        Self {
            write: Mutex::new(()),
        }
    }

    fn sessions_dir(root: &Path) -> PathBuf {
        root.join("agent").join("sessions")
    }

    fn path(root: &Path, id: &str) -> SessionResult<PathBuf> {
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(SessionError::not_found(id));
        }
        Ok(Self::sessions_dir(root).join(format!("{id}.json")))
    }

    /// Lists conversations, newest first, optionally filtered by a search.
    ///
    /// A session file that cannot be parsed is moved aside and named in
    /// `warnings`: one damaged conversation is not a project that cannot be
    /// opened.
    pub async fn list(
        &self,
        root: &Path,
        query: Option<&str>,
        limit: usize,
        cursor: Option<&str>,
    ) -> SessionResult<SessionList> {
        let dir = Self::sessions_dir(root);
        let mut warnings = Vec::new();
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SessionList {
                    sessions: Vec::new(),
                    warnings,
                })
            }
            Err(error) => return Err(SessionError::io(error)),
        };
        let needle = query
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(|q| q.to_lowercase());
        let mut summaries = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !name.ends_with(".json") || name.contains(".corrupt.") {
                continue;
            }
            let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            let (session, snippet) = match Self::read(&path) {
                Ok(session) => {
                    let snippet = needle
                        .as_deref()
                        .and_then(|needle| search_hit(&session, needle));
                    (session, snippet)
                }
                Err(_) => {
                    let corrupt = corrupt_path(&path);
                    let _ = std::fs::rename(&path, &corrupt);
                    warnings.push(format!(
                        "{} was unreadable and was moved to {}",
                        name,
                        corrupt
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("a corrupt file")
                    ));
                    continue;
                }
            };
            if let Some(needle) = &needle {
                let in_title = session.title.to_lowercase().contains(needle);
                if snippet.is_none() && !in_title {
                    continue;
                }
            }
            summaries.push(summary_of(&session, bytes, snippet));
        }
        summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        if let Some(cursor) = cursor {
            summaries.retain(|summary| summary.updated_at.as_str() < cursor);
        }
        let limit = limit.clamp(1, 100);
        summaries.truncate(limit);
        Ok(SessionList {
            sessions: summaries,
            warnings,
        })
    }

    pub async fn create(
        &self,
        root: &Path,
        title: Option<String>,
        model: Option<String>,
        scope: Option<Value>,
    ) -> SessionResult<AgentSessionSummary> {
        let _guard = self.write.lock().await;
        let now = crate::domain::now_iso();
        let session = AgentSession {
            id: crate::domain::new_id(),
            title: clean_title(title.unwrap_or_default()),
            messages: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
            last_scope: scope,
            model,
        };
        let path = Self::path(root, &session.id)?;
        write_session(&path, &session)?;
        Ok(summary_of(&session, 0, None))
    }

    pub async fn get(
        &self,
        root: &Path,
        id: &str,
        limit: usize,
        before: Option<&str>,
    ) -> SessionResult<AgentSession> {
        let mut session =
            Self::read(&Self::path(root, id)?).map_err(|_| SessionError::not_found(id))?;
        let limit = limit.clamp(1, MAX_AGENT_MESSAGES_PER_SESSION);
        let end = before
            .and_then(|before| {
                session
                    .messages
                    .iter()
                    .position(|message| message.id == before)
            })
            .unwrap_or(session.messages.len());
        let start = end.saturating_sub(limit);
        session.messages = session.messages[start..end].to_vec();
        Ok(session)
    }

    pub async fn patch(
        &self,
        root: &Path,
        id: &str,
        title: Option<String>,
        model: Option<Option<String>>,
        scope: Option<Value>,
    ) -> SessionResult<AgentSessionSummary> {
        let _guard = self.write.lock().await;
        let path = Self::path(root, id)?;
        let mut session = Self::read(&path).map_err(|_| SessionError::not_found(id))?;
        if let Some(title) = title {
            session.title = clean_title(title);
        }
        if let Some(model) = model {
            session.model = model.filter(|model| !model.trim().is_empty());
        }
        if let Some(scope) = scope {
            session.last_scope = Some(scope);
        }
        session.updated_at = crate::domain::now_iso();
        write_session(&path, &session)?;
        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        Ok(summary_of(&session, bytes, None))
    }

    pub async fn delete(&self, root: &Path, id: &str) -> SessionResult<()> {
        let _guard = self.write.lock().await;
        let path = Self::path(root, id)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(SessionError::not_found(id))
            }
            Err(error) => Err(SessionError::io(error)),
        }
    }

    pub async fn delete_many(
        &self,
        root: &Path,
        ids: &[String],
    ) -> SessionResult<(usize, Vec<String>)> {
        let _guard = self.write.lock().await;
        let mut deleted = 0;
        let mut warnings = Vec::new();
        for id in ids {
            let path = match Self::path(root, id) {
                Ok(path) => path,
                Err(_) => {
                    warnings.push(format!("session {id} does not exist"));
                    continue;
                }
            };
            match std::fs::remove_file(&path) {
                Ok(()) => deleted += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    warnings.push(format!("session {id} does not exist"));
                }
                Err(error) => warnings.push(format!("session {id}: {error}")),
            }
        }
        Ok((deleted, warnings))
    }

    /// Appends one message. An id already present is returned as it stands, so
    /// a retried append cannot duplicate a turn.
    pub async fn append(
        &self,
        root: &Path,
        id: &str,
        mut message: AgentMessage,
    ) -> SessionResult<(AgentSessionSummary, usize)> {
        let _guard = self.write.lock().await;
        let path = Self::path(root, id)?;
        let mut session = Self::read(&path).map_err(|_| SessionError::not_found(id))?;
        normalize_message(&mut session, &mut message)?;
        if session
            .messages
            .iter()
            .any(|existing| existing.id == message.id)
        {
            let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            return Ok((summary_of(&session, bytes, None), 0));
        }
        session.messages.push(message);
        if session.messages.len() > MAX_AGENT_MESSAGES_PER_SESSION {
            session.messages = trim(&session.messages, MAX_AGENT_MESSAGES_PER_SESSION - 1);
        }
        session.updated_at = crate::domain::now_iso();
        if session.title.is_empty() || session.title == DEFAULT_TITLE {
            if let Some(first) = session
                .messages
                .iter()
                .find(|message| message.role == "user")
            {
                session.title = clean_title(first_line(&first.text));
            }
        }
        let trimmed = trim_to_size(&mut session)?;
        write_session(&path, &session)?;
        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        Ok((summary_of(&session, bytes, None), trimmed))
    }

    /// Replaces one assistant step message. Only a step may be replaced: a
    /// user's own words are not a record to be rewritten.
    pub async fn update_message(
        &self,
        root: &Path,
        id: &str,
        message_id: &str,
        mut message: AgentMessage,
    ) -> SessionResult<(AgentSessionSummary, usize)> {
        let _guard = self.write.lock().await;
        let path = Self::path(root, id)?;
        let mut session = Self::read(&path).map_err(|_| SessionError::not_found(id))?;
        if !matches!(message.role.as_str(), "assistant" | "error") {
            return Err(SessionError::validation(
                "only an assistant or error step message can be updated",
            ));
        }
        let Some(index) = session
            .messages
            .iter()
            .position(|existing| existing.id == message_id)
        else {
            return Err(SessionError {
                code: "MESSAGE_NOT_FOUND",
                message: format!("message {message_id} does not exist"),
                status: 404,
            });
        };
        let existing = &session.messages[index];
        if existing.role != message.role {
            return Err(SessionError::validation("a message cannot change its role"));
        }
        message.created_at = existing.created_at.clone();
        normalize_message(&mut session, &mut message)?;
        session.messages[index] = message;
        session.updated_at = crate::domain::now_iso();
        let trimmed = trim_to_size(&mut session)?;
        write_session(&path, &session)?;
        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        Ok((summary_of(&session, bytes, None), trimmed))
    }

    fn read(path: &Path) -> std::io::Result<AgentSession> {
        let raw = std::fs::read_to_string(path)?;
        let file: AgentSessionFile = serde_json::from_str(&raw)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        if file.schema_version > SESSION_SCHEMA_VERSION {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "the session was written by a newer version",
            ));
        }
        Ok(file.session)
    }
}

const DEFAULT_TITLE: &str = "New conversation";

fn clean_title(title: String) -> String {
    let title = title.trim();
    if title.is_empty() {
        DEFAULT_TITLE.to_string()
    } else {
        title.chars().take(MAX_AGENT_TITLE_LENGTH).collect()
    }
}

fn first_line(text: &str) -> String {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(DEFAULT_TITLE)
        .chars()
        .take(MAX_AGENT_TITLE_LENGTH)
        .collect()
}

fn normalize_message(session: &AgentSession, message: &mut AgentMessage) -> SessionResult<()> {
    let _ = session;
    if !matches!(message.role.as_str(), "user" | "assistant" | "error") {
        return Err(SessionError::validation(format!(
            "unknown message role '{}'",
            message.role
        )));
    }
    if message.text.chars().count() > MAX_AGENT_MESSAGE_LENGTH {
        message.text = message
            .text
            .chars()
            .take(MAX_AGENT_MESSAGE_LENGTH)
            .collect::<String>()
            .trim_end()
            .to_string();
        message.text.push('…');
    }
    if serde_json::to_vec(&message.tool_calls)
        .map(|bytes| bytes.len())
        .unwrap_or(0)
        > MAX_AGENT_TOOL_CALLS_BYTES
    {
        return Err(SessionError::validation(
            "the tool calls on one step are too large to keep",
        ));
    }
    if message.id.trim().is_empty() {
        message.id = crate::domain::new_id();
    }
    Ok(())
}

/// Drops the oldest messages, keeping the opening question and the recent tail.
fn trim(messages: &[AgentMessage], room: usize) -> Vec<AgentMessage> {
    let first_user = messages.iter().position(|message| message.role == "user");
    let tail_start = messages.len().saturating_sub(room);
    let mut kept = Vec::with_capacity(room + 1);
    for (index, message) in messages.iter().enumerate() {
        if index >= tail_start || Some(index) == first_user {
            kept.push(message.clone());
        }
    }
    kept
}

/// Trims until the file fits its ceiling. A session that cannot fit even after
/// keeping only the first question and the newest messages is refused rather
/// than written over its quota.
fn trim_to_size(session: &mut AgentSession) -> SessionResult<usize> {
    let mut trimmed = 0;
    while session.messages.len() > 1 && serialized_len(session) > MAX_AGENT_SESSION_BYTES {
        let drop = session
            .messages
            .iter()
            .position(|message| message.role != "user")
            .or(Some(0));
        let Some(drop) = drop else { break };
        session.messages.remove(drop);
        trimmed += 1;
    }
    if serialized_len(session) > MAX_AGENT_SESSION_BYTES {
        return Err(SessionError::too_large());
    }
    Ok(trimmed)
}

fn serialized_len(session: &AgentSession) -> usize {
    serde_json::to_vec(&AgentSessionFile {
        schema_version: SESSION_SCHEMA_VERSION,
        session: session.clone(),
    })
    .map(|bytes| bytes.len())
    .unwrap_or(0)
}

fn summary_of(session: &AgentSession, bytes: u64, snippet: Option<String>) -> AgentSessionSummary {
    AgentSessionSummary {
        id: session.id.clone(),
        title: session.title.clone(),
        created_at: session.created_at.clone(),
        updated_at: session.updated_at.clone(),
        message_count: session.messages.len(),
        bytes,
        last_scope: session.last_scope.clone(),
        model: session.model.clone(),
        snippet,
    }
}

fn search_hit(session: &AgentSession, needle: &str) -> Option<String> {
    for message in &session.messages {
        let lower = message.text.to_lowercase();
        if let Some(index) = lower.find(needle) {
            let chars: Vec<char> = message.text.chars().collect();
            let start = message.text[..index].chars().count().saturating_sub(40);
            let snippet: String = chars.into_iter().skip(start).take(SNIPPET_CHARS).collect();
            return Some(snippet);
        }
    }
    None
}

fn corrupt_path(path: &Path) -> PathBuf {
    let stamp = uuid::Uuid::now_v7();
    path.with_file_name(format!(
        "{}.corrupt.{stamp}.json",
        path.file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("session")
    ))
}

fn write_session(path: &Path, session: &AgentSession) -> SessionResult<()> {
    let Some(dir) = path.parent() else {
        return Err(SessionError::io(std::io::Error::other(
            "the session path has no directory",
        )));
    };
    std::fs::create_dir_all(dir).map_err(SessionError::io)?;
    let bytes = serde_json::to_vec_pretty(&AgentSessionFile {
        schema_version: SESSION_SCHEMA_VERSION,
        session: session.clone(),
    })
    .map_err(|error| SessionError::io(std::io::Error::other(error)))?;
    let tmp = dir.join(format!(".{}.{}.tmp", session.id, uuid::Uuid::now_v7()));
    let outcome = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        if let Ok(handle) = std::fs::File::open(dir) {
            let _ = handle.sync_all();
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        let _ = std::fs::remove_file(&tmp);
        return Err(SessionError::io(error));
    }
    Ok(())
}

/// The message ids a caller may name, for a bulk delete that should not be
/// able to name a path.
pub fn valid_ids(ids: &[String]) -> bool {
    let unique: BTreeSet<&String> = ids.iter().collect();
    unique.len() == ids.len()
        && ids.iter().all(|id| {
            !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

/// Creates the directory a project's conversations live in, when a project is
/// scaffolded. A project made before this existed gets it on first write.
pub fn scaffold(root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(AgentSessionStore::sessions_dir(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn message(id: &str, role: &str, text: &str) -> AgentMessage {
        AgentMessage {
            id: id.into(),
            role: role.into(),
            text: text.into(),
            created_at: crate::domain::now_iso(),
            turn_id: None,
            step_index: None,
            tool_calls: Vec::new(),
            references: Vec::new(),
            scope: None,
            failure: None,
        }
    }

    async fn store() -> (tempfile::TempDir, Arc<AgentSessionStore>) {
        let dir = tempfile::tempdir().expect("a temporary project");
        scaffold(dir.path()).expect("the sessions directory");
        (dir, Arc::new(AgentSessionStore::new()))
    }

    #[tokio::test]
    async fn a_session_is_created_read_and_deleted() {
        let (dir, store) = store().await;
        let created = store
            .create(dir.path(), Some("湖边".into()), None, None)
            .await
            .expect("a session");
        assert_eq!(created.title, "湖边");
        let read = store.get(dir.path(), &created.id, 20, None).await;
        assert!(read.is_ok());
        store
            .delete(dir.path(), &created.id)
            .await
            .expect("deleted");
        assert!(store.get(dir.path(), &created.id, 20, None).await.is_err());
    }

    #[tokio::test]
    async fn appending_the_same_message_twice_keeps_one() {
        let (dir, store) = store().await;
        let session = store.create(dir.path(), None, None, None).await.unwrap();
        for _ in 0..2 {
            store
                .append(dir.path(), &session.id, message("m_1", "user", "hello"))
                .await
                .expect("appended");
        }
        let read = store.get(dir.path(), &session.id, 20, None).await.unwrap();
        assert_eq!(read.messages.len(), 1);
    }

    #[tokio::test]
    async fn the_first_question_names_a_session_that_has_no_title() {
        let (dir, store) = store().await;
        let session = store.create(dir.path(), None, None, None).await.unwrap();
        assert_eq!(session.title, DEFAULT_TITLE);
        store
            .append(
                dir.path(),
                &session.id,
                message("m_1", "user", "把湖面裁到 20 秒\n再加一个溶解"),
            )
            .await
            .unwrap();
        let read = store.get(dir.path(), &session.id, 20, None).await.unwrap();
        assert_eq!(read.title, "把湖面裁到 20 秒");
    }

    #[tokio::test]
    async fn search_matches_a_message_and_returns_a_snippet() {
        let (dir, store) = store().await;
        let session = store.create(dir.path(), None, None, None).await.unwrap();
        store
            .append(
                dir.path(),
                &session.id,
                message("m_1", "user", "please add a crossfade to the lake"),
            )
            .await
            .unwrap();
        let found = store
            .list(dir.path(), Some("crossfade"), 20, None)
            .await
            .unwrap();
        assert_eq!(found.sessions.len(), 1);
        assert!(found.sessions[0]
            .snippet
            .as_deref()
            .unwrap_or_default()
            .contains("crossfade"));
        let none = store
            .list(dir.path(), Some("mountain"), 20, None)
            .await
            .unwrap();
        assert!(none.sessions.is_empty());
    }

    #[tokio::test]
    async fn a_session_over_the_message_ceiling_keeps_the_first_question_and_the_tail() {
        let (dir, store) = store().await;
        let session = store.create(dir.path(), None, None, None).await.unwrap();
        for index in 0..MAX_AGENT_MESSAGES_PER_SESSION {
            store
                .append(
                    dir.path(),
                    &session.id,
                    message(
                        &format!("m_{index}"),
                        if index == 0 { "user" } else { "assistant" },
                        &format!("line {index}"),
                    ),
                )
                .await
                .unwrap();
        }
        store
            .append(
                dir.path(),
                &session.id,
                message("m_last", "assistant", "the newest line"),
            )
            .await
            .unwrap();
        let read = store
            .get(dir.path(), &session.id, 1_000, None)
            .await
            .unwrap();
        assert!(read.messages.len() <= MAX_AGENT_MESSAGES_PER_SESSION);
        assert_eq!(read.messages[0].id, "m_0");
        assert_eq!(read.messages.last().expect("a tail").id, "m_last");
    }

    #[tokio::test]
    async fn a_corrupt_session_is_set_aside_without_hiding_the_rest() {
        let (dir, store) = store().await;
        let good = store
            .create(dir.path(), Some("good".into()), None, None)
            .await
            .unwrap();
        let bad = AgentSessionStore::sessions_dir(dir.path()).join("bad.json");
        std::fs::write(&bad, "{not json").unwrap();
        let listed = store.list(dir.path(), None, 20, None).await.unwrap();
        assert_eq!(listed.sessions.len(), 1);
        assert_eq!(listed.sessions[0].id, good.id);
        assert_eq!(listed.warnings.len(), 1);
        assert!(!bad.exists());
    }

    #[tokio::test]
    async fn only_an_assistant_step_can_be_updated() {
        let (dir, store) = store().await;
        let session = store.create(dir.path(), None, None, None).await.unwrap();
        store
            .append(dir.path(), &session.id, message("m_1", "user", "hello"))
            .await
            .unwrap();
        let error = store
            .update_message(
                dir.path(),
                &session.id,
                "m_1",
                message("m_1", "assistant", "rewritten"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION_FAILED");
    }

    #[tokio::test]
    async fn a_session_file_is_written_atomically_and_never_as_a_partial_document() {
        let (dir, store) = store().await;
        let session = store.create(dir.path(), None, None, None).await.unwrap();
        store
            .append(dir.path(), &session.id, message("m_1", "user", "hello"))
            .await
            .unwrap();
        let path = AgentSessionStore::sessions_dir(dir.path()).join(format!("{}.json", session.id));
        let raw = std::fs::read_to_string(path).unwrap();
        let file: AgentSessionFile = serde_json::from_str(&raw).expect("a whole document");
        assert_eq!(file.schema_version, SESSION_SCHEMA_VERSION);
        assert_eq!(file.session.messages.len(), 1);
    }
}
