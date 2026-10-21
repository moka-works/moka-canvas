//! The failure a tool names, before it becomes an HTTP problem.
//!
//! A tool refusal is structured: a code a client branches on, a sentence a
//! reader can act on, and details that say which entity or field. The HTTP
//! layer maps the code to a status; the CLI and MCP map it to their own
//! conventions without parsing the sentence.

use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct ToolError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
    pub status: u16,
    pub retryable: bool,
}

impl ToolError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        let code = code.into();
        let status = status_for(&code);
        Self {
            code,
            message: message.into(),
            details: None,
            status,
            retryable: false,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("VALIDATION_FAILED", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new("CONFLICT", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }

    pub fn details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn with_tool(mut self, tool: &str) -> Self {
        let mut details = self.details.take().unwrap_or_else(|| json!({}));
        if let Some(map) = details.as_object_mut() {
            map.entry("tool")
                .or_insert_with(|| Value::String(tool.to_string()));
        } else {
            details = json!({"tool": tool, "detail": details});
        }
        self.details = Some(details);
        self
    }

    pub fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }
}

impl From<crate::project::ProjectError> for ToolError {
    fn from(error: crate::project::ProjectError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
            details: None,
            status: status_for(error.code()),
            retryable: matches!(error.code(), "REVISION_CONFLICT"),
        }
    }
}

impl From<crate::generate::ProviderError> for ToolError {
    fn from(error: crate::generate::ProviderError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
            details: error.details(),
            status: status_for(error.code()),
            retryable: error.retryable(),
        }
    }
}

pub fn status_for(code: &str) -> u16 {
    match code {
        "NOT_FOUND" | "TOOL_NOT_FOUND" | "ASSET_NOT_FOUND" | "CANVAS_NOT_FOUND"
        | "NODE_NOT_FOUND" | "TIMELINE_NOT_FOUND" | "TRACK_NOT_FOUND" | "CLIP_NOT_FOUND"
        | "STORY_NOT_FOUND" | "SESSION_NOT_FOUND" | "TASK_NOT_FOUND" => 404,
        "VALIDATION_FAILED"
        | "DRY_RUN_UNSUPPORTED"
        | "SESSION_TOO_LARGE"
        | "STEP_GAPS"
        | "NO_TEXT_CLIPS" => 422,
        "TOOLS_VERSION_MISMATCH"
        | "PROJECT_NOT_OPEN"
        | "REVISION_CONFLICT"
        | "AGENT_RISK_UNACKNOWLEDGED"
        | "CHANGE_STALE"
        | "NOT_UNDOABLE"
        | "ASSET_IN_USE"
        | "TRACK_LOCKED"
        | "TRACK_NOT_EMPTY"
        | "CLIP_OVERLAP"
        | "IDEMPOTENCY_KEY_REUSED"
        | "USER_CANCELLED"
        | "APPROVAL_DENIED" => 409,
        "APP_ONLY_UNAVAILABLE" => 410,
        _ => 500,
    }
}

impl From<ToolError> for crate::api::problem::Problem {
    fn from(error: ToolError) -> Self {
        let mut details = error.details.unwrap_or_else(|| json!({}));
        if error.retryable {
            details["retryable"] = json!(true);
        }
        let status = reqwest_status(error.status);
        let mut problem = crate::api::problem::Problem::new(status, error.code, error.message);
        if details.as_object().is_some_and(|values| !values.is_empty()) {
            problem = problem.with_details(details);
        }
        problem
    }
}

fn reqwest_status(status: u16) -> axum::http::StatusCode {
    axum::http::StatusCode::from_u16(status)
        .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_can_name_the_tool_and_the_entity() {
        let error = ToolError::validation("clip cl_1 does not exist")
            .details(json!({"clipId": "cl_1"}))
            .with_tool("clip.trim");
        assert_eq!(error.status, 422);
        assert_eq!(error.details.as_ref().unwrap()["tool"], "clip.trim");
        assert_eq!(error.details.as_ref().unwrap()["clipId"], "cl_1");
    }
}
