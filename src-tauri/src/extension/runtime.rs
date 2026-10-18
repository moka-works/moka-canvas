//! The sandbox one extension step's Lua runs in.
//!
//! A fresh Lua state per step, with no `os`, `io`, `package`, `debug`, file
//! loading or network. A script may read the inputs and parameters the host
//! put in front of it, call the model handles the host made for it, write log
//! lines and report progress — and hand back a table of outputs. Everything
//! else is the host's: the bytes, the credentials, the addresses, the clock
//! and the disk.
//!
//! Model calls look synchronous to the script. The executor hands this module
//! a caller that runs on the same blocking thread and knows how to reach the
//! async gateway, so the script writes one statement after another while the
//! host does the waiting.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use mlua::{HookTriggers, Lua, Table, Value, Variadic, VmState};
use serde_json::Value as Json;

use crate::converter::runtime::{json_to_lua, table_to_json};
use crate::domain::{now_iso, Capability, ExtensionLogRecord};

use super::manifest::NodeDefinition;

/// The hard bounds the host keeps whatever a definition says. These are not
/// settings: a script that needs more is a script that has outgrown a canvas
/// step.
const INSTRUCTION_BUDGET: u64 = 5_000_000;
const HOOK_INTERVAL: u64 = 50_000;
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
/// How large a value `json`/`base64` may carry in or out.
const HELPER_BYTES: usize = 1024 * 1024;

/// One piece of media a model answered with, already filed in the project.
#[derive(Debug, Clone, Default)]
pub struct ModelItem {
    pub kind: String,
    pub mime: String,
    pub asset_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
}

/// What one model call answered.
#[derive(Debug, Clone, Default)]
pub struct ModelAnswer {
    pub text: Option<String>,
    pub items: Vec<ModelItem>,
    pub usage: Json,
}

/// One call a script asked a model handle to make.
#[derive(Debug, Clone)]
pub struct ModelCall {
    pub slot: String,
    pub capability: Capability,
    pub prompt: String,
    pub system: Option<String>,
    pub params: Json,
    pub inputs: Vec<Json>,
}

/// Why a model call did not answer.
#[derive(Debug, Clone)]
pub struct ModelError {
    pub code: String,
    pub message: String,
    pub details: Json,
    pub retryable: bool,
    pub cancelled: bool,
    pub timed_out: bool,
}

impl ModelError {
    pub fn script(message: impl Into<String>) -> Self {
        Self {
            code: "EXTENSION_SCRIPT_FAILED".into(),
            message: message.into(),
            details: Json::Null,
            retryable: false,
            cancelled: false,
            timed_out: false,
        }
    }
}

pub type ModelCaller = Arc<dyn Fn(ModelCall) -> Result<ModelAnswer, ModelError> + Send + Sync>;

/// What the definition's slots look like from inside the script: no model
/// configuration id, no address, no credential — the slot's name and the
/// bound model's display name, for logs.
#[derive(Debug, Clone)]
pub struct ModelHandleInfo {
    pub capability: Capability,
    pub label: String,
    pub model_name: String,
}

type LiveLog = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Where an extension's log lines go, and what it is allowed to keep.
pub struct LogWriter {
    max_bytes: usize,
    used: AtomicUsize,
    truncated: AtomicBool,
    live: Option<LiveLog>,
    entries: Mutex<Vec<ExtensionLogRecord>>,
}

impl LogWriter {
    pub fn new(max_bytes: usize, live: Option<LiveLog>) -> Self {
        Self {
            max_bytes,
            used: AtomicUsize::new(0),
            truncated: AtomicBool::new(false),
            live,
            entries: Mutex::new(Vec::new()),
        }
    }

    pub fn push(&self, level: &str, message: &str) {
        let level = match level {
            "debug" | "info" | "warn" | "error" => level,
            _ => "info",
        };
        let mut text = message.replace(['\r', '\n'], " ");
        if text.len() > 4_000 {
            truncate_utf8(&mut text, 4_000);
            text.push('…');
        }
        let mut entries = self.entries.lock().expect("log buffer poisoned");
        if self.truncated.load(Ordering::SeqCst) {
            return;
        }
        let used = self.used.load(Ordering::SeqCst);
        if used + text.len() > self.max_bytes {
            let room = self.max_bytes.saturating_sub(used);
            let mut cut = text;
            let cut_to = room.min(cut.len());
            truncate_utf8(&mut cut, cut_to);
            if !cut.is_empty() {
                entries.push(ExtensionLogRecord {
                    level: level.to_string(),
                    message: cut,
                    at: now_iso(),
                });
                if let Some(live) = &self.live {
                    live(level, message);
                }
            }
            entries.push(ExtensionLogRecord {
                level: "warn".to_string(),
                message: "log truncated: the definition's log limit was reached".to_string(),
                at: now_iso(),
            });
            self.truncated.store(true, Ordering::SeqCst);
            self.used.store(self.max_bytes, Ordering::SeqCst);
            return;
        }
        self.used.store(used + text.len(), Ordering::SeqCst);
        entries.push(ExtensionLogRecord {
            level: level.to_string(),
            message: text,
            at: now_iso(),
        });
        if let Some(live) = &self.live {
            live(level, message);
        }
    }

