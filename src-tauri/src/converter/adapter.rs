//! Lua adapter: the protocol implementation a converter script stands behind.
//!
//! This module runs the script: it asks the script what to send, sends it, and
//! hands the answer back for the script to read. Which protocols exist is the
//! registry's business rather than this module's, so a protocol is added by
//! adding a converter directory and nothing here changes.
//!
//! A protocol that needs more than one call for one step — an upload before a
//! submit, a document behind a poll — describes the whole conversation to
//! [`LuaAdapter`]'s `follow`, which runs it one exchange at a time. A protocol
//! whose answer arrives in pieces describes its stream request to
//! `build_stream_request`, and each piece is handed to `parse_event` as it
//! lands.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use async_trait::async_trait;
use base64::Engine as _;
use reqwest::header::HeaderMap;
use serde_json::{json, Map, Value};

use super::registry::{AuthSpec, ConverterRegistry, ProtocolEntry};
use super::runtime::{LuaRuntime, ScriptRef};
use crate::domain::Capability;
use crate::generate::adapters::{
    exchange, image_item, media_item, open_stream, provider_error, read_stream, succeeded,
    ModelCall, Opened, ProviderAdapter, Reply, StreamEvent,
};
use crate::generate::debug::Kind;
use crate::generate::error::ProviderError;
use crate::generate::media::{MediaInput, MultipartBody};
use crate::generate::{
    AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, GeneratedItem, SettledAnswer,
    TaskState, Usage,
};

/// How many exchanges one step may take before a script is stopped.
///
/// A protocol needs two or three; the ceiling is here because a reply that
/// names the same handler again is a loop, and a loop would otherwise never
/// end.
const MAX_EXCHANGES: usize = 8;

static CONVERTER_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Sets the converter root directory. Called once during startup after deploy.
pub fn set_converter_root(root: PathBuf) {
    let _ = CONVERTER_ROOT.set(root);
}

/// The models directory, once startup has set it. Model validation reads the
/// registry through it to learn which Lua protocols exist.
pub fn converter_root() -> Option<&'static Path> {
    CONVERTER_ROOT.get().map(PathBuf::as_path)
}

/// The shared instance returned by [`for_protocol`] for Lua-backed protocols.
pub(super) static LUA_ADAPTER: LuaAdapter = LuaAdapter;

pub struct LuaAdapter;

impl LuaAdapter {
    /// Returns a reference to the shared adapter instance.
    pub fn get() -> &'static Self {
        &LUA_ADAPTER
    }
}

#[async_trait]
impl ProviderAdapter for LuaAdapter {
    async fn generate(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        let session = Session::open(call)?;
        let asked = session.call(
            "build_request",
            vec![call_json(call), request_json(request), inputs_json(inputs)],
        )?;
        let ended = follow(
            &session,
            &asked,
            "parse_response",
            Step {
                call,
                inputs,
                capability: request.capability,
                cancel,
                kind: Kind::Generate,
            },
        )
        .await?;
        result_of(&session, &ended, call, request.capability).await
    }

