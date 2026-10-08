//! Lua API functions registered in the converter runtime.
//!
//! Every converter script can call these globals:
//!
//! - `json.encode(value)` → string     — serde_json::to_string
//! - `json.decode(string)` → value     — serde_json::from_str
//! - `base64.encode(bytes)` → string   — encode to base64
//! - `base64.decode(string)` → bytes   — decode from base64
//! - `log.info(msg)`                   — tracing::info!
//! - `log.warn(msg)`                   — tracing::warn!
//! - `util.default_table()` → table    — empty table with safe __index
//! - `memo_get(key)` → string?         — what was remembered, nil when nothing
//! - `memo_set(key, value)`            — remember a string for a later call
//!
//! Base64 works on bytes rather than on text, because the things it is for —
//! a recording that arrived, a picture that has to travel inside a document —
//! are not text.
//!
//! The memo is where a script leaves something for its later calls — a voice
//! built once from a recording, under a key the recording's digest built. It
//! is the process's memory rather than the project's: nothing is written
//! down, a restart forgets, and each protocol reads only what it wrote
//! itself, so two converters cannot collide.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use mlua::{Lua, Result as LuaResult, Value};

use super::runtime::{json_to_lua, table_to_json};

/// Register all API functions into the Lua globals.
pub fn register(lua: &Lua) -> LuaResult<()> {
    register_json(lua)?;
    register_base64(lua)?;
    register_log(lua)?;
    register_util(lua)?;
    Ok(())
}

fn register_json(lua: &Lua) -> LuaResult<()> {
    let json = lua.create_table()?;
    json.set(
        "encode",
        lua.create_function(|_, value: mlua::Value| {
            let json_val = table_to_json(&value);
            serde_json::to_string(&json_val)
                .map_err(|e| mlua::Error::RuntimeError(format!("json.encode: {e}")))
        })?,
    )?;
    json.set(
        "decode",
        lua.create_function(|lua, text: String| {
            let parsed: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| mlua::Error::RuntimeError(format!("json.decode: {e}")))?;
            json_to_lua(lua, &parsed)
        })?,
    )?;
    lua.globals().set("json", json)?;
    Ok(())
}

fn register_base64(lua: &Lua) -> LuaResult<()> {
    let base64 = lua.create_table()?;
    // Bytes rather than text, both ways: a Lua string carries any bytes, and a
    // converter that has to hand the host a recording it received, or read
    // one it fetched, is working with bytes that are not text.
    base64.set(
        "encode",
        lua.create_function(|_, bytes: mlua::String| Ok(base64_encode(&bytes.as_bytes())))?,
    )?;
    base64.set(
        "decode",
        lua.create_function(|lua, encoded: mlua::String| {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&encoded.as_bytes()[..])
                .map_err(|e| mlua::Error::RuntimeError(format!("base64.decode: {e}")))?;
            lua.create_string(bytes)
        })?,
    )?;
    lua.globals().set("base64", base64)?;
    Ok(())
}

fn register_log(lua: &Lua) -> LuaResult<()> {
    let log = lua.create_table()?;
    log.set(
        "info",
        lua.create_function(|_, msg: String| {
            tracing::info!(target: "moka::converter", "{msg}");
            Ok(())
        })?,
    )?;
    log.set(
        "warn",
        lua.create_function(|_, msg: String| {
            tracing::warn!(target: "moka::converter", "{msg}");
            Ok(())
        })?,
    )?;
    lua.globals().set("log", log)?;
    Ok(())
}