    /// The lines written so far. A snapshot rather than a drain, because the
    /// Lua state still holds callbacks that point at this writer when the
    /// script returns.
    pub fn snapshot(&self) -> Vec<ExtensionLogRecord> {
        self.entries.lock().expect("log buffer poisoned").clone()
    }

    #[cfg(test)]
    pub fn finish(self) -> Vec<ExtensionLogRecord> {
        self.entries.into_inner().unwrap_or_default()
    }
}

/// Cuts a string at a byte position that is a character boundary.
fn truncate_utf8(text: &mut String, at: usize) {
    if at >= text.len() {
        return;
    }
    let mut end = at;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

/// One stop signal shared by the hook, the model calls and the executor.
pub struct StepControl {
    cancelled: AtomicBool,
    /// The gateway's own cancel flag for this run. A user pressing stop flips
    /// it, and the instruction hook has to see that without waiting for a
    /// model call to notice.
    cancel: Option<crate::generate::Cancel>,
    timeout: Duration,
    deadline: Instant,
    instructions: AtomicU64,
    abort: Mutex<Option<Failure>>,
    /// The last error a model handle handed back. A Lua error object that is a
    /// table reaches Rust as `table: 0x...`, so the structured failure is kept
    /// beside it for the case where the script did not catch it.
    last_error: Mutex<Option<Failure>>,
}

/// What stopped a step, in the words the runner records.
#[derive(Debug, Clone)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub details: Json,
    pub cancelled: bool,
}

impl StepControl {
    pub fn new(timeout: Duration, cancel: Option<crate::generate::Cancel>) -> Arc<Self> {
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
            cancel,
            timeout,
            deadline: Instant::now() + timeout,
            instructions: AtomicU64::new(0),
            abort: Mutex::new(None),
            last_error: Mutex::new(None),
        })
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.record(Failure {
            code: "EXTENSION_CANCELLED".into(),
            message: "the run was cancelled".into(),
            details: Json::Null,
            cancelled: true,
        });
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
            || self
                .cancel
                .as_ref()
                .is_some_and(crate::generate::Cancel::is_cancelled)
    }

    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    pub fn timed_out(&self) -> bool {
        Instant::now() >= self.deadline
    }

    pub fn failure(&self) -> Option<Failure> {
        self.abort.lock().expect("step control poisoned").clone()
    }

    fn note_error(&self, failure: Failure) {
        *self.last_error.lock().expect("step control poisoned") = Some(failure);
    }

    fn clear_last_error(&self) {
        *self.last_error.lock().expect("step control poisoned") = None;
    }

    fn last_error(&self) -> Option<Failure> {
        self.last_error
            .lock()
            .expect("step control poisoned")
            .clone()
    }

    fn record(&self, failure: Failure) {
        let mut abort = self.abort.lock().expect("step control poisoned");
        if abort.is_none() {
            *abort = Some(failure);
        }
    }

    fn hook(&self) -> mlua::Result<VmState> {
        if self.is_cancelled() {
            self.record(Failure {
                code: "EXTENSION_CANCELLED".into(),
                message: "the run was cancelled".into(),
                details: Json::Null,
                cancelled: true,
            });
            return Err(mlua::Error::RuntimeError(
                "the run was cancelled".to_string(),
            ));
        }
        if Instant::now() >= self.deadline {
            self.record(Failure {
                code: "EXTENSION_TIMEOUT".into(),
                message: "the step exceeded its time limit".into(),
                details: serde_json::json!({ "timeoutSeconds": self.timeout.as_secs() }),
                cancelled: false,
            });
            return Err(mlua::Error::RuntimeError(
                "the step exceeded its time limit".to_string(),
            ));
        }
        let spent = self.instructions.fetch_add(HOOK_INTERVAL, Ordering::SeqCst) + HOOK_INTERVAL;
        if spent > INSTRUCTION_BUDGET {
            self.record(Failure {
                code: "EXTENSION_LIMIT_EXCEEDED".into(),
                message: format!("the script used more than {INSTRUCTION_BUDGET} instructions"),
                details: serde_json::json!({ "instructionBudget": INSTRUCTION_BUDGET }),
                cancelled: false,
            });
            return Err(mlua::Error::RuntimeError(
                "the script exceeded its instruction budget".to_string(),
            ));
        }
        Ok(VmState::Continue)
    }

    fn check(&self) -> mlua::Result<()> {
        if let Some(failure) = self.failure() {
            return Err(mlua::Error::RuntimeError(failure.message));
        }
        self.hook().map(|_| ())
    }
}

