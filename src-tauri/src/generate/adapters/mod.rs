//! The wire protocols a model configuration can speak.
//!
//! One module per protocol family, all behind the same trait, so nothing above
//! this branches on the protocol itself. An adapter is given the full endpoint
//! address, a credential, and a request phrased in the project's own words,
//! and answers with bytes and a mime type: no provider field name crosses this
//! boundary in either direction.

use std::time::Duration;

use reqwest::header::HeaderMap;

use crate::config::GenerateConfig;
use crate::converter;
use crate::converter::registry::AuthSpec;
use crate::domain::Capability;
use crate::metadata::{Protocol, Scene};

use super::debug::{self, Kind};
use super::error::ProviderError;
use super::media::MediaInput;
use super::models::ResolvedModel;
use super::{
    AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, GeneratedItem, TaskState,
    ToolCall, ToolCallDelta, Usage,
};

/// A provider that cannot answer in this long is not about to finish a
/// generation.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How much of a provider's complaint reaches a problem body and a log line.
const MAX_DETAIL_CHARS: usize = 300;

/// Shortest credential worth scrubbing out of a message that echoes it. A
/// shorter one could match ordinary words and mangle the explanation.
const MIN_SCRUBBED_KEY_CHARS: usize = 8;

const USER_AGENT: &str = concat!("moka-canvas/", env!("CARGO_PKG_VERSION"));

/// The sentinel that ends a server-sent stream.
const STREAM_DONE: &str = "[DONE]";

/// The mime that says nothing. An answer carrying it did not name what it sent,
/// which is a different case from one that named something else.
const UNSPECIFIED_MIME: &str = "application/octet-stream";

/// One model configuration, addressed for a single call.
///
/// It carries the plaintext credential, which is why it is built when a request
/// goes out and dropped when the call returns. No `Debug` on purpose: a stray
/// `{call:?}` in a log line should fail to build rather than print a key.
#[derive(Clone)]
pub struct ModelCall {
    /// The model configuration's own identifier: a name worth writing down,
    /// and what a job started here is pointed back at.
    pub config_id: String,
    /// The provider's own model name.
    pub model: String,
    /// What the user calls this model in the settings.
    pub display_name: String,
    pub protocol: Protocol,
    /// The complete endpoint address the configured calls are sent to.
    pub url: String,
    /// The scenario this call was placed for, kept so a job started here can
    /// be polled at the same address it was started at.
    pub scene: Option<Scene>,
    pub api_key: String,
    pub budgets: GenerateConfig,
    client: reqwest::Client,
}

impl ModelCall {
    pub fn new(
        resolved: &ResolvedModel,
        api_key: String,
        budgets: GenerateConfig,
    ) -> Result<Self, ProviderError> {
        Ok(Self {
            config_id: resolved.config_id.clone(),
            model: resolved.model.clone(),
            display_name: resolved.display_name.clone(),
            protocol: resolved.protocol.clone(),
            url: resolved.url.clone(),
            scene: resolved.scene,
            api_key,
            budgets,
            client: build_client()?,
        })
    }

    /// The origin of the configured address, so a caller can tell whether
    /// another URL belongs to the same provider.
    pub fn origin(&self) -> Option<String> {
        origin_of(&self.url)
    }

    /// The same request, with the credential placed the way a converter
    /// declared it: in the header it named, with the scheme it named, or not
    /// at all where it named none.
    ///
    /// A converter says where its key rides because that is a fact about the
    /// service rather than about this program — one endpoint wants a bearer
    /// token, another a key of its own in a header of its own, and a third
    /// takes none. The credential follows the configured origin and nothing
    /// else: an endpoint a script derived is the provider's, and a link it was
    /// handed is somebody else's. A link on a third-party CDN is public by
    /// nature, and a key sent after it would not be going to the provider.
    pub(crate) fn described_with(
        &self,
        method: &str,
        address: &str,
        auth: &AuthSpec,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        let request = self.without_credential(method, address);
        if origin_of(address).is_none() || origin_of(address) != self.origin() {
            return Ok(request);
        }
        if auth.header.is_empty() {
            return Ok(request);
        }
        let name =
            reqwest::header::HeaderName::from_bytes(auth.header.as_bytes()).map_err(|e| {
                ProviderError::invalid(format!("'{}' is not a header name: {e}", auth.header))
            })?;
        let value = if auth.scheme.is_empty() {
            self.api_key.clone()
        } else {
            format!("{} {}", auth.scheme, self.api_key)
        };
        let value = reqwest::header::HeaderValue::from_str(&value).map_err(|e| {
            // A credential carrying a newline is a stored-value problem rather
            // than an outage, and saying so stops a client from retrying it.
            ProviderError::invalid(format!("the credential cannot be sent in a header: {e}"))
        })?;
        Ok(request.header(name, value))
    }

    /// A request with nothing of this call's credential on it yet.
    fn without_credential(&self, method: &str, address: &str) -> reqwest::RequestBuilder {
        match reqwest::Method::from_bytes(method.trim().to_uppercase().as_bytes()) {
            Ok(reqwest::Method::GET) => self.client.get(address.to_string()),
            Ok(reqwest::Method::HEAD) => self.client.head(address.to_string()),
            Ok(reqwest::Method::PUT) => self.client.put(address.to_string()),
            Ok(reqwest::Method::PATCH) => self.client.patch(address.to_string()),
            Ok(reqwest::Method::DELETE) => self.client.delete(address.to_string()),
            // Everything else is a POST: no protocol here speaks another
            // method, and a method nobody named is not one to invent.
            _ => self.client.post(address.to_string()),
        }
    }
}

