//! The in-app agent: a tool catalog, one chat step, project-local sessions,
//! and the executor that turns a tool call into document commands or a
//! guarded external effect.
//!
//! The loop lives in the interface; this module is the half that must also
//! serve the CLI, MCP, and third-party agents. Nothing here reads the
//! browser's state, so a tool has the same meaning whoever called it.

#![allow(clippy::result_large_err)]

// A tool refusal carries a code, a sentence, and structured details. Boxing
// it to satisfy a size heuristic would make every `?` allocate on the error
// path — the path that is already going wrong.

pub mod catalog;
pub mod chat;
pub mod context;
pub mod error;
pub mod journal;
pub mod prompt;
pub mod protocol;
pub mod runner;
pub mod sessions;
pub mod tools;