/// Everything a script sees, as the host arranged it.
pub struct ScriptContext {
    pub definition: Arc<NodeDefinition>,
    pub node_id: String,
    pub node_title: String,
    /// port id → the values that arrived, as the Lua input shape.
    pub inputs: Json,
    pub params: Json,
    pub models: BTreeMap<String, ModelHandleInfo>,
    pub caller: ModelCaller,
    pub logs: Arc<LogWriter>,
    pub progress: Arc<dyn Fn(f64) + Send + Sync>,
    pub control: Arc<StepControl>,
}

/// What a script handed back.
#[derive(Debug)]
pub struct ScriptOutcome {
    pub value: Json,
    pub logs: Vec<ExtensionLogRecord>,
}

/// Runs one definition's `validate` (if it has one) and then its `run`.
#[allow(clippy::result_large_err)]
pub fn execute(context: ScriptContext) -> Result<ScriptOutcome, Failure> {
    let lua = Lua::new();
    sandbox(&lua);

    if let Err(error) = lua.set_memory_limit(MEMORY_LIMIT) {
        return Err(Failure {
            code: "EXTENSION_LIMIT_EXCEEDED".into(),
            message: format!("the script's memory limit could not be set: {error}"),
            details: Json::Null,
            cancelled: false,
        });
    }
    {
        let control = Arc::clone(&context.control);
        lua.set_hook(
            HookTriggers::new().every_nth_instruction(HOOK_INTERVAL as u32),
            move |_lua, _debug| control.hook(),
        );
    }

    if let Err(error) = register_helpers(&lua, &context) {
        return Err(script_failure(&context, error));
    }
    if let Err(error) = register_require(&lua, &context.definition) {
        return Err(script_failure(&context, error));
    }
    if let Err(error) = lua
        .load(&context.definition.entry_source)
        .set_name(&context.definition.script)
        .exec()
    {
        return Err(script_failure(&context, error));
    }

    let ctx = match build_ctx(&lua, &context) {
        Ok(table) => table,
        Err(error) => return Err(script_failure(&context, error)),
    };

    let phase_validate = Arc::new(AtomicBool::new(true));
    // The model handles need to know which phase they were made for, so they
    // are registered after the context that holds them.
    if let Err(error) = register_model_handles(&lua, &context, &phase_validate, &ctx) {
        return Err(script_failure(&context, error));
    }

    if let Ok(Value::Function(validate)) = lua.globals().get::<Value>("validate") {
        if let Err(error) = validate.call::<Value>(ctx.clone()) {
            return Err(abort_or_script(&context, error));
        }
    }
    phase_validate.store(false, Ordering::SeqCst);

    let run: Value = match lua.globals().get("run") {
        Ok(Value::Function(run)) => Value::Function(run),
        Ok(_) => {
            return Err(Failure {
                code: "EXTENSION_SCRIPT_FAILED".into(),
                message: "the definition's script has no run function".into(),
                details: Json::Null,
                cancelled: false,
            })
        }
        Err(error) => return Err(script_failure(&context, error)),
    };
    let Value::Function(run) = run else {
        unreachable!("checked above");
    };
    let value = match run.call::<Value>(ctx) {
        Ok(value) => table_to_json(&value),
        Err(error) => return Err(abort_or_script(&context, error)),
    };
    if let Some(failure) = context.control.failure() {
        return Err(failure);
    }
    // A script that swallowed a cancellation or reached its deadline without
    // the hook firing is still a step the run gave up on.
    if context.control.is_cancelled() {
        return Err(Failure {
            code: "EXTENSION_CANCELLED".into(),
            message: "the run was cancelled".into(),
            details: Json::Null,
            cancelled: true,
        });
    }
    if context.control.timed_out() {
        return Err(Failure {
            code: "EXTENSION_TIMEOUT".into(),
            message: "the step exceeded its time limit".into(),
            details: serde_json::json!({ "timeoutSeconds": context.control.timeout.as_secs() }),
            cancelled: false,
        });
    }
    Ok(ScriptOutcome {
        value,
        logs: context.logs.snapshot(),
    })
}

