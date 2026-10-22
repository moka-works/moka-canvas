//! One model step for the in-app agent.
//!
//! The server owns the prompt, the context summary, and the tool protocol; the
//! interface owns the loop, the approvals, and the document adoption. That
//! split is what lets the same tools serve a CLI or an MCP client without a
//! browser, while the app keeps the context only a browser has.
//!
//! A chat step never writes the document and never runs a tool. It reads the
//! project, asks a model what to do, and streams the answer and any tool calls
//! back. The caller then executes them through `/agent/tools/{name}`.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::io::ReaderStream;

use crate::api::problem::{status_for_code, Problem};
use crate::api::{ApiState, ProjectSession};
use crate::domain::Capability;
use crate::generate::{Cancel, ChatMessage, DeltaSink, GenerateRequest};
use crate::project::ProjectStore;

use super::catalog::{catalog, ToolSurface};
use super::context::{chat_context, AgentScope};
use super::prompt::{context_line, system_prompt};
use super::protocol;

/// Long enough for a large tool-rich system prompt and a normal conversation,
/// short enough that a client cannot make one step cost unboundedly.
const MAX_MESSAGES: usize = 60;
const MAX_MESSAGE_CHARS: usize = 16_000;
const STREAM_BUFFER_BYTES: usize = 64 * 1024;
/// How much of a fallback conversation is folded into one prompt. A model
/// with no native tool channel reads the transcript as text, and the whole of
/// a long session does not fit any context; the recent part is what a step
/// acts on.
const MAX_FALLBACK_CHARS: usize = 48_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub scope: AgentScope,
    #[serde(default)]
    pub packs: Vec<String>,
    #[serde(default)]
    pub client_tools: Vec<String>,
    pub catalog_hash: String,
    #[serde(default)]
    pub messages: Vec<ChatTurn>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub protocol: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tool_calls: Vec<ChatTurnCall>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

/// `POST /api/v1/agent/chat`
pub async fn chat(
    State(state): State<ApiState>,
    session: ProjectSession,
    axum::Json(request): axum::Json<ChatRequest>,
) -> Response {
    match prepare(&state, &session, &request).await {
        Ok(prepared) => stream_chat(state, session, request, prepared),
        Err(problem) => problem.into_response(),
    }
}

struct Prepared {
    tools: Vec<super::catalog::ToolSpec>,
    fallback: bool,
    model: String,
    context: Value,
    warnings: Vec<String>,
    revision: i32,
    toolset_hash: String,
    catalog_hash: String,
    messages: Vec<ChatMessage>,
    system: String,
    fallback_prompt: String,
}

fn problem(code: &str, message: impl Into<String>) -> Problem {
    Problem::new(status_for_code(code), code, message)
}

