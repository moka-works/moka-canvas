//! The tools themselves.
//!
//! A command tool reads the document it is handed and returns the commands
//! that change it; it never writes. An effect tool is handed the store and
//! does the one thing it is for, returning what changed outside the document.
//! The split is enforced by the runner, not by convention.

pub mod assets;
pub mod canvas;
pub mod clip;
pub mod core;
pub mod story;

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::{ApiState, ProjectSession};
use crate::domain::{DocumentCommand, MokaFile, ResourceEntry};

use super::error::ToolError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRef {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Default)]
pub struct ToolOutcome {
    pub summary: String,
    pub data: Value,
    pub commands: Vec<DocumentCommand>,
    pub assets_added: Vec<ResourceEntry>,
    pub assets_updated: Vec<ResourceEntry>,
    pub assets_removed: Vec<String>,
    pub task: Option<TaskRef>,
    pub warnings: Vec<String>,
    pub reload: bool,
    pub revision: Option<i32>,
    pub updated_at: Option<String>,
}

impl ToolOutcome {
    pub fn read(summary: impl Into<String>, data: Value) -> Self {
        Self {
            summary: summary.into(),
            data,
            ..Self::default()
        }
    }

    pub fn write(summary: impl Into<String>, data: Value, commands: Vec<DocumentCommand>) -> Self {
        Self {
            summary: summary.into(),
            data,
            commands,
            ..Self::default()
        }
    }

    pub fn effect(summary: impl Into<String>, data: Value) -> Self {
        Self {
            summary: summary.into(),
            data,
            ..Self::default()
        }
    }
}

/// One query of a tool's input, with the errors a model's mistakes deserve.
pub struct Args<'a> {
    input: &'a serde_json::Map<String, Value>,
    tool: &'a str,
}

impl<'a> Args<'a> {
    pub fn new(tool: &'a str, input: &'a Value) -> Result<Self, ToolError> {
        let Some(map) = input.as_object() else {
            return Err(ToolError::validation(format!(
                "{tool} expects an input object"
            )));
        };
        Ok(Self { input: map, tool })
    }

    fn missing(&self, key: &str) -> ToolError {
        ToolError::validation(format!("{} requires '{key}'", self.tool))
    }

    pub fn raw(&self, key: &str) -> Option<&Value> {
        self.input.get(key)
    }

    pub fn req_str(&self, key: &str) -> Result<&str, ToolError> {
        self.input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| self.missing(key))
    }

    pub fn opt_str(&self, key: &str) -> Option<&str> {
        self.input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    pub fn req_strings(&self, key: &str) -> Result<Vec<String>, ToolError> {
        let list = self
            .input
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| self.missing(key))?;
        let strings: Vec<String> = list
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect();
        if strings.len() != list.len() || strings.is_empty() {
            return Err(ToolError::validation(format!(
                "{}.{key} must be a non-empty list of ids",
                self.tool
            )));
        }
        Ok(strings)
    }

    pub fn opt_strings(&self, key: &str) -> Vec<String> {
        self.input
            .get(key)
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn opt_i64(&self, key: &str) -> Option<i64> {
        let value = self.input.get(key)?;
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| value.as_f64().map(|value| value as i64))
            .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
    }

    pub fn req_i64(&self, key: &str) -> Result<i64, ToolError> {
        self.opt_i64(key).ok_or_else(|| self.missing(key))
    }

    pub fn opt_f64(&self, key: &str) -> Option<f64> {
        let value = self.input.get(key)?;
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
    }

    pub fn opt_bool(&self, key: &str, fallback: bool) -> bool {
        self.input
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(fallback)
    }

    pub fn opt_object(&self, key: &str) -> Option<&serde_json::Map<String, Value>> {
        self.input.get(key).and_then(Value::as_object)
    }

    pub fn opt_array(&self, key: &str) -> Option<&Vec<Value>> {
        self.input.get(key).and_then(Value::as_array)
    }

    pub fn req_array(&self, key: &str) -> Result<&Vec<Value>, ToolError> {
        self.input
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| self.missing(key))
    }

    /// Refuses an action the caller did not confirm. A destroy tool's
    /// `confirm` is the model showing what it thinks it is doing; an empty one
    /// is a model that has not read the target.
    pub fn confirmed(&self) -> Result<(), ToolError> {
        self.req_str("confirm")?;
        Ok(())
    }

    pub fn error(&self, code: &str, message: impl Into<String>) -> ToolError {
        ToolError::new(code, message)
    }
}