fn sandbox(lua: &Lua) {
    for name in ["os", "io", "dofile", "loadfile", "load", "package", "debug"] {
        let _ = lua.globals().set(name, Value::Nil);
    }
}

fn abort_or_script(context: &ScriptContext, error: mlua::Error) -> Failure {
    if let Some(failure) = context.control.failure() {
        return failure;
    }
    // A Lua `error` with a table reaches Rust as the table's address. The
    // structured failure the handle stored beside it is what the reader needs;
    // a plain string error after a caught failure keeps its own words.
    if format!("{error}").contains("table: 0x") {
        if let Some(failure) = context.control.last_error() {
            return failure;
        }
    }
    script_failure(context, error)
}

fn script_failure(context: &ScriptContext, error: mlua::Error) -> Failure {
    let message = format!("{error}");
    let limited = message.contains("memory") || message.contains("not enough memory");
    Failure {
        code: if limited {
            "EXTENSION_LIMIT_EXCEEDED".into()
        } else {
            "EXTENSION_SCRIPT_FAILED".into()
        },
        message,
        details: serde_json::json!({ "script": context.definition.script }),
        cancelled: false,
    }
}

fn register_helpers(lua: &Lua, context: &ScriptContext) -> mlua::Result<()> {
    let json = lua.create_table()?;
    json.set(
        "encode",
        lua.create_function(|lua, value: Value| {
            let text = serde_json::to_string(&table_to_json(&value))
                .map_err(|error| mlua::Error::RuntimeError(error.to_string()))?;
            if text.len() > HELPER_BYTES {
                return Err(mlua::Error::RuntimeError(
                    "json.encode produced a value that is too large".into(),
                ));
            }
            lua.create_string(text)
        })?,
    )?;
    json.set(
        "decode",
        lua.create_function(|lua, text: String| {
            if text.len() > HELPER_BYTES {
                return Err(mlua::Error::RuntimeError(
                    "json.decode was handed a value that is too large".into(),
                ));
            }
            let value: Json = serde_json::from_str(&text)
                .map_err(|error| mlua::Error::RuntimeError(format!("json.decode: {error}")))?;
            json_to_lua(lua, &value)
        })?,
    )?;
    lua.globals().set("json", json)?;

    let base64 = lua.create_table()?;
    base64.set(
        "encode",
        lua.create_function(|lua, text: String| {
            if text.len() > HELPER_BYTES {
                return Err(mlua::Error::RuntimeError(
                    "base64.encode was handed a value that is too large".into(),
                ));
            }
            lua.create_string(base64::engine::general_purpose::STANDARD.encode(text.as_bytes()))
        })?,
    )?;
    base64.set(
        "decode",
        lua.create_function(|lua, text: String| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(text.trim())
                .map_err(|error| mlua::Error::RuntimeError(format!("base64.decode: {error}")))?;
            if bytes.len() > HELPER_BYTES {
                return Err(mlua::Error::RuntimeError(
                    "base64.decode produced a value that is too large".into(),
                ));
            }
            lua.create_string(bytes)
        })?,
    )?;
    lua.globals().set("base64", base64)?;

    let logs = Arc::clone(&context.logs);
    let log = lua.create_function(move |lua, (level, message): (String, Value)| {
        let message = tostring(lua, message);
        logs.push(&level, &message);
        Ok(())
    })?;
    lua.globals().set("log", log.clone())?;

    let logs = Arc::clone(&context.logs);
    lua.globals().set(
        "print",
        lua.create_function(move |lua, values: Variadic<Value>| {
            let message = values
                .into_iter()
                .map(|value| tostring(lua, value))
                .collect::<Vec<_>>()
                .join("\t");
            logs.push("info", &message);
            Ok(())
        })?,
    )?;

    let progress = Arc::clone(&context.progress);
    let last = Arc::new(Mutex::new(0.0f64));
    let progress_fn =
        lua.create_function(move |_lua, (fraction, _label): (f64, Option<String>)| {
            if fraction.is_finite() {
                let mut last = last.lock().expect("progress is not held across a call");
                let clamped = fraction.clamp(0.0, 1.0).max(*last);
                if clamped > *last {
                    *last = clamped;
                    progress(clamped);
                }
            }
            Ok(())
        })?;
    lua.globals().set("progress", progress_fn.clone())?;

    let control = Arc::clone(&context.control);
    lua.globals().set(
        "fail",
        lua.create_function(
            move |lua, (message, details): (Value, Option<Value>)| -> mlua::Result<()> {
                let message = tostring(lua, message);
                control.record(Failure {
                    code: "EXTENSION_SCRIPT_FAILED".into(),
                    message: message.clone(),
                    details: details
                        .map(|value| table_to_json(&value))
                        .unwrap_or(Json::Null),
                    cancelled: false,
                });
                Err(mlua::Error::RuntimeError(message))
            },
        )?,
    )?;

    Ok(())
}

