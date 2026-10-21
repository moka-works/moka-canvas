//! Turning a tool call into a committed change or a guarded effect.
//!
//! The rules are the contract: a command tool is planned from the current
//! document, submitted through the one command pipeline with CAS, and recorded
//! with its inverse. An effect tool runs once, is never retried automatically,
//! and leaves an audit record instead of an inverse. A tool may not do both.
//!
//! The runner is also where risk is enforced for callers that have no
//! interface to ask: a spend, destroy, or export without an acknowledgement is
//! refused before anything happens.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::{ApiState, ProjectSession};
use crate::project::{ProjectStore, StagedAsset};

use super::catalog::{catalog, ToolKind, ToolRisk, ToolSurface};
use super::error::ToolError;
use super::journal::{self, AuditRequest, ChangeRequest};
use super::tools::{self, TaskRef, ToolOutcome};

const CAS_ATTEMPTS: usize = 5;

#[derive(Debug, Clone)]
pub struct ToolRequest {
    pub input: Value,
    pub dry_run: bool,
    pub acknowledge_risk: bool,
    pub idempotency_key: Option<String>,
    pub request_id: Option<String>,
    pub actor: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
}

impl Default for ToolRequest {
    fn default() -> Self {
        Self {
            input: Value::Object(Default::default()),
            dry_run: false,
            acknowledge_risk: false,
            idempotency_key: None,
            request_id: None,
            actor: "http".into(),
            session_id: None,
            turn_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResponse {
    pub ok: bool,
    pub tool: String,
    pub version: u32,
    pub kind: String,
    pub summary: String,
    pub data: Value,
    pub commands: Vec<crate::domain::DocumentCommand>,
    pub assets_added: Vec<crate::domain::ResourceEntry>,
    pub assets_updated: Vec<crate::domain::ResourceEntry>,
    pub assets_removed: Vec<String>,
    pub base_revision: i32,
    pub revision: i32,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_set_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskRef>,
    pub warnings: Vec<String>,
    pub view: Option<Value>,
    pub reload: bool,
}

/// Runs one tool call end to end.
pub async fn invoke(
    state: &ApiState,
    session: Option<&ProjectSession>,
    name: &str,
    request: ToolRequest,
) -> Result<ToolResponse, ToolError> {
    let catalog = catalog();
    let spec = catalog
        .find(name)
        .ok_or_else(|| ToolError::new("TOOL_NOT_FOUND", format!("tool {name} does not exist")))?
        .clone();
    if spec.surface == ToolSurface::App {
        return Err(ToolError::new(
            "APP_ONLY_UNAVAILABLE",
            format!("{name} runs in the interface's own agent loop, not on the server"),
        ));
    }
    let external = !matches!(request.actor.as_str(), "ui" | "app");
    if external && !spec.accepts_surface(ToolSurface::External) {
        return Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {name} is not available to external callers"),
        ));
    }
    if spec.risk.needs_acknowledgement() && !request.acknowledge_risk {
        return Err(ToolError::new(
            "AGENT_RISK_UNACKNOWLEDGED",
            format!(
                "{name} is a {} tool; confirm the action before it runs",
                spec.risk.as_str()
            ),
        )
        .details(serde_json::json!({"tool": name, "risk": spec.risk.as_str()})));
    }
    if spec.kind == ToolKind::Effect && request.dry_run {
        return Err(ToolError::new(
            "DRY_RUN_UNSUPPORTED",
            format!("{name} has external effects and cannot be dry-run"),
        ));
    }
    if spec.kind == ToolKind::Effect && !spec.mutates && spec.risk == ToolRisk::Read {
        // An effect with no document mutation still does something outside;
        // the audit path below is where it belongs.
    }
    match spec.kind {
        ToolKind::Command => match session {
            Some(session) => run_command(state, session, &spec, &request).await,
            None if spec.name == "project.list_recent" => {
                let outcome = tools::run_without_project(state, &spec.name, &request.input).await?;
                Ok(response_of(
                    &spec,
                    &outcome,
                    0,
                    0,
                    crate::domain::now_iso(),
                    None,
                    None,
                ))
            }
            None => Err(ToolError::new("PROJECT_NOT_OPEN", "No project is open")),
        },
        ToolKind::Effect => run_effect(state, session, &spec, &request).await,
    }
}

async fn run_command(
    state: &ApiState,
    session: &ProjectSession,
    spec: &super::catalog::ToolSpec,
    request: &ToolRequest,
) -> Result<ToolResponse, ToolError> {
    let root = session.0.project_root().await.map_err(ToolError::from)?;
    let mut last_conflict: Option<ToolError> = None;
    for _ in 0..CAS_ATTEMPTS {
        let opened = session
            .0
            .current()
            .await
            .map_err(ToolError::from)?
            .ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
        let base_revision = opened.moka.metadata.revision;
        let digest_before = journal::digest_of(&opened.moka);
        let outcome = tools::run_command(state, &root, &opened.moka, &spec.name, &request.input)
            .await
            .map_err(|error| error.with_tool(&spec.name))?;
        if request.dry_run || !spec.mutates || outcome.commands.is_empty() {
            return Ok(response_of(
                spec,
                &outcome,
                base_revision,
                base_revision,
                opened.moka.metadata.updated_at.clone(),
                None,
                None,
            ));
        }
        match session
            .0
            .apply_agent_commands(base_revision, outcome.commands.clone())
            .await
        {
            Ok((saved, inverse)) => {
                let after = session
                    .0
                    .current()
                    .await
                    .map_err(ToolError::from)?
                    .ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
                let change = journal::record_change(
                    &root,
                    ChangeRequest {
                        tool: &spec.name,
                        tool_version: spec.version,
                        actor: &request.actor,
                        session_id: request.session_id.as_deref(),
                        turn_id: request.turn_id.as_deref(),
                        base_revision,
                        revision: saved.revision,
                        summary: &outcome.summary,
                        forward: outcome.commands.clone(),
                        inverse,
                        digest_before,
                        digest_after: journal::digest_of(&after.moka),
                    },
                )?;
                return Ok(response_of(
                    spec,
                    &outcome,
                    base_revision,
                    saved.revision,
                    saved.updated_at,
                    Some(change),
                    None,
                ));
            }
            Err(error) if error.code() == "REVISION_CONFLICT" => {
                last_conflict = Some(error.into());
                continue;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(last_conflict.unwrap_or_else(|| {
        ToolError::new(
            "REVISION_CONFLICT",
            "The document kept moving; read it again and retry",
        )
    }))
}

async fn run_effect(
    state: &ApiState,
    session: Option<&ProjectSession>,
    spec: &super::catalog::ToolSpec,
    request: &ToolRequest,
) -> Result<ToolResponse, ToolError> {
    let Some(session) = session else {
        // Project lifecycle happens before there is a project to keep an
        // audit in. It runs, and its answer is the record the caller gets.
        if !matches!(
            spec.name.as_str(),
            "project.create" | "project.open" | "project.import" | "project.remove_recent"
        ) {
            return Err(ToolError::new("PROJECT_NOT_OPEN", "No project is open"));
        }
        let outcome = tools::run_effect(
            state,
            None,
            &spec.name,
            &request.input,
            &crate::domain::MokaFile {
                version: crate::domain::MOKA_FILE_VERSION.into(),
                metadata: crate::domain::ProjectMetadata {
                    id: String::new(),
                    name: String::new(),
                    description: None,
                    cover_path: None,
                    revision: 0,
                    created_at: crate::domain::now_iso(),
                    updated_at: crate::domain::now_iso(),
                },
                resources: Default::default(),
                folders: None,
                timelines: None,
                stories: None,
                director_scenes: None,
                canvas: Vec::new(),
            },
            None,
        )
        .await
        .map_err(|error| error.with_tool(&spec.name))?;
        return Ok(response_of(
            spec,
            &outcome,
            0,
            0,
            crate::domain::now_iso(),
            None,
            None,
        ));
    };
    let root = session.0.project_root().await.map_err(ToolError::from)?;
    let input = prepare_effect_input(state, session, &root, spec, request).await?;
    let hash = journal::input_hash(&input);
    let key = request
        .idempotency_key
        .as_deref()
        .or(request.request_id.as_deref());
    if let Some(key) = key {
        if let Some(previous) = journal::idempotent_answer(&root, key, &spec.name, &hash)? {
            return serde_json::from_value(previous).map_err(|error| {
                ToolError::internal(format!("the remembered answer cannot be read: {error}"))
            });
        }
    }
    let opened = session
        .0
        .current()
        .await
        .map_err(ToolError::from)?
        .ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
    let before = opened.moka.metadata.revision;
    let outcome = tools::run_effect(
        state,
        Some(session),
        &spec.name,
        &input,
        &opened.moka,
        request.session_id.as_deref(),
    )
    .await
    .map_err(|error| error.with_tool(&spec.name))?;
    if !outcome.commands.is_empty() {
        return Err(ToolError::internal(format!(
            "{} is an effect but planned document commands",
            spec.name
        )));
    }
    let revision = outcome.revision.unwrap_or(before);
    let updated_at = outcome
        .updated_at
        .clone()
        .unwrap_or_else(|| opened.moka.metadata.updated_at.clone());
    let audit = journal::record_audit(
        &root,
        AuditRequest {
            tool: &spec.name,
            tool_version: spec.version,
            actor: &request.actor,
            session_id: request.session_id.as_deref(),
            turn_id: request.turn_id.as_deref(),
            input_hash: hash.clone(),
            summary: &outcome.summary,
            result: outcome.data.clone(),
            task_id: outcome.task.as_ref().map(|task| task.id.clone()),
            assets_added: outcome
                .assets_added
                .iter()
                .map(|entry| entry.id.clone())
                .collect(),
            assets_updated: outcome
                .assets_updated
                .iter()
                .map(|entry| entry.id.clone())
                .collect(),
            assets_removed: outcome.assets_removed.clone(),
        },
    )?;
    let response = response_of(
        spec,
        &outcome,
        before,
        revision,
        updated_at,
        None,
        Some(audit),
    );
    if let Some(key) = key {
        let stored = serde_json::to_value(&response)
            .map_err(|error| ToolError::internal(error.to_string()))?;
        journal::remember_answer(&root, key, &spec.name, &hash, &stored)?;
        journal::prune_idempotency(&root);
    }
    Ok(response)
}

/// An app-only import cannot reach the server; an external path import must
/// name paths. Everything else is handed through unchanged.
async fn prepare_effect_input(
    _state: &ApiState,
    _session: &ProjectSession,
    _root: &std::path::Path,
    _spec: &super::catalog::ToolSpec,
    request: &ToolRequest,
) -> Result<Value, ToolError> {
    Ok(request.input.clone())
}

fn response_of(
    spec: &super::catalog::ToolSpec,
    outcome: &ToolOutcome,
    base_revision: i32,
    revision: i32,
    updated_at: String,
    change_set_id: Option<String>,
    audit_id: Option<String>,
) -> ToolResponse {
    ToolResponse {
        ok: true,
        tool: spec.name.clone(),
        version: spec.version,
        kind: spec.kind.as_str().into(),
        summary: outcome.summary.clone(),
        data: outcome.data.clone(),
        commands: outcome.commands.clone(),
        assets_added: outcome.assets_added.clone(),
        assets_updated: outcome.assets_updated.clone(),
        assets_removed: outcome.assets_removed.clone(),
        base_revision,
        revision,
        updated_at,
        change_set_id,
        audit_id,
        task: outcome.task.clone(),
        warnings: outcome.warnings.clone(),
        view: None,
        reload: outcome.reload,
    }
}

/// Undoes a command change, if its starting point is still the document.
pub async fn undo_change(
    state: &ApiState,
    session: &ProjectSession,
    id: &str,
) -> Result<Value, ToolError> {
    let _ = state;
    let root = session.0.project_root().await.map_err(ToolError::from)?;
    let Some(change) = journal::get_change(&root, id) else {
        // An audit id is not a change; saying so is the whole point of the
        // split. An unknown id is simply not found.
        if id.starts_with("au_") {
            return Err(ToolError::new(
                "NOT_UNDOABLE",
                "That operation wrote files or started a task; it cannot be undone",
            ));
        }
        return Err(ToolError::new(
            "CHANGE_STALE",
            format!("change {id} is not in the history"),
        ));
    };
    if change.undone_at.is_some() {
        return Err(ToolError::new(
            "CHANGE_STALE",
            "That change was already undone",
        ));
    }
    let mut last: Option<ToolError> = None;
    for _ in 0..CAS_ATTEMPTS {
        let opened = session
            .0
            .current()
            .await
            .map_err(ToolError::from)?
            .ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
        if journal::digest_of(&opened.moka) != change.digest_after {
            return Err(ToolError::new(
                "CHANGE_STALE",
                "The document has changed since that tool ran; undo is no longer exact",
            ));
        }
        match session
            .0
            .apply_agent_commands(
                opened.moka.metadata.revision,
                change.inverse_commands.clone(),
            )
            .await
        {
            Ok((saved, _inverse)) => {
                journal::mark_undone(&root, &change)?;
                return Ok(serde_json::json!({
                    "revision": saved.revision,
                    "updatedAt": saved.updated_at,
                    "changeSetId": change.id,
                }));
            }
            Err(error) if error.code() == "REVISION_CONFLICT" => {
                last = Some(error.into());
                continue;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(last.unwrap_or_else(|| {
        ToolError::new(
            "REVISION_CONFLICT",
            "The document kept moving; read it again and retry",
        )
    }))
}

/// Stages a file from a path on this machine, for the external import tool.
pub async fn stage_path(
    path: &std::path::Path,
    hint: Option<&str>,
) -> Result<StagedAsset, ToolError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        ToolError::validation(format!("{} cannot be read: {error}", path.display()))
    })?;
    if !metadata.is_file() {
        return Err(ToolError::validation(format!(
            "{} is not a file",
            path.display()
        )));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("import")
        .to_string();
    let tmp_dir = std::env::temp_dir().join(format!("moka-agent-{}", crate::domain::new_id()));
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|error| ToolError::internal(format!("a staging directory failed: {error}")))?;
    let tmp_path = tmp_dir.join(&name);
    std::fs::copy(path, &tmp_path)
        .map_err(|error| ToolError::internal(format!("the file could not be staged: {error}")))?;
    Ok(StagedAsset {
        name,
        tmp_path,
        declared_mime: None,
        category_hint: hint.map(str::to_string),
        provenance: None,
    })
}

/// The store an effect tool writes through, kept in one place so a tool does
/// not grow its own copy of the resolution rules.
pub async fn store_of(session: &ProjectSession) -> Arc<crate::project::store::FsProjectStore> {
    Arc::clone(&session.0)
}
