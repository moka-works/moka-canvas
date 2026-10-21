//! Project-level tools: what the project is, what it can generate with, what
//! a task is doing, and the lifecycle calls only an external caller makes.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::api::{ApiState, ProjectSession};
use crate::domain::{Capability, DocumentCommand, MokaFile};
use crate::generate::TaskState;
use crate::metadata::RecentProject;
use crate::project::{CreateProject, OpenProject, PackageScope, ProjectStore};

use super::super::context::{chat_context, AgentScope};
use super::super::error::ToolError;
use super::{Args, ToolOutcome};

pub async fn command(
    state: &ApiState,
    _root: &Path,
    moka: &MokaFile,
    name: &str,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    let store = state
        .store
        .resolve(Some(&moka.metadata.id))
        .map_err(ToolError::from)?;
    match name {
        "project.overview" => {
            let snapshot = state.models.snapshot().await.map_err(ToolError::from)?;
            let models: Vec<Value> = snapshot
                .models
                .iter()
                .map(|model| {
                    json!({
                        "id": model.id,
                        "label": model.display_name,
                        "capability": model.category,
                        "protocol": model.protocol.wire_name(),
                        "enabled": model.enabled,
                    })
                })
                .collect();
            let catalog = super::super::catalog::catalog();
            let mut overview = super::super::context::project_summary(moka, 0);
            overview["models"] = json!(models);
            overview["catalogVersion"] = json!(super::super::catalog::CATALOG_VERSION);
            overview["catalogHash"] = json!(catalog.hash());
            Ok(ToolOutcome::read("project overview", overview))
        }
        "project.update" => {
            let args = Args::new(name, input)?;
            let new_name = args.req_str("name")?;
            let description = args
                .opt_str("description")
                .map(str::to_string)
                .or_else(|| moka.metadata.description.clone())
                .unwrap_or_default();
            Ok(ToolOutcome::write(
                format!("Renamed the project to {new_name}"),
                json!({"name": new_name, "description": description}),
                vec![DocumentCommand::UpdateProjectMetadata {
                    name: new_name.to_string(),
                    description,
                }],
            ))
        }
        "project.self_check" => {
            let Some((report, verified)) =
                store.self_check_status().await.map_err(ToolError::from)?
            else {
                return Err(ToolError::new("PROJECT_NOT_OPEN", "No project is open"));
            };
            Ok(ToolOutcome::read(
                if report.ok {
                    "the file check found no issues".to_string()
                } else {
                    format!("the file check found {} issues", report.issues.len())
                },
                json!({"report": report, "verified": verified}),
            ))
        }
        "project.describe_models" => {
            let args = Args::new(name, input)?;
            let wanted = args.opt_str("capability");
            let snapshot = state.models.snapshot().await.map_err(ToolError::from)?;
            let models: Vec<Value> = snapshot
                .models
                .iter()
                .filter(|model| {
                    wanted
                        .map(|wanted| model.category.as_str() == wanted)
                        .unwrap_or(true)
                })
                .map(|model| {
                    json!({
                        "id": model.id,
                        "label": model.display_name,
                        "capability": model.category,
                        "protocol": model.protocol.wire_name(),
                        "enabled": model.enabled,
                    })
                })
                .collect();
            Ok(ToolOutcome::read(
                format!("{} configured models", models.len()),
                json!({"models": models}),
            ))
        }
        "project.list_recent" => list_recent(state).await,
        "context.get" => {
            let args = Args::new(name, input)?;
            let scope = AgentScope {
                room: args.opt_str("section").unwrap_or("project").to_string(),
                canvas_id: args.opt_str("canvasId").map(str::to_string),
                timeline_id: args.opt_str("timelineId").map(str::to_string),
                asset_id: args.opt_str("assetId").map(str::to_string),
                story_id: args.opt_str("storyId").map(str::to_string),
                node_ids: args.opt_strings("nodeIds"),
                ..AgentScope::default()
            };
            if scope.room == "project" {
                let catalog = super::super::catalog::catalog();
                return Ok(ToolOutcome::read(
                    "project context",
                    json!({
                        "project": super::super::context::project_summary(moka, 0),
                        "catalogVersion": super::super::catalog::CATALOG_VERSION,
                        "catalogHash": catalog.hash(),
                    }),
                ));
            }
            if !scope.valid_room() {
                return Err(ToolError::validation(
                    "section must be project, canvas, timeline, asset, or story",
                ));
            }
            let summary = chat_context(moka, &scope, 0);
            Ok(ToolOutcome::read("room context", summary))
        }
        "task.get" => {
            let args = Args::new(name, input)?;
            let kind = args.req_str("kind")?;
            let id = args.req_str("id")?;
            let status = task_status(state, &store, kind, id).await?;
            Ok(ToolOutcome::read(
                format!(
                    "{kind} {id}: {status}",
                    status = status["status"].as_str().unwrap_or("unknown")
                ),
                status,
            ))
        }
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not a core command"),
        )),
    }
}