fn build_client() -> Result<reqwest::Client, ProviderError> {
    // No client-wide timeout: each request sets its own budget, and a stream
    // that is still producing must not be cut off by a deadline meant for the
    // first byte.
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| ProviderError::Unreachable(error.to_string()))
}

/// One wire protocol.
///
/// The methods mirror what a caller can ask for rather than what a provider
/// happens to offer, and the ones a protocol cannot serve are refused by
/// default: the gateway routes video through a job and text through a stream
/// only where an adapter says it can.
#[async_trait::async_trait]
pub trait ProviderAdapter: Send + Sync {
    /// One generation, waited out.
    async fn generate(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError>;

    /// The same generation, with text pushed to `sink` as it arrives. What
    /// comes back is still the aggregate, because the aggregate is what gets
    /// stored: the stream only makes the wait visible.
    ///
    /// A protocol that cannot stream still answers a caller who is not reading
    /// the pieces — a stream is how the answer was to be carried, and this
    /// caller only ever wanted the answer — and refuses the caller who is
    /// reading them, whose wait the pieces were for.
    async fn generate_stream(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        sink: &DeltaSink,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        if sink.is_watched() {
            return Err(ProviderError::invalid("this protocol does not stream"));
        }
        self.generate(call, request, inputs, cancel).await
    }

    /// Starts a job that outlives this request and returns the handle to poll.
    async fn create_task(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        let _ = (call, request, inputs, cancel);
        Err(ProviderError::invalid("this protocol does not run jobs"))
    }

    /// One look at a job started earlier.
    async fn poll_task(
        &self,
        call: &ModelCall,
        task: &AsyncTask,
        cancel: &Cancel,
    ) -> Result<TaskState, ProviderError> {
        let _ = (call, task, cancel);
        Err(ProviderError::invalid("this protocol does not run jobs"))
    }
}

/// The adapter every protocol is spoken by. A protocol is a name and nothing
/// more, so which shape a call has is decided by the converter script that
/// name finds — no family is built into this program at all.
pub fn for_protocol(_protocol: Protocol) -> &'static dyn ProviderAdapter {
    converter::LuaAdapter::get()
}

/// A provider's answer, reduced to what an adapter acts on.
///
/// The body is read on both paths because a provider explains a failure in it,
/// and kept as bytes because audio and video arrive as neither text nor JSON.
pub(crate) struct Reply {
    pub(crate) status: u16,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Vec<u8>,
}

impl Reply {
    pub(crate) fn text(&self) -> Result<&str, ProviderError> {
        std::str::from_utf8(&self.body)
            .map_err(|_| ProviderError::Rejected("the answer is not valid UTF-8 text".to_string()))
    }

    /// The provider's own advice about when to come back. A date is left alone:
    /// a skewed clock would turn it into a wait of the wrong length, and the
    /// gateway's backoff already covers that case.
    fn retry_after(&self) -> Option<Duration> {
        let value = self
            .headers
            .get(reqwest::header::RETRY_AFTER)?
            .to_str()
            .ok()?;
        value.trim().parse::<u64>().ok().map(Duration::from_secs)
    }
}

pub(crate) fn succeeded(status: u16) -> bool {
    (200..300).contains(&status)
}

/// Places a request under a deadline and reads the answer whole, leaving the
/// status for the caller: one adapter has to see a 404 before it can decide to
/// try a second endpoint, and a converter script reads one as an answer of its
/// own.
///
/// The kind says what the call was for, which is the only thing that tells two
/// requests to the same address apart in a recording made afterwards.
pub(crate) async fn exchange(
    kind: Kind,
    call: &ModelCall,
    request: reqwest::RequestBuilder,
    deadline: Duration,
    ceiling: u64,
) -> Result<Reply, ProviderError> {
    let built = build(request.timeout(deadline))?;
    let recording = debug::begin(kind, call, &built);
    let response = match send(call, built).await {
        Ok(response) => response,
        Err(error) => {
            debug::unsent(recording, &error.to_string());
            return Err(error);
        }
    };
    // Read before the body is, because draining consumes the response that
    // carries them and a recording wants all three of them together.
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    match drain(response, ceiling).await {
        Ok(reply) => {
            debug::answered(recording, status, &headers, &reply.body);
            Ok(reply)
        }
        Err(error) => {
            debug::broken(recording, &error.to_string(), status, &headers);
            Err(error)
        }
    }
}

/// Builds a request into the shape it goes out in.
///
/// Built here rather than sent, because a recording has to read the address, the
/// headers and the body while all three are still in hand: a request is consumed
/// by sending it, and the body in particular is not there afterwards.
fn build(request: reqwest::RequestBuilder) -> Result<reqwest::Request, ProviderError> {
    request
        .build()
        .map_err(|error| ProviderError::Unreachable(error.to_string()))
}

/// Places a built request and stops at the headers, which is what lets a failure
/// be read whole and a success be streamed.
async fn send(
    call: &ModelCall,
    request: reqwest::Request,
) -> Result<reqwest::Response, ProviderError> {
    call.client.execute(request).await.map_err(transport)
}