fn register_util(lua: &Lua) -> LuaResult<()> {
    let util = lua.create_table()?;
    util.set(
        "default_table",
        lua.create_function(|lua, ()| {
            let table = lua.create_table()?;
            let mt = lua.create_table()?;
            mt.set(
                "__index",
                lua.create_function(|_, _key: mlua::Value| Ok(Value::Nil))?,
            )?;
            table.set_metatable(Some(mt));
            Ok(table)
        })?,
    )?;
    lua.globals().set("util", util)?;
    Ok(())
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// What converters have left for their later calls, one table per protocol.
fn memo() -> &'static Mutex<HashMap<String, HashMap<String, String>>> {
    static MEMO: OnceLock<Mutex<HashMap<String, HashMap<String, String>>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registers `memo_get` / `memo_set`, scoped to one protocol: what a
/// converter remembers is between it and its own later calls.
pub fn register_memo(lua: &Lua, protocol: &str) -> LuaResult<()> {
    let scope = protocol.to_string();
    lua.globals().set(
        "memo_get",
        lua.create_function(move |_, key: String| {
            let remembered = memo()
                .lock()
                .expect("memo poisoned")
                .get(&scope)
                .and_then(|mine| mine.get(&key))
                .cloned();
            Ok(remembered)
        })?,
    )?;
    let scope = protocol.to_string();
    lua.globals().set(
        "memo_set",
        lua.create_function(move |_, (key, value): (String, String)| {
            memo()
                .lock()
                .expect("memo poisoned")
                .entry(scope.clone())
                .or_default()
                .insert(key, value);
            Ok(())
        })?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_functions_work() {
        let lua = Lua::new();
        register(&lua).unwrap();
        lua.load(
            r#"
            local tbl = {a = 1, b = {2, 3}}
            local encoded = json.encode(tbl)
            -- Re-decode to verify roundtrip (avoid key-order fragility)
            local rt = json.decode(encoded)
            assert(rt.a == 1, "roundtrip a failed: " .. tostring(rt.a))
            assert(rt.b[1] == 2, "roundtrip b[1] failed: " .. tostring(rt.b[1]))
            assert(rt.b[2] == 3, "roundtrip b[2] failed: " .. tostring(rt.b[2]))

            local decoded = json.decode('{"x":"y"}')
            assert(decoded.x == "y", "decode failed")
            "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn base64_roundtrip() {
        let lua = Lua::new();
        register(&lua).unwrap();
        lua.load(
            r#"
            local encoded = base64.encode("hello")
            assert(encoded == "aGVsbG8=", "base64 encode failed: " .. encoded)
            local decoded = base64.decode(encoded)
            assert(decoded == "hello", "base64 decode failed: " .. decoded)
            "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn base64_carries_bytes_that_are_not_text() {
        let lua = Lua::new();
        register(&lua).unwrap();
        // What a recording looks like rather than what a message looks like:
        // these bytes are not UTF-8, and a converter has to be able to hand
        // them over and get them back.
        lua.load(
            r#"
            local bytes = base64.decode("//79AAECAwQF")
            assert(#bytes == 9, "decoded length: " .. #bytes)
            assert(base64.encode(bytes) == "//79AAECAwQF", "roundtrip changed the bytes")
            "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn default_table_does_not_error_on_missing_keys() {
        let lua = Lua::new();
        register(&lua).unwrap();
        lua.load(
            r#"
            local t = util.default_table()
            assert(t.missing == nil, "missing key should be nil")
            assert(t.anything == nil, "any missing key should be nil")
            "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn a_memo_remembers_within_its_own_scope_and_nowhere_else() {
        // Two scopes, as two protocols have: each is its own Lua state, as
        // each call builds its own runtime.
        let one = Lua::new();
        register(&one).unwrap();
        register_memo(&one, "memo-scope-test-one").unwrap();
        let two = Lua::new();
        register(&two).unwrap();
        register_memo(&two, "memo-scope-test-two").unwrap();

        let remembered = |lua: &Lua, key: &str| -> Option<String> {
            let get: mlua::Function = lua.globals().get("memo_get").unwrap();
            get.call(key).unwrap()
        };
        let remember = |lua: &Lua, key: &str, value: &str| {
            let set: mlua::Function = lua.globals().get("memo_set").unwrap();
            set.call::<()>((key, value)).unwrap();
        };

        // A key nobody wrote reads as nothing rather than failing: most calls
        // look and find nothing.
        assert_eq!(remembered(&one, "voice"), None);
        remember(&one, "voice", "cosyvoice-v3.5-flash-moka-1");
        assert_eq!(
            remembered(&one, "voice").as_deref(),
            Some("cosyvoice-v3.5-flash-moka-1")
        );
        // Another protocol's key is not this one's to read.
        assert_eq!(remembered(&two, "voice"), None);
        // And a later write replaces the earlier one.
        remember(&one, "voice", "cosyvoice-v3.5-flash-moka-2");
        assert_eq!(
            remembered(&one, "voice").as_deref(),
            Some("cosyvoice-v3.5-flash-moka-2")
        );
    }
}