pub async fn effect(
    state: &ApiState,
    session: Option<&ProjectSession>,
    name: &str,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    match name {
        "project.create" => {
            if !super::local_paths_allowed(state) {
                return Err(ToolError::new(
                    "VALIDATION_FAILED",
                    "project lifecycle tools that take a path are only available on a loopback server",
                ));
            }
            let args = Args::new(name, input)?;
            let directory = PathBuf::from(args.req_str("directory")?);
            let project_name = args.req_str("name")?.to_string();
            let use_subdirectory = args.opt_bool("useSubdirectory", false);
            let root = if use_subdirectory {
                directory.join(crate::assets::slugify(&project_name))
            } else if target_is_empty(&directory)? {
                directory
            } else {
                return Err(ToolError::new(
                    "TARGET_DIRECTORY_NOT_EMPTY",
                    "The target folder is not empty; the project needs a subfolder of its own",
                ));
            };
            let (_, opened) = state
                .store
                .create_project(
                    &root,
                    CreateProject {
                        name: project_name,
                        first_canvas_name: None,
                    },
                )
                .await?;
            note_recent(state, &opened).await;
            Ok(ToolOutcome::effect(
                format!(
                    "Created project {} at {}",
                    opened.moka.metadata.name,
                    opened.root.display()
                ),
                json!({
                    "projectId": opened.moka.metadata.id,
                    "root": opened.root,
                    "revision": opened.moka.metadata.revision,
                }),
            ))
        }
        "project.open" => {
            if !super::local_paths_allowed(state) {
                return Err(ToolError::new(
                    "VALIDATION_FAILED",
                    "project lifecycle tools that take a path are only available on a loopback server",
                ));
            }
            let args = Args::new(name, input)?;
            let path = PathBuf::from(args.req_str("path")?);
            let (_, opened) = state.store.open_project(&path).await?;
            note_recent(state, &opened).await;
            Ok(ToolOutcome::effect(
                format!("Opened project {}", opened.moka.metadata.name),
                json!({
                    "projectId": opened.moka.metadata.id,
                    "root": opened.root,
                    "revision": opened.moka.metadata.revision,
                }),
            ))
        }
        "project.import" => {
            if !super::local_paths_allowed(state) {
                return Err(ToolError::new(
                    "VALIDATION_FAILED",
                    "project lifecycle tools that take a path are only available on a loopback server",
                ));
            }
            let args = Args::new(name, input)?;
            let archive = PathBuf::from(args.req_str("archivePath")?);
            let directory = PathBuf::from(args.req_str("directory")?);
            let root = match args.opt_str("name") {
                Some(project_name) => directory.join(crate::assets::slugify(project_name)),
                None => directory,
            };
            let (_, opened) = state.store.import_package(&archive, &root).await?;
            note_recent(state, &opened).await;
            Ok(ToolOutcome::effect(
                format!("Imported project {}", opened.moka.metadata.name),
                json!({
                    "projectId": opened.moka.metadata.id,
                    "root": opened.root,
                    "revision": opened.moka.metadata.revision,
                }),
            ))
        }
        "project.remove_recent" => {
            let args = Args::new(name, input)?;
            let id = args.req_str("id")?;
            state
                .metadata
                .remove_recent(id)
                .await
                .map_err(metadata_error)?;
            Ok(ToolOutcome::effect(
                format!("Removed project {id} from the recent list"),
                json!({"removed": id}),
            ))
        }
        "project.export" => {
            let args = Args::new(name, input)?;
            let destination = PathBuf::from(args.req_str("destination")?);
            if let Some(parent) = destination.parent() {
                if !parent.exists() {
                    return Err(ToolError::new(
                        "DESTINATION_NOT_FOUND",
                        format!("{} does not exist", parent.display()),
                    ));
                }
            }
            let scope = PackageScope {
                personal_history: args.opt_bool("includePersonalHistory", false),
                referenced_assets_only: args.opt_bool("onlyReferencedAssets", false),
            };
            let session =
                session.ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
            let report = session
                .0
                .export_package(&destination, args.opt_bool("allowIncomplete", false), scope)
                .await?;
            Ok(ToolOutcome::effect(
                format!(
                    "Exported {} entries to {}",
                    report.entries,
                    destination.display()
                ),
                json!({
                    "destination": report.destination,
                    "entries": report.entries,
                    "bytes": report.bytes,
                    "incomplete": report.incomplete,
                }),
            ))
        }
        "task.cancel" => {
            let args = Args::new(name, input)?;
            let kind = args.req_str("kind")?;
            let id = args.req_str("id")?;
            match kind {
                "run" => {
                    let session = session
                        .ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
                    state.runs.cancel(&session.0, id).await?;
                }
                "storyJob" => {
                    let session = session
                        .ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
                    state.story_jobs.cancel(&session.0, id).await?;
                }
                "clipExport" => {
                    state
                        .exports
                        .cancel(id)
                        .map_err(|error| ToolError::new("TASK_NOT_FOUND", error.to_string()))?;
                }
                "asr" => return Err(ToolError::new(
                    "VALIDATION_FAILED",
                    "A recognition job cannot be cancelled once placed; it is read when it answers",
                )),
                other => {
                    return Err(ToolError::validation(format!(
                        "unknown task kind '{other}'"
                    )))
                }
            }
            let session =
                session.ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?;
            let status = task_status(state, &session.0, kind, id).await?;
            Ok(ToolOutcome::effect(
                format!("Cancelled {kind} {id}"),
                status,
            ))
        }
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not a core effect"),
        )),
    }
}