    /// The answer read as it arrives, where the script asked for a stream.
    ///
    /// A script that describes no stream request answers whole: a caller who is
    /// reading the pieces is refused rather than surprised at the end, and one
    /// who is not reading them — a story job waiting an answer out — is served
    /// the whole answer, which is all it was asking for.
    async fn generate_stream(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        sink: &DeltaSink,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        let session = Session::open(call)?;
        if !session.has("build_stream_request") {
            if sink.is_watched() {
                return Err(ProviderError::invalid(
                    "this converter does not stream, and its answer was being read piece by piece",
                ));
            }
            return self.generate(call, request, inputs, cancel).await;
        }
        // A stream nobody could read is a mistake in the script rather than in
        // the request: the pieces would arrive and be dropped, one at a time,
        // with nothing said about it.
        if !session.has("parse_event") {
            return Err(ProviderError::invalid(
                "this converter streams without exporting 'parse_event'",
            ));
        }
        let asked = session.call(
            "build_stream_request",
            vec![call_json(call), request_json(request), inputs_json(inputs)],
        )?;
        if let Some(error) = asked.get("error").and_then(Value::as_str) {
            return Err(ProviderError::Rejected(error.to_string()));
        }
        // The door the stream is asked at is the one the script named; a
        // service that refuses it — and a script that asked to read the
        // refusal — lets the script name another door before the refusal is
        // the answer, the chain the whole-answer path runs in `follow`.
        let mut exchange_step = Exchange::asked(&asked, "parse_response")?;
        let mut state = asked.get("state").cloned().unwrap_or(Value::Null);
        for _ in 0..MAX_EXCHANGES {
            cancel.check()?;
            let request_builder = builder(call, &session.entry, &exchange_step.request, inputs)?;
            let deadline = call.budgets.timeout_for(request.capability);
            match open_stream(Kind::Stream, call, request_builder).await? {
                Opened::Streaming(response, recording) => {
                    let parse = |payload: &Value| session.event(payload);
                    return read_stream(
                        response,
                        recording.map(|recording| *recording),
                        sink,
                        cancel,
                        deadline,
                        parse,
                    )
                    .await;
                }
                Opened::Refused(reply) => {
                    if !reads_failure(&exchange_step.request) {
                        return Err(provider_error(&reply, &call.api_key));
                    }
                    // Looked up before the script is asked what to make of the
                    // refusal: a script that named no function to read it with
                    // is refused rather than handed a body nothing will read.
                    if !session.has(&exchange_step.handler) {
                        return Err(ProviderError::invalid(format!(
                            "script '{}' does not export '{}'",
                            session.entry.script, exchange_step.handler
                        )));
                    }
                    let parsed = session.reply(&exchange_step.handler, &reply, state)?;
                    if let Some(next) = exchange_step.asked_by(&parsed) {
                        exchange_step = next?;
                        state = parsed.get("state").cloned().unwrap_or(Value::Null);
                        continue;
                    }
                    if let Some(error) = parsed.get("error").and_then(Value::as_str) {
                        return Err(ProviderError::Rejected(error.to_string()));
                    }
                    // Said by the host: a script with nothing of its own to say
                    // about the refusal has left it where it was found.
                    return Err(provider_error(&reply, &call.api_key));
                }
            }
        }
        Err(ProviderError::invalid(format!(
            "the script asked for more than {MAX_EXCHANGES} exchanges in one step"
        )))
    }

    async fn create_task(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        let session = Session::open(call)?;
        if !session.has("build_task_request") {
            // A converter whose protocol has no job for this capability
            // answers whole where the job would have started — a service that
            // recognizes a recording in the one call it was sent — and the
            // answer travels with the handle for the first poll to find. A
            // script that can neither start a job nor answer one is a
            // converter that cannot serve the capability at all, and saying so
            // beats a handle nothing could ever answer.
            if !session.has("build_request") {
                return Err(ProviderError::invalid(format!(
                    "{} generation has no job to start under the '{}' converter, and nothing to answer with either",
                    request.capability.as_str(),
                    call.protocol.wire_name()
                )));
            }
            let result = self.generate(call, request, inputs, cancel).await?;
            return Ok(AsyncTask {
                id: crate::domain::new_id(),
                reference: String::new(),
                protocol: call.protocol.clone(),
                capability: request.capability,
                model: call.config_id.clone(),
                scene: call.scene,
                created_at: crate::domain::now_iso(),
                answer: Some(Box::new(SettledAnswer::of(&result))),
            });
        }
        let asked = session.call(
            "build_task_request",
            vec![call_json(call), request_json(request), inputs_json(inputs)],
        )?;
        let ended = follow(
            &session,
            &asked,
            "parse_task_response",
            Step {
                call,
                inputs,
                capability: request.capability,
                cancel,
                kind: Kind::TaskCreate,
            },
        )
        .await?;
        if let Some(error) = ended.reply.get("error").and_then(Value::as_str) {
            return Err(ProviderError::Rejected(error.to_string()));
        }
        let reference = ended
            .reply
            .get("reference")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reference| !reference.is_empty())
            .ok_or_else(|| ProviderError::NoOutput("no task reference in response".to_string()))?
            .to_string();