pub(crate) async fn drain(
    response: reqwest::Response,
    ceiling: u64,
) -> Result<Reply, ProviderError> {
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = next_chunk(&mut response).await? {
        body.extend_from_slice(&chunk);
        if body.len() as u64 > ceiling {
            return Err(ProviderError::Rejected(format!(
                "the answer is larger than {ceiling} bytes"
            )));
        }
    }
    Ok(Reply {
        status,
        headers,
        body,
    })
}

/// The next piece of a body, or none once it has ended. Owned rather than
/// borrowed from the client's own buffer type, which is not a dependency here.
async fn next_chunk(response: &mut reqwest::Response) -> Result<Option<Vec<u8>>, ProviderError> {
    response
        .chunk()
        .await
        .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
        .map_err(|error| ProviderError::Unreachable(error.to_string()))
}

/// An opened stream, or the answer that refused to open one.
///
/// Split out so an adapter that can try a second endpoint does so before a
/// single character has reached anybody: once deltas are on screen, a fallback
/// would repeat them.
pub(crate) enum Opened {
    /// A stream that opened, with the recording waiting for its end. The
    /// recording travels with the stream rather than staying here, because the
    /// answer is not finished until the stream is. Boxed because a whole request
    /// — address, headers, body — is a large thing to size an enum by, and this
    /// variant is read once and handed back to the recorder.
    Streaming(reqwest::Response, Option<Box<debug::Pending>>),
    Refused(Reply),
}

/// Places a request whose answer arrives in pieces and stops at the headers.
///
/// The request is prepared by the caller: one protocol asks for a stream on
/// another endpoint, the other on the same endpoint with a query that changes
/// the shape of the answer.
pub(crate) async fn open_stream(
    kind: Kind,
    call: &ModelCall,
    request: reqwest::RequestBuilder,
) -> Result<Opened, ProviderError> {
    let built = build(request)?;
    let recording = debug::begin(kind, call, &built);
    let response = match send(call, built).await {
        Ok(response) => response,
        Err(error) => {
            debug::unsent(recording, &error.to_string());
            return Err(error);
        }
    };
    let status = response.status().as_u16();
    if succeeded(status) {
        return Ok(Opened::Streaming(response, recording.map(Box::new)));
    }
    // A refusal arrives whole rather than in pieces, so it is read here and
    // written down here: a stream nobody is going to read has no end to wait
    // for.
    let headers = response.headers().clone();
    match drain(response, call.budgets.max_response_bytes).await {
        Ok(reply) => {
            debug::answered(recording, status, &headers, &reply.body);
            Ok(Opened::Refused(reply))
        }
        Err(error) => {
            debug::broken(recording, &error.to_string(), status, &headers);
            Err(error)
        }
    }
}

/// Reads an opened stream to its end, pushing each piece of text to the sink
/// and returning the aggregate.
///
/// The deadline is a silence, not a total: a stream that is still producing
/// text must not be cut off by a budget meant for the whole of it, because a
/// thinking model may deliberate for minutes before its first word and a long
/// answer may take longer still — what is wrong is a channel that has gone
/// quiet, and that is what the budget measures, from the last piece rather
/// than from the start.
///
/// When the stream is being recorded, the raw events are kept beside the reading
/// of them, because the interesting failure is the one where the two disagree:
/// what the provider sent is evidence, and what was made of it is an opinion.
pub(crate) async fn read_stream<F>(
    response: reqwest::Response,
    recording: Option<debug::Pending>,
    sink: &DeltaSink,
    cancel: &Cancel,
    deadline: Duration,
    parse: F,
) -> Result<GenerateResult, ProviderError>
where
    F: Fn(&serde_json::Value) -> StreamEvent,
{
    let mut response = response;
    let keep = recording.is_some();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let mut reader = SseReader::new(&parse, sink);
    // Kept only when something is going to be written down: reading a stream
    // twice is work, and most streams are not being recorded.
    let mut raw: Vec<u8> = Vec::new();
    let ended = loop {
        // The wait for the next piece is where the budget bites: a channel that
        // has gone quiet is what is wrong, and a future left to wait forever on
        // one would never reach a check stood after it.
        let chunk = match tokio::time::timeout(deadline, next_chunk(&mut response)).await {
            Err(_) => {
                break Err(ProviderError::Timeout(format!(
                    "the stream went quiet for {} seconds",
                    deadline.as_secs()
                )))
            }
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break Ok(()),
            Ok(Err(error)) => break Err(error),
        };
        if keep {
            raw.extend_from_slice(&chunk);
        }
        if let Err(error) = cancel.check() {
            break Err(error);
        }
        reader.feed(&chunk);
        if reader.done {
            break Ok(());
        }
    };
    match ended {
        Ok(()) => match reader.finish() {
            Ok(result) => {
                debug::streamed(
                    recording,
                    status,
                    &headers,
                    raw,
                    result.text.clone().unwrap_or_default(),
                );
                Ok(result)
            }
            // A complaint that arrived with the stream is refused the same way
            // a status would have been, and what arrived before it is still
            // the evidence of what the provider was doing.
            Err(error) => {
                debug::stream_broken(recording, &error.to_string(), status, &headers, raw);
                Err(error)
            }
        },
        Err(error) => {
            // What arrived before the end is still the evidence of what the
            // provider was doing, so it is kept rather than dropped with the call.
            debug::stream_broken(recording, &error.to_string(), status, &headers, raw);
            Err(error)
        }
    }
}