pub async fn list_recent(state: &ApiState) -> Result<ToolOutcome, ToolError> {
    let recent = state.metadata.list_recent().await.map_err(metadata_error)?;
    Ok(ToolOutcome::read(
        format!("{} recent projects", recent.len()),
        json!({"projects": recent}),
    ))
}

fn target_is_empty(directory: &Path) -> Result<bool, ToolError> {
    match std::fs::read_dir(directory) {
        Ok(mut entries) => Ok(entries.next().is_none()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(ToolError::validation(format!(
            "{} cannot be read: {error}",
            directory.display()
        ))),
    }
}

async fn note_recent(state: &ApiState, opened: &OpenProject) {
    let entry = RecentProject {
        id: opened.moka.metadata.id.clone(),
        name: opened.moka.metadata.name.clone(),
        path: opened.root.clone(),
        last_opened: crate::domain::now_iso(),
    };
    if let Err(error) = state.metadata.upsert_recent(&entry).await {
        tracing::warn!("recent project could not be noted: {error}");
    }
}

fn metadata_error(error: crate::metadata::MetadataError) -> ToolError {
    ToolError::new(error.code(), error.to_string())
}

async fn task_status(
    state: &ApiState,
    store: &std::sync::Arc<crate::project::store::FsProjectStore>,
    kind: &str,
    id: &str,
) -> Result<Value, ToolError> {
    match kind {
        "run" => {
            let run = store.get_run(id).await?;
            Ok(json!({
                "status": run.status,
                "message": run.error,
                "result": {"runId": run.id, "canvasId": run.canvas_id},
                "steps": run.steps,
            }))
        }
        "storyJob" => {
            let job = store.get_story_job(id).await?;
            Ok(json!({
                "status": job.status,
                "message": job.error,
                "result": {"jobId": job.id, "storyId": job.story_id, "items": job.items},
                "progress": progress_of(job.items.len(), job.items.iter().filter(|item| item.status.is_terminal()).count()),
            }))
        }
        "asr" => {
            let cached = state.agent_tasks.lock().await.get(id).cloned();
            if let Some(cached) = cached {
                return Ok(cached);
            }
            match state
                .gateway
                .poll(store, id, &crate::generate::Cancel::new())
                .await
            {
                Ok(TaskState::Pending { retry_after_ms }) => Ok(json!({
                    "status": "running",
                    "message": format!("again in {retry_after_ms} ms"),
                })),
                Ok(TaskState::Succeeded(result)) => {
                    let status = json!({
                        "status": "succeeded",
                        "progress": 1.0,
                        "result": {"text": result.text, "usage": result.usage},
                    });
                    state
                        .agent_tasks
                        .lock()
                        .await
                        .insert(id.to_string(), status.clone());
                    Ok(status)
                }
                Ok(TaskState::Failed { message, retryable }) => Ok(json!({
                    "status": "failed",
                    "error": {"code": "PROVIDER_FAILED", "message": message, "retryable": retryable},
                })),
                Err(error) => Err(error.into()),
            }
        }
        "clipExport" => {
            let task = state
                .exports
                .snapshot(id)
                .map_err(|error| ToolError::new("TASK_NOT_FOUND", error.to_string()))?;
            Ok(json!({
                "status": task.status,
                "progress": task.progress01,
                "message": task.message,
                "result": {"path": task.saved_to, "timelineId": task.timeline_id},
            }))
        }
        other => Err(ToolError::validation(format!(
            "unknown task kind '{other}'"
        ))),
    }
}

fn progress_of(total: usize, done: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        done as f64 / total as f64
    }
}

/// The capabilities a caller may ask a model for, named for an error message.
pub fn capability_named(name: &str) -> Option<Capability> {
    match name {
        "text" => Some(Capability::Text),
        "image" => Some(Capability::Image),
        "speech" => Some(Capability::Speech),
        "music" => Some(Capability::Music),
        "video" => Some(Capability::Video),
        "asr" => Some(Capability::Asr),
        _ => None,
    }
}
