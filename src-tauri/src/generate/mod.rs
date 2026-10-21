//! Talking to generation providers.
//!
//! [`models`] is the configuration domain — standalone model configurations
//! and what may be disclosed about a stored credential. [`adapters`] turns
//! that configuration into an HTTP call, one module per wire protocol.
//! [`error`] names what can go wrong on the provider side, which is a
//! different thing from what can go wrong on the storage side: the client
//! recovers from the first by opening Settings and from the second by
//! retrying. [`media`] is where a reference to a stored asset becomes bytes,
//! and where the size and format rules live so that no adapter has to repeat
//! them.
//!
//! [`gateway`] sits above all four and is what the rest of the program calls:
//! it picks the model, merges the parameters, decides between answering at
//! once and starting a job, and asks again when waiting would help. [`jobs`]
//! keeps the handles a started job is polled by, for as long as polling one
//! could still mean anything.
//!
//! [`context`] is the other side of the same boundary: where the gateway turns
//! a request into a call, this turns a node and its place in the graph into
//! that request.
//!
//! [`ingest`] is the last step of the journey: an answer becomes files in the
//! project, each carrying a record of the run and the node it came out of.
//!
//! The types below are the whole generation vocabulary that leaves this
//! module: a request phrased in the project's own terms and a result phrased
//! as bytes with a mime type. No provider field name appears in either, so
//! nothing above the adapters has to know who answered.

pub mod adapters;
pub mod context;
pub mod debug;
pub mod error;
pub mod gateway;
pub mod ingest;
pub mod jobs;
pub mod media;
pub mod models;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::domain::{AssetId, Capability, IsoTimestamp};
use crate::metadata::{Protocol, Scene};

pub use context::{collect_generation_inputs, context_node_ids, ResolvedInputs};
pub use error::ProviderError;
pub use gateway::Gateway;
pub use ingest::{file_incoming, ingest_generated, Incoming};
pub use jobs::TaskRegistry;
pub use models::{ModelRepo, ResolvedModel};

/// One generation, in the project's words.
///
/// `params` arrives already merged — node parameters over global preferences
/// over built-in defaults — so an adapter never has to know that a settings
/// dialog exists.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub capability: Capability,
    /// A model configuration id; empty means the default for the capability.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompt: String,
    /// An instruction that frames the prompt rather than forming part of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default)]
    pub params: serde_json::Map<String, serde_json::Value>,
    /// Reference media: what to edit, what to imitate, which frames to land on.
    #[serde(default)]
    pub inputs: Vec<GenerateInput>,
    /// A conversation, when the request is a step of one.
    ///
    /// A generation with no messages keeps the old shape: the prompt and the
    /// system instruction are the request. A conversation request carries the
    /// turns instead, and a converter that knows how sends them as they are.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<ChatMessage>,
    /// Tools the model may ask for. Empty for an ordinary generation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDef>,
    /// `auto`, `none`, or a tool name. Absent lets the provider decide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<String>,
}

/// One turn of a conversation, in the project's own shape.
///
/// A tool result is a message of its own rather than a field of a text turn:
/// providers that speak tools insist on the two being separate roles, and one
/// shape here means the chat layer does not carry two.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// `system`, `user`, `assistant`, or `tool`.
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ChatMessage {
    pub fn text(role: &str, text: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            text: text.into(),
            ..Self::default()
        }
    }

    pub fn assistant_calls(calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".to_string(),
            tool_calls: calls,
            ..Self::default()
        }
    }

    pub fn tool_result(call: &ToolCall, text: impl Into<String>) -> Self {
        Self {
            role: "tool".to_string(),
            text: text.into(),
            tool_call_id: Some(call.id.clone()),
            name: Some(call.name.clone()),
            ..Self::default()
        }
    }
}

/// One tool a model may call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// A JSON Schema object describing the arguments.
    pub parameters: serde_json::Value,
}