/// What one event in a stream contributed.
#[derive(Debug, Default)]
pub(crate) struct StreamEvent {
    /// Text to show as it arrives and to add to the aggregate.
    pub(crate) text: Option<String>,
    /// The whole answer, where a protocol sends a copy of it with the event
    /// that closes the stream. It replaces the aggregate rather than adding to
    /// it, so a provider that sends both is not counted twice, and one that
    /// buffers and sends only this still produces an answer.
    pub(crate) complete: Option<String>,
    /// Totals, which some protocols send only with the last event.
    pub(crate) usage: Option<Usage>,
    /// Tool calls, or pieces of them. A provider that streams tools sends the
    /// name once and the arguments in fragments; what is executed is still the
    /// aggregate read at the end.
    pub(crate) tool_calls: Vec<ToolCallDelta>,
    /// Why the model stopped, when the event says so.
    pub(crate) finish_reason: Option<String>,
    /// The provider's own complaint, where the event carried one instead of a
    /// piece of the answer. A stream that has opened has no status left to
    /// refuse with, so some protocols say what went wrong here.
    pub(crate) failed: Option<String>,
}

/// Reads a server-sent stream: lines out of chunks, events out of lines.
///
/// Split out from the read loop so the parsing can be tested against bytes
/// rather than against a socket, and so a chunk that ends mid-line or mid-event
/// is held over instead of dropped.
struct SseReader<'a, F> {
    parse: &'a F,
    sink: &'a DeltaSink,
    remainder: Vec<u8>,
    data: Vec<String>,
    aggregate: String,
    usage: Option<Usage>,
    /// Tool calls as they are being put together, keyed by the position the
    /// provider gave them.
    calls: std::collections::BTreeMap<usize, PartialCall>,
    finish_reason: Option<String>,
    /// What the provider said instead of finishing the answer, where an event
    /// carried a complaint rather than a piece.
    failed: Option<String>,
    done: bool,
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

impl<'a, F> SseReader<'a, F>
where
    F: Fn(&serde_json::Value) -> StreamEvent,
{
    fn new(parse: &'a F, sink: &'a DeltaSink) -> Self {
        Self {
            parse,
            sink,
            remainder: Vec::new(),
            data: Vec::new(),
            aggregate: String::new(),
            usage: None,
            calls: std::collections::BTreeMap::new(),
            finish_reason: None,
            failed: None,
            done: false,
        }
    }

    fn feed(&mut self, chunk: &[u8]) {
        self.remainder.extend_from_slice(chunk);
        while let Some(newline) = self.remainder.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.remainder.drain(..=newline).collect();
            self.line(&String::from_utf8_lossy(&line));
        }
    }

    fn line(&mut self, line: &str) {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            self.event();
        } else if line.starts_with(':') {
            // A comment, which proxies send to keep the connection warm.
        } else if let Some(payload) = line.strip_prefix("data:") {
            self.data.push(payload.trim_start().to_string());
        }
        // `event:`, `id:`, and `retry:` say nothing about the answer.
    }

    /// Ends one event. Several `data:` lines belong to a single event, so they
    /// are joined before being parsed rather than parsed one at a time.
    fn event(&mut self) {
        if self.data.is_empty() {
            return;
        }
        let payload = self.data.join("\n");
        self.data.clear();
        if payload.trim() == STREAM_DONE {
            self.done = true;
            return;
        }
        // An event that is not JSON is a keep-alive from something sitting in
        // front of the provider; dropping it loses nothing the model said.
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload.trim()) {
            let event = (self.parse)(&value);
            // A complaint ends the stream: there is nothing more to read from
            // a provider that has said what went wrong.
            if let Some(failed) = event.failed {
                self.failed = Some(failed);
                self.done = true;
                return;
            }
            if let Some(text) = event.text {
                self.sink.push(&text);
                self.aggregate.push_str(&text);
            }
            if let Some(whole) = event.complete {
                self.aggregate = whole;
            }
            if event.usage.is_some() {
                self.usage = event.usage;
            }
            if event.finish_reason.is_some() {
                self.finish_reason = event.finish_reason;
            }
            for delta in event.tool_calls {
                let call = self.calls.entry(delta.index).or_default();
                if let Some(id) = delta.id.filter(|id| !id.is_empty()) {
                    call.id = id;
                }
                if let Some(name) = delta.name.filter(|name| !name.is_empty()) {
                    call.name = name;
                }
                if let Some(arguments) = delta.arguments_delta {
                    call.arguments.push_str(&arguments);
                }
            }
        }
    }

    /// Ends the stream. A provider that closes without a blank line after the
    /// last event still ends it here.
    fn finish(mut self) -> Result<GenerateResult, ProviderError> {
        self.event();
        if let Some(failed) = self.failed {
            return Err(ProviderError::Rejected(failed));
        }
        let tool_calls: Vec<ToolCall> = self
            .calls
            .into_values()
            .filter(|call| !call.name.is_empty())
            .map(|call| ToolCall {
                id: call.id,
                name: call.name,
                arguments: arguments_of(&call.arguments),
            })
            .collect();
        let finish_reason = if !tool_calls.is_empty()
            && self.finish_reason.as_deref() != Some("length")
        {
            // A provider that reports the end of a stream as `stop` has still
            // asked for tools; the calls are the reason the turn ended.
            Some("tool_calls".to_string())
        } else {
            self.finish_reason
        };
        Ok(GenerateResult {
            text: (!self.aggregate.is_empty()).then_some(self.aggregate),
            items: Vec::new(),
            usage: self.usage,
            tool_calls,
            finish_reason,
        })
    }
}