fn tostring(lua: &Lua, value: Value) -> String {
    match value {
        Value::String(text) => text.to_string_lossy(),
        other => lua
            .globals()
            .get::<mlua::Function>("tostring")
            .and_then(|tostring| tostring.call::<String>(other))
            .unwrap_or_default(),
    }
}

fn register_require(lua: &Lua, definition: &NodeDefinition) -> mlua::Result<()> {
    let modules = Arc::new(
        definition
            .scripts
            .iter()
            .map(|(name, source)| (name.clone(), source.clone()))
            .collect::<BTreeMap<_, _>>(),
    );
    let loaded = lua.create_table()?;
    let cache = loaded.clone();
    let dir = definition.dir.to_string_lossy().to_string();
    let require = lua.create_function(move |lua, name: String| {
        if !super::valid_identifier(&name) {
            return Err(mlua::Error::RuntimeError(format!(
                "require(\"{name}\"): a module name is letters, digits and underscores"
            )));
        }
        if let Ok(value) = cache.raw_get::<Value>(name.as_str()) {
            if !matches!(value, Value::Nil) {
                return Ok(value);
            }
        }
        let Some(source) = modules.get(&name) else {
            return Err(mlua::Error::RuntimeError(format!(
                "require(\"{name}\"): no {name}.lua beside the definition in {dir}"
            )));
        };
        // Standard `require` behaviour: a sentinel goes in before the module
        // body runs, so a cycle sees a partially loaded module rather than
        // recursing forever.
        cache.set(name.as_str(), Value::Boolean(true))?;
        let value: Value = lua
            .load(source)
            .set_name(format!("{name}.lua"))
            .eval()
            .map_err(|error| mlua::Error::RuntimeError(format!("require(\"{name}\"): {error}")))?;
        let value = match value {
            Value::Nil => Value::Boolean(true),
            other => other,
        };
        cache.set(name.as_str(), value.clone())?;
        Ok(value)
    })?;
    lua.globals().set("require", require)
}

fn build_ctx(lua: &Lua, context: &ScriptContext) -> mlua::Result<Table> {
    let ctx = lua.create_table()?;
    let extension = lua.create_table()?;
    extension.set("id", context.definition.id.as_str())?;
    extension.set("version", context.definition.version)?;
    extension.set("apiVersion", context.definition.api_version)?;
    ctx.set("extension", extension)?;

    let node = lua.create_table()?;
    node.set("id", context.node_id.as_str())?;
    node.set("title", context.node_title.as_str())?;
    ctx.set("node", node)?;

    ctx.set("inputs", json_to_lua(lua, &context.inputs)?)?;
    ctx.set("params", json_to_lua(lua, &context.params)?)?;

    ctx.set("log", lua.globals().get::<mlua::Function>("log")?)?;
    ctx.set("progress", lua.globals().get::<mlua::Function>("progress")?)?;
    ctx.set("fail", lua.globals().get::<mlua::Function>("fail")?)?;
    Ok(ctx)
}