async fn prepare(
    state: &ApiState,
    session: &ProjectSession,
    request: &ChatRequest,
) -> Result<Prepared, Problem> {
    let catalog = catalog();
    let catalog_hash = catalog.hash();
    if request.catalog_hash.trim().is_empty() || request.catalog_hash != catalog_hash {
        return Err(problem(
            "TOOLS_VERSION_MISMATCH",
            format!(
                "The catalog is {}, but the request was built against {}; refresh the tool list and retry",
                catalog_hash, request.catalog_hash
            ),
        ));
    }
    if !request.scope.valid_room() {
        return Err(problem(
            "VALIDATION_FAILED",
            format!("unknown room '{}'", request.scope.room),
        ));
    }
    if request.messages.len() > MAX_MESSAGES {
        return Err(problem(
            "VALIDATION_FAILED",
            format!("a chat step carries at most {MAX_MESSAGES} messages"),
        ));
    }
    let opened = session
        .0
        .current()
        .await
        .map_err(Problem::from)?
        .ok_or_else(|| problem("PROJECT_NOT_OPEN", "No project is open"))?;

    let mut packs = if request.packs.is_empty() {
        super::catalog::default_packs(&request.scope.room)
    } else {
        request.packs.clone()
    };
    if !packs.iter().any(|pack| pack == "core") {
        packs.push("core".into());
    }
    let known = super::catalog::packs()
        .into_iter()
        .map(|pack| pack.name)
        .collect::<Vec<_>>();
    if let Some(unknown) = packs.iter().find(|pack| !known.contains(pack)) {
        return Err(problem(
            "VALIDATION_FAILED",
            format!("unknown tool pack '{unknown}'"),
        ));
    }
    let mut client_tools = request.client_tools.clone();
    if client_tools.iter().any(|name| {
        catalog
            .find(name)
            .map(|tool| tool.surface != ToolSurface::App)
            .unwrap_or(true)
    }) {
        return Err(problem(
            "VALIDATION_FAILED",
            "clientTools may only name app tools from the catalog",
        ));
    }
    client_tools.sort();
    client_tools.dedup();

    let tools: Vec<super::catalog::ToolSpec> = catalog
        .for_chat(&packs, &client_tools)
        .into_iter()
        .cloned()
        .collect();
    if tools.is_empty() {
        return Err(problem(
            "VALIDATION_FAILED",
            "this room has no tools to offer the model",
        ));
    }

    let model = request
        .model
        .clone()
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_default();
    let resolved = if model.trim().is_empty() {
        state
            .models
            .resolve_default(Capability::Text)
            .await
            .map_err(Problem::from)?
    } else {
        state
            .models
            .resolve(&model, Capability::Text)
            .await
            .map_err(Problem::from)?
    };
    // What a converter declares about itself decides the protocol, not its
    // name: a script that maps tools says so, and one that does not is not
    // asked to pretend. A converter deployed by an older build declares
    // nothing and therefore falls back rather than being sent fields it
    // would ignore.
    let fallback = !crate::converter::ConverterRegistry::load(state.converter_root())
        .find(resolved.protocol.wire_name())
        .and_then(|entry| entry.features.get("toolCalling").copied())
        .unwrap_or(false);

    let context = chat_context(&opened.moka, &request.scope, 0);
    let system = system_prompt(
        &request.scope,
        &context,
        &tools,
        fallback,
        request.locale.as_deref().unwrap_or("en"),
    );

    let mut conversation = Vec::with_capacity(request.messages.len());
    for turn in &request.messages {
        if !matches!(turn.role.as_str(), "user" | "assistant" | "tool") {
            return Err(problem(
                "VALIDATION_FAILED",
                format!("unknown message role '{}'", turn.role),
            ));
        }
        if turn.text.chars().count() > MAX_MESSAGE_CHARS {
            return Err(problem(
                "VALIDATION_FAILED",
                "a message is longer than 16000 characters",
            ));
        }
        conversation.push(ChatMessage {
            role: turn.role.clone(),
            text: turn.text.clone(),
            tool_calls: turn
                .tool_calls
                .iter()
                .map(|call| crate::generate::ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                })
                .collect(),
            tool_call_id: turn.tool_call_id.clone(),
            name: turn.name.clone(),
        });
    }

    // A converter without native tools reads `prompt`, not `messages`: the
    // conversation is folded into one transcript rather than sent as roles it
    // would ignore, and the system prompt travels in its own field.
    let fallback_prompt = if fallback {
        flatten_conversation(&conversation)
    } else {
        String::new()
    };
    let mut messages = Vec::new();
    if !fallback {
        messages.push(ChatMessage::text("system", system.clone()));
        messages.extend(conversation);
    }

    let toolset_hash = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        for tool in &tools {
            hasher.update(tool.name.as_bytes());
        }
        format!("sha256:{}", hex::encode(hasher.finalize()))
    };
    let warnings = context["warnings"]
        .as_array()
        .map(|warnings| {
            warnings
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let revision = opened.moka.metadata.revision;
    Ok(Prepared {
        tools,
        fallback,
        model: model.clone(),
        context,
        warnings,
        revision,
        toolset_hash,
        catalog_hash,
        messages,
        system,
        fallback_prompt,
    })
}

/// The conversation as one document a converter can send as a prompt.
fn flatten_conversation(messages: &[ChatMessage]) -> String {
    let mut out = String::new();
    for message in messages {
        let part = match message.role.as_str() {
            "user" => format!("USER:\n{}\n\n", message.text),
            "assistant" => {
                let mut said = String::new();
                if !message.text.trim().is_empty() {
                    said.push_str(&format!("ASSISTANT:\n{}\n\n", message.text));
                }
                for call in &message.tool_calls {
                    said.push_str(&format!(
                        "ASSISTANT CALLED {} WITH {}\n\n",
                        call.name,
                        serde_json::to_string(&call.arguments).unwrap_or_default()
                    ));
                }
                said
            }
            "tool" => format!(
                "TOOL {} RESULT:\n{}\n\n",
                message.name.as_deref().unwrap_or(""),
                message.text
            ),
            _ => String::new(),
        };
        if out.chars().count() + part.chars().count() > MAX_FALLBACK_CHARS {
            // Keep the newest part whole when it alone overflows; otherwise
            // stop rather than cut a turn in half.
            if out.is_empty() {
                out.extend(part.chars().take(MAX_FALLBACK_CHARS));
            }
            break;
        }
        out.push_str(&part);
    }
    out
}

fn stream_chat(
    state: ApiState,
    _session: ProjectSession,
    request: ChatRequest,
    prepared: Prepared,
) -> Response {
    let (mut writer, reader) = tokio::io::duplex(STREAM_BUFFER_BYTES);
    let (deltas, mut received) = mpsc::unbounded_channel::<String>();
    // A fallback answer is protocol JSON until it is parsed; showing it
    // piece by piece would put `{"thought":...` in the conversation. The
    // provider is still asked for a stream, and the pieces are dropped until
    // the whole object can be read.
    let sink = if prepared.fallback {
        DeltaSink::unwatched()
    } else {
        DeltaSink::new(Arc::new(move |chunk: &str| {
            let _ = deltas.send(chunk.to_string());
        }))
    };
    let cancel = Cancel::new();
    let watching = cancel.clone();
    let gateway = Arc::clone(&state.gateway);

    tokio::spawn(async move {
        let line = context_line(&request.scope, &prepared.context);
        let context_event = json!({
            "summary": line,
            "revision": prepared.revision,
            "warnings": prepared.warnings,
        });
        if frame(&mut writer, "context", &context_event).await.is_err() {
            return;
        }

        let mut generate = GenerateRequest {
            capability: Capability::Text,
            model: prepared.model.clone(),
            messages: prepared.messages.clone(),
            ..GenerateRequest::default()
        };
        if prepared.fallback {
            generate.prompt = prepared.fallback_prompt.clone();
            generate.system = Some(prepared.system.clone());
            generate.messages.clear();
        } else {
            generate.tools = prepared.tools.iter().map(|tool| tool.model_def()).collect();
            generate.tool_choice = Some("auto".into());
        }

        let mut pending = Box::pin(gateway.text(&_session.0, generate, &sink, &watching));
        let outcome = loop {
            tokio::select! {
                Some(chunk) = received.recv() => {
                    if frame(&mut writer, "text", &json!({ "delta": chunk })).await.is_err() {
                        watching.cancel();
                        return;
                    }
                }
                answered = &mut pending => break answered,
            }
        };
        drop(pending);
        drop(sink);
        while let Some(chunk) = received.recv().await {
            if frame(&mut writer, "text", &json!({ "delta": chunk }))
                .await
                .is_err()
            {
                return;
            }
        }

        match outcome {
            Ok(result) => {
                let mut text = result.text.unwrap_or_default();
                let mut calls: Vec<Value> = result
                    .tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "name": call.name,
                            "arguments": call.arguments,
                        })
                    })
                    .collect();
                // A provider with no native tool channel answers with the
                // JSON protocol; one step is read out of the words and the
                // rest of the text is what the model wanted to say.
                if calls.is_empty() && prepared.fallback {
                    if let Some(step) = protocol::parse(&text) {
                        if !step.tools.is_empty() {
                            for call in step.tools {
                                calls.push(json!({
                                    "id": format!("call_{}", uuid::Uuid::now_v7()),
                                    "name": call.name,
                                    "arguments": call.input,
                                }));
                            }
                            text = step.thought.unwrap_or_default();
                        } else if let Some(answer) = step.answer {
                            text = answer;
                        }
                    } else if text.trim_start().starts_with('{') {
                        // A fallback step that looks like protocol JSON but
                        // cannot be read is a failed step, not an answer; the
                        // loop reports the empty answer rather than showing
                        // the protocol as prose.
                        text.clear();
                    }
                }
                for call in &calls {
                    if frame(&mut writer, "tool_call", call).await.is_err() {
                        return;
                    }
                }
                let done = json!({
                    "text": text,
                    "toolCalls": calls,
                    "usage": result.usage,
                    "protocol": if prepared.fallback { "json" } else { "native" },
                    "stopReason": result.finish_reason,
                    "toolsetHash": prepared.toolset_hash,
                    "catalogHash": prepared.catalog_hash,
                });
                let _ = frame(&mut writer, "done", &done).await;
            }
            Err(error) => {
                let mut failure = json!({
                    "code": error.code(),
                    "message": error.to_string(),
                    "retryable": error.retryable(),
                });
                if let Some(details) = error.details() {
                    failure["details"] = details;
                }
                let _ = frame(&mut writer, "error", &failure).await;
            }
        }
    });

    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(ReaderStream::new(reader)),
    )
        .into_response()
}