/// One call a model asked for.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// The arguments as the model sent them, decoded where that is possible.
    #[serde(default)]
    pub arguments: serde_json::Value,
}

/// One piece of a tool call arriving in a stream.
///
/// Providers send the name once and the arguments in fragments, keyed by
/// position; a reader that executes nothing until the stream ends still has
/// to put the fragments back together to know what was called.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallDelta {
    #[serde(default)]
    pub index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments_delta: Option<String>,
}

impl GenerateRequest {
    pub fn param(&self, key: &str) -> Option<&serde_json::Value> {
        self.params.get(key)
    }

    pub fn text_param(&self, key: &str) -> Option<&str> {
        self.param(key).and_then(|value| value.as_str())
    }

    pub fn int_param(&self, key: &str) -> Option<i64> {
        let value = self.param(key)?;
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| value.as_f64().map(|value| value as i64))
            // A number can arrive quoted, and dropping it here while
            // `float_param` accepts the same string would surprise an adapter.
            .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
    }

    pub fn float_param(&self, key: &str) -> Option<f64> {
        let value = self.param(key)?;
        value.as_f64().or_else(|| {
            value
                .as_str()
                .and_then(|value| value.trim().parse::<f64>().ok())
        })
    }

    pub fn bool_param(&self, key: &str) -> Option<bool> {
        self.param(key).and_then(|value| value.as_bool())
    }

    /// Streaming is a text parameter rather than a field: only text has
    /// anything to stream, and the caller opts in per request.
    pub fn wants_stream(&self) -> bool {
        self.bool_param("stream").unwrap_or(false)
    }

    /// The instruction that frames the prompt rather than forming part of it.
    ///
    /// A parameter can carry the same meaning as the field, and a request with
    /// both means it twice; the field wins. An instruction of nothing but
    /// whitespace is no instruction, and sending one would ask a model to obey
    /// a blank page.
    pub fn instruction(&self) -> Option<&str> {
        self.system
            .as_deref()
            .or_else(|| self.text_param("instructions"))
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }

    pub fn inputs_in(&self, role: InputRole) -> impl Iterator<Item = &GenerateInput> {
        self.inputs.iter().filter(move |input| input.role == role)
    }
}

/// Why a piece of media travels with a request. The role, not the mime type,
/// decides which provider field it lands in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InputRole {
    Reference,
    FirstFrame,
    LastFrame,
    Mask,
    ControlVideo,
    ControlAudio,
}

impl InputRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Reference => "reference",
            Self::FirstFrame => "firstFrame",
            Self::LastFrame => "lastFrame",
            Self::Mask => "mask",
            Self::ControlVideo => "controlVideo",
            Self::ControlAudio => "controlAudio",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateInput {
    pub role: InputRole,
    pub asset_id: AssetId,
    /// The part of the asset this reference means, when it means a part of one.
    ///
    /// Nothing else in a request can say where on a timeline the reference
    /// sits, so a caller that wants one window of a long recording says so
    /// here rather than sending hours nobody asked about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<InputWindow>,
}

/// A stretch of an asset, measured from its own beginning.
///
/// Both ends are milliseconds into the file rather than into a timeline: where
/// the window sits on a timeline is the caller's business, and a provider that
/// is told about a minute of a recording has no use for the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputWindow {
    pub start_ms: u64,
    pub duration_ms: u64,
}

/// One answer. Text and media are alternatives rather than a union because a
/// provider can return a caption beside the image it made.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct GenerateResult {
    pub text: Option<String>,
    pub items: Vec<GeneratedItem>,
    /// For display and statistics only; nothing decides based on it.
    pub usage: Option<Usage>,
    /// What the model asked to run. A pure tool call is an answer: there is
    /// no text, and reporting it as `PROVIDER_NO_OUTPUT` would throw away a
    /// step the caller is waiting to perform.
    pub tool_calls: Vec<ToolCall>,
    /// Why the model stopped: `stop`, `tool_calls`, `length`, or the
    /// provider's own word.
    pub finish_reason: Option<String>,
}