        Ok(AsyncTask {
            id: crate::domain::new_id(),
            reference,
            protocol: call.protocol.clone(),
            // The capability the request came in on, not the one this adapter
            // was written for: polling resolves the model configuration again,
            // and a handle filed under the wrong category would be answered by
            // whatever model that category happens to hold.
            capability: request.capability,
            model: call.config_id.clone(),
            scene: call.scene,
            created_at: crate::domain::now_iso(),
            answer: None,
        })
    }

    async fn poll_task(
        &self,
        call: &ModelCall,
        task: &AsyncTask,
        cancel: &Cancel,
    ) -> Result<TaskState, ProviderError> {
        let session = Session::open(call)?;
        if !session.has("build_poll_request") {
            // A converter that answered whole has no job to look at: what it
            // answered travelled with the handle. One that carries no answer —
            // a handle written down by a process that is gone, whose answer
            // was dropped with it — will not answer again, which is what a
            // caller is told: start over rather than wait.
            let Some(answer) = task.answer.as_deref() else {
                return Err(ProviderError::TaskExpired {
                    task: task.id.clone(),
                });
            };
            return answer.result().map(TaskState::Succeeded);
        }
        let task_json = serde_json::json!({
            "id": task.id,
            "reference": task.reference,
        });
        let asked = session.call("build_poll_request", vec![call_json(call), task_json])?;
        // No inputs: a poll describes a request about a job rather than one
        // carrying media, so a script that asks for a file part here is told
        // the request carried none.
        let ended = follow(
            &session,
            &asked,
            "parse_poll_response",
            Step {
                call,
                inputs: &[],
                capability: task.capability,
                cancel,
                kind: Kind::TaskPoll,
            },
        )
        .await?;

        if ended.gone {
            return Err(ProviderError::TaskExpired {
                task: task.id.clone(),
            });
        }

        if let Some(error) = ended.reply.get("error").and_then(Value::as_str) {
            match ended.reply.get("status").and_then(Value::as_str) {
                Some("expired") => {
                    return Err(ProviderError::TaskExpired {
                        task: task.id.clone(),
                    })
                }
                // A job that ran and ended badly is not a failed look: it is
                // what the job did, and a client reading it is owed the
                // provider's own words and whether waiting would help.
                Some("failed") => {
                    return Ok(TaskState::Failed {
                        message: error.to_string(),
                        retryable: ended
                            .reply
                            .get("retryable")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                }
                _ => return Err(ProviderError::Rejected(error.to_string())),
            }
        }

        match ended.reply.get("status").and_then(Value::as_str) {
            Some("succeeded") => {
                let result = ended.reply.get("result");
                let mut items = Vec::new();
                if let Some(list) = result.and_then(|result| result.get("items")) {
                    items = items_of(
                        list,
                        &ended.body,
                        call,
                        task.capability,
                        &session.entry.auth,
                    )
                    .await?;
                }
                // Words travel the same way media does. A job that answers with
                // them — a transcript, the point of a recognition job — has
                // nothing to download and everything to say.
                let text = result
                    .and_then(|result| result.get("text"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                Ok(TaskState::Succeeded(GenerateResult {
                    text,
                    items,
                    usage: usage_of(result.and_then(|result| result.get("usage"))),
                }))
            }
            Some("pending") | None => {
                let interval_ms = ended
                    .reply
                    .get("poll_interval_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(15000);
                Ok(TaskState::Pending {
                    retry_after_ms: interval_ms,
                })
            }
            Some("failed") => Ok(TaskState::Failed {
                message: ended
                    .reply
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("the job failed without saying why")
                    .to_string(),
                retryable: false,
            }),
            Some(other) => Err(ProviderError::Rejected(format!(
                "unexpected status: {other}"
            ))),
        }
    }
}

/// One call's Lua side: the converter it came from, a runtime, and the script
/// loaded into it.
///
/// The runtime lives for the whole call rather than for one exchange, because
/// building one is the same work every time and a stream is an exchange per
/// event. It is built for the protocol it runs, so what the script remembers
/// in the memo is this converter's alone. Nothing is asked of it that one
/// thread could not do: a runtime is created, used, and dropped inside the
/// call that made it.
struct Session {
    entry: ProtocolEntry,
    runtime: LuaRuntime,
    script: ScriptRef,
}

impl Session {
    /// Opens the converter the configured protocol names.
    fn open(call: &ModelCall) -> Result<Self, ProviderError> {
        let name = call.protocol.wire_name();
        let root = CONVERTER_ROOT
            .get()
            .ok_or_else(|| ProviderError::invalid("converter root not initialised"))?;
        let entry = ConverterRegistry::load(root)
            .find(name)
            .cloned()
            .ok_or_else(|| {
                ProviderError::invalid(format!("no converter script for protocol '{name}'"))
            })?;
        let runtime = LuaRuntime::for_protocol(name)
            .map_err(|e| ProviderError::invalid(format!("Lua runtime failed: {e}")))?;
        let script = runtime.load(&root.join(&entry.script)).map_err(|e| {
            ProviderError::invalid(format!("failed to load script '{}': {e}", entry.script))
        })?;
        Ok(Self {
            entry,
            runtime,
            script,
        })
    }

    /// Whether the script exports a function, which is also how it says
    /// whether it can do a thing at all.
    fn has(&self, func: &str) -> bool {
        self.runtime.has_function(&self.script, func)
    }

    /// Calls a hook with JSON arguments.
    fn call(&self, func: &str, args: Vec<Value>) -> Result<Value, ProviderError> {
        self.runtime
            .call_json_value(&self.script, func, args)
            .map_err(|e| ProviderError::invalid(format!("Lua '{func}' failed: {e}")))
    }

    /// Calls the handler that reads one answer: the status, the headers as a
    /// table, the body as text, whatever the last step left behind, and the
    /// body as it arrived — which is what a handler reads when the answer is
    /// not text at all.
    fn reply(&self, func: &str, reply: &Reply, state: Value) -> Result<Value, ProviderError> {
        let headers = self
            .runtime
            .to_lua(&header_table(&reply.headers))
            .map_err(|e| {
                ProviderError::invalid(format!("headers could not be handed over: {e}"))
            })?;
        let body = self
            .runtime
            .to_lua(&Value::String(
                String::from_utf8_lossy(&reply.body).to_string(),
            ))
            .map_err(|e| {
                ProviderError::invalid(format!("the body could not be handed over: {e}"))
            })?;
        let raw = self.runtime.bytes(&reply.body).map_err(|e| {
            ProviderError::invalid(format!("the body could not be handed over: {e}"))
        })?;
        let state = self
            .runtime
            .to_lua(&state)
            .map_err(|e| ProviderError::invalid(format!("Lua '{func}' failed: {e}")))?;
        let args = vec![
            self.runtime
                .to_lua(&json!(reply.status))
                .map_err(|e| ProviderError::invalid(format!("Lua '{func}' failed: {e}")))?,
            headers,
            body,
            state,
            raw,
        ];
        self.runtime
            .call_values(func, args)
            .map_err(|e| ProviderError::invalid(format!("Lua '{func}' failed: {e}")))
    }

    /// One event of a stream, read by the script that asked for it.
    ///
    /// A script that fails here fails the stream rather than a call: the answer
    /// has already begun arriving, and the complaint is what its reader is
    /// told.
    fn event(&self, payload: &Value) -> StreamEvent {
        if !self.has("parse_event") {
            return StreamEvent {
                failed: Some("the script streams without exporting 'parse_event'".to_string()),
                ..StreamEvent::default()
            };
        }
        match self.call("parse_event", vec![Value::String(payload.to_string())]) {
            Ok(reply) => StreamEvent {
                text: reply
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                complete: reply
                    .get("complete")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                usage: usage_of(reply.get("usage")),
                failed: reply
                    .get("failed")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
            Err(error) => StreamEvent {
                failed: Some(error.to_string()),
                ..StreamEvent::default()
            },
        }
    }
}

/// What a step ended with: the script's last reply, and the bytes of the answer
/// it read — which is where an item that says `raw` comes from. A `gone` step
/// has no reply to speak of: the provider answered that it no longer knows the
/// job that was being polled.
struct Ended {
    reply: Value,
    body: Vec<u8>,
    gone: bool,
}

/// Runs the exchanges a build hook asked for, and returns the reply that ended
/// the chain.
///
/// The hook's reply is the first exchange, either as a request description or
/// as `{request, handler}` when the answer needs a function of its own to read;
/// a hook with nothing to ask for says so with `{error}`. From there, a reply
/// that carries `next` asks for one more exchange, which is how a protocol
/// needing several calls stays in Lua rather than in this host. What a reply
/// learned travels in `state`, handed to the next handler as its fourth
/// argument.
async fn follow(
    session: &Session,
    asked: &Value,
    fallback: &str,
    step: Step<'_>,
) -> Result<Ended, ProviderError> {
    if let Some(error) = asked.get("error").and_then(Value::as_str) {
        return Err(ProviderError::Rejected(error.to_string()));
    }
    let mut exchange_step = Exchange::asked(asked, fallback)?;
    let mut state = asked.get("state").cloned().unwrap_or(Value::Null);
    for _ in 0..MAX_EXCHANGES {
        step.cancel.check()?;
        // Looked up before the request goes out: a script that names a function
        // it never wrote is refused rather than sending an upload of tens of
        // megabytes to a provider nobody will read.
        if !session.has(&exchange_step.handler) {
            return Err(ProviderError::invalid(format!(
                "script '{}' does not export '{}'",
                session.entry.script, exchange_step.handler
            )));
        }
        let request_builder = builder(
            step.call,
            &session.entry,
            &exchange_step.request,
            step.inputs,
        )?;
        let reply = exchange(
            step.kind,
            step.call,
            request_builder,
            step.call.budgets.timeout_for(step.capability),
            step.call.budgets.max_response_bytes,
        )
        .await?;
        // A status the provider refused is the host's to explain, unless the
        // script asked to read it: the code a client acts on comes from the
        // status, and a script that read them all as one thing would report a
        // rate limit as a refusal nothing may retry.
        if !reads_failure(&exchange_step.request) && !succeeded(reply.status) {
            // A poll answered with "no such job" is the end of the looking
            // rather than a refusal of the request: the provider said it in a
            // status, and every polling protocol means the same by it. Handed
            // back untouched, because what that means for a client — start
            // over rather than wait — is the caller's to say.
            if step.kind == Kind::TaskPoll && matches!(reply.status, 404 | 410) {
                return Ok(Ended {
                    reply: Value::Null,
                    body: reply.body,
                    gone: true,
                });
            }
            return Err(provider_error(&reply, &step.call.api_key));
        }
        let parsed = session.reply(&exchange_step.handler, &reply, state)?;
        if let Some(next) = exchange_step.asked_by(&parsed) {
            exchange_step = next?;
            state = parsed.get("state").cloned().unwrap_or(Value::Null);
            continue;
        }
        // A script that asked to read a failure and then said nothing about it
        // has left the refusal for the host to explain, which is what a
        // protocol wants when only some refusals are its business: the rest go
        // on meaning what their status means, a rate limit among them.
        if !succeeded(reply.status) && nothing_said(&parsed) {
            return Err(provider_error(&reply, &step.call.api_key));
        }
        return Ok(Ended {
            reply: parsed,
            body: reply.body,
            gone: false,
        });
    }
    Err(ProviderError::invalid(format!(
        "the script asked for more than {MAX_EXCHANGES} exchanges in one step"
    )))
}

/// What one step of a chain is run with: the call it belongs to, the media the
/// request carried, and what to do if the caller gives up.
struct Step<'a> {
    call: &'a ModelCall,
    inputs: &'a [MediaInput],
    capability: Capability,
    cancel: &'a Cancel,
    kind: Kind,
}

/// Whether a request description asks for the answer even when the provider
/// refused it. A protocol whose failure carries an answer of its own — an edit
/// address that does not exist, tried before the one that does — needs to read
/// the failure rather than be handed a complaint about it.
fn reads_failure(request_def: &Value) -> bool {
    request_def
        .get("read_failure")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Whether a script's reading of a refusal says nothing about it, which is how
/// a script handed a failure it asked to read defers one that is not its to
/// answer back to the host.
fn nothing_said(reply: &Value) -> bool {
    !reply.as_object().is_some_and(|said| {
        ["error", "text", "items"]
            .iter()
            .any(|key| said.contains_key(*key))
    })
}

/// The answer one step ended with, read as media and words.
async fn result_of(
    session: &Session,
    ended: &Ended,
    call: &ModelCall,
    capability: Capability,
) -> Result<GenerateResult, ProviderError> {
    if let Some(error) = ended.reply.get("error").and_then(Value::as_str) {
        return Err(ProviderError::Rejected(error.to_string()));
    }
    let items = match ended.reply.get("items") {
        Some(list) => items_of(list, &ended.body, call, capability, &session.entry.auth).await?,
        None => Vec::new(),
    };
    let text = ended
        .reply
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(GenerateResult {
        text,
        items,
        usage: usage_of(ended.reply.get("usage")),
    })
}

/// The media a reply described, each one stored as it arrived.
///
/// An item says where its bytes are: at an address the host fetches, inside a
/// data URL, in base64, or in the answer itself. What the bytes are is settled
/// by sniffing them rather than by what the script called them, because a
/// container's name is not always one a file can be stored under.
async fn items_of(
    list: &Value,
    body: &[u8],
    call: &ModelCall,
    capability: Capability,
    auth: &AuthSpec,
) -> Result<Vec<GeneratedItem>, ProviderError> {
    let specs = match list.as_array() {
        Some(specs) => specs,
        // A Lua table with nothing in it crosses back as an empty document
        // rather than as an empty list, which is the same answer said
        // differently: a script that has no media to report is not describing
        // media wrongly.
        None if list.as_object().is_some_and(|shape| shape.is_empty()) => return Ok(Vec::new()),
        None => {
            return Err(ProviderError::invalid(
                "the script described items that are not a list",
            ))
        }
    };
    let mut items = Vec::with_capacity(specs.len());
    for spec in specs {
        items.push(item_of(spec, body, call, capability, auth).await?);
    }
    Ok(items)
}

async fn item_of(
    spec: &Value,
    body: &[u8],
    call: &ModelCall,
    capability: Capability,
    auth: &AuthSpec,
) -> Result<GeneratedItem, ProviderError> {
    let claimed = spec.get("mime").and_then(Value::as_str);
    if let Some(address) = spec.get("url").and_then(Value::as_str) {
        // The address is wherever the provider left the media, so it is asked
        // for the way the configured endpoint was — the same rule every other
        // address outside it follows.
        let reply = exchange(
            Kind::Media,
            call,
            call.described_with("GET", address, auth)?,
            call.budgets.timeout_for(capability),
            call.budgets.max_response_bytes,
        )
        .await?;
        if !succeeded(reply.status) {
            return Err(provider_error(&reply, &call.api_key));
        }
        return stored(reply.body, claimed, capability);
    }
    if let Some(data_url) = spec.get("data_url").and_then(Value::as_str) {
        let (named, bytes) = decode_data_url(data_url)?;
        return stored(bytes, claimed.or(named.as_deref()), capability);
    }
    if let Some(encoded) = spec.get("base64").and_then(Value::as_str) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|error| {
                ProviderError::Rejected(format!("the answer carried unusable base64: {error}"))
            })?;
        return stored(bytes, claimed, capability);
    }
    if spec.get("raw").and_then(Value::as_bool).unwrap_or(false) {
        return stored(body.to_vec(), claimed, capability);
    }
    Err(ProviderError::invalid(
        "the script described an item with no bytes to store",
    ))
}

/// One item's bytes, stored as the media the request was for.
///
/// An image is read for its size as well as its mime, because the canvas lays
/// it out before anyone opens it. Anything else is stored under the family it
/// belongs to, which is what keeps an answer that is not what was asked for
/// from becoming an asset nothing can play.
fn stored(
    bytes: Vec<u8>,
    claimed: Option<&str>,
    capability: Capability,
) -> Result<GeneratedItem, ProviderError> {
    match capability {
        Capability::Image => image_item(bytes),
        other => media_item(bytes, claimed, other, fallback_for(other)),
    }
}

/// What an answer with nothing recognisable in it is taken to be. Only reached
/// when neither the bytes nor the script named a mime inside the family.
fn fallback_for(capability: Capability) -> &'static str {
    match capability {
        Capability::Image => "image/png",
        Capability::Speech | Capability::Music => "audio/mpeg",
        Capability::Video => "video/mp4",
        Capability::Text | Capability::Asr => "application/octet-stream",
    }
}

/// The bytes inside a `data:` URL, and the mime it named if it named one.
fn decode_data_url(url: &str) -> Result<(Option<String>, Vec<u8>), ProviderError> {
    let unusable =
        || ProviderError::Rejected("the answer carried a data URL that cannot be read".to_string());
    let without_scheme = url.strip_prefix("data:").ok_or_else(unusable)?;
    let (header, encoded) = without_scheme.split_once(',').ok_or_else(unusable)?;
    let named = header
        .split(';')
        .next()
        .map(str::trim)
        .filter(|mime| !mime.is_empty() && !mime.eq_ignore_ascii_case("base64"))
        .map(str::to_string);
    if !header.to_ascii_lowercase().contains("base64") {
        return Err(unusable());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| unusable())?;
    Ok((named, bytes))
}

/// The totals a script reported, under the names a request is counted by.
fn usage_of(value: Option<&Value>) -> Option<Usage> {
    let counted = value?.as_object()?;
    let read = |key: &str| counted.get(key).and_then(Value::as_u64);
    let usage = Usage {
        input_tokens: read("input_tokens"),
        output_tokens: read("output_tokens"),
        images: read("images").map(|count| count as u32),
        seconds: counted.get("seconds").and_then(Value::as_f64),
    };
    (usage.input_tokens.is_some()
        || usage.output_tokens.is_some()
        || usage.images.is_some()
        || usage.seconds.is_some())
    .then_some(usage)
}

/// One exchange: a request a script described, and the function that reads the
/// answer to it.
struct Exchange {
    request: Value,
    handler: String,
}

impl Exchange {
    /// The exchange a hook or a reply asked for.
    ///
    /// The request description can be returned on its own — the shape every
    /// script used before protocols chained calls — or as a `{request,
    /// handler}` pair when the answer needs a function of its own to read it.
    /// Without one, `fallback` reads it.
    fn asked(reply: &Value, fallback: &str) -> Result<Self, ProviderError> {
        let (request, handler) = match reply.get("request") {
            Some(request) if request.is_object() => (
                request.clone(),
                reply.get("handler").and_then(Value::as_str),
            ),
            _ => (reply.clone(), None),
        };
        if !request.is_object() {
            return Err(ProviderError::invalid(
                "the script described no request to send",
            ));
        }
        Ok(Self {
            request,
            handler: handler.unwrap_or(fallback).to_string(),
        })
    }

    /// The exchange a reply asked for next, or none when the chain is over.
    ///
    /// A reply that names no handler is read by the one that read the last
    /// answer, which is what a script paging through one endpoint wants; the
    /// step ceiling is what stops that from being a loop.
    fn asked_by(&self, reply: &Value) -> Option<Result<Self, ProviderError>> {
        reply
            .get("next")
            .map(|next| Self::asked(next, &self.handler))
    }
}

/// What a request description says to send.
enum Body {
    /// Nothing, which only a GET or a HEAD may.
    None,
    /// The text the script wrote.
    Text(String),
    /// A form, with the bytes and the content type that names its boundary.
    Multipart(Vec<u8>, String),
}

/// The request a description asks for, ready to be sent.
///
/// The credential follows the address rather than the script, and takes the
/// shape the converter declared: an upload host or a link a provider handed
/// back is a different origin from the configured endpoint, and a key sent
/// there would not be going to the provider.
fn builder(
    call: &ModelCall,
    entry: &ProtocolEntry,
    request_def: &Value,
    inputs: &[MediaInput],
) -> Result<reqwest::RequestBuilder, ProviderError> {
    let method = request_def["method"].as_str().unwrap_or("POST");
    let url = request_def["url"]
        .as_str()
        .ok_or_else(|| ProviderError::invalid("Lua script returned no URL"))?;

    let mut builder = call.described_with(method, url, &entry.auth)?;
    if let Some(headers) = request_def["headers"].as_object() {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                builder = builder.header(name.as_str(), value);
            }
        }
    }

    match described_body(request_def, inputs)? {
        Body::None => {
            if !matches!(method.trim().to_ascii_uppercase().as_str(), "GET" | "HEAD") {
                return Err(ProviderError::invalid(format!(
                    "Lua script returned no body for a {method} request"
                )));
            }
            Ok(builder)
        }
        Body::Text(text) => Ok(builder.body(text)),
        // The content type is set after the script's own headers: a boundary a
        // script wrote down itself would not be the one this body was
        // assembled with.
        Body::Multipart(bytes, content_type) => {
            Ok(builder.header("Content-Type", content_type).body(bytes))
        }
    }
}