fn register_model_handles(
    lua: &Lua,
    context: &ScriptContext,
    phase_validate: &Arc<AtomicBool>,
    ctx: &Table,
) -> mlua::Result<()> {
    let models = lua.create_table()?;
    for (slot_id, info) in &context.models {
        let Some(slot) = context.definition.slot(slot_id) else {
            continue;
        };
        let handle = lua.create_table()?;
        handle.set("id", slot.id.as_str())?;
        handle.set("capability", slot.capability.as_str())?;
        handle.set("label", info.label.as_str())?;
        handle.set("modelName", info.model_name.as_str())?;

        let caller = Arc::clone(&context.caller);
        let slot_id = slot.id.clone();
        let capability = slot.capability;
        let phase = Arc::clone(phase_validate);
        let control = Arc::clone(&context.control);
        // The raw call hands back either an answer or an error table. A small
        // Lua wrapper raises the table, so a script's `pcall` can inspect
        // `.code` and a caught failure does not have to be a string.
        let raw = lua.create_function(move |lua, (_this, request): (Table, Table)| {
            if phase.load(Ordering::SeqCst) {
                return Err(mlua::Error::RuntimeError(
                    "models cannot be called from validate".to_string(),
                ));
            }
            control.check()?;
            let mut call = match read_model_call(lua, &request, &slot_id, capability) {
                Ok(call) => call,
                Err(error) => {
                    let failure = Failure {
                        code: "EXTENSION_SCRIPT_FAILED".into(),
                        message: format!("{error}"),
                        details: serde_json::json!({ "slot": slot_id }),
                        cancelled: false,
                    };
                    control.note_error(failure.clone());
                    return Ok((
                        Value::Nil,
                        Value::Table(error_table(
                            lua,
                            &failure.code,
                            &failure.message,
                            &failure.details,
                        )?),
                    ));
                }
            };
            call.slot = slot_id.clone();
            match caller(call) {
                Ok(answer) => {
                    control.clear_last_error();
                    Ok((answer_to_lua(lua, answer)?, Value::Nil))
                }
                Err(error) => {
                    let failure = Failure {
                        code: error.code.clone(),
                        message: error.message.clone(),
                        details: error.details.clone(),
                        cancelled: error.cancelled || error.timed_out,
                    };
                    control.note_error(failure.clone());
                    Ok((
                        Value::Nil,
                        Value::Table(error_table(
                            lua,
                            &failure.code,
                            &failure.message,
                            &failure.details,
                        )?),
                    ))
                }
            }
        })?;
        let factory: mlua::Function = lua
            .load(
                r#"
                return function(raw)
                    return function(self, request)
                        local answer, err = raw(self, request)
                        if err ~= nil then error(err, 0) end
                        return answer
                    end
                end
                "#,
            )
            .eval()?;
        let generate: mlua::Function = factory.call(raw)?;
        handle.set("generate", generate)?;
        models.set(slot.id.as_str(), handle)?;
    }
    ctx.set("models", models)
}

fn error_table(lua: &Lua, code: &str, message: &str, details: &Json) -> mlua::Result<Table> {
    let table = lua.create_table()?;
    table.set("code", code)?;
    table.set("message", message)?;
    table.set("details", json_to_lua(lua, details)?)?;
    Ok(table)
}

fn read_model_call(
    lua: &Lua,
    request: &Table,
    slot: &str,
    capability: Capability,
) -> mlua::Result<ModelCall> {
    let prompt = match request.get::<Value>("prompt") {
        Ok(Value::String(text)) => text.to_string_lossy(),
        Ok(Value::Nil) | Err(_) => String::new(),
        Ok(other) => {
            return Err(mlua::Error::RuntimeError(format!(
                "generate.prompt must be a string, not {}",
                other.type_name()
            )))
        }
    };
    let system = match request.get::<Value>("system") {
        Ok(Value::String(text)) => Some(text.to_string_lossy()),
        Ok(Value::Nil) | Err(_) => None,
        Ok(_) => {
            return Err(mlua::Error::RuntimeError(
                "generate.system must be a string".to_string(),
            ))
        }
    };
    let params = match request.get::<Value>("params") {
        Ok(Value::Table(table)) => table_to_json(&Value::Table(table)),
        Ok(Value::Nil) | Err(_) => serde_json::json!({}),
        Ok(_) => {
            return Err(mlua::Error::RuntimeError(
                "generate.params must be a table".to_string(),
            ))
        }
    };
    if !params.is_object() {
        return Err(mlua::Error::RuntimeError(
            "generate.params must be a table of named values".to_string(),
        ));
    }
    let inputs = match request.get::<Value>("inputs") {
        Ok(Value::Table(table)) => read_inputs(lua, table)?,
        Ok(Value::Nil) | Err(_) => Vec::new(),
        Ok(_) => {
            return Err(mlua::Error::RuntimeError(
                "generate.inputs must be a list".to_string(),
            ))
        }
    };
    Ok(ModelCall {
        slot: slot.to_string(),
        capability,
        prompt,
        system,
        params,
        inputs,
    })
}