impl GenerateResult {
    /// A 200 that carried nothing usable, which the gateway reports as
    /// `PROVIDER_NO_OUTPUT` rather than handing back an empty answer.
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
            && self.tool_calls.is_empty()
            && self.text.as_deref().unwrap_or_default().trim().is_empty()
    }

    /// How much of it there is, counted the same way whoever is counting and
    /// whoever is bounding it need it counted.
    pub fn bytes(&self) -> u64 {
        let text = self.text.as_deref().map(str::len).unwrap_or_default() as u64;
        text + self
            .items
            .iter()
            .map(|item| item.bytes.len() as u64)
            .sum::<u64>()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedItem {
    pub bytes: Vec<u8>,
    pub mime: String,
    /// Reuses [`Capability`]: an item is exactly one modality, and a fourth
    /// enum with the same four members would only drift.
    pub kind: Capability,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub images: Option<u32>,
    pub seconds: Option<f64>,
}

/// An upstream job that outlives the request that started it.
///
/// Serializable because one is written down when it starts: a shot takes
/// minutes, and a process that stops in the middle of one has to leave enough
/// behind to ask again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTask {
    /// The handle the client polls with. Ours, not the provider's.
    pub id: String,
    /// The provider's own job handle. Opaque, and never disclosed: it is a
    /// credential-adjacent identifier in some protocols, so the only place it is
    /// written is a record that is neither served to a client nor packaged.
    pub reference: String,
    pub protocol: Protocol,
    pub capability: Capability,
    /// The resolved model configuration id, kept so a poll cannot be pointed
    /// at a different model than the one that created the job.
    pub model: String,
    /// The scenario the job was placed with, kept so a poll resolves the same
    /// sub-model at the same address. A note written before scenes existed
    /// has none, and polls as the configuration's own model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene: Option<Scene>,
    pub created_at: IsoTimestamp,
    /// The answer, where the converter had one in the same call that would
    /// have started a job. Written down with the handle, so the first poll
    /// finds it where a provider's own job would have left one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Box<SettledAnswer>>,
}

/// An answer that arrived with its job rather than after it.
///
/// A capability the program runs as a job can be served by a protocol that has
/// no job — a service that recognizes a recording in the same call it was sent
/// in. There is then nothing to poll, so the answer travels with the handle:
/// a capability is served by the service that offers it, and whether that
/// service takes one call or many is the converter's business rather than the
/// caller's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettledAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<SettledItem>,
}

impl SettledAnswer {
    /// An answer as it is carried: media written out, because what holds this
    /// is a document.
    pub fn of(result: &GenerateResult) -> Self {
        use base64::Engine as _;
        Self {
            text: result.text.clone(),
            usage: result.usage,
            items: result
                .items
                .iter()
                .map(|item| SettledItem {
                    mime: item.mime.clone(),
                    kind: item.kind,
                    width: item.width,
                    height: item.height,
                    duration_ms: item.duration_ms,
                    data: base64::engine::general_purpose::STANDARD.encode(&item.bytes),
                })
                .collect(),
        }
    }

    /// The answer as the rest of the program reads it: the media back as the
    /// bytes they were carried as.
    pub fn result(&self) -> Result<GenerateResult, ProviderError> {
        use base64::Engine as _;
        let mut items = Vec::with_capacity(self.items.len());
        for item in &self.items {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(item.data.trim())
                .map_err(|error| {
                    ProviderError::invalid(format!(
                        "a job's answer carried media that cannot be read: {error}"
                    ))
                })?;
            items.push(GeneratedItem {
                bytes,
                mime: item.mime.clone(),
                kind: item.kind,
                width: item.width,
                height: item.height,
                duration_ms: item.duration_ms,
            });
        }
        Ok(GenerateResult {
            text: self.text.clone(),
            items,
            usage: self.usage,
            ..GenerateResult::default()
        })
    }
}

