use crate::project::ProjectError;
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemBody {
    pub code: String,
    pub message: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug)]
struct ProblemInner {
    status: StatusCode,
    body: ProblemBody,
}

#[derive(Debug)]
pub struct Problem(Box<ProblemInner>);

/// The sentence a problem body carries, for the request log.
///
/// The log sees this response and not the body inside it, and a code like
/// "INTERNAL" says a request failed without saying why. Carried beside the
/// body rather than read back out of it, so logging never buffers a response
/// body — some of them are streams.
#[derive(Clone)]
pub struct ProblemMessage(pub String);

impl Problem {
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self(Box::new(ProblemInner {
            status,
            body: ProblemBody {
                code: code.into(),
                message: message.into(),
                status: status.as_u16(),
                details: None,
            },
        }))
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.0.body.details = Some(details);
        self
    }
}

pub fn status_for_code(code: &str) -> StatusCode {
    match code {
        "NOT_FOUND"
        | "PROJECT_NOT_FOUND"
        | "RUN_NOT_FOUND"
        | "ASSET_MISSING"
        | "TASK_NOT_FOUND"
        | "EXPORT_NOT_FOUND"
        | "TIMELINE_NOT_FOUND"
        | "STORY_NOT_FOUND"
        | "STORY_JOB_NOT_FOUND" => StatusCode::NOT_FOUND,
        "PROJECT_NOT_OPEN"
        | "REVISION_CONFLICT"
        | "TOOLS_VERSION_MISMATCH"
        | "AGENT_RISK_UNACKNOWLEDGED"
        | "CHANGE_STALE"
        | "NOT_UNDOABLE"
        | "IDEMPOTENCY_KEY_REUSED"
        | "TRACK_LOCKED"
        | "TRACK_NOT_EMPTY"
        | "CLIP_OVERLAP"
        | "USER_CANCELLED"
        | "APPROVAL_DENIED"
        | "METADATA_CONFLICT"
        | "ASSET_IN_USE"
        | "CONFLICT"
        | "RUN_NOT_CANCELLABLE"
        | "RUN_NOT_RETRYABLE"
        | "STORY_JOB_NOT_CANCELLABLE"
        | "STORY_JOB_BUSY" => StatusCode::CONFLICT,
        // The job existed and is gone for good; retrying the same handle
        // cannot bring it back, which is what separates this from a 404.
        "TASK_EXPIRED" => StatusCode::GONE,
        // The request was well formed; the local store could not serve it.
        // Retrying once the disk or the deployment is fixed can succeed.
        "METADATA_UNAVAILABLE"
        | "METADATA_WRITE_FAILED"
        | "METADATA_SCHEMA_UNSUPPORTED"
        | "CONFIG_METADATA_KEY_MISSING"
        | "CONFIG_METADATA_DIR_INVALID"
        | "CONFIG_METADATA_STORE_UNSUPPORTED" => StatusCode::SERVICE_UNAVAILABLE,
        // The work was asked for on a machine that cannot do it, and no retry
        // of this request changes that: what has to change is the machine.
        "FFMPEG_UNAVAILABLE" => StatusCode::SERVICE_UNAVAILABLE,
        // The server is the gateway here, so the status mirrors what the
        // provider's own answer meant. The code is what tells a client that
        // the failure was upstream rather than in its request.
        "PROVIDER_AUTH" => StatusCode::UNAUTHORIZED,
        "PROVIDER_RATE_LIMIT" => StatusCode::TOO_MANY_REQUESTS,
        "PROVIDER_BAD_REQUEST" => StatusCode::BAD_REQUEST,
        // An answer too big to keep is one this server refused rather than one
        // the client asked badly for, so it reports as the gateway it is.
        "PROVIDER_UNAVAILABLE" | "PROVIDER_NO_OUTPUT" | "GENERATION_OUTPUT_TOO_LARGE" => {
            StatusCode::BAD_GATEWAY
        }
        "PROVIDER_TIMEOUT" => StatusCode::GATEWAY_TIMEOUT,
        // Unregistered, but the established name for "the client went away
        // mid-request"; 4xx keeps it out of the server-failure counts.
        "GENERATION_CANCELLED" => client_closed_request(),
        "PAYLOAD_TOO_LARGE" | "MOKA_TOO_LARGE" => StatusCode::PAYLOAD_TOO_LARGE,
        "UNSUPPORTED_MEDIA_TYPE" => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "PATH_ESCAPE" => StatusCode::BAD_REQUEST,
        "INTERNAL" => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    }
}