fn read_inputs(_lua: &Lua, table: Table) -> mlua::Result<Vec<Json>> {
    let len = table.raw_len();
    let mut inputs = Vec::with_capacity(len);
    for index in 1..=len {
        let value: Value = table.raw_get(index)?;
        let Value::Table(entry) = value else {
            return Err(mlua::Error::RuntimeError(format!(
                "generate.inputs[{index}] must be a table"
            )));
        };
        let json = table_to_json(&Value::Table(entry));
        let Some(object) = json.as_object() else {
            return Err(mlua::Error::RuntimeError(format!(
                "generate.inputs[{index}] must be a table of named values"
            )));
        };
        let role = object.get("role").and_then(Json::as_str).unwrap_or("");
        if !matches!(
            role,
            "reference" | "firstFrame" | "lastFrame" | "mask" | "controlVideo" | "controlAudio"
        ) {
            return Err(mlua::Error::RuntimeError(format!(
                "generate.inputs[{index}].role \"{role}\" is not a reference role"
            )));
        }
        if object
            .get("assetId")
            .and_then(Json::as_str)
            .unwrap_or_default()
            .is_empty()
        {
            return Err(mlua::Error::RuntimeError(format!(
                "generate.inputs[{index}] names no assetId"
            )));
        }
        inputs.push(json);
    }
    Ok(inputs)
}