/// One piece of media an answer that arrived with its job carries: the bytes
/// themselves, because a record that pointed at a file the process no longer
/// has would be an answer nothing could read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettledItem {
    pub mime: String,
    pub kind: Capability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// The bytes, base64, which is how they travel in a document.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TaskState {
    Pending { retry_after_ms: u64 },
    Succeeded(GenerateResult),
    Failed { message: String, retryable: bool },
}

impl TaskState {
    pub fn pending(retry_after: Duration) -> Self {
        Self::Pending {
            retry_after_ms: retry_after.as_millis().min(u64::MAX as u128) as u64,
        }
    }
}

/// Cooperative cancellation for one in-flight generation.
///
/// A flag plus a wake-up rather than a dropped future: the adapters sit in
/// the middle of an HTTP exchange, and the interesting question is always
/// "should the *next* step still happen".
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    wake: Arc<tokio::sync::Notify>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<(), ProviderError> {
        if self.is_cancelled() {
            Err(ProviderError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// A backoff wait that ends at once on cancellation instead of running
    /// its full duration against a client that has already gone.
    pub async fn wait(&self, delay: Duration) -> Result<(), ProviderError> {
        let wake = Arc::clone(&self.wake);
        // Registered before the flag is read, so a cancel that lands in
        // between still wakes this waiter.
        let woken = wake.notified();
        self.check()?;
        tokio::select! {
            _ = tokio::time::sleep(delay) => self.check(),
            _ = woken => Err(ProviderError::Cancelled),
        }
    }
}

/// Callback invoked once per chunk of streamed text.
pub type DeltaHandler = Arc<dyn Fn(&str) + Send + Sync>;

/// Where streamed text goes as it arrives.
///
/// Streaming only accelerates the display: the adapter still aggregates the
/// full answer, because what gets stored is the aggregate.
///
/// The two questions a sink answers are not the same one. Whether a provider is
/// asked for a stream at all is {@link DeltaSink::is_streaming}; whether
/// anybody is reading the pieces as they arrive is
/// {@link DeltaSink::is_watched}. A story job asks for a stream nobody reads,
/// because a long answer carried piece by piece is not the one a gateway gives
/// up on — and a protocol that can only answer whole still serves it, since
/// that caller only ever wanted the answer.
#[derive(Clone, Default)]
pub struct DeltaSink {
    sink: Option<DeltaHandler>,
    watched: bool,
}

impl DeltaSink {
    /// Pieces pushed to a reader as they arrive.
    pub fn new(sink: DeltaHandler) -> Self {
        Self {
            sink: Some(sink),
            watched: true,
        }
    }

    /// A stream nobody is reading.
    ///
    /// An answer that is waited out rather than watched still travels as a
    /// stream, and for a reason that has nothing to do with showing it: a long
    /// answer sent in one piece is held whole at the far end before the first
    /// byte comes back, and that is exactly the kind of request a gateway gives
    /// up on. The pieces arrive, are counted as they arrive, and are dropped.
    pub fn unwatched() -> Self {
        Self {
            sink: Some(Arc::new(|_| {})),
            watched: false,
        }
    }

    /// True when a provider is asked for a stream, whether or not anybody is
    /// watching the pieces.
    pub fn is_streaming(&self) -> bool {
        self.sink.is_some()
    }

    /// True when the pieces have a reader, which is what a protocol that cannot
    /// stream has to refuse rather than answer at the end instead.
    pub fn is_watched(&self) -> bool {
        self.watched
    }

    /// The same sink with `tap` called for every piece as well.
    ///
    /// What is asked for does not change: whether the pieces have a reader
    /// comes along, because a tap is not a reader — counting what arrived is
    /// what the gateway does on the way to somewhere else.
    pub fn tapped(&self, tap: DeltaHandler) -> Self {
        let inner = self.clone();
        Self {
            sink: Some(Arc::new(move |chunk: &str| {
                tap(chunk);
                inner.push(chunk);
            })),
            watched: self.watched,
        }
    }

    pub fn push(&self, text: &str) {
        if !text.is_empty() {
            if let Some(sink) = &self.sink {
                sink(text);
            }
        }
    }
}

impl std::fmt::Debug for DeltaSink {
    /// Whether anybody is listening, which is all a sink can say about itself:
    /// what it holds is a callback, and a callback has no readable shape.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DeltaSink")
            .field("streaming", &self.is_streaming())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn request(params: serde_json::Value) -> GenerateRequest {
        GenerateRequest {
            capability: Capability::Image,
            params: params.as_object().cloned().unwrap_or_default(),
            ..GenerateRequest::default()
        }
    }

    #[test]
    fn a_parameter_is_read_as_the_type_the_caller_asked_for() {
        // Providers disagree about whether a number arrives as a number, so
        // the accessors coerce rather than reject.
        let request = request(serde_json::json!({
            "count": 2,
            "seconds": "6",
            "temperature": 0.7,
            "ratio": "16:9",
            "watermark": true,
            "size": null,
        }));
        assert_eq!(request.int_param("count"), Some(2));
        assert_eq!(request.int_param("seconds"), Some(6));
        assert_eq!(request.int_param("temperature"), Some(0));
        assert_eq!(request.float_param("temperature"), Some(0.7));
        assert_eq!(request.text_param("ratio"), Some("16:9"));
        assert_eq!(request.bool_param("watermark"), Some(true));
        assert_eq!(request.param("size"), Some(&serde_json::Value::Null));
        assert_eq!(request.text_param("size"), None);
        assert_eq!(request.int_param("missing"), None);
    }

    #[test]
    fn streaming_is_off_unless_the_request_says_so() {
        assert!(!request(serde_json::json!({})).wants_stream());
        assert!(request(serde_json::json!({ "stream": true })).wants_stream());
        assert!(!request(serde_json::json!({ "stream": "yes" })).wants_stream());
    }

    #[test]
    fn inputs_keep_their_order_within_a_role() {
        let mut request = request(serde_json::json!({}));
        request.inputs = vec![
            GenerateInput {
                role: InputRole::FirstFrame,
                asset_id: "a1".into(),
                window: None,
            },
            GenerateInput {
                role: InputRole::Reference,
                asset_id: "a2".into(),
                window: None,
            },
            GenerateInput {
                role: InputRole::FirstFrame,
                asset_id: "a3".into(),
                window: None,
            },
        ];
        let frames: Vec<&str> = request
            .inputs_in(InputRole::FirstFrame)
            .map(|input| input.asset_id.as_str())
            .collect();
        assert_eq!(frames, ["a1", "a3"]);
        assert_eq!(request.inputs_in(InputRole::Mask).count(), 0);
    }

    #[test]
    fn an_answer_counts_as_empty_unless_it_carries_text_or_media() {
        assert!(GenerateResult::default().is_empty());
        // Whitespace is not an answer; reporting it as one would store a
        // blank text node instead of surfacing the provider failure.
        assert!(GenerateResult {
            text: Some("   ".into()),
            ..Default::default()
        }
        .is_empty());
        assert!(!GenerateResult {
            text: Some("a caption".into()),
            ..Default::default()
        }
        .is_empty());
        assert!(!GenerateResult {
            items: vec![GeneratedItem {
                bytes: vec![1],
                mime: "image/png".into(),
                kind: Capability::Image,
                width: None,
                height: None,
                duration_ms: None,
            }],
            ..Default::default()
        }
        .is_empty());
    }

    #[test]
    fn what_an_answer_takes_up_counts_the_words_and_the_media_together() {
        assert_eq!(GenerateResult::default().bytes(), 0);
        assert_eq!(
            GenerateResult {
                text: Some("a caption".into()),
                items: vec![
                    GeneratedItem {
                        bytes: vec![0; 40],
                        mime: "image/png".into(),
                        kind: Capability::Image,
                        width: None,
                        height: None,
                        duration_ms: None,
                    },
                    GeneratedItem {
                        bytes: vec![0; 7],
                        mime: "audio/wav".into(),
                        kind: Capability::Speech,
                        width: None,
                        height: None,
                        duration_ms: Some(1000),
                    },
                ],
                ..Default::default()
            }
            .bytes(),
            9 + 40 + 7,
            "a ceiling nobody counts the same way would bound the wrong thing"
        );
    }

    #[test]
    fn a_pending_task_carries_the_retry_hint_in_milliseconds() {
        assert_eq!(
            TaskState::pending(Duration::from_millis(1500)),
            TaskState::Pending {
                retry_after_ms: 1500
            }
        );
        assert_eq!(
            TaskState::pending(Duration::ZERO),
            TaskState::Pending { retry_after_ms: 0 }
        );
    }

    #[test]
    fn an_answer_carried_with_a_job_survives_the_document_it_is_written_in() {
        let result = GenerateResult {
            text: Some("1\n00:00:00,000 --> 00:00:01,000\nHello.\n".into()),
            items: vec![GeneratedItem {
                bytes: vec![7, 8, 9],
                mime: "image/png".into(),
                kind: Capability::Image,
                width: Some(4),
                height: Some(3),
                duration_ms: None,
            }],
            usage: Some(Usage {
                input_tokens: None,
                output_tokens: None,
                images: Some(1),
                seconds: Some(1.5),
            }),
            ..GenerateResult::default()
        };
        let carried = SettledAnswer::of(&result);
        // Written down and read back the way a job note travels.
        let written = serde_json::to_string(&carried).expect("a settled answer is a document");
        let read: SettledAnswer = serde_json::from_str(&written).expect("it reads back");
        assert_eq!(read.result().expect("the media decode"), result);
    }

    #[test]
    fn media_carried_with_a_job_that_cannot_be_read_is_refused() {
        let answer = SettledAnswer {
            text: None,
            usage: None,
            items: vec![SettledItem {
                mime: "image/png".into(),
                kind: Capability::Image,
                width: None,
                height: None,
                duration_ms: None,
                data: "not base64 at all".into(),
            }],
        };
        assert_eq!(
            answer.result().unwrap_err().code(),
            "VALIDATION_FAILED",
            "a record that cannot be read is a refusal rather than a panic"
        );
    }

    #[tokio::test]
    async fn cancelling_ends_a_backoff_wait_at_once() {
        let cancel = Cancel::new();
        assert!(cancel.check().is_ok());

        let waiter = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                cancel
                    .wait(Duration::from_secs(60))
                    .await
                    .unwrap_err()
                    .code()
                    .to_string()
            })
        };
        // Yield so the waiter registers its wake-up before the cancel lands.
        tokio::task::yield_now().await;
        cancel.cancel();

        // The timeout is the assertion: a wake-up that never arrives would
        // leave the wait running its full backoff.
        let code = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("a cancel must not wait out the backoff")
            .expect("the waiter must finish");
        assert_eq!(code, "GENERATION_CANCELLED");
        assert_eq!(cancel.check().unwrap_err().code(), "GENERATION_CANCELLED");
    }

    #[test]
    fn the_delta_sink_forwards_only_non_empty_chunks() {
        assert!(!DeltaSink::default().is_streaming());
        DeltaSink::default().push("dropped without a listener");

        let seen = Arc::new(Mutex::new(String::new()));
        let collected = Arc::clone(&seen);
        let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
            collected
                .lock()
                .expect("the sink is not held across a call")
                .push_str(chunk);
        }));
        assert!(sink.is_streaming());
        sink.push("Hello");
        sink.push("");
        sink.push(", world");
        assert_eq!(
            seen.lock()
                .expect("the sink is not held across a call")
                .as_str(),
            "Hello, world"
        );
    }

    #[test]
    fn a_stream_nobody_reads_is_still_asked_for_and_still_unwatched() {
        use std::sync::atomic::AtomicUsize;

        // The story jobs' own ask: a long answer travels as a stream, and
        // nothing on this side is waiting to read it.
        let sink = DeltaSink::unwatched();
        assert!(sink.is_streaming(), "the provider is asked for a stream");
        assert!(!sink.is_watched(), "nobody is reading the pieces");
        sink.push("a piece nobody reads");

        // A count of what arrived is not a reader either: the gateway wraps a
        // caller's sink on the way through, and what the caller asked for
        // travels with it.
        let seen = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&seen);
        let tapped = sink.tapped(Arc::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(tapped.is_streaming());
        assert!(!tapped.is_watched());
        tapped.push("another");
        assert_eq!(seen.load(Ordering::SeqCst), 1);

        // And a reader's own sink stays a reader's through the same wrap.
        let watched = DeltaSink::new(Arc::new(|_| {})).tapped(Arc::new(|_| {}));
        assert!(watched.is_watched());
    }

    #[test]
    fn a_conversation_request_carries_its_tools_in_camel_case() {
        let request = GenerateRequest {
            capability: Capability::Text,
            messages: vec![
                ChatMessage::text("user", "trim the first clip"),
                ChatMessage::assistant_calls(vec![ToolCall {
                    id: "call_1".into(),
                    name: "clip.trim".into(),
                    arguments: serde_json::json!({"timelineId":"tl_1"}),
                }]),
                ChatMessage::tool_result(
                    &ToolCall {
                        id: "call_1".into(),
                        name: "clip.trim".into(),
                        arguments: serde_json::Value::Null,
                    },
                    r#"{"ok":true}"#,
                ),
            ],
            tools: vec![ToolDef {
                name: "clip.trim".into(),
                description: "Trim clips".into(),
                parameters: serde_json::json!({"type":"object"}),
            }],
            ..GenerateRequest::default()
        };
        let wire = serde_json::to_value(&request).expect("a request encodes");
        assert_eq!(wire["messages"][1]["toolCalls"][0]["name"], "clip.trim");
        assert_eq!(wire["messages"][2]["toolCallId"], "call_1");
        assert_eq!(wire["tools"][0]["name"], "clip.trim");
        assert!(wire.get("toolChoice").is_none());
        let read: GenerateRequest = serde_json::from_value(wire).expect("it reads back");
        assert_eq!(read.messages.len(), 3);
        assert_eq!(read.tools.len(), 1);
    }

    #[test]
    fn a_pure_tool_call_is_an_answer_rather_than_an_empty_response() {
        let result = GenerateResult {
            tool_calls: vec![ToolCall {
                id: "call_1".into(),
                name: "canvas.get".into(),
                arguments: serde_json::json!({}),
            }],
            finish_reason: Some("tool_calls".into()),
            ..GenerateResult::default()
        };
        assert!(!result.is_empty());
        assert_eq!(result.bytes(), 0);
    }

    #[test]
    fn a_request_travels_in_camel_case_and_tolerates_absent_sections() {
        let request: GenerateRequest = serde_json::from_value(serde_json::json!({
            "capability": "video",
            "prompt": "a lantern over a lake",
            "inputs": [{ "role": "firstFrame", "assetId": "a1" }],
        }))
        .expect("a minimal request must decode");
        assert_eq!(request.capability, Capability::Video);
        assert!(request.model.is_empty());
        assert!(request.params.is_empty());
        assert_eq!(request.inputs[0].role, InputRole::FirstFrame);

        let wire = serde_json::to_value(&request).expect("a request must encode");
        assert_eq!(wire["inputs"][0]["assetId"], "a1");
        assert_eq!(wire["inputs"][0]["role"], "firstFrame");
        assert!(wire.get("system").is_none());
    }
}