/// A streamed call's arguments, which travel as text fragments.
///
/// What arrives should be one JSON object; a model that wrote something else
/// is handed over as the text it wrote rather than dropped, so the caller can
/// report the failure with the model's own words.
fn arguments_of(raw: &str) -> serde_json::Value {
    let raw = raw.trim();
    if raw.is_empty() {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::Value::String(raw.to_string()))
}

/// An image item with its mime sniffed and its size read from the header.
///
/// Neither is taken from the request: a provider that answers in a format it
/// was not asked for is answering, and storing that under the requested mime
/// would produce an asset the canvas cannot open.
pub(crate) fn image_item(bytes: Vec<u8>) -> Result<GeneratedItem, ProviderError> {
    let mime = infer::get(&bytes)
        .map(|kind| kind.mime_type().to_string())
        .filter(|mime| mime.starts_with("image/"))
        .ok_or_else(|| {
            ProviderError::Rejected("the answer carried no recognisable image".to_string())
        })?;
    let (width, height) = dimensions(&bytes).unzip();
    Ok(GeneratedItem {
        bytes,
        mime,
        kind: Capability::Image,
        width,
        height,
        duration_ms: None,
    })
}

/// The size from the header alone: decoding a whole image to learn two numbers
/// would cost more than the request that produced it.
fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    reader.into_dimensions().ok()
}

/// An item whose bytes are the whole answer: audio and video, which arrive as
/// neither a document nor a field of one.
///
/// What the bytes are wins over what the provider called them, because a
/// container's name is not always one a file can be stored under. A success
/// that carried a different family is refused rather than stored: an asset that
/// cannot be played is worse than an error that says why.
pub(crate) fn media_item(
    bytes: Vec<u8>,
    claimed: Option<&str>,
    kind: Capability,
    fallback: &str,
) -> Result<GeneratedItem, ProviderError> {
    if bytes.is_empty() {
        return Err(ProviderError::NoOutput(format!(
            "the answer carried no {}",
            kind.as_str()
        )));
    }
    let named = infer::get(&bytes)
        .map(|sniffed| sniffed.mime_type().to_string())
        .or_else(|| claimed.map(str::to_string))
        .filter(|mime| mime != UNSPECIFIED_MIME);
    // Sound is two capabilities and one family: a line read aloud and a score
    // both come back as `audio/...`.
    let family = match kind {
        Capability::Speech | Capability::Music => "audio",
        other => other.as_str(),
    };
    let family = format!("{family}/");
    let mime = match named {
        Some(mime) if mime.starts_with(&family) => mime,
        Some(mime) => {
            return Err(ProviderError::Rejected(format!(
                "the answer was {mime}, not {}",
                kind.as_str()
            )))
        }
        None => fallback.to_string(),
    };
    Ok(GeneratedItem {
        bytes,
        mime,
        kind,
        width: None,
        height: None,
        duration_ms: None,
    })
}

fn transport(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout("the channel did not answer in time".to_string())
    } else if error.is_builder() {
        // A credential carrying a newline is a stored-value problem rather
        // than an outage, and saying so stops a client from retrying it.
        ProviderError::invalid(error.to_string())
    } else {
        // reqwest names the address and the reason here. Neither is secret:
        // credentials travel in headers, never in a URL.
        ProviderError::Unreachable(error.to_string())
    }
}

/// Maps a provider's answer onto a code the client can act on.
pub(crate) fn provider_error(reply: &Reply, api_key: &str) -> ProviderError {
    let explained = explain(reply.status, reply.text().unwrap_or_default(), api_key);
    match reply.status {
        401 | 403 => ProviderError::Auth(explained),
        429 => ProviderError::RateLimited {
            detail: explained,
            retry_after: reply.retry_after(),
        },
        // A 404 here nearly always means the address is wrong rather than
        // that a model is missing, which makes it something the user fixes.
        400 | 404 | 405 | 422 => ProviderError::Rejected(explained),
        _ => ProviderError::Unreachable(explained),
    }
}

