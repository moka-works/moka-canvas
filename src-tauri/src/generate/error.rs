//! What can go wrong on the provider side, named so a client can tell a
//! configuration it has to fix from an outage it can only wait out.

use crate::metadata::MetadataError;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProviderError {
    /// Anything the metadata layer reported. Carried as a variant instead of
    /// a second error type so a route converts once and the storage codes
    /// keep their existing meanings.
    #[error(transparent)]
    Storage(#[from] MetadataError),

    /// Anything the project layer reported: a reference that is not in the
    /// open project, or no project open at all. Carried rather than translated
    /// so those codes keep the meanings every other route gives them.
    #[error(transparent)]
    Project(#[from] crate::project::ProjectError),

    /// A disk read that failed after the asset was known to be there, which
    /// is the machine's problem rather than the request's.
    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// A reference names something that is not there. Reported as a missing
    /// configuration rather than a missing record because the fix is in
    /// Settings, not in a retry.
    #[error("no {capability} model is configured: {reason}")]
    NotConfigured { capability: String, reason: String },

    #[error("model {model} has no stored API key")]
    KeyMissing { model: String },

    /// A speech ask whose converter cannot make a sound without a voice, and
    /// none is configured. Refused here rather than sent on: the engines that
    /// declare the need answer a voiceless ask with an error of their own that
    /// names neither the missing setting nor where it lives.
    #[error("the model {model} has no voice set, and its speech converter needs one")]
    VoiceRequired { model: String },

    /// A speech ask whose converter copies a voice from a recording, and none
    /// travelled with it. Refused here rather than sent on: an engine that
    /// needs a reference answers its absence with an error of its own that
    /// names neither the missing piece nor where a reader keeps one.
    #[error("the model {model} reads a voice from a reference recording, and none was sent")]
    ReferenceAudioRequired { model: String },

    #[error("{reference} generates {found}, not {capability}")]
    CapabilityMismatch {
        reference: String,
        capability: String,
        found: String,
    },

    /// A configuration routes its scenarios through sub-models and none of
    /// them covers this request. Wrong rather than late: asking again is
    /// refused the same way, and the repair is in Settings.
    #[error("the model {reference} has no sub-model for the {scene} scene")]
    SceneUnconfigured {
        reference: String,
        capability: String,
        scene: String,
    },

    #[error("the provider rejected the stored credential: {0}")]
    Auth(String),

    /// The provider is busy. Carries its own advice about when to come back,
    /// because a backoff that ignores `Retry-After` either hammers a provider
    /// that asked for a minute or waits one out when it asked for a second.
    #[error("the provider is rate limiting requests: {detail}")]
    RateLimited {
        detail: String,
        retry_after: Option<Duration>,
    },

    #[error("the provider did not answer in time: {0}")]
    Timeout(String),

    #[error("the provider could not serve the request: {0}")]
    Unreachable(String),

    #[error("the provider rejected the request: {0}")]
    Rejected(String),

    /// A successful answer with nothing in it. Reported instead of handing
    /// back an empty result, because "no output" is a provider failure the
    /// caller can retry elsewhere rather than a legitimate blank page.
    #[error("the provider returned no usable output: {0}")]
    NoOutput(String),

    /// A successful answer too big to keep. The ceiling is one the deployment
    /// set, so this is not a provider misbehaving and asking it again would be
    /// answered the same way: what has to change is the request or the budget.
    #[error("the answer was too large to keep: {0}")]
    TooLarge(String),

    /// The caller walked away mid-generation.
    #[error("the generation was cancelled")]
    Cancelled,

    /// Nothing is registered under this handle: it never existed, or the
    /// process that was tracking it has gone.
    #[error("no generation task {task} is being tracked")]
    TaskMissing { task: String },

    /// The upstream job is too old to poll any more.
    #[error("generation task {task} expired before it was collected")]
    TaskExpired { task: String },

    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    Invalid(String),
}

impl ProviderError {
    pub fn not_configured(capability: &str, reason: impl Into<String>) -> Self {
        Self::NotConfigured {
            capability: capability.to_string(),
            reason: reason.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Storage(error) => error.code(),
            Self::Project(error) => error.code(),
            Self::Io(_) => "INTERNAL",
            // A model that is configured and a capability with nothing behind
            // it are one repair, `NotConfigured`; a model that is there but
            // holds no credential is another, and says which model.
            Self::NotConfigured { .. } => "PROVIDER_NOT_CONFIGURED",
            Self::KeyMissing { .. } => "PROVIDER_KEY_MISSING",
            Self::VoiceRequired { .. } => "MODEL_VOICE_REQUIRED",
            Self::ReferenceAudioRequired { .. } => "MODEL_REFERENCE_AUDIO_REQUIRED",
            Self::CapabilityMismatch { .. } => "MODEL_CAPABILITY_MISMATCH",
            Self::SceneUnconfigured { .. } => "MODEL_SCENE_UNCONFIGURED",
            Self::Auth(_) => "PROVIDER_AUTH",
            Self::RateLimited { .. } => "PROVIDER_RATE_LIMIT",
            Self::Timeout(_) => "PROVIDER_TIMEOUT",
            Self::Unreachable(_) => "PROVIDER_UNAVAILABLE",
            Self::Rejected(_) => "PROVIDER_BAD_REQUEST",
            Self::NoOutput(_) => "PROVIDER_NO_OUTPUT",
            Self::TooLarge(_) => "GENERATION_OUTPUT_TOO_LARGE",
            Self::Cancelled => "GENERATION_CANCELLED",
            Self::TaskMissing { .. } => "TASK_NOT_FOUND",
            Self::TaskExpired { .. } => "TASK_EXPIRED",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Invalid(_) => "VALIDATION_FAILED",
        }
    }

    /// True when waiting could fix it: the storage layer's own classification,
    /// plus a provider that is busy, slow, or unreachable. A credential the
    /// provider rejected and a request it refused are wrong, not late, so
    /// repeating them verbatim only repeats the failure.
    pub fn retryable(&self) -> bool {
        match self {
            Self::Storage(error) => error.retryable(),
            Self::RateLimited { .. } | Self::Timeout(_) | Self::Unreachable(_) => true,
            _ => false,
        }
    }

    /// Extra structure for the problem body, when the message alone would
    /// leave the client guessing which part of its state to repair.
    ///
    /// The values a sentence in another language interpolates, and what tells
    /// a client whether the repair is in its settings — which model, which
    /// capability — rather than in a retry. They travel beside the message,
    /// never instead of it: a reader of the English is owed the whole of what
    /// went wrong, and a reader of the Chinese is owed the same facts.
    pub fn details(&self) -> Option<serde_json::Value> {
        match self {
            Self::NotConfigured { capability, reason } => Some(serde_json::json!({
                "capability": capability,
                "reason": reason,
            })),
            Self::KeyMissing { model }
            | Self::VoiceRequired { model }
            | Self::ReferenceAudioRequired { model } => Some(serde_json::json!({ "model": model })),
            Self::CapabilityMismatch {
                reference,
                capability,
                found,
            } => Some(serde_json::json!({
                "reference": reference,
                "requested": capability,
                "actual": found,
            })),
            Self::SceneUnconfigured {
                reference,
                capability,
                scene,
            } => Some(serde_json::json!({
                "reference": reference,
                "capability": capability,
                "scene": scene,
            })),
            Self::Auth(detail) => Some(serde_json::json!({ "detail": detail })),
            Self::RateLimited {
                detail,
                retry_after,
            } => {
                let mut values = serde_json::json!({ "detail": detail });
                if let Some(wait) = retry_after {
                    values["retryAfterMs"] =
                        serde_json::json!(u64::try_from(wait.as_millis()).unwrap_or(u64::MAX));
                }
                Some(values)
            }
            Self::Timeout(detail)
            | Self::Unreachable(detail)
            | Self::Rejected(detail)
            | Self::NoOutput(detail)
            | Self::TooLarge(detail) => Some(serde_json::json!({ "detail": detail })),
            Self::TaskMissing { task } | Self::TaskExpired { task } => {
                Some(serde_json::json!({ "task": task }))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_outcomes() -> Vec<ProviderError> {
        vec![
            ProviderError::NoOutput("the answer carried no text and no media".into()),
            ProviderError::TooLarge("the answer carried 17 pieces".into()),
            ProviderError::Cancelled,
            ProviderError::TaskMissing {
                task: "task-1".into(),
            },
            ProviderError::TaskExpired {
                task: "task-1".into(),
            },
        ]
    }

    #[test]
    fn each_run_outcome_has_its_own_code() {
        let codes: Vec<&str> = run_outcomes().iter().map(ProviderError::code).collect();
        assert_eq!(
            codes,
            [
                "PROVIDER_NO_OUTPUT",
                "GENERATION_OUTPUT_TOO_LARGE",
                "GENERATION_CANCELLED",
                "TASK_NOT_FOUND",
                "TASK_EXPIRED"
            ]
        );
    }

    #[test]
    fn a_run_outcome_is_never_something_waiting_fixes() {
        // An empty answer, one too big to keep, a caller that left, and a
        // handle that is gone all fail again verbatim; only a busy or
        // unreachable provider is worth a backoff.
        for error in run_outcomes() {
            assert!(!error.retryable(), "{error} must not be retried");
        }
    }

    #[test]
    fn a_missing_credential_is_its_own_trouble_and_names_the_model() {
        // The model is configured and holds nothing; that is a different
        // repair from a capability with no model at all, and a client showing
        // the trouble in Chinese cannot say which model without this value.
        let error = ProviderError::KeyMissing {
            model: "gpt-4o-mini".into(),
        };
        assert_eq!(error.code(), "PROVIDER_KEY_MISSING");
        assert_eq!(
            error.details(),
            Some(serde_json::json!({ "model": "gpt-4o-mini" }))
        );
        assert!(ProviderError::not_configured("text", "nothing is set")
            .code()
            .eq("PROVIDER_NOT_CONFIGURED"));
    }

    #[test]
    fn a_voice_a_speech_model_was_never_given_is_its_own_trouble_too() {
        // The model is configured and holds a key; what it lacks is the voice
        // its converter is asked for. A second ask is refused the same way, so
        // the client offers the setting rather than another try.
        let error = ProviderError::VoiceRequired {
            model: "a-voice".into(),
        };
        assert_eq!(error.code(), "MODEL_VOICE_REQUIRED");
        assert_eq!(
            error.details(),
            Some(serde_json::json!({ "model": "a-voice" }))
        );
        assert!(!error.retryable());
    }

    #[test]
    fn a_scene_a_configuration_does_not_route_names_what_to_fix() {
        let error = ProviderError::SceneUnconfigured {
            reference: "filmer".into(),
            capability: "video".into(),
            scene: "referenceToVideo".into(),
        };
        assert_eq!(error.code(), "MODEL_SCENE_UNCONFIGURED");
        assert_eq!(
            error.details(),
            Some(serde_json::json!({
                "reference": "filmer",
                "capability": "video",
                "scene": "referenceToVideo",
            })),
            "the client has to be told which configuration and which scene"
        );
        assert!(
            !error.retryable(),
            "the same request would be refused the same way"
        );
    }

    #[test]
    fn what_a_message_says_travels_beside_it() {
        // Every value a sentence in another language would interpolate is
        // carried, so the translated words are the same facts as the English.
        let rate_limited = ProviderError::RateLimited {
            detail: "slow down".into(),
            retry_after: Some(Duration::from_secs(2)),
        };
        assert_eq!(rate_limited.code(), "PROVIDER_RATE_LIMIT");
        assert_eq!(
            rate_limited.details(),
            Some(serde_json::json!({ "detail": "slow down", "retryAfterMs": 2000 }))
        );
        assert_eq!(
            ProviderError::TaskExpired { task: "t-1".into() }.details(),
            Some(serde_json::json!({ "task": "t-1" }))
        );
        // Nothing to add to a trouble whose message is the whole of it.
        assert_eq!(ProviderError::Cancelled.details(), None);
    }
}
