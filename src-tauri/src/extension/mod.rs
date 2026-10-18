//! Extension nodes: canvas nodes whose ports, model slots and behaviour come
//! from a directory under `nodes/`.
//!
//! A definition is a self-contained directory: `node.json` says what the node
//! looks like and what it needs, and the Lua scripts beside it decide what it
//! asks for. The program does not know any definition by name; it reads the
//! directory every time somebody asks, so adding one is adding a directory and
//! removing one is taking that directory away.
//!
//! The scripts are trusted local code, like the converter scripts that speak
//! provider protocols. They still run with no network, no filesystem and no
//! credential of their own: every model call is made by the host, through the
//! same gateway a generation node uses, and only for the models the reader
//! bound to the definition's slots.

pub mod deploy;
pub mod executor;
pub mod manifest;
pub mod registry;
pub mod runtime;

use crate::domain::AssetId;

pub use executor::ExtensionExecutor;
pub use manifest::{LoadProblem, NodeDefinition};
pub use registry::ExtensionRegistry;

/// Whether a string may name a port, a slot, a parameter module or a directory
/// reference: a letter, then letters, digits and underscores.
pub fn valid_identifier(id: &str) -> bool {
    let mut characters = id.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    id.len() <= 64
        && first.is_ascii_alphabetic()
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// Whether a parameter key is shaped like one: lowercase first, then letters,
/// digits and underscores.
pub fn valid_parameter_key(key: &str) -> bool {
    let mut characters = key.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    key.len() <= 32
        && first.is_ascii_lowercase()
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// Whether a string is a bare `.lua` filename: no directories, no climbing,
/// and not the document itself.
pub fn valid_script_name(name: &str) -> bool {
    !name.is_empty()
        && name != "node.json"
        && name.ends_with(".lua")
        && !name.contains('/')
        && !name.contains('\\')
        && std::path::Path::new(name).file_name() == Some(std::ffi::OsStr::new(name))
}

/// Whether a directory name may be a definition id.
pub fn valid_directory_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && !id.contains("..")
        && id.starts_with(|character: char| {
            character.is_ascii_lowercase() || character.is_ascii_digit()
        })
        && id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

/// Whether an asset id names something this step made or was given.
pub fn owned_asset(
    asset_id: &AssetId,
    input_ids: &std::collections::HashSet<AssetId>,
    created_ids: &std::collections::HashSet<AssetId>,
) -> bool {
    input_ids.contains(asset_id) || created_ids.contains(asset_id)
}