/// Keeps the provider's own words — usually the only explanation that makes
/// sense — after lifting them out of the error envelope, cutting them down,
/// and removing any credential they echo back.
fn explain(status: u16, body: &str, api_key: &str) -> String {
    let text = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|payload| {
            // OpenAI-shaped envelopes nest the complaint under `error`;
            // Bailian says it in a `message` beside a `code`, at the top of
            // the body. Either way it is the provider's own explanation.
            payload
                .pointer("/error/message")
                .and_then(serde_json::Value::as_str)
                .or_else(|| payload.get("message").and_then(serde_json::Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.to_string());
    let detail = truncate(scrub(&text, api_key).trim());
    if detail.is_empty() {
        format!("status {status}")
    } else {
        format!("status {status}: {detail}")
    }
}

fn scrub(text: &str, api_key: &str) -> String {
    if api_key.chars().count() >= MIN_SCRUBBED_KEY_CHARS && text.contains(api_key) {
        text.replace(api_key, &crate::metadata::redact::masked(api_key))
    } else {
        text.to_string()
    }
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= MAX_DETAIL_CHARS {
        return text.to_string();
    }
    let mut shortened: String = text.chars().take(MAX_DETAIL_CHARS).collect();
    shortened.push('…');
    shortened
}

/// The scheme, host, and port of an address, which is what decides whether a
/// URL a provider handed back belongs to the channel that produced it.
fn origin_of(address: &str) -> Option<String> {
    let parsed = url::Url::parse(address).ok()?;
    Some(format!(
        "{}://{}{}",
        parsed.scheme(),
        parsed.host_str()?,
        parsed
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};

    /// A sink that records what it was shown, so a test can assert on the
    /// display as well as on the aggregate that gets stored.
    fn watching() -> (DeltaSink, Arc<Mutex<String>>) {
        let seen = Arc::new(Mutex::new(String::new()));
        let collected = Arc::clone(&seen);
        let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
            collected
                .lock()
                .expect("the sink is not held across a call")
                .push_str(chunk);
        }));
        (sink, seen)
    }

    fn shown(seen: &Arc<Mutex<String>>) -> String {
        seen.lock()
            .expect("the sink is not held across a call")
            .clone()
    }

    /// An event shape of the test's own: text under `delta`, a whole answer
    /// under `whole`, totals under `tokens`, a complaint under `complaint`.
    fn event(payload: &Value) -> StreamEvent {
        let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_string);
        StreamEvent {
            text: text("delta"),
            complete: text("whole"),
            failed: text("complaint"),
            usage: payload
                .get("tokens")
                .and_then(Value::as_u64)
                .map(|tokens| Usage {
                    input_tokens: Some(tokens),
                    output_tokens: None,
                    images: None,
                    seconds: None,
                }),
            ..StreamEvent::default()
        }
    }

    /// Reads a stream delivered in the chunks given, stopping where the reader
    /// would.
    fn read(chunks: &[&str]) -> (GenerateResult, String) {
        let (sink, seen) = watching();
        let mut reader = SseReader::new(&event, &sink);
        for chunk in chunks {
            if reader.done {
                break;
            }
            reader.feed(chunk.as_bytes());
        }
        (
            reader
                .finish()
                .expect("the stream ended without a complaint"),
            shown(&seen),
        )
    }

    fn event_with(payload: &str) -> String {
        format!("data: {payload}\n\n")
    }

    #[test]
    fn a_chunk_that_ends_midway_through_an_event_is_held_over() {
        // Neither the transport nor the provider has to break a stream at an
        // event boundary, and a reader that dropped the tail would lose words.
        let (result, seen) = read(&[
            r#"data: {"delt"#,
            r#"a":"Hello"}"#,
            "\n\n",
            &event_with(r#"{"delta":", world"}"#),
        ]);
        assert_eq!(result.text.as_deref(), Some("Hello, world"));
        assert_eq!(seen, "Hello, world");
    }

    #[test]
    fn the_sentinel_ends_a_stream_and_what_follows_is_not_read() {
        let (result, _) = read(&[
            &event_with(r#"{"delta":"one"}"#),
            &event_with(STREAM_DONE),
            &event_with(r#"{"delta":"two"}"#),
        ]);
        assert_eq!(result.text.as_deref(), Some("one"));
    }

    #[test]
    fn keep_alives_and_events_that_are_not_json_carry_nothing() {
        let (result, seen) = read(&[
            ": a proxy keeping the connection warm\n\n",
            "event: ping\ndata: still not json\n\n",
            &event_with(r#"{"delta":"the answer"}"#),
        ]);
        assert_eq!(result.text.as_deref(), Some("the answer"));
        assert_eq!(seen, "the answer");
    }

    #[test]
    fn several_data_lines_belong_to_one_event() {
        let (result, _) = read(&["data: {\"delta\":\ndata: \"split\"}\n\n"]);
        assert_eq!(result.text.as_deref(), Some("split"));
    }

    #[test]
    fn an_event_carrying_the_whole_answer_replaces_the_deltas() {
        // A provider that sends both must not be counted twice, and one that
        // buffers and sends only this must still produce an answer.
        let (result, seen) = read(&[
            &event_with(r#"{"delta":"a"}"#),
            &event_with(r#"{"delta":"b"}"#),
            &event_with(r#"{"whole":"ab"}"#),
        ]);
        assert_eq!(result.text.as_deref(), Some("ab"));
        assert_eq!(seen, "ab", "what was shown as it arrived is not changed");
    }

    #[test]
    fn a_stream_that_said_nothing_is_no_answer_rather_than_a_blank_one() {
        let (result, seen) = read(&[": nothing at all\n\n"]);
        assert_eq!(result.text, None);
        assert!(result.is_empty());
        assert!(seen.is_empty());
    }

    #[test]
    fn totals_arrive_with_the_event_that_reports_them() {
        let (result, _) = read(&[
            &event_with(r#"{"delta":"x"}"#),
            &event_with(r#"{"tokens":12}"#),
        ]);
        assert_eq!(result.usage.and_then(|usage| usage.input_tokens), Some(12));
    }

    #[test]
    fn an_event_that_complains_ends_the_stream_as_a_refusal() {
        // A stream that has opened has no status left to refuse with, so a
        // provider that fails halfway says so in an event. Reading that as an
        // answer would hand back a truncated one as though it were whole.
        let (sink, seen) = watching();
        let mut reader = SseReader::new(&event, &sink);
        reader.feed(event_with(r#"{"delta":"A lantern"}"#).as_bytes());
        assert!(!reader.done);
        reader.feed(event_with(r#"{"complaint":"the service is busy"}"#).as_bytes());
        assert!(reader.done, "there is nothing more to read from it");

        let error = reader.finish().expect_err("the stream was refused");
        assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
        assert!(error.to_string().contains("the service is busy"), "{error}");
        assert!(!error.retryable(), "the caller has already seen the pieces");
        assert_eq!(shown(&seen), "A lantern");
    }

    #[test]
    fn streamed_tool_call_fragments_are_put_back_together() {
        // Providers send a call's name once and its arguments in pieces; what
        // is executed is the whole call, read after the stream has ended.
        let parse = |payload: &Value| StreamEvent {
            tool_calls: payload
                .get("calls")
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .map(|call| ToolCallDelta {
                            index: call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize,
                            id: call.get("id").and_then(Value::as_str).map(str::to_string),
                            name: call.get("name").and_then(Value::as_str).map(str::to_string),
                            arguments_delta: call
                                .get("arguments")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            finish_reason: payload
                .get("finish")
                .and_then(Value::as_str)
                .map(str::to_string),
            ..StreamEvent::default()
        };
        let (sink, _) = watching();
        let mut reader = SseReader::new(&parse, &sink);
        for event in [
            r#"{"calls":[{"index":0,"id":"call_1","name":"clip.trim","arguments":"{\"timeli"}]}"#,
            r#"{"calls":[{"index":0,"arguments":"neId\":\"tl_1\"}"}]}"#,
            r#"{"calls":[{"index":1,"id":"call_2","name":"task.get","arguments":"{\"kind\":\"run\"}"}],"finish":"tool_calls"}"#,
        ] {
            reader.feed(event_with(event).as_bytes());
        }
        let result = reader.finish().expect("the stream ended");
        assert_eq!(result.tool_calls.len(), 2);
        assert_eq!(result.tool_calls[0].id, "call_1");
        assert_eq!(result.tool_calls[0].name, "clip.trim");
        assert_eq!(result.tool_calls[0].arguments["timelineId"], "tl_1");
        assert_eq!(result.tool_calls[1].name, "task.get");
        assert_eq!(result.finish_reason.as_deref(), Some("tool_calls"));
        assert!(result.text.is_none(), "no words were said");
        assert!(!result.is_empty(), "a pure tool call is an answer");
    }

    fn reply(status: u16, body: &str) -> Reply {
        Reply {
            status,
            headers: HeaderMap::new(),
            body: body.as_bytes().to_vec(),
        }
    }

    fn retry_after(value: &str) -> Reply {
        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::RETRY_AFTER,
            HeaderValue::from_str(value).expect("an ASCII header value"),
        );
        Reply {
            status: 429,
            headers,
            body: Vec::new(),
        }
    }

    #[test]
    fn a_status_maps_to_the_outcome_its_remedy_implies() {
        for (status, code, retryable) in [
            (401, "PROVIDER_AUTH", false),
            (403, "PROVIDER_AUTH", false),
            (429, "PROVIDER_RATE_LIMIT", true),
            (400, "PROVIDER_BAD_REQUEST", false),
            (404, "PROVIDER_BAD_REQUEST", false),
            (405, "PROVIDER_BAD_REQUEST", false),
            (422, "PROVIDER_BAD_REQUEST", false),
            (500, "PROVIDER_UNAVAILABLE", true),
            (503, "PROVIDER_UNAVAILABLE", true),
        ] {
            let error = provider_error(&reply(status, "{}"), "a-key");
            assert_eq!(error.code(), code, "status {status}");
            assert_eq!(error.retryable(), retryable, "status {status}");
        }
    }

    #[test]
    fn a_provider_explains_itself_through_its_own_envelope() {
        let body = r#"{"error":{"message":"that model is not on this key","type":"invalid"}}"#;
        let message = provider_error(&reply(403, body), "a-key").to_string();
        assert!(
            message.contains("that model is not on this key"),
            "{message}"
        );
        assert!(message.contains("status 403"), "{message}");

        // Bailian states the complaint at the top of the body, beside the code
        // that names it, rather than nesting it.
        let bailian =
            r#"{"code":"InvalidApiKey","message":"the key is not valid","request_id":"abc"}"#;
        let message = provider_error(&reply(401, bailian), "a-key").to_string();
        assert!(message.contains("the key is not valid"), "{message}");
        assert!(message.contains("status 401"), "{message}");
    }

    #[test]
    fn an_answer_that_is_not_json_is_quoted_as_it_arrived() {
        let message = provider_error(&reply(502, "<html>bad gateway</html>"), "a-key").to_string();
        assert!(message.contains("<html>bad gateway</html>"), "{message}");
    }

    #[test]
    fn an_answer_that_explains_nothing_still_names_its_status() {
        assert!(provider_error(&reply(500, ""), "a-key")
            .to_string()
            .contains("status 500"));
    }

    #[test]
    fn a_credential_echoed_back_is_masked_and_a_long_complaint_is_cut_down() {
        let key = "sk-a-very-long-test-credential";
        let body = format!(r#"{{"error":{{"message":"{key} {}"}}}}"#, "x".repeat(600));
        let message = provider_error(&reply(400, &body), key).to_string();
        assert!(!message.contains(key), "{message}");
        assert!(message.contains("sk-…tial"), "{message}");
        assert!(
            message.chars().count() < 400,
            "the complaint was not cut down: {message}"
        );
    }

    #[test]
    fn a_wait_measured_in_seconds_is_the_one_the_provider_asked_for() {
        match provider_error(&retry_after("7"), "a-key") {
            ProviderError::RateLimited { retry_after, .. } => {
                assert_eq!(retry_after, Some(Duration::from_secs(7)))
            }
            other => panic!("expected a rate limit, got {other}"),
        }
    }

    #[test]
    fn a_wait_given_as_a_date_is_left_to_the_backoff() {
        // A clock that disagrees with the provider's would turn a date into a
        // wait of the wrong length, and the backoff already covers being busy.
        match provider_error(&retry_after("Wed, 21 Oct 2026 07:28:00 GMT"), "a-key") {
            ProviderError::RateLimited { retry_after, .. } => assert_eq!(retry_after, None),
            other => panic!("expected a rate limit, got {other}"),
        }
    }

    #[test]
    fn an_origin_says_whether_an_address_belongs_to_the_model() {
        assert_eq!(
            origin_of("https://api.example.com/v1/images").as_deref(),
            Some("https://api.example.com")
        );
        assert_eq!(
            origin_of("http://127.0.0.1:8787/v1").as_deref(),
            Some("http://127.0.0.1:8787")
        );
        // A port that is the scheme's default is not part of the origin, so two
        // spellings of one host still match.
        assert_eq!(
            origin_of("https://api.example.com:443/v1").as_deref(),
            Some("https://api.example.com")
        );
        assert_eq!(origin_of("not a url"), None);
    }

    /// A protocol's name is its whole identity, and what a name reaches is the
    /// one scripted adapter: the shapes this program once implemented itself —
    /// the Gemini and Bailian ones among them — are converters like any other,
    /// and a name nothing was written for is looked for by that same adapter,
    /// which is what can say no script was found.
    #[test]
    fn every_protocol_routes_to_the_adapter_of_its_family() {
        let scripted = for_protocol(Protocol::from_wire_name("openaiChat"));
        for name in [
            "openaiResponses",
            "openaiImages",
            "openaiSpeech",
            "openaiVideos",
            "gemini",
            "geminiVideo",
            "bailianText",
            "bailianImage",
            "bailianSpeech",
            "bailianMusic",
            "bailianVideo",
            "bailianAsr",
            // Nothing serves these names: the adapter is what goes looking and
            // says which converter was missing.
            "custom",
            "aProtocolNobodyHasHeardOf",
        ] {
            assert!(
                std::ptr::eq(scripted, for_protocol(Protocol::from_wire_name(name))),
                "{name}"
            );
        }
    }

    /// A real encoded image, so a test can assert on what sniffing and the
    /// header read find rather than on a mime somebody claimed.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let picture = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([12, 34, 56, 255]),
        ));
        let mut encoded = Vec::new();
        picture
            .write_to(
                &mut std::io::Cursor::new(&mut encoded),
                image::ImageFormat::Png,
            )
            .expect("a png encodes");
        encoded
    }

    #[test]
    fn an_image_is_read_from_its_bytes_rather_than_from_the_request() {
        // A provider that answers in a format it was not asked for is still
        // answering, and storing that under the requested mime would produce an
        // asset the canvas cannot open.
        let item = image_item(png(3, 2)).expect("the bytes are an image");
        assert_eq!(item.mime, "image/png");
        assert_eq!(item.kind, Capability::Image);
        assert_eq!((item.width, item.height), (Some(3), Some(2)));

        let error = image_item(b"<html>not an image</html>".to_vec())
            .expect_err("the bytes are not an image");
        assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
        assert!(!error.retryable(), "{error} will not improve on a retry");
    }

    #[test]
    fn media_is_named_by_what_it_is_rather_than_by_what_it_arrived_as() {
        // The header of a wave file, which is what the bytes are however a
        // provider spells the container it put them in.
        let bytes = b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec();
        let item = media_item(
            bytes,
            Some("audio/L16;codec=pcm"),
            Capability::Speech,
            "audio/mpeg",
        )
        .expect("the bytes are audio");
        assert_eq!(item.mime, "audio/x-wav");
        assert_eq!(item.kind, Capability::Speech);

        // Nothing recognised and nothing claimed: the answer is stored as the
        // mime such media usually arrives under, rather than refused.
        let item = media_item(vec![1, 2, 3], None, Capability::Video, "video/mp4")
            .expect("the bytes are kept");
        assert_eq!(item.mime, "video/mp4");

        // A mime that says nothing is the same as no mime at all.
        let item = media_item(
            vec![1, 2, 3],
            Some(UNSPECIFIED_MIME),
            Capability::Speech,
            "audio/mpeg",
        )
        .expect("the bytes are kept");
        assert_eq!(item.mime, "audio/mpeg");
    }

    #[test]
    fn a_success_that_carried_something_else_is_refused_rather_than_stored() {
        // Storing it would produce an asset that cannot be played, and the
        // provider's own complaint would never be read.
        let error = media_item(
            br#"{"error":{"message":"that voice is not on this key"}}"#.to_vec(),
            Some("application/json"),
            Capability::Speech,
            "audio/mpeg",
        )
        .expect_err("the answer is not audio");
        assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
        assert!(error.to_string().contains("application/json"), "{error}");
        assert!(!error.retryable(), "{error} will not improve on a retry");
    }

    #[test]
    fn an_answer_with_no_bytes_carried_no_media() {
        let error = media_item(
            Vec::new(),
            Some("audio/mpeg"),
            Capability::Speech,
            "audio/mpeg",
        )
        .expect_err("there is nothing to store");
        assert_eq!(error.code(), "PROVIDER_NO_OUTPUT");
    }
}