fn client_closed_request() -> StatusCode {
    StatusCode::from_u16(499).expect("499 is inside the status code range")
}

impl From<ProjectError> for Problem {
    fn from(error: ProjectError) -> Self {
        Problem::new(
            status_for_code(error.code()),
            error.code(),
            error.to_string(),
        )
    }
}

impl From<crate::metadata::MetadataError> for Problem {
    fn from(error: crate::metadata::MetadataError) -> Self {
        let mut problem = Problem::new(
            status_for_code(error.code()),
            error.code(),
            error.to_string(),
        );
        if error.retryable() {
            problem = problem.with_details(serde_json::json!({ "retryable": true }));
        }
        problem
    }
}

impl From<crate::generate::ProviderError> for Problem {
    fn from(error: crate::generate::ProviderError) -> Self {
        let mut problem = Problem::new(
            status_for_code(error.code()),
            error.code(),
            error.to_string(),
        );
        // Merged rather than chosen between: a provider that is busy carries
        // both what it asked for and the fact that waiting is the fix, and a
        // client reads the structure to name the trouble and the flag to say
        // whether asking again is worth anything.
        let mut details = error.details().unwrap_or_else(|| serde_json::json!({}));
        if error.retryable() {
            details["retryable"] = serde_json::json!(true);
        }
        if details.as_object().is_some_and(|values| !values.is_empty()) {
            problem = problem.with_details(details);
        }
        problem
    }
}

impl From<super::filesystem::BrowseError> for Problem {
    fn from(error: super::filesystem::BrowseError) -> Self {
        Problem::new(
            status_for_code(error.code()),
            error.code(),
            error.to_string(),
        )
    }
}

impl From<super::filesystem::WriteError> for Problem {
    fn from(error: super::filesystem::WriteError) -> Self {
        Problem::new(
            status_for_code(error.code()),
            error.code(),
            error.to_string(),
        )
    }
}

impl From<crate::clip::ClipError> for Problem {
    fn from(error: crate::clip::ClipError) -> Self {
        Problem::new(
            status_for_code(error.code()),
            error.code(),
            error.to_string(),
        )
    }
}

/// A timeline that cannot be rendered says why in the document's own terms:
/// the code is what a client branches on, and the message is what the dialog
/// shows.
impl From<crate::clip::plan::PlanError> for Problem {
    fn from(error: crate::clip::plan::PlanError) -> Self {
        Problem::new(
            status_for_code(error.code()),
            error.code(),
            error.to_string(),
        )
    }
}

impl From<std::io::Error> for Problem {
    fn from(error: std::io::Error) -> Self {
        Problem::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            format!("I/O error: {error}"),
        )
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let inner = *self.0;
        let code = inner.body.code.clone();
        let message = inner.body.message.clone();
        let mut response = (
            inner.status,
            [(
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/problem+json"),
            )],
            Json(inner.body),
        )
            .into_response();
        // Surfaced for structured request logs and API debugging; the code is
        // an uppercase domain constant, never user input.
        if let Ok(value) = header::HeaderValue::from_str(&code) {
            response.headers_mut().insert("x-error-code", value);
        }
        let _ = response.extensions_mut().insert(ProblemMessage(message));
        response
    }
}

/// Maps axum JSON extractor rejections into the shared problem shape.
pub fn json_or_problem<T>(
    result: Result<Json<T>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<T>, Problem> {
    result.map_err(|rejection| {
        // A body that never arrived in full is not a malformed one, and the
        // remedy differs: send less, rather than send it differently.
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            return Problem::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "PAYLOAD_TOO_LARGE",
                "Request body is too large",
            );
        }
        Problem::new(
            rejection.status(),
            "VALIDATION_FAILED",
            format!("Request body is not valid: {}", rejection.body_text()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_codes_map_to_the_status_their_remedy_implies() {
        assert_eq!(status_for_code("TASK_NOT_FOUND"), StatusCode::NOT_FOUND);
        // Gone rather than not found: the handle existed and will never work
        // again, so re-polling it is pointless.
        assert_eq!(status_for_code("TASK_EXPIRED"), StatusCode::GONE);
        assert_eq!(
            status_for_code("PROVIDER_NO_OUTPUT"),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            status_for_code("GENERATION_OUTPUT_TOO_LARGE"),
            StatusCode::BAD_GATEWAY
        );
        // A 4xx, so a caller walking away mid-request is not counted as a
        // server failure.
        let cancelled = status_for_code("GENERATION_CANCELLED");
        assert_eq!(cancelled.as_u16(), 499);
        assert!(cancelled.is_client_error());
    }
}