fn answer_to_lua(lua: &Lua, answer: ModelAnswer) -> mlua::Result<Value> {
    let table = lua.create_table()?;
    if let Some(text) = &answer.text {
        table.set("text", text.as_str())?;
    }
    let items = lua.create_table()?;
    for (index, item) in answer.items.iter().enumerate() {
        let entry = lua.create_table()?;
        entry.set("kind", item.kind.as_str())?;
        entry.set("mime", item.mime.as_str())?;
        entry.set("assetId", item.asset_id.as_str())?;
        if let Some(width) = item.width {
            entry.set("width", width)?;
        }
        if let Some(height) = item.height {
            entry.set("height", height)?;
        }
        if let Some(duration_ms) = item.duration_ms {
            entry.set("durationMs", duration_ms)?;
        }
        items.set(index + 1, entry)?;
    }
    table.set("items", items)?;
    if !answer.usage.is_null() {
        table.set("usage", json_to_lua(lua, &answer.usage)?)?;
    }
    Ok(Value::Table(table))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::result_large_err)]

    use super::*;
    use crate::extension::manifest;
    use std::path::Path;

    fn definition(dir: &Path, script: &str, helpers: &[(&str, &str)]) -> Arc<NodeDefinition> {
        let document = r#"{
          "apiVersion": 1,
          "displayName": "Test",
          "script": "main.lua",
          "inputs": [{"id": "text", "dataTypes": ["text"], "label": "Text"}],
          "outputs": [{"id": "out", "dataTypes": ["text", "image"], "label": "Out"}],
          "models": [{"id": "writer", "capability": "text", "label": "Writer"}],
          "parameters": [{"key": "style", "type": "string", "label": "Style", "default": "ink"}]
        }"#;
        std::fs::write(dir.join("node.json"), document).unwrap();
        std::fs::write(dir.join("main.lua"), script).unwrap();
        for (name, source) in helpers {
            std::fs::write(dir.join(name), source).unwrap();
        }
        Arc::new(manifest::load(dir, "test").unwrap())
    }

    fn context(
        definition: Arc<NodeDefinition>,
        caller: ModelCaller,
    ) -> (ScriptContext, Arc<StepControl>, Arc<LogWriter>) {
        let control = StepControl::new(Duration::from_secs(30), None);
        let logs = Arc::new(LogWriter::new(64 * 1024, None));
        let context = ScriptContext {
            definition,
            node_id: "n-1".into(),
            node_title: "Test".into(),
            inputs: serde_json::json!({"text": [{"type": "text", "text": "hello"}]}),
            params: serde_json::json!({"style": "ink"}),
            models: BTreeMap::from([(
                "writer".to_string(),
                ModelHandleInfo {
                    capability: Capability::Text,
                    label: "Writer".into(),
                    model_name: "Test Model".into(),
                },
            )]),
            caller,
            logs: Arc::clone(&logs),
            progress: Arc::new(|_| {}),
            control: Arc::clone(&control),
        };
        (context, control, logs)
    }

    fn echo_caller() -> ModelCaller {
        Arc::new(|call| {
            Ok(ModelAnswer {
                text: Some(format!("{}: {}", call.slot, call.prompt)),
                items: Vec::new(),
                usage: serde_json::json!({}),
            })
        })
    }

    #[test]
    #[allow(clippy::result_large_err)]
    fn a_script_reads_inputs_params_and_hands_outputs_back() {
        let dir = tempfile::tempdir().unwrap();
        let definition = definition(
            dir.path(),
            r#"
            function run(ctx)
              local text = ctx.inputs.text[1].text
              local made = ctx.models.writer:generate{ prompt = text .. " " .. ctx.params.style }
              ctx.log("info", "made " .. (made.text or ""))
              return { outputs = { out = { { type = "text", text = made.text } } } }
            end
            "#,
            &[],
        );
        let (context, _, logs) = context(definition, echo_caller());
        let outcome = execute(context).unwrap();
        assert_eq!(
            outcome.value["outputs"]["out"][0]["text"],
            "writer: hello ink"
        );
        let written = logs.snapshot();
        assert!(written
            .iter()
            .any(|entry| entry.message.contains("made writer: hello ink")));
    }

    #[test]
    fn validate_runs_before_run_and_cannot_spend_money() {
        let dir = tempfile::tempdir().unwrap();
        let definition = definition(
            dir.path(),
            r#"
            function validate(ctx)
              local ok, err = pcall(function()
                return ctx.models.writer:generate{ prompt = "x" }
              end)
              if ok then error("a model call from validate must fail") end
              ctx.fail("not this time", { parameter = "style" })
            end
            function run(ctx)
              return { outputs = {} }
            end
            "#,
            &[],
        );
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let caller: ModelCaller = Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(ModelAnswer::default())
        });
        let (context, _, _) = context(definition, caller);
        let failure = execute(context).unwrap_err();
        assert_eq!(failure.code, "EXTENSION_SCRIPT_FAILED");
        assert_eq!(failure.message, "not this time");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_helper_module_is_required_once_from_beside_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let definition = definition(
            dir.path(),
            r#"
            local prompts = require("prompts")
            function run(ctx)
              return { outputs = { out = { { type = "text", text = prompts.words() } } } }
            end
            "#,
            &[(
                "prompts.lua",
                r#"
                local loaded = 0
                return { words = function() loaded = loaded + 1; return "from a helper" end }
                "#,
            )],
        );
        let (context, _, _) = context(definition, echo_caller());
        let outcome = execute(context).unwrap();
        assert_eq!(outcome.value["outputs"]["out"][0]["text"], "from a helper");
    }

    #[test]
    fn a_module_the_directory_does_not_hold_is_an_error_not_a_network_load() {
        let dir = tempfile::tempdir().unwrap();
        let definition = definition(
            dir.path(),
            r#"
            function run(ctx)
              require("socket")
            end
            "#,
            &[],
        );
        let (context, _, _) = context(definition, echo_caller());
        let failure = execute(context).unwrap_err();
        assert_eq!(failure.code, "EXTENSION_SCRIPT_FAILED");
        assert!(failure.message.contains("socket"), "{}", failure.message);
    }

    #[test]
    fn cancel_and_timeout_stop_a_script_that_would_not_stop_itself() {
        let dir = tempfile::tempdir().unwrap();
        let definition = definition(
            dir.path(),
            r#"
            function run(ctx)
              while true do end
            end
            "#,
            &[],
        );
        // The loop would run past the instruction budget in tens of
        // milliseconds, so the cancel is in place before the first hook fires.
        let (script, control, _) = self::context(definition, echo_caller());
        control.cancel();
        let failure = execute(script).unwrap_err();
        assert_eq!(failure.code, "EXTENSION_CANCELLED");
        assert!(failure.cancelled);

        // A deadline the same loop cannot outrun: the hook checks the clock,
        // not only a flag someone else has to set.
        let endless = self::definition(
            dir.path(),
            r#"
            function run(ctx)
              while true do end
            end
            "#,
            &[],
        );
        let (mut script, _, _) = self::context(endless, echo_caller());
        script.control = StepControl::new(Duration::from_millis(1), None);
        std::thread::sleep(Duration::from_millis(5));
        let failure = execute(script).unwrap_err();
        assert_eq!(failure.code, "EXTENSION_TIMEOUT");
    }

    #[test]
    fn a_caught_model_error_can_be_handled_but_an_uncaught_one_ends_the_step() {
        let dir = tempfile::tempdir().unwrap();
        let definition = definition(
            dir.path(),
            r#"
            function run(ctx)
              local ok, err = pcall(function()
                return ctx.models.writer:generate{ prompt = "x" }
              end)
              if ok then ctx.fail("the call should have failed") end
              return { outputs = { out = { { type = "text", text = "handled " .. err.code } } } }
            end
            "#,
            &[],
        );
        let failing: ModelCaller = Arc::new(|_| {
            Err(ModelError {
                code: "EXTENSION_MODEL_CALL_FAILED".into(),
                message: "no".into(),
                details: serde_json::json!({"slot": "writer"}),
                retryable: false,
                cancelled: false,
                timed_out: false,
            })
        });
        let (context, _, _) = context(definition, failing);
        let outcome = execute(context).unwrap();
        assert_eq!(
            outcome.value["outputs"]["out"][0]["text"],
            "handled EXTENSION_MODEL_CALL_FAILED"
        );
    }
}
