//! Lua script runtime: loads scripts, registers the API surface a converter
//! script can call, and invokes exported functions.
//!
//! A converter script is one file of global functions. Which of them a protocol
//! implements is what it can be asked for:
//!
//! | Function | Input | Output | Used by |
//! |---|---|---|---|
//! | `build_request(call, req, inputs)` | 3 tables | `{method, url, headers, body}` | text, image, audio |
//! | `build_stream_request(call, req, inputs)` | 3 tables | the same, for an answer that arrives in pieces | streaming |
//! | `parse_response(status, headers, body, state, raw)` | number, table, string, table, bytes | `{text, items, usage, error}` | text, image, audio |
//! | `parse_event(event_json)` | string | `{text, complete, usage, failed}` | streaming |
//! | `build_task_request(call, req, inputs)` | 3 tables | `{method, url, headers, body}` | video, asr |
//! | `parse_task_response(status, headers, body, state, raw)` | as `parse_response` | `{reference, poll_interval_ms}` | video, asr |
//! | `build_poll_request(call, task)` | 2 tables | `{method, url, headers}` | video, asr |
//! | `parse_poll_response(status, headers, body, state, raw)` | as `parse_response` | `{status, result, error}` | video, asr |
//!
//! What those arguments hold:
//!
//! - `call` is `{url, model}`: the endpoint a configuration names, and the
//!   provider's own name for the model.
//! - `req` is `{prompt, system, capability, params}`, where `system` is the
//!   instruction that frames the prompt rather than forming part of it.
//! - `inputs[i]` is `{role, filename, mime, data_url, sha256}`: one piece of
//!   reference media, with its bytes inside the data URL and the digest of
//!   those bytes beside them — a name for the file that two calls carrying
//!   the same file agree on, which is what a memo key needs.
//! - `headers` is the answer's headers as a table, lowercased, a name sent
//!   twice joined by `", "`.
//! - `body` is the answer as text, and `raw` is the answer as it arrived —
//!   which is what a converter reads when the answer is not text.
//!
//! # Asking for another exchange
//!
//! A protocol that needs more than one call per step — an upload before a
//! submit, a document behind a poll — says so instead of the host knowing it.
//! Any hook may return
//!
//! ```lua
//! { request = {method = "GET", url = ..., headers = ..., body = ...},
//!   handler = "parse_something",  -- optional: the hook that reads this answer
//!   state = { ... } }             -- optional: handed to the next handler
//! ```
//!
//! as its reply, or may carry one under `next` beside the rest of what it
//! answers. The host sends that request, calls `handler` with
//! `(status, headers, body, state, raw)`, and repeats until a reply carries no
//! `next`; the reply that ends the chain is that step's answer. Handlers are
//! looked up before each request goes out, so a script that names a function it
//! never wrote is refused rather than sending an upload nobody will read. What
//! one step learns is what it wrote into `state`: a runtime lives for one call
//! rather than one step, but a chain says what it means to say through `state`
//! and not through a global. What one call means to say to the next is what it
//! leaves in the memo (`memo_get`/`memo_set`), which outlives the runtime and
//! dies with the process. A chain is capped, so a reply that asks for itself
//! again is an error rather than a loop.
//!
//! A `body` is text, or a form whose file parts are inputs the request carried
//! — Lua counts from one:
//!
//! ```lua
//! body = {multipart = {fields = {key = "a-value"},
//!                      files = {{part = "image", input = 1}}}}
//! ```
//!
//! `file = {part = ..., input = ...}` describes one form with a single part,
//! which is what most uploads are.
//!
//! # What a step may answer
//!
//! - `text`, and `usage` = `{input_tokens, output_tokens, images, seconds}`.
//! - `items`: media, each one `{url = ...}` (fetched by the host),
//!   `{data_url = ...}`, `{base64 = ..., mime = ...}`, or `{raw = true, mime =
//!   ...}` for the bytes of the answer itself. The host sniffs what each one
//!   is rather than trusting its name, and stores it under the family the
//!   request was for.
//! - `error`: the provider's own words, refused as something asking again
//!   would not fix.
//! - `failed` from `parse_event`: a complaint that arrived mid-stream, refused
//!   the same way.
//!
//! # Failures and credentials
//!
//! A status the provider refused is the host's to explain: the code a caller
//! acts on — a credential problem, a rate limit, an address that is wrong —
//! comes from the status, and a host that handed every one of them to a script
//! would report a rate limit as a refusal nothing may retry. A request that
//! says `read_failure = true` is handed over anyway, for a protocol that reads
//! a failure as an answer of its own.
//!
//! Credentials are not a script's business. The host attaches the one the
//! converter's `model.json` declares, in the header and scheme it declares, and
//! only for addresses inside the configured origin: an upload host or a link a
//! provider handed back is a different origin, and a key sent there would not
//! be going to the provider.

use std::path::Path;

use mlua::{Function, Lua, Result as LuaResult, Value};

use super::api;

/// A handle for interacting with a loaded Lua script.
pub struct ScriptRef {
    _name: String,
}

/// A Lua runtime, held for as long as the one call that made it needs it.
///
/// No lock and no reference count. A runtime is built inside the adapter's
/// `call_lua`, used, and dropped before that function returns, so nothing else
/// can ever reach it; and `Lua` is not `Send` without mlua's `send` feature, so
/// a mutex around it could not make it shareable across threads even if two
/// callers existed. What the pair would add is the pretence of contention.
pub struct LuaRuntime {
    lua: Lua,
}