pub async fn run_command(
    state: &ApiState,
    root: &Path,
    moka: &MokaFile,
    name: &str,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    match name {
        "project.overview"
        | "project.update"
        | "project.self_check"
        | "project.describe_models"
        | "project.list_recent"
        | "context.get"
        | "task.get" => core::command(state, root, moka, name, input).await,
        "canvas.list"
        | "canvas.get"
        | "canvas.get_node"
        | "canvas.create"
        | "canvas.update"
        | "canvas.delete"
        | "canvas.add_node"
        | "canvas.update_node"
        | "canvas.move_nodes"
        | "canvas.resize_nodes"
        | "canvas.remove_nodes"
        | "canvas.connect"
        | "canvas.disconnect"
        | "canvas.group_nodes"
        | "canvas.ungroup"
        | "canvas.duplicate_nodes" => canvas::command(state, root, moka, name, input).await,
        "timeline.list"
        | "timeline.get"
        | "timeline.create"
        | "timeline.update"
        | "timeline.delete"
        | "timeline.add_track"
        | "timeline.update_track"
        | "timeline.remove_track"
        | "clip.add"
        | "clip.update"
        | "clip.move"
        | "clip.trim"
        | "clip.split"
        | "clip.remove"
        | "clip.duplicate"
        | "clip.align"
        | "clip.add_text"
        | "clip.import_srt"
        | "clip.apply_transcript"
        | "clip.add_transition"
        | "clip.remove_transition" => clip::command(root, moka, name, input).await,
        "asset.list"
        | "asset.get"
        | "asset.detach_references"
        | "asset.place_in_canvas"
        | "asset.place_in_timeline"
        | "asset.place_in_story" => assets::command(state, root, moka, name, input).await,
        name if name.starts_with("story.") => story::command(moka, name, input).await,
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not implemented"),
        )),
    }
}

/// The one command that reads project lists rather than a document.
pub async fn run_without_project(
    state: &ApiState,
    name: &str,
    _input: &Value,
) -> Result<ToolOutcome, ToolError> {
    match name {
        "project.list_recent" => core::list_recent(state).await,
        other => Err(ToolError::new(
            "PROJECT_NOT_OPEN",
            format!("{other} needs an open project"),
        )),
    }
}

pub async fn run_effect(
    state: &ApiState,
    session: Option<&ProjectSession>,
    name: &str,
    input: &Value,
    moka: &MokaFile,
    session_id: Option<&str>,
) -> Result<ToolOutcome, ToolError> {
    match name {
        "project.create"
        | "project.open"
        | "project.import"
        | "project.remove_recent"
        | "project.export"
        | "task.cancel" => core::effect(state, session, name, input).await,
        "canvas.run" => {
            canvas::effect(
                state,
                session.ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?,
                input,
                session_id,
            )
            .await
        }
        "clip.transcribe" | "timeline.export" | "clip.export_srt" => {
            clip::effect(
                state,
                session.ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?,
                name,
                input,
                moka,
            )
            .await
        }
        "asset.import_path" => {
            assets::effect(
                state,
                session.ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?,
                name,
                input,
                moka,
            )
            .await
        }
        "asset.update" | "asset.delete" | "asset.copy" => {
            assets::effect(
                state,
                session.ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?,
                name,
                input,
                moka,
            )
            .await
        }
        "story.start_job" => {
            story::effect(
                state,
                session.ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "No project is open"))?,
                name,
                input,
                moka,
            )
            .await
        }
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not implemented"),
        )),
    }
}

/// Reads a timeline and fails with the id a reader can act on.
pub fn timeline_of<'a>(
    moka: &'a MokaFile,
    id: &str,
) -> Result<&'a crate::domain::TimelineDocument, ToolError> {
    moka.timelines
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|timeline| timeline.id == id)
        .ok_or_else(|| {
            ToolError::new(
                "TIMELINE_NOT_FOUND",
                format!("timeline {id} does not exist"),
            )
            .details(serde_json::json!({"timelineId": id}))
        })
}

pub fn canvas_of<'a>(
    moka: &'a MokaFile,
    id: &str,
) -> Result<&'a crate::domain::CanvasDocument, ToolError> {
    moka.canvas(id).ok_or_else(|| {
        ToolError::new("CANVAS_NOT_FOUND", format!("canvas {id} does not exist"))
            .details(serde_json::json!({"canvasId": id}))
    })
}

pub fn story_of<'a>(
    moka: &'a MokaFile,
    id: &str,
) -> Result<&'a crate::domain::story::StoryDocument, ToolError> {
    moka.stories
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|story| story.id == id)
        .ok_or_else(|| {
            ToolError::new("STORY_NOT_FOUND", format!("story {id} does not exist"))
                .details(serde_json::json!({"storyId": id}))
        })
}