/// The body a request description asks for, sent as it stands.
fn described_body(request_def: &Value, inputs: &[MediaInput]) -> Result<Body, ProviderError> {
    match request_def.get("body") {
        None | Some(Value::Null) => Ok(Body::None),
        Some(Value::String(text)) => Ok(Body::Text(text.clone())),
        Some(Value::Object(shape)) => {
            let multipart = shape.get("multipart").ok_or_else(|| {
                ProviderError::invalid("the script described a body this host cannot send")
            })?;
            let (bytes, content_type) = multipart_body(multipart, inputs)?;
            Ok(Body::Multipart(bytes, content_type))
        }
        Some(_) => Err(ProviderError::invalid(
            "the script described a body that is neither text nor a multipart form",
        )),
    }
}

/// A multipart form: the script's fields, and the inputs that travel as files.
///
/// A script cannot carry bytes, so it says which of the inputs it sent along
/// belongs in a file part — counting from one, as Lua counts — and the boundary
/// is this host's business rather than the script's. One file is written as
/// `file = {part = ..., input = ...}`; several as `files = {{...}, {...}}`,
/// which is what an edit that sends a mask beside its picture needs.
///
/// Fields are written in the order of their names. A Lua table of them has no
/// order to keep — its pairs come out in whatever order the hash puts them —
/// and a body that differs between two runs of the same request is no use to
/// anybody, least of all a test.
fn multipart_body(
    shape: &Value,
    inputs: &[MediaInput],
) -> Result<(Vec<u8>, String), ProviderError> {
    let mut body = MultipartBody::new();
    for (name, value) in named_fields(shape) {
        if let Some(text) = field_text(&value) {
            body = body.field(&name, &text);
        }
    }
    let files: Vec<&Value> = match shape.get("files") {
        Some(Value::Array(list)) => list.iter().collect(),
        _ => shape
            .get("file")
            .filter(|file| !file.is_null())
            .into_iter()
            .collect(),
    };
    for file in files {
        let part = file.get("part").and_then(Value::as_str).unwrap_or("file");
        let index = file.get("input").and_then(Value::as_u64).unwrap_or(1);
        let media = inputs
            .get(index.saturating_sub(1) as usize)
            .ok_or_else(|| {
                ProviderError::invalid(format!(
                    "the script asked for input {index} and the request carried {}",
                    inputs.len()
                ))
            })?;
        body = body.file(part, media);
    }
    Ok(body.finish())
}

