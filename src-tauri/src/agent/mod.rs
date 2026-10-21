//! The in-app agent: a tool catalog, one chat step, project-local sessions,
//! and the executor that turns a tool call into document commands or a
//! guarded external effect.
//!
//! The loop lives in the interface; this module is the half that must also
//! serve the CLI, MCP, and third-party agents. Nothing here reads the
//! browser's state, so a tool has the same meaning whoever called it.

pub mod catalog;
pub mod chat;
pub mod context;
pub mod prompt;
pub mod protocol;