impl LuaRuntime {
    /// Creates a new runtime with the standard API registered, its memo
    /// scoped to no protocol in particular — which is what a runtime built
    /// for its own sake, as a test does, gets.
    pub fn new() -> Result<Self, mlua::Error> {
        Self::for_protocol("")
    }

    /// A runtime for one protocol, whose memo (`memo_get`/`memo_set`) is that
    /// protocol's alone: two converters cannot read each other's keys.
    pub fn for_protocol(protocol: &str) -> Result<Self, mlua::Error> {
        let lua = Lua::new();
        // Safety sandbox: restrict dangerous functions
        lua.globals().set("os", mlua::Value::Nil)?;
        lua.globals().set("io", mlua::Value::Nil)?;
        lua.globals().set("dofile", mlua::Value::Nil)?;
        lua.globals().set("loadfile", mlua::Value::Nil)?;

        api::register(&lua)?;
        api::register_memo(&lua, protocol)?;

        Ok(Self { lua })
    }

    /// Loads a script file and returns a reference to it.
    pub fn load(&self, path: &Path) -> Result<ScriptRef, mlua::Error> {
        let source = std::fs::read_to_string(path).map_err(|e| {
            mlua::Error::RuntimeError(format!("cannot read script {}: {e}", path.display()))
        })?;
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        self.load_source(&name, &source)
    }

    /// Loads script text under a name its errors are reported by.
    pub fn load_source(&self, name: &str, source: &str) -> Result<ScriptRef, mlua::Error> {
        let chunk = self.lua.load(source).set_name(name);
        chunk.exec()?;
        Ok(ScriptRef {
            _name: name.to_string(),
        })
    }

    /// Checks whether a loaded script exports the named function.
    pub fn has_function(&self, _script: &ScriptRef, name: &str) -> bool {
        let lua = &self.lua;
        lua.globals()
            .get::<Value>(name)
            .map(|v| matches!(v, Value::Function(_)))
            .unwrap_or(false)
    }

    /// Calls a function on a loaded script and converts the result to a
    /// [`serde_json::Value`].
    pub fn call_json(
        &self,
        _script: &ScriptRef,
        func: &str,
        args: Vec<mlua::Value>,
    ) -> Result<mlua::Value, mlua::Error> {
        let lua = &self.lua;
        let func: Function = lua.globals().get(func)?;
        // A Vec<Value> on its own would convert to one Lua table — a single
        // argument — leaving every parameter after the first nil inside the
        // script. MultiValue is what spreads the elements as arguments.
        let result = func.call::<mlua::Value>(mlua::MultiValue::from_vec(args))?;
        Ok(result)
    }