/// A script's form fields, by name and in the order their names sort.
fn named_fields(shape: &Value) -> Vec<(String, Value)> {
    let mut fields: Vec<(String, Value)> = shape
        .get("fields")
        .and_then(Value::as_object)
        .map(|fields| {
            fields
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default();
    fields.sort_by(|(a, _), (b, _)| a.cmp(b));
    fields
}

/// A form field as text. A script may write a number or a flag where a field is
/// expected, and a form has no types of its own.
fn field_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// The answer's headers as a table, lowercased, a name sent twice joined by
/// `", "` — the way a reader of one header wants to find both.
fn header_table(headers: &HeaderMap) -> Value {
    let mut table = Map::new();
    for (name, value) in headers {
        let Ok(value) = value.to_str() else {
            continue;
        };
        match table.get_mut(name.as_str()) {
            Some(Value::String(existing)) => {
                existing.push_str(", ");
                existing.push_str(value);
            }
            _ => {
                table.insert(name.as_str().to_string(), Value::String(value.to_string()));
            }
        }
    }
    Value::Object(table)
}

/// The model call as a script reads it: the endpoint it was configured with,
/// and the provider's own name for the model.
fn call_json(call: &ModelCall) -> Value {
    json!({
        "url": call.url,
        "model": call.model,
    })
}

/// The request as a script reads it.
fn request_json(request: &GenerateRequest) -> Value {
    json!({
        "prompt": request.prompt,
        "system": request.instruction(),
        "capability": request.capability.as_str(),
        "params": request.params,
    })
}

/// The reference media, each with its name, its type, its bytes inside a data
/// URL, and the digest of those bytes.
///
/// The digest is a name for the file rather than for the request: a script
/// that builds something once out of a recording — a voice copied, reused by
/// the next line — keys its memo by it, so two asks carrying the same file
/// agree on the key.
fn inputs_json(inputs: &[MediaInput]) -> Value {
    let list: Vec<Value> = inputs
        .iter()
        .map(|input| {
            json!({
                "role": input.role.as_str(),
                "filename": input.filename(),
                "mime": input.mime,
                "data_url": input.data_url(),
                "sha256": sha256_hex(&input.bytes),
            })
        })
        .collect();
    Value::Array(list)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}