async fn frame(
    writer: &mut tokio::io::DuplexStream,
    event: &str,
    data: &Value,
) -> std::io::Result<()> {
    let payload = serde_json::to_string(data).unwrap_or_else(|_| "{}".into());
    writer
        .write_all(format!("event: {event}\ndata: {payload}\n\n").as_bytes())
        .await?;
    writer.flush().await
}

/// `GET /api/v1/agent/context`
pub async fn get_context(
    State(_state): State<ApiState>,
    session: ProjectSession,
    axum::extract::Query(query): axum::extract::Query<ContextQuery>,
) -> Result<axum::Json<Value>, Problem> {
    let opened = session
        .0
        .current()
        .await
        .map_err(Problem::from)?
        .ok_or_else(|| problem("PROJECT_NOT_OPEN", "No project is open"))?;
    let scope = AgentScope {
        room: query.room.unwrap_or_else(|| "canvas".into()),
        canvas_id: query.canvas_id,
        timeline_id: query.timeline_id,
        asset_id: query.asset_id,
        story_id: query.story_id,
        ..AgentScope::default()
    };
    if !scope.valid_room() {
        return Err(problem("VALIDATION_FAILED", "unknown room"));
    }
    Ok(axum::Json(chat_context(&opened.moka, &scope, 0)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextQuery {
    room: Option<String>,
    canvas_id: Option<String>,
    timeline_id: Option<String>,
    asset_id: Option<String>,
    story_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_carries_the_catalog_it_was_built_against() {
        let request: ChatRequest = serde_json::from_value(json!({
            "catalogHash": "sha256:abc",
            "scope": {"room": "clip", "timelineId": "tl_1", "clipIds": ["cl_1"]},
            "messages": [{"role": "user", "text": "trim it"}],
        }))
        .expect("a chat request decodes");
        assert_eq!(request.catalog_hash, "sha256:abc");
        assert_eq!(request.scope.room, "clip");
        assert_eq!(request.scope.clip_ids, ["cl_1"]);
        assert!(request.messages[0].tool_calls.is_empty());
    }

    #[test]
    fn a_fallback_transcript_carries_calls_and_results_as_text() {
        let call = crate::generate::ToolCall {
            id: "call_1".into(),
            name: "canvas.list".into(),
            arguments: serde_json::json!({}),
        };
        let prompt = flatten_conversation(&[
            ChatMessage::text("user", "add a note"),
            ChatMessage::assistant_calls(vec![call.clone()]),
            ChatMessage::tool_result(&call, r#"{"ok":true,"data":{"canvases":[]}}"#),
        ]);
        assert!(prompt.contains("USER:\nadd a note"));
        assert!(prompt.contains("ASSISTANT CALLED canvas.list"));
        assert!(prompt.contains("TOOL canvas.list RESULT:"));
        assert!(prompt.contains("\"ok\":true"));
    }

    #[test]
    fn a_scope_must_name_a_room_we_know() {
        let scope = AgentScope {
            room: "settings".into(),
            ..AgentScope::default()
        };
        assert!(!scope.valid_room());
    }
}