    /// Calls a function with [`serde_json::Value`] arguments. Converts each
    /// argument to a Lua value, calls the function, and converts the result
    /// back to JSON.
    pub fn call_json_value(
        &self,
        _script: &ScriptRef,
        func: &str,
        args: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, mlua::Error> {
        let built: Result<Vec<mlua::Value>, mlua::Error> =
            args.iter().map(|arg| self.to_lua(arg)).collect();
        self.call_values(func, built?)
    }

    /// A Lua value for a JSON value, in this runtime.
    pub fn to_lua(&self, value: &serde_json::Value) -> Result<mlua::Value, mlua::Error> {
        json_to_lua(&self.lua, value)
    }

    /// A Lua string of these bytes as they are. Lua strings carry bytes rather
    /// than text, which is what lets an answer that is not text — a recording,
    /// a picture — reach a script whole.
    pub fn bytes(&self, bytes: &[u8]) -> Result<mlua::Value, mlua::Error> {
        Ok(mlua::Value::String(self.lua.create_string(bytes)?))
    }

    /// Calls a function with values already built for this runtime, spread as
    /// arguments, and reads the reply as JSON.
    pub fn call_values(
        &self,
        func: &str,
        args: Vec<mlua::Value>,
    ) -> Result<serde_json::Value, mlua::Error> {
        let lua = &self.lua;
        let called: Function = lua.globals().get(func)?;
        // Spread as arguments, not passed as one table: see `call_json`.
        let result = called.call::<mlua::Value>(mlua::MultiValue::from_vec(args))?;
        Ok(table_to_json(&result))
    }
}

impl Default for LuaRuntime {
    fn default() -> Self {
        Self::new().expect("Lua runtime initialises")
    }
}

/// Converts any Lua value to a [`serde_json::Value`].
pub(crate) fn table_to_json(value: &mlua::Value) -> serde_json::Value {
    use mlua::Value::*;
    match value {
        Nil => serde_json::Value::Null,
        Boolean(b) => serde_json::Value::Bool(*b),
        Integer(i) => serde_json::Value::Number((*i).into()),
        Number(n) => serde_json::Value::Number(
            serde_json::Number::from_f64(*n).unwrap_or_else(|| serde_json::Number::from(0)),
        ),
        String(s) => {
            serde_json::Value::String(s.to_str().map(|s| s.to_string()).unwrap_or_default())
        }
        Table(t) => {
            let len = t.raw_len();
            if len > 0 {
                let mut arr = Vec::with_capacity(len);
                for i in 1..=len {
                    if let Ok(v) = t.raw_get::<mlua::Value>(mlua::Value::Integer(i as i64)) {
                        arr.push(table_to_json(&v));
                    }
                }
                return serde_json::Value::Array(arr);
            }
            let mut map = serde_json::Map::new();
            for (k, v) in t.clone().pairs::<mlua::String, mlua::Value>().flatten() {
                map.insert(
                    k.to_str().map(|s| s.to_string()).unwrap_or_default(),
                    table_to_json(&v),
                );
            }
            serde_json::Value::Object(map)
        }
        _ => serde_json::Value::Null,
    }
}

/// Converts a Rust [`serde_json::Value`] to a Lua value.
pub fn json_to_lua(lua: &Lua, value: &serde_json::Value) -> LuaResult<mlua::Value> {
    match value {
        serde_json::Value::Null => Ok(mlua::Value::Nil),
        serde_json::Value::Bool(b) => Ok(mlua::Value::Boolean(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(mlua::Value::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(mlua::Value::Number(f))
            } else {
                Ok(mlua::Value::String(lua.create_string(n.to_string())?))
            }
        }
        serde_json::Value::String(s) => Ok(mlua::Value::String(lua.create_string(s)?)),
        serde_json::Value::Array(arr) => {
            let table = lua.create_table()?;
            for (i, v) in arr.iter().enumerate() {
                table.set(i + 1, json_to_lua(lua, v)?)?;
            }
            Ok(mlua::Value::Table(table))
        }
        serde_json::Value::Object(obj) => {
            let table = lua.create_table()?;
            for (k, v) in obj {
                table.set(k.as_str(), json_to_lua(lua, v)?)?;
            }
            Ok(mlua::Value::Table(table))
        }
    }
}

/// Converts a Lua value to a string representation.
#[allow(dead_code)]
pub(crate) fn to_lua_string(v: &mlua::Value) -> String {
    match v {
        mlua::Value::String(s) => s.to_str().map(|s| s.to_string()).unwrap_or_default(),
        mlua::Value::Number(n) => n.to_string(),
        mlua::Value::Integer(i) => i.to_string(),
        mlua::Value::Boolean(b) => b.to_string(),
        mlua::Value::Nil => String::new(),
        _ => format!("{v:?}"),
    }
}

/// Builds a Python-like str() representation.
fn _lua_to_string(lua: &Lua, value: mlua::Value) -> LuaResult<String> {
    let tostring: Function = lua.globals().get("tostring")?;
    tostring.call(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_runtime() -> LuaRuntime {
        LuaRuntime::new().expect("runtime builds")
    }

    #[test]
    fn runtime_creates_and_registers_apis() {
        let rt = test_runtime();
        let lua = &rt.lua;
        assert!(lua.globals().get::<mlua::Value>("json").is_ok());
        assert!(lua.globals().get::<mlua::Value>("base64").is_ok());
        assert!(lua.globals().get::<mlua::Value>("log").is_ok());
        assert!(lua.globals().get::<mlua::Value>("util").is_ok());
        assert!(lua.globals().get::<mlua::Value>("memo_get").is_ok());
        assert!(lua.globals().get::<mlua::Value>("memo_set").is_ok());
    }

    #[test]
    fn json_table_to_value_roundtrip() {
        let rt = test_runtime();
        let lua = &rt.lua;
        let tbl = lua.create_table().unwrap();
        tbl.set("a", 1).unwrap();
        let inner = lua.create_table().unwrap();
        inner.set(1, 2).unwrap();
        inner.set(2, 3).unwrap();
        tbl.set("b", inner).unwrap();

        let json = table_to_json(&mlua::Value::Table(tbl));
        assert_eq!(json, serde_json::json!({"a": 1, "b": [2, 3]}));
    }

    #[test]
    fn a_script_function_receives_every_argument() {
        let rt = test_runtime();
        // The bug this pins: a Vec of values converts to one Lua table, so
        // without spreading, `call` was the whole list and `req` was nil —
        // "attempt to index a nil value (local 'req')" at the first field
        // a script read off the request.
        let script = rt
            .load_source(
                "args",
                r#"
                function build_request(call, req, inputs)
                    return {
                        method = "POST",
                        url = call.url .. "/" .. req.prompt .. "/" .. #inputs,
                    }
                end
                "#,
            )
            .unwrap();
        let out = rt
            .call_json_value(
                &script,
                "build_request",
                vec![
                    serde_json::json!({"url": "https://provider.test"}),
                    serde_json::json!({"prompt": "hello", "params": {}}),
                    serde_json::json!([{"role": "firstFrame"}]),
                ],
            )
            .unwrap();
        assert_eq!(out["method"], "POST");
        assert_eq!(out["url"], "https://provider.test/hello/1");
    }

    #[test]
    fn the_bailian_scripts_build_their_requests() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");

        // Speech: the non-streaming CosyVoice TTS shape.
        let speech = rt
            .load(&scripts.join("models/speech/bailianSpeech/bailian-speech.lua"))
            .unwrap();
        let out = rt
            .call_json_value(
                &speech,
                "build_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/tts", "model": "cosyvoice-v1"}),
                    serde_json::json!({"prompt": "hello", "params": {"voice": "longxiaochun"}}),
                    serde_json::json!([]),
                ],
            )
            .unwrap();
        assert_eq!(out["url"], "https://ws.test/tts");
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["model"], "cosyvoice-v1");
        assert_eq!(body["input"]["text"], "hello");
        assert_eq!(body["input"]["voice"], "longxiaochun");

        // The pace and the acting direction the room sends arrive as the
        // service's: `instructions` as `instruction` — the field the engine
        // reads a role or an emotion from — and the generic `speed` as `rate`
        // for a caller that stated no pace in the service's own name. Before
        // this, both were dropped and the ask went out as a voice-only read of
        // the lines.
        let out = rt
            .call_json_value(
                &speech,
                "build_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/tts", "model": "cosyvoice-v1"}),
                    serde_json::json!({
                        "prompt": "hello",
                        "params": {
                            "voice": "longxiaochun",
                            "format": "mp3",
                            "speed": 1.2,
                            "instructions": "平稳地念",
                        },
                    }),
                    serde_json::json!([]),
                ],
            )
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["input"]["rate"], 1.2);
        assert_eq!(body["input"]["instruction"], "平稳地念");

        // Both pace names stated, as a generation carries them once the audio
        // settings have filled the service's own: `rate` is the pace, and the
        // generic `speed` beside it is not a second one.
        let out = rt
            .call_json_value(
                &speech,
                "build_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/tts", "model": "cosyvoice-v1"}),
                    serde_json::json!({
                        "prompt": "hello",
                        "params": {"voice": "longxiaochun", "rate": 1.6, "speed": 0.8},
                    }),
                    serde_json::json!([]),
                ],
            )
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["input"]["rate"], 1.6);

        // A pace the service does not take — the room's fields allow 0.25 to 4
        // — is brought to the nearest end rather than sent to be refused.
        let out = rt
            .call_json_value(
                &speech,
                "build_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/tts", "model": "cosyvoice-v1"}),
                    serde_json::json!({
                        "prompt": "hello",
                        "params": {"voice": "longxiaochun", "speed": 3},
                    }),
                    serde_json::json!([]),
                ],
            )
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["input"]["rate"], 2);

        // The direction does not reach every family: v2 reads none at all, and
        // the v3 pair take only their own fixed phrasing — a free sentence is
        // refused with the engine's code 428. The room's words are left off
        // for those, since a refused ask reads nothing.
        for model in ["cosyvoice-v2", "cosyvoice-v3-flash", "cosyvoice-v3-plus"] {
            let out = rt
                .call_json_value(
                    &speech,
                    "build_request",
                    vec![
                        serde_json::json!({"url": "https://ws.test/tts", "model": model}),
                        serde_json::json!({
                            "prompt": "hello",
                            "params": {"voice": "longxiaochun", "instructions": "平稳地念"},
                        }),
                        serde_json::json!([]),
                    ],
                )
                .unwrap();
            let body: serde_json::Value =
                serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
            assert_eq!(
                body["input"].get("instruction"),
                None,
                "{model} must be spared a direction it refuses"
            );
        }

        // v3.5 and later read the free text, and it travels as written.
        let out = rt
            .call_json_value(
                &speech,
                "build_request",
                vec![
                    serde_json::json!({
                        "url": "https://ws.test/tts",
                        "model": "cosyvoice-v3.5-flash",
                    }),
                    serde_json::json!({
                        "prompt": "hello",
                        "params": {"voice": "longanyang", "instructions": "按喜剧的演法念"},
                    }),
                    serde_json::json!([]),
                ],
            )
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["input"]["instruction"], "按喜剧的演法念");

        // The sample rate the room sends under its own name travels as this
        // engine's `sample_rate`. The bug this pins: the script read a
        // snake_case key no request carries, so the setting was dropped
        // without a word and the engine's default was heard instead.
        let out = rt
            .call_json_value(
                &speech,
                "build_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/tts", "model": "cosyvoice-v1"}),
                    serde_json::json!({
                        "prompt": "hello",
                        "params": {"voice": "longxiaochun", "sampleRate": 48000},
                    }),
                    serde_json::json!([]),
                ],
            )
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["input"]["sample_rate"], 48000);

        // Video: the async DashScope task shape.
        let video = rt
            .load(&scripts.join("models/video/bailianVideo/bailian-video.lua"))
            .unwrap();
        let out = rt
            .call_json_value(
                &video,
                "build_task_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/video-synthesis", "model": "wan2.2-t2v"}),
                    serde_json::json!({"prompt": "a cat", "params": {"seconds": "6", "resolution": "720"}}),
                    serde_json::json!([{"role": "firstFrame", "data_url": "https://img.test/1.png"}]),
                ],
            )
            .unwrap();
        assert_eq!(out["headers"]["X-DashScope-Async"], "enable");
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["model"], "wan2.2-t2v");
        assert_eq!(body["input"]["prompt"], "a cat");
        assert_eq!(body["input"]["media"][0]["type"], "first_frame");
        assert_eq!(body["parameters"]["duration"], 6);
        // The API only takes the tiers with a trailing P, so the bare tier the
        // request carries is dressed before it travels.
        assert_eq!(body["parameters"]["resolution"], "720P");

        // Music: the one-shot composition shape, whose answer names the song.
        let music = rt
            .load(&scripts.join("models/music/bailianMusic/bailian-music.lua"))
            .unwrap();
        let out = rt
            .call_json_value(
                &music,
                "build_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/music", "model": "fun-music-v1"}),
                    serde_json::json!({
                        "prompt": "雨夜站台，低音提琴，缓慢",
                        "params": {
                            "music": true,
                            "instrumental": true,
                            "format": "mp3",
                            "voice": "alloy",
                        },
                    }),
                    serde_json::json!([]),
                ],
            )
            .unwrap();
        assert_eq!(out["url"], "https://ws.test/music");
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["model"], "fun-music-v1");
        assert_eq!(body["input"]["prompt"], "雨夜站台，低音提琴，缓慢");
        assert_eq!(body["input"]["is_instrumental"], true);
        assert_eq!(body["input"]["format"], "mp3");
        // A parameter meant for a voice does not travel to a service that
        // writes songs, and the flag the shelf files by is not a field of its.
        assert!(body["input"].get("voice").is_none(), "{body}");
        assert!(body["input"].get("music").is_none(), "{body}");

        // The song arrives as a link rather than as bytes, and the words the
        // service wrote with it are kept.
        let answered = rt
            .call_json_value(
                &music,
                "parse_response",
                vec![
                    serde_json::json!(200),
                    serde_json::json!({}),
                    serde_json::json!(
                        r#"{"output":{"audio":{"url":"https://oss.test/song.mp3?sig=x"},"extra_info":{"lyrics":"[verse]\n雨落"},"finish_reason":"stop"},"usage":{"duration":200}}"#
                    ),
                ],
            )
            .unwrap();
        assert_eq!(
            answered["items"][0]["url"],
            "https://oss.test/song.mp3?sig=x"
        );
        assert_eq!(answered["items"][0]["mime"], "audio/mpeg");
        assert_eq!(answered["text"], "[verse]\n雨落");

        // A 200 that carries no song says so, in the service's own words.
        let empty = rt
            .call_json_value(
                &music,
                "parse_response",
                vec![
                    serde_json::json!(200),
                    serde_json::json!({}),
                    serde_json::json!(r#"{"output":{"audio":{"url":""}}}"#),
                ],
            )
            .unwrap();
        assert!(
            empty["error"].as_str().unwrap().contains("no song"),
            "{empty}"
        );

        let refused = rt
            .call_json_value(
                &music,
                "parse_response",
                vec![
                    serde_json::json!(401),
                    serde_json::json!({}),
                    serde_json::json!(
                        r#"{"code":"InvalidApiKey","message":"the key is not one of ours"}"#
                    ),
                ],
            )
            .unwrap();
        assert!(
            refused["error"]
                .as_str()
                .unwrap()
                .contains("the key is not one of ours"),
            "{refused}"
        );
    }

    /// The clone script as the host runs it: the recording goes to voice
    /// enrollment as a data URL, the id that comes back rides the synthesis
    /// request, and that request's answer is read like any CosyVoice one.
    #[test]
    fn the_bailian_clone_script_enrolls_a_recording_then_speaks_in_its_voice() {
        // Built for a protocol of its own so the memo this test leaves behind
        // is nobody else's to read, whatever runs beside it.
        let rt = LuaRuntime::for_protocol("clone-chain-test").expect("runtime builds");
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let clone = rt
            .load(&scripts.join("models/speech/bailianCloneSpeech/bailian-clone-speech.lua"))
            .unwrap();
        let endpoint = "https://ws.test/api/v1/services/audio/tts/SpeechSynthesizer";
        let recording = "data:audio/wav;base64,UklGRiQAAABXQVZF";

        // The ask carries a recording and names no voice: the first exchange
        // builds the voice from the recording itself, which travels inside
        // the document — nothing needs hosting anywhere for the service to
        // read it.
        let asked = rt
            .call_json_value(
                &clone,
                "build_request",
                vec![
                    serde_json::json!({"url": endpoint, "model": "cosyvoice-v3.5-flash"}),
                    serde_json::json!({"prompt": "hello", "params": {
                        "speed": 1.2, "instructions": "平稳地念"
                    }}),
                    serde_json::json!([{
                        "role": "reference", "filename": "take.wav", "mime": "audio/wav",
                        "data_url": recording, "sha256": "a".repeat(64),
                    }]),
                ],
            )
            .unwrap();
        assert_eq!(asked["handler"], "after_enroll");
        assert_eq!(
            asked["request"]["url"],
            "https://ws.test/api/v1/services/audio/tts/customization"
        );
        let body: serde_json::Value =
            serde_json::from_str(asked["request"]["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["model"], "voice-enrollment");
        assert_eq!(body["input"]["action"], "create_voice");
        // The id a voice is forged as is per the family, so the model the ask
        // was configured for is what the voice is built for.
        assert_eq!(body["input"]["target_model"], "cosyvoice-v3.5-flash");
        assert_eq!(body["input"]["url"], recording);

        // The id the enrollment answered with is spoken with, and the room's
        // settings travel to the synthesis under this service's own names.
        let enrolled = rt
            .call_json_value(
                &clone,
                "after_enroll",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::Value::String(
                        serde_json::json!({
                            "output": {"voice_id": "cosyvoice-v3.5-flash-moka-deadbeef"}
                        })
                        .to_string(),
                    ),
                    asked["state"].clone(),
                ],
            )
            .unwrap();
        assert_eq!(enrolled["next"]["handler"], "parse_speech");
        assert_eq!(enrolled["next"]["request"]["url"], endpoint);
        let body: serde_json::Value = serde_json::from_str(
            enrolled["next"]["request"]["body"]
                .as_str()
                .expect("a JSON body"),
        )
        .unwrap();
        assert_eq!(body["model"], "cosyvoice-v3.5-flash");
        assert_eq!(body["input"]["voice"], "cosyvoice-v3.5-flash-moka-deadbeef");
        assert_eq!(body["input"]["text"], "hello");
        assert_eq!(body["input"]["rate"], 1.2);
        assert_eq!(body["input"]["instruction"], "平稳地念");

        // And that answer is read the way every CosyVoice one is: a link,
        // whose extension names what the audio is.
        let spoke = rt
            .call_json_value(
                &clone,
                "parse_speech",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::json!(
                        r#"{"output":{"audio":{"url":"https://oss.test/voice.mp3?sig=x"}}}"#
                    ),
                ],
            )
            .unwrap();
        assert_eq!(spoke["items"][0]["url"], "https://oss.test/voice.mp3?sig=x");
        assert_eq!(spoke["items"][0]["mime"], "audio/mpeg");
    }

    /// A recording enrolls a voice once: the id is remembered under a key the
    /// recording's digest built, so the next line in the same voice — the
    /// next ask carrying the same file — speaks straight with it, and a
    /// different file is a different voice.
    #[test]
    fn the_bailian_clone_script_enrolls_a_recording_once() {
        let rt = LuaRuntime::for_protocol("clone-memo-test").expect("runtime builds");
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let clone = rt
            .load(&scripts.join("models/speech/bailianCloneSpeech/bailian-clone-speech.lua"))
            .unwrap();
        let endpoint = "https://ws.test/api/v1/services/audio/tts/SpeechSynthesizer";
        let ask = |sha: String| {
            rt.call_json_value(
                &clone,
                "build_request",
                vec![
                    serde_json::json!({"url": endpoint, "model": "cosyvoice-v3.5-flash"}),
                    serde_json::json!({"prompt": "hello", "params": {}}),
                    serde_json::json!([{
                        "role": "reference", "filename": "take.wav", "mime": "audio/wav",
                        "data_url": "data:audio/wav;base64,UklGRiQAAABXQVZF", "sha256": sha,
                    }]),
                ],
            )
            .unwrap()
        };

        // Nothing was remembered for this recording: it enrolls.
        let first = ask("b".repeat(64));
        assert_eq!(first["handler"], "after_enroll");
        assert_eq!(
            first["request"]["url"],
            "https://ws.test/api/v1/services/audio/tts/customization"
        );
        let enrolled = rt
            .call_json_value(
                &clone,
                "after_enroll",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::Value::String(
                        serde_json::json!({"output": {"voice_id": "cosyvoice-v3.5-flash-moka-one"}})
                            .to_string(),
                    ),
                    first["state"].clone(),
                ],
            )
            .unwrap();
        assert_eq!(enrolled["next"]["handler"], "parse_speech");

        // The same recording again: the remembered voice is spoken with, and
        // no second voice is built on the account.
        let second = ask("b".repeat(64));
        assert_eq!(second["handler"], "parse_speech");
        assert_eq!(second["request"]["url"], endpoint);
        let body: serde_json::Value =
            serde_json::from_str(second["request"]["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["input"]["voice"], "cosyvoice-v3.5-flash-moka-one");

        // A different recording is a different voice: nothing is remembered
        // for it, so it enrolls before it speaks.
        let other = ask("c".repeat(64));
        assert_eq!(other["handler"], "after_enroll");
    }

    /// A voice named on the card needs no recording read: the ask synthesizes
    /// straight under that name, with nothing built on the account.
    #[test]
    fn the_bailian_clone_script_speaks_a_named_voice_without_enrolling() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let clone = rt
            .load(&scripts.join("models/speech/bailianCloneSpeech/bailian-clone-speech.lua"))
            .unwrap();
        let endpoint = "https://ws.test/api/v1/services/audio/tts/SpeechSynthesizer";

        let asked = rt
            .call_json_value(
                &clone,
                "build_request",
                vec![
                    serde_json::json!({"url": endpoint, "model": "cosyvoice-v3-flash"}),
                    serde_json::json!({"prompt": "hello", "params": {"voice": "longxiaochun_v2"}}),
                    serde_json::json!([{
                        "role": "reference", "filename": "take.wav", "mime": "audio/wav",
                        "data_url": "data:audio/wav;base64,UklGRiQAAABXQVZF",
                        "sha256": "d".repeat(64),
                    }]),
                ],
            )
            .unwrap();
        assert_eq!(asked["handler"], "parse_speech");
        assert_eq!(asked["request"]["url"], endpoint);
        let body: serde_json::Value =
            serde_json::from_str(asked["request"]["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["model"], "cosyvoice-v3-flash");
        assert_eq!(body["input"]["voice"], "longxiaochun_v2");
    }

    /// The video scripts whose names the built-in protocols also answer to, so
    /// a copy taken as the basis of a model of one's own keeps the ends of a
    /// shot where they were put rather than turning them into references.
    #[test]
    fn the_video_scripts_name_the_frames_a_shot_lands_on() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let picture = |role: &str, url: &str| serde_json::json!({"role": role, "mime": "image/png", "data_url": url});
        // An act filmed whole: its first board, its last, and a shot between.
        let inputs = serde_json::json!([
            picture("firstFrame", "https://img.test/first.png"),
            picture("lastFrame", "https://img.test/last.png"),
            picture("reference", "https://img.test/middle.png"),
        ]);
        let request = serde_json::json!({"prompt": "a slow pan", "params": {"seconds": "6"}});

        let openai = rt
            .load(&scripts.join("models/video/openaiVideos/openai-videos.lua"))
            .unwrap();
        let built = rt
            .call_json_value(
                &openai,
                "build_task_request",
                vec![
                    serde_json::json!({"url": "https://provider.test/v1/videos", "model": "a-video-model"}),
                    request.clone(),
                    inputs.clone(),
                ],
            )
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(built["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["first_frame"], "https://img.test/first.png");
        assert_eq!(body["last_frame"], "https://img.test/last.png");
        assert_eq!(
            body["reference_images"],
            serde_json::json!(["https://img.test/middle.png"])
        );

        // With no pair of ends labelled there is only the count to go on: one
        // picture opens the shot, two open and close it, and three or more are
        // references — no provider takes three frames.
        let ask = |params: serde_json::Value, pictures: serde_json::Value| {
            let built = rt
                .call_json_value(
                    &openai,
                    "build_task_request",
                    vec![
                        serde_json::json!({"url": "https://provider.test/v1/videos", "model": "a-video-model"}),
                        serde_json::json!({"prompt": "a slow pan", "params": params}),
                        pictures,
                    ],
                )
                .unwrap();
            serde_json::from_str::<serde_json::Value>(built["body"].as_str().unwrap())
                .expect("a JSON body")
        };

        let one = ask(
            serde_json::json!({}),
            serde_json::json!([picture("reference", "https://img.test/one.png")]),
        );
        assert_eq!(one["first_frame"], "https://img.test/one.png");
        assert!(one.get("last_frame").is_none(), "{one}");

        let two = ask(
            serde_json::json!({}),
            serde_json::json!([
                picture("reference", "https://img.test/one.png"),
                picture("reference", "https://img.test/two.png"),
            ]),
        );
        assert_eq!(two["first_frame"], "https://img.test/one.png");
        assert_eq!(two["last_frame"], "https://img.test/two.png");

        let three = ask(
            serde_json::json!({}),
            serde_json::json!([
                picture("reference", "https://img.test/one.png"),
                picture("reference", "https://img.test/two.png"),
                picture("reference", "https://img.test/three.png"),
            ]),
        );
        assert!(three.get("first_frame").is_none(), "{three}");
        assert_eq!(
            three["reference_images"],
            serde_json::json!([
                "https://img.test/one.png",
                "https://img.test/two.png",
                "https://img.test/three.png",
            ])
        );

        // A request that asked for references is given references and nothing
        // else, whatever the pictures were labelled.
        let wanted_references = ask(serde_json::json!({"mode": "reference"}), inputs.clone());
        assert!(wanted_references.get("first_frame").is_none());
        assert_eq!(
            wanted_references["reference_images"]
                .as_array()
                .map(Vec::len),
            Some(3),
            "{wanted_references}"
        );

        let gemini = rt
            .load(&scripts.join("models/video/geminiVideo/gemini-video.lua"))
            .unwrap();
        let built = rt
            .call_json_value(
                &gemini,
                "build_task_request",
                vec![
                    serde_json::json!({"url": "https://provider.test/v1beta/models/veo:predictLongRunning", "model": ""}),
                    request,
                    inputs,
                ],
            )
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(built["body"].as_str().unwrap()).expect("a JSON body");
        let shot = &body["instances"][0];
        assert!(shot["image"].is_object(), "{shot}");
        assert!(shot["lastFrame"].is_object(), "{shot}");
        assert_eq!(
            shot["referenceImages"].as_array().map(Vec::len),
            Some(1),
            "{shot}"
        );
    }

    /// A policy answer as the provider writes one, and the state step one left.
    fn policy() -> serde_json::Value {
        serde_json::json!({
            "data": {
                "upload_host": "https://dashscope-file.oss-cn-beijing.aliyuncs.com",
                "upload_dir": "dashscope-instant/2026/09/22/abc",
                "oss_access_key_id": "LTAm5xxx",
                "policy": "eyJleHBpcmF0aW9u",
                "signature": "Sm/tv7DcZuTZftFVvt5yOoSETsc=",
                "x_oss_object_acl": "private",
                "x_oss_forbid_overwrite": "true"
            }
        })
    }

    /// A transcription document as the provider writes one: two speakers, and
    /// two sentences from the first of them.
    fn transcript() -> serde_json::Value {
        serde_json::json!({
            "transcripts": [{
                "channel_id": 0,
                "text": "Hello world, 这里是阿里巴巴语音实验室。第二句。换人了。",
                "sentences": [
                    {"begin_time": 100, "end_time": 3820, "speaker_id": 0,
                     "text": "Hello world, 这里是阿里巴巴语音实验室。"},
                    {"begin_time": 4000, "end_time": 5200, "speaker_id": 0,
                     "text": "第二句。"},
                    {"begin_time": 6000, "end_time": 7000, "speaker_id": 1,
                     "text": "换人了。"}
                ]
            }]
        })
    }

    #[test]
    fn the_bailian_recognition_script_uploads_submits_and_reads_the_transcript() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let asr = rt
            .load(&scripts.join("models/asr/bailianAsr/bailian-asr.lua"))
            .unwrap();
        let endpoint = "https://ws.test/api/v1/services/audio/asr/transcription";

        // Step one: ask where the audio may be put. What the caller asked for
        // rides along, because nothing after this call can see the request.
        let asked = rt
            .call_json_value(
                &asr,
                "build_task_request",
                vec![
                    serde_json::json!({"url": endpoint, "model": "fun-asr"}),
                    serde_json::json!({"prompt": "", "params": {
                        "language": "zh", "speakerCount": 2, "speakerLabel": "说话人{id}："
                    }}),
                    serde_json::json!([{
                        "role": "controlAudio", "filename": "take-1.wav", "mime": "audio/wav"
                    }]),
                ],
            )
            .unwrap();
        assert_eq!(
            asked["request"]["url"],
            "https://ws.test/api/v1/uploads?action=getPolicy&model=fun-asr"
        );
        assert_eq!(asked["handler"], "parse_policy");
        assert_eq!(asked["state"]["parameters"]["language_hints"][0], "zh");
        assert_eq!(asked["state"]["parameters"]["diarization_enabled"], true);
        assert_eq!(asked["state"]["parameters"]["speaker_count"], 2);

        // Step two: the policy names a host, and the audio goes there as a
        // form whose file part is the input this request carried.
        let upload = rt
            .call_json_value(
                &asr,
                "parse_policy",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::Value::String(policy().to_string()),
                    asked["state"].clone(),
                ],
            )
            .unwrap();
        let out = &upload["next"]["request"];
        assert_eq!(
            out["url"],
            "https://dashscope-file.oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(out["body"]["multipart"]["file"]["part"], "file");
        assert_eq!(out["body"]["multipart"]["file"]["input"], 1);
        let fields = &out["body"]["multipart"]["fields"];
        assert_eq!(fields["key"], "dashscope-instant/2026/09/22/abc/take-1.wav");
        assert_eq!(fields["success_action_status"], 200);
        assert_eq!(fields["x-oss-forbid-overwrite"], "true");

        // Step three: with the audio uploaded, the job is submitted against
        // the address the provider can fetch it from.
        let submit = rt
            .call_json_value(
                &asr,
                "parse_upload",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::json!(""),
                    upload["state"].clone(),
                ],
            )
            .unwrap();
        let body: serde_json::Value = serde_json::from_str(
            submit["next"]["request"]["body"]
                .as_str()
                .expect("a JSON body"),
        )
        .unwrap();
        assert_eq!(body["model"], "fun-asr");
        assert_eq!(
            body["input"]["file_urls"][0],
            "oss://dashscope-instant/2026/09/22/abc/take-1.wav"
        );
        assert_eq!(body["parameters"]["language_hints"][0], "zh");
        assert_eq!(
            submit["next"]["request"]["headers"]["X-DashScope-OssResourceResolve"],
            "enable"
        );
        assert_eq!(
            submit["next"]["request"]["headers"]["X-DashScope-Async"],
            "enable"
        );

        // The job's answer names the document with the words in it, which is
        // one more call rather than a field of the answer.
        let polled = rt
            .call_json_value(
                &asr,
                "parse_poll_response",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::Value::String(
                        serde_json::json!({"output": {
                            "task_status": "SUCCEEDED",
                            "results": [{"transcription_url": "https://result.test/1.json"}]
                        }})
                        .to_string(),
                    ),
                ],
            )
            .unwrap();
        assert_eq!(polled["next"]["handler"], "parse_transcription");
        assert_eq!(
            polled["next"]["request"]["url"],
            "https://result.test/1.json"
        );

        // And the document becomes a subtitle file, its times measured from
        // the beginning of the audio that was sent.
        let done = rt
            .call_json_value(
                &asr,
                "parse_transcription",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::json!(transcript().to_string()),
                    submit["state"].clone(),
                ],
            )
            .unwrap();
        assert_eq!(done["status"], "succeeded");
        assert_eq!(
            done["result"]["text"],
            "1\n00:00:00,100 --> 00:00:05,200\n\
             说话人1：Hello world, 这里是阿里巴巴语音实验室。 第二句。\n\n\
             2\n00:00:06,000 --> 00:00:07,000\n说话人2：换人了。\n"
        );
    }

    #[test]
    fn a_recognition_without_speakers_gives_one_cue_per_sentence() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let asr = rt
            .load(&scripts.join("models/asr/bailianAsr/bailian-asr.lua"))
            .unwrap();

        let asked = rt
            .call_json_value(
                &asr,
                "build_task_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/asr", "model": "fun-asr"}),
                    serde_json::json!({"prompt": "", "params": {}}),
                    serde_json::json!([{"role": "controlAudio", "filename": "a.wav"}]),
                ],
            )
            .unwrap();
        // Nothing was asked about speakers, so nothing is asked of the
        // recognizer either: a channel list and nothing else.
        assert_eq!(
            asked["state"]["parameters"]["diarization_enabled"],
            serde_json::Value::Null
        );

        let done = rt
            .call_json_value(
                &asr,
                "parse_transcription",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::json!(transcript().to_string()),
                    asked["state"].clone(),
                ],
            )
            .unwrap();
        assert_eq!(
            done["result"]["text"],
            "1\n00:00:00,100 --> 00:00:03,820\nHello world, 这里是阿里巴巴语音实验室。\n\n\
             2\n00:00:04,000 --> 00:00:05,200\n第二句。\n\n\
             3\n00:00:06,000 --> 00:00:07,000\n换人了。\n"
        );
    }

    #[test]
    fn a_recording_with_nothing_said_is_refused_rather_than_answered() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let asr = rt
            .load(&scripts.join("models/asr/bailianAsr/bailian-asr.lua"))
            .unwrap();
        let done = rt
            .call_json_value(
                &asr,
                "parse_transcription",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::Value::String(
                        serde_json::json!({"transcripts": [{"sentences": []}]}).to_string(),
                    ),
                    serde_json::json!({}),
                ],
            )
            .unwrap();
        assert!(
            done["error"].as_str().unwrap().contains("no speech"),
            "{done}"
        );
    }

    #[test]
    fn base64_encode_decode() {
        let rt = test_runtime();
        let lua = &rt.lua;
        let b64_table: mlua::Table = lua.globals().get("base64").unwrap();
        let encode: Function = b64_table.get("encode").unwrap();
        let decode: Function = b64_table.get("decode").unwrap();

        let encoded: String = encode.call("hello").unwrap();
        assert_eq!(encoded, "aGVsbG8=");

        let decoded: String = decode.call(encoded.clone()).unwrap();
        assert_eq!(decoded, "hello");
    }
}
