//! One extension node's definition: its `node.json`, the scripts beside it,
//! and the contract that decides whether a node may run against it.
//!
//! Everything here is read from a directory under `nodes/`. A document says
//! only which definition it was inserted from and which contract it was drawn
//! against; the ports, model slots and parameters themselves live here, on the
//! machine, and are never carried by a project.
//!
//! Validation is deliberately strict. A misspelt `output` would otherwise load
//! as a node with no output ports, and a default outside its own range would
//! only be refused once somebody pressed Run. Both are reported when the
//! directory is read, with the field that is wrong.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::Digest;

use crate::domain::{Capability, Cardinality, DataType, PortDefinition, PortDirection};

/// The host contract this build implements. A definition that declares a
/// version above this one is refused with an explanation rather than run
/// against rules it was not written for.
pub const EXTENSION_API_VERSION: u32 = 1;

/// How large one Lua file may be, and how large all of a definition's scripts
/// together may be. These are safety bounds, not settings.
pub const MAX_SCRIPT_BYTES: u64 = 256 * 1024;
pub const MAX_SCRIPTS_BYTES: u64 = 1024 * 1024;

/// How many model slots and parameters one definition may declare.
pub const MAX_MODEL_SLOTS: usize = 16;
pub const MAX_PARAMETERS: usize = 32;

/// How large resolved parameters may be, serialized.
pub const MAX_PARAMETER_BYTES: usize = 64 * 1024;

/// The default and ceiling of every step limit, in the order a definition
/// states them. A definition may tighten a limit, never raise it past the
/// ceiling; a value over the ceiling is clamped and reported in the effective
/// limits rather than refused.
const DEFAULT_TIMEOUT_SECONDS: u64 = 600;
const MAX_TIMEOUT_SECONDS: u64 = 1_800;
const DEFAULT_MODEL_CALLS: u32 = 8;
const MAX_MODEL_CALLS: u32 = 32;
const DEFAULT_OUTPUT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_OUTPUT_ITEMS: u32 = 4;
const MAX_OUTPUT_ITEMS: u32 = 8;
const DEFAULT_TEXT_BYTES: u64 = 64 * 1024;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
const DEFAULT_LOG_BYTES: u64 = 16 * 1024;
const MAX_LOG_BYTES: u64 = 64 * 1024;

const DEFAULT_ICON: &str = "generic";
const DEFAULT_ACCENT: &str = "violet";
const DEFAULT_ORDER: u32 = 1000;
const DEFAULT_STRING_MAX_LENGTH: usize = 2_000;
const MAX_STRING_MAX_LENGTH: usize = 20_000;

/// The icons and accents a definition may name. An unknown token is not an
/// error: it falls back to the default, so a definition written for a newer
/// host still inserts and merely looks plainer.
const ICONS: [&str; 8] = [
    "generic",
    "sparkles",
    "panels",
    "storyboard",
    "speech",
    "transcribe",
    "compose",
    "mix",
];
const ACCENTS: [&str; 6] = ["violet", "blue", "green", "amber", "rose", "slate"];

/// A directory that could not become a definition, and why. Reported beside
/// the definitions that did load rather than failing the whole directory read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadProblem {
    pub id: String,
    pub code: String,
    pub message: String,
}

impl LoadProblem {
    pub fn new(id: impl Into<String>, code: &str, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// A port as a definition states it, localized labels included. The shape the
/// client copies onto the node for rendering and wiring.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionPort {
    pub id: String,
    pub direction: PortDirection,
    pub data_types: Vec<DataType>,
    pub required: bool,
    pub cardinality: Cardinality,
    pub label: String,
    pub labels: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub description_labels: BTreeMap<String, String>,
    pub primary: bool,
}

impl DefinitionPort {
    /// The port as a document carries it: the snapshot copied onto a node.
    pub fn snapshot(&self) -> PortDefinition {
        PortDefinition {
            id: self.id.clone(),
            direction: self.direction,
            data_types: self.data_types.clone(),
            required: self.required,
            cardinality: self.cardinality,
            label: self.label.clone(),
        }
    }
}

/// One model slot. A slot is one model: two pictures want two slots with two
/// names, so a script and a log can say which of them made what.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionSlot {
    pub id: String,
    pub capability: Capability,
    pub required: bool,
    pub label: String,
    pub labels: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub description_labels: BTreeMap<String, String>,
}

/// The scalar parameter types v1 supports. Objects, arrays and file references
/// are not among them: reference media travels through an input port.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParameterType {
    String,
    Number,
    Integer,
    Boolean,
    Enum,
}

impl ParameterType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Number => "number",
            Self::Integer => "integer",
            Self::Boolean => "boolean",
            Self::Enum => "enum",
        }
    }
}

/// One parameter, and everything the panel needs to draw and check it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionParameter {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: ParameterType,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    pub label: String,
    pub labels: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub description_labels: BTreeMap<String, String>,
    pub multiline: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
    pub options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
}

impl DefinitionParameter {
    fn string_max_length(&self) -> usize {
        self.max_length
            .unwrap_or(DEFAULT_STRING_MAX_LENGTH)
            .min(MAX_STRING_MAX_LENGTH)
    }
}

/// The step limits as they actually apply: the definition's own where it
/// stated one, clamped to what the host is willing to allow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveLimits {
    pub timeout_seconds: u64,
    pub max_model_calls: u32,
    pub max_output_bytes: u64,
    pub max_output_items_per_port: u32,
    pub max_text_bytes: u64,
    pub max_log_bytes: u64,
}

impl Default for EffectiveLimits {
    fn default() -> Self {
        Self {
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
            max_model_calls: DEFAULT_MODEL_CALLS,
            max_output_bytes: DEFAULT_OUTPUT_BYTES,
            max_output_items_per_port: DEFAULT_OUTPUT_ITEMS,
            max_text_bytes: DEFAULT_TEXT_BYTES,
            max_log_bytes: DEFAULT_LOG_BYTES,
        }
    }
}

/// A loaded definition. `serialize` is what `GET /extensions/nodes` shows;
/// the script sources and the directory stay on this side of the wire.
#[derive(Debug, Clone)]
pub struct NodeDefinition {
    pub id: String,
    pub version: u32,
    pub api_version: u32,
    pub display_name: String,
    pub labels: BTreeMap<String, String>,
    pub description: Option<String>,
    pub description_labels: BTreeMap<String, String>,
    pub order: u32,
    pub icon: String,
    pub accent: String,
    pub inputs: Vec<DefinitionPort>,
    pub outputs: Vec<DefinitionPort>,
    pub models: Vec<DefinitionSlot>,
    pub parameters: Vec<DefinitionParameter>,
    pub limits: EffectiveLimits,
    pub contract_hash: String,
    /// The entry script, a bare filename beside `node.json`.
    pub script: String,
    /// The entry script's source, read with the rest of the definition so a
    /// run sees what was validated rather than whatever is on disk by then.
    pub entry_source: String,
    /// The helper scripts a definition may `require`, keyed by module name.
    /// The entry script is not among them.
    pub scripts: BTreeMap<String, String>,
    pub dir: std::path::PathBuf,
}

/// What the directory endpoint returns for one definition.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionView<'a> {
    pub id: &'a str,
    pub version: u32,
    pub api_version: u32,
    pub display_name: &'a str,
    pub labels: &'a BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'a str>,
    pub description_labels: &'a BTreeMap<String, String>,
    pub order: u32,
    pub icon: &'a str,
    pub accent: &'a str,
    pub inputs: &'a [DefinitionPort],
    pub outputs: &'a [DefinitionPort],
    pub models: &'a [DefinitionSlot],
    pub parameters: &'a [DefinitionParameter],
    pub contract_hash: &'a str,
    pub limits: EffectiveLimits,
}

impl NodeDefinition {
    pub fn view(&self) -> DefinitionView<'_> {
        DefinitionView {
            id: &self.id,
            version: self.version,
            api_version: self.api_version,
            display_name: &self.display_name,
            labels: &self.labels,
            description: self.description.as_deref(),
            description_labels: &self.description_labels,
            order: self.order,
            icon: &self.icon,
            accent: &self.accent,
            inputs: &self.inputs,
            outputs: &self.outputs,
            models: &self.models,
            parameters: &self.parameters,
            contract_hash: &self.contract_hash,
            limits: self.limits,
        }
    }

    pub fn input(&self, id: &str) -> Option<&DefinitionPort> {
        self.inputs.iter().find(|port| port.id == id)
    }

    pub fn output(&self, id: &str) -> Option<&DefinitionPort> {
        self.outputs.iter().find(|port| port.id == id)
    }

    pub fn slot(&self, id: &str) -> Option<&DefinitionSlot> {
        self.models.iter().find(|slot| slot.id == id)
    }

    pub fn parameter(&self, key: &str) -> Option<&DefinitionParameter> {
        self.parameters
            .iter()
            .find(|parameter| parameter.key == key)
    }

    /// The port the card shows as the node's own answer: the one the
    /// definition marks, or the first that can produce media, or the first
    /// output. A card always has something to show.
    pub fn primary_output(&self) -> Option<&DefinitionPort> {
        self.outputs
            .iter()
            .find(|port| port.primary)
            .or_else(|| {
                self.outputs.iter().find(|port| {
                    port.data_types
                        .iter()
                        .any(|kind| *kind != DataType::Text && *kind != DataType::Timeline)
                })
            })
            .or_else(|| self.outputs.first())
    }

    /// The parameter values a run hands the script: declared defaults, then
    /// whatever the node says, checked against the declaration. Keys the
    /// definition does not declare are not passed on; they stay on the node so
    /// a parameter the definition temporarily lacks is not lost.
    pub fn resolved_parameters(
        &self,
        given: Option<&serde_json::Value>,
    ) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        let given = match given {
            None | Some(serde_json::Value::Null) => serde_json::Map::new(),
            Some(serde_json::Value::Object(map)) => map.clone(),
            Some(_) => return Err("parameters must be an object".to_string()),
        };
        let mut resolved = serde_json::Map::new();
        for parameter in &self.parameters {
            let value = match given.get(&parameter.key) {
                Some(value) if !value.is_null() => value.clone(),
                _ => match &parameter.default {
                    Some(default) => default.clone(),
                    None if parameter.required => {
                        return Err(format!(
                            "parameter \"{}\" is required and has no value",
                            parameter.key
                        ))
                    }
                    None => continue,
                },
            };
            let value = check_parameter(parameter, &value)?;
            resolved.insert(parameter.key.clone(), value);
        }
        let bytes = serde_json::to_vec(&resolved)
            .map(|held| held.len())
            .unwrap_or(usize::MAX);
        if bytes > MAX_PARAMETER_BYTES {
            return Err(format!(
                "parameters exceed {MAX_PARAMETER_BYTES} bytes once resolved"
            ));
        }
        Ok(resolved)
    }

    /// The default value of every parameter that states one, for a node being
    /// inserted.
    pub fn default_parameters(&self) -> serde_json::Map<String, serde_json::Value> {
        self.parameters
            .iter()
            .filter_map(|parameter| {
                parameter
                    .default
                    .as_ref()
                    .map(|value| (parameter.key.clone(), value.clone()))
            })
            .collect()
    }
}

/// Validates a submitted value against one parameter's declaration.
fn check_parameter(
    parameter: &DefinitionParameter,
    value: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let named = &parameter.key;
    match parameter.kind {
        ParameterType::String => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("parameter \"{named}\" must be a string"))?;
            let limit = parameter.string_max_length();
            if text.chars().count() > limit {
                return Err(format!("parameter \"{named}\" exceeds {limit} characters"));
            }
            Ok(value.clone())
        }
        ParameterType::Number => {
            let number = value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("parameter \"{named}\" must be a number"))?;
            if parameter.min.is_some_and(|min| number < min) {
                return Err(format!(
                    "parameter \"{named}\" is below its minimum of {}",
                    parameter.min.unwrap_or_default()
                ));
            }
            if parameter.max.is_some_and(|max| number > max) {
                return Err(format!(
                    "parameter \"{named}\" is above its maximum of {}",
                    parameter.max.unwrap_or_default()
                ));
            }
            Ok(value.clone())
        }
        ParameterType::Integer => {
            let number = value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
                .or_else(|| {
                    value
                        .as_f64()
                        .filter(|number| number.is_finite() && number.fract() == 0.0)
                        .map(|number| number as i64)
                })
                .ok_or_else(|| format!("parameter \"{named}\" must be an integer"))?;
            if parameter.min.is_some_and(|min| (number as f64) < min) {
                return Err(format!("parameter \"{named}\" is below its minimum"));
            }
            if parameter.max.is_some_and(|max| (number as f64) > max) {
                return Err(format!("parameter \"{named}\" is above its maximum"));
            }
            Ok(serde_json::Value::Number(number.into()))
        }
        ParameterType::Boolean => value
            .as_bool()
            .map(serde_json::Value::Bool)
            .ok_or_else(|| format!("parameter \"{named}\" must be true or false")),
        ParameterType::Enum => {
            let chosen = value
                .as_str()
                .ok_or_else(|| format!("parameter \"{named}\" must be one of its options"))?;
            if !parameter.options.iter().any(|option| option == chosen) {
                return Err(format!(
                    "parameter \"{named}\" is \"{chosen}\", which is not one of its options"
                ));
            }
            Ok(value.clone())
        }
    }
}

// ---------------------------------------------------------------------------
// Reading a directory
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    api_version: u32,
    #[serde(default)]
    version: u32,
    display_name: String,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    description_labels: BTreeMap<String, String>,
    script: String,
    #[serde(default = "default_order")]
    order: u32,
    #[serde(default = "default_icon")]
    icon: String,
    #[serde(default = "default_accent")]
    accent: String,
    inputs: Vec<ManifestPort>,
    outputs: Vec<ManifestPort>,
    models: Vec<ManifestSlot>,
    #[serde(default)]
    parameters: Vec<ManifestParameter>,
    #[serde(default)]
    limits: ManifestLimits,
}

fn default_order() -> u32 {
    DEFAULT_ORDER
}

fn one_cardinality() -> Cardinality {
    Cardinality::One
}

fn data_type_name(kind: DataType) -> &'static str {
    match kind {
        DataType::Text => "text",
        DataType::Image => "image",
        DataType::Audio => "audio",
        DataType::Video => "video",
        DataType::Timeline => "timeline",
        DataType::Artifact => "artifact",
    }
}

fn default_icon() -> String {
    DEFAULT_ICON.to_string()
}

fn default_accent() -> String {
    DEFAULT_ACCENT.to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestPort {
    id: String,
    data_types: Vec<DataType>,
    #[serde(default)]
    required: bool,
    #[serde(default = "one_cardinality")]
    cardinality: Cardinality,
    label: String,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    description_labels: BTreeMap<String, String>,
    #[serde(default)]
    primary: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestSlot {
    id: String,
    capability: Capability,
    #[serde(default)]
    required: bool,
    label: String,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    description_labels: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestParameter {
    key: String,
    #[serde(rename = "type")]
    kind: ParameterType,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    default: Option<serde_json::Value>,
    label: String,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    description_labels: BTreeMap<String, String>,
    #[serde(default)]
    multiline: bool,
    #[serde(default)]
    min: Option<f64>,
    #[serde(default)]
    max: Option<f64>,
    #[serde(default)]
    step: Option<f64>,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    max_length: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestLimits {
    timeout_seconds: Option<u64>,
    max_model_calls: Option<u32>,
    max_output_bytes: Option<u64>,
    max_output_items_per_port: Option<u32>,
    max_text_bytes: Option<u64>,
    max_log_bytes: Option<u64>,
}

/// Reads one definition directory. `id` is the directory name, checked by the
/// caller against the same rule a definition id must satisfy.
pub fn load(dir: &Path, id: &str) -> Result<NodeDefinition, LoadProblem> {
    let document = dir.join("node.json");
    let text = std::fs::read_to_string(&document).map_err(|error| {
        LoadProblem::new(
            id,
            "EXTENSION_MANIFEST_INVALID",
            format!("node.json could not be read: {error}"),
        )
    })?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|error| {
        LoadProblem::new(
            id,
            "EXTENSION_MANIFEST_INVALID",
            format!("node.json does not parse: {error}"),
        )
    })?;
    validate(manifest, dir, id)
}

fn validate(manifest: Manifest, dir: &Path, id: &str) -> Result<NodeDefinition, LoadProblem> {
    let invalid = |message: String| LoadProblem::new(id, "EXTENSION_MANIFEST_INVALID", message);

    if manifest.api_version != EXTENSION_API_VERSION {
        return Err(LoadProblem::new(
            id,
            "EXTENSION_API_VERSION_UNSUPPORTED",
            format!(
                "apiVersion {} is not supported (this build implements {EXTENSION_API_VERSION})",
                manifest.api_version
            ),
        ));
    }
    if manifest.display_name.trim().is_empty() {
        return Err(invalid("displayName is empty".into()));
    }
    check_labels("labels", &manifest.labels).map_err(invalid)?;
    check_labels("descriptionLabels", &manifest.description_labels).map_err(invalid)?;
    if let Some(description) = &manifest.description {
        if description.trim().is_empty() {
            return Err(invalid("description is empty; leave it out instead".into()));
        }
    }

    let (script, entry_source, scripts) = read_scripts(dir, id, &manifest.script)?;

    let mut port_ids = HashSet::new();
    let inputs = read_ports(
        "inputs",
        manifest.inputs,
        PortDirection::Input,
        &mut port_ids,
    )
    .map_err(invalid)?;
    let outputs = read_ports(
        "outputs",
        manifest.outputs,
        PortDirection::Output,
        &mut port_ids,
    )
    .map_err(invalid)?;
    if outputs.is_empty() {
        return Err(invalid(
            "a definition needs at least one output port".into(),
        ));
    }
    if outputs.iter().filter(|port| port.primary).count() > 1 {
        return Err(invalid(
            "more than one output port is marked primary".into(),
        ));
    }

    if manifest.models.len() > MAX_MODEL_SLOTS {
        return Err(invalid(format!(
            "a definition may declare at most {MAX_MODEL_SLOTS} model slots"
        )));
    }
    let mut slot_ids = HashSet::new();
    let mut models = Vec::with_capacity(manifest.models.len());
    for slot in manifest.models {
        if !super::valid_identifier(&slot.id) {
            return Err(invalid(format!(
                "model slot id \"{}\" is not usable",
                slot.id
            )));
        }
        if !slot_ids.insert(slot.id.clone()) {
            return Err(invalid(format!(
                "model slot id \"{}\" is declared twice",
                slot.id
            )));
        }
        if slot.label.trim().is_empty() {
            return Err(invalid(format!("model slot \"{}\" has no label", slot.id)));
        }
        check_labels(&format!("model slot \"{}\" labels", slot.id), &slot.labels)
            .map_err(invalid)?;
        check_labels(
            &format!("model slot \"{}\" descriptionLabels", slot.id),
            &slot.description_labels,
        )
        .map_err(invalid)?;
        models.push(DefinitionSlot {
            id: slot.id,
            capability: slot.capability,
            required: slot.required,
            label: slot.label,
            labels: slot.labels,
            description: slot.description,
            description_labels: slot.description_labels,
        });
    }

    if manifest.parameters.len() > MAX_PARAMETERS {
        return Err(invalid(format!(
            "a definition may declare at most {MAX_PARAMETERS} parameters"
        )));
    }
    let mut parameter_keys = HashSet::new();
    let mut parameters = Vec::with_capacity(manifest.parameters.len());
    for parameter in manifest.parameters {
        if !super::valid_parameter_key(&parameter.key) {
            return Err(invalid(format!(
                "parameter key \"{}\" is not usable",
                parameter.key
            )));
        }
        if !parameter_keys.insert(parameter.key.clone()) {
            return Err(invalid(format!(
                "parameter key \"{}\" is declared twice",
                parameter.key
            )));
        }
        parameters.push(read_parameter(parameter).map_err(invalid)?);
    }

    let limits = read_limits(manifest.limits).map_err(invalid)?;
    let icon = if ICONS.contains(&manifest.icon.as_str()) {
        manifest.icon
    } else {
        DEFAULT_ICON.to_string()
    };
    let accent = if ACCENTS.contains(&manifest.accent.as_str()) {
        manifest.accent
    } else {
        DEFAULT_ACCENT.to_string()
    };

    let (inputs, outputs) = (inputs, outputs);
    let contract_hash = contract_hash(
        &inputs,
        &outputs,
        &models,
        &parameters,
        manifest.api_version,
    );

    Ok(NodeDefinition {
        id: id.to_string(),
        version: manifest.version,
        api_version: manifest.api_version,
        display_name: manifest.display_name,
        labels: manifest.labels,
        description: manifest.description,
        description_labels: manifest.description_labels,
        order: manifest.order,
        icon,
        accent,
        inputs,
        outputs,
        models,
        parameters,
        limits,
        contract_hash,
        script,
        entry_source,
        scripts,
        dir: dir.to_path_buf(),
    })
}

fn check_labels(field: &str, labels: &BTreeMap<String, String>) -> Result<(), String> {
    for (locale, label) in labels {
        if locale.trim().is_empty() {
            return Err(format!("{field} has an empty language key"));
        }
        if label.trim().is_empty() {
            return Err(format!("{field}.{locale} is empty"));
        }
    }
    Ok(())
}

fn read_ports(
    field: &str,
    ports: Vec<ManifestPort>,
    direction: PortDirection,
    ids: &mut HashSet<String>,
) -> Result<Vec<DefinitionPort>, String> {
    let mut read = Vec::with_capacity(ports.len());
    for port in ports {
        if !super::valid_identifier(&port.id) {
            return Err(format!("{field}: port id \"{}\" is not usable", port.id));
        }
        if !ids.insert(port.id.clone()) {
            return Err(format!(
                "{field}: port id \"{}\" is declared twice",
                port.id
            ));
        }
        if port.label.trim().is_empty() {
            return Err(format!("{field}: port \"{}\" has no label", port.id));
        }
        check_labels(&format!("{field}.{}.labels", port.id), &port.labels)?;
        check_labels(
            &format!("{field}.{}.descriptionLabels", port.id),
            &port.description_labels,
        )?;
        if port.data_types.is_empty() {
            return Err(format!(
                "{field}: port \"{}\" declares no data types",
                port.id
            ));
        }
        let mut seen: Vec<DataType> = Vec::new();
        for kind in &port.data_types {
            if *kind == DataType::Timeline {
                return Err(format!(
                    "{field}: port \"{}\" declares timeline, which an extension cannot make",
                    port.id
                ));
            }
            if seen.contains(kind) {
                return Err(format!(
                    "{field}: port \"{}\" declares a data type twice",
                    port.id
                ));
            }
            seen.push(*kind);
        }
        if direction == PortDirection::Input && port.primary {
            return Err(format!(
                "{field}: port \"{}\" marks an input as primary; only outputs may be",
                port.id
            ));
        }
        read.push(DefinitionPort {
            id: port.id,
            direction,
            data_types: port.data_types,
            required: port.required,
            cardinality: port.cardinality,
            label: port.label,
            labels: port.labels,
            description: port.description,
            description_labels: port.description_labels,
            primary: port.primary,
        });
    }
    Ok(read)
}

fn read_parameter(parameter: ManifestParameter) -> Result<DefinitionParameter, String> {
    let named = &parameter.key;
    if parameter.label.trim().is_empty() {
        return Err(format!("parameter \"{named}\" has no label"));
    }
    check_labels(&format!("parameter \"{named}\" labels"), &parameter.labels)?;
    check_labels(
        &format!("parameter \"{named}\" descriptionLabels"),
        &parameter.description_labels,
    )?;
    if parameter.multiline && parameter.kind != ParameterType::String {
        return Err(format!(
            "parameter \"{named}\" is multiline but is not a string"
        ));
    }
    let mut options = parameter.options;
    match parameter.kind {
        ParameterType::Enum => {
            if options.is_empty() {
                return Err(format!("parameter \"{named}\" is an enum with no options"));
            }
            let mut seen = HashSet::new();
            for option in &options {
                if option.is_empty() {
                    return Err(format!("parameter \"{named}\" has an empty option"));
                }
                if !seen.insert(option.clone()) {
                    return Err(format!(
                        "parameter \"{named}\" lists option \"{option}\" twice"
                    ));
                }
            }
        }
        _ if !options.is_empty() => {
            return Err(format!(
                "parameter \"{named}\" lists options but is not an enum"
            ));
        }
        _ => {}
    }
    if let Some(min) = parameter.min {
        if !min.is_finite() {
            return Err(format!("parameter \"{named}\" has a non-finite minimum"));
        }
    }
    if let Some(max) = parameter.max {
        if !max.is_finite() {
            return Err(format!("parameter \"{named}\" has a non-finite maximum"));
        }
    }
    if let (Some(min), Some(max)) = (parameter.min, parameter.max) {
        if min > max {
            return Err(format!(
                "parameter \"{named}\" has a minimum above its maximum"
            ));
        }
    }
    if let Some(step) = parameter.step {
        if !step.is_finite() || step <= 0.0 {
            return Err(format!("parameter \"{named}\" has an unusable step"));
        }
    }
    if let Some(max_length) = parameter.max_length {
        if max_length == 0 || max_length > MAX_STRING_MAX_LENGTH {
            return Err(format!(
                "parameter \"{named}\" has a maxLength outside 1..{MAX_STRING_MAX_LENGTH}"
            ));
        }
        if parameter.kind != ParameterType::String {
            return Err(format!(
                "parameter \"{named}\" states maxLength but is not a string"
            ));
        }
    }
    options.sort();
    let read = DefinitionParameter {
        key: parameter.key,
        kind: parameter.kind,
        required: parameter.required,
        default: parameter.default,
        label: parameter.label,
        labels: parameter.labels,
        description: parameter.description,
        description_labels: parameter.description_labels,
        multiline: parameter.multiline,
        min: parameter.min,
        max: parameter.max,
        step: parameter.step,
        options,
        max_length: parameter.max_length,
    };
    // A default is part of the declaration, so a bad one is a defect in the
    // definition rather than something to discover when the node runs.
    if let Some(default) = &read.default {
        check_parameter(&read, default).map_err(|message| {
            format!(
                "parameter \"{}\" has an unusable default: {message}",
                read.key
            )
        })?;
    }
    Ok(read)
}

fn read_limits(limits: ManifestLimits) -> Result<EffectiveLimits, String> {
    let positive = |name: &str, value: Option<u64>| -> Result<Option<u64>, String> {
        match value {
            Some(0) => Err(format!("limits.{name} must be positive")),
            Some(value) => Ok(Some(value)),
            None => Ok(None),
        }
    };
    let mut effective = EffectiveLimits::default();
    if let Some(value) = positive("timeoutSeconds", limits.timeout_seconds)? {
        effective.timeout_seconds = value.min(MAX_TIMEOUT_SECONDS);
    }
    if let Some(value) = positive("maxModelCalls", limits.max_model_calls.map(u64::from))? {
        effective.max_model_calls =
            u32::try_from(value.min(u64::from(MAX_MODEL_CALLS))).unwrap_or(MAX_MODEL_CALLS);
    }
    if let Some(value) = positive("maxOutputBytes", limits.max_output_bytes)? {
        effective.max_output_bytes = value.min(MAX_OUTPUT_BYTES);
    }
    if let Some(value) = positive(
        "maxOutputItemsPerPort",
        limits.max_output_items_per_port.map(u64::from),
    )? {
        effective.max_output_items_per_port =
            u32::try_from(value.min(u64::from(MAX_OUTPUT_ITEMS))).unwrap_or(MAX_OUTPUT_ITEMS);
    }
    if let Some(value) = positive("maxTextBytes", limits.max_text_bytes)? {
        effective.max_text_bytes = value.min(MAX_TEXT_BYTES);
    }
    if let Some(value) = positive("maxLogBytes", limits.max_log_bytes)? {
        effective.max_log_bytes = value.min(MAX_LOG_BYTES);
    }
    Ok(effective)
}

/// Reads the entry script and every helper beside the document.
///
/// A `.lua` that is a link, a directory, or not UTF-8 is refused rather than
/// ignored: a definition whose scripts differ from what its directory says is
/// a definition nobody can reason about. A helper whose name is not a valid
/// module name is simply not loadable, and is left out of the module table.
fn read_scripts(
    dir: &Path,
    id: &str,
    named: &str,
) -> Result<(String, String, BTreeMap<String, String>), LoadProblem> {
    if !super::valid_script_name(named) {
        return Err(LoadProblem::new(
            id,
            "EXTENSION_SCRIPT_MISSING",
            format!("script \"{named}\" is not a .lua filename beside node.json"),
        ));
    }
    let entry = dir.join(named);
    let metadata = std::fs::symlink_metadata(&entry).map_err(|_| {
        LoadProblem::new(
            id,
            "EXTENSION_SCRIPT_MISSING",
            format!("script \"{named}\" is not beside node.json"),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LoadProblem::new(
            id,
            "EXTENSION_SCRIPT_MISSING",
            format!("script \"{named}\" is not a regular file beside node.json"),
        ));
    }
    if metadata.len() > MAX_SCRIPT_BYTES {
        return Err(LoadProblem::new(
            id,
            "EXTENSION_SCRIPT_TOO_LARGE",
            format!("script \"{named}\" exceeds {MAX_SCRIPT_BYTES} bytes"),
        ));
    }

    let mut entry_source = String::new();
    let mut scripts = BTreeMap::new();
    let mut total = 0u64;
    let entries = std::fs::read_dir(dir).map_err(|error| {
        LoadProblem::new(
            id,
            "EXTENSION_MANIFEST_INVALID",
            format!("the definition directory could not be read: {error}"),
        )
    })?;
    for item in entries.flatten() {
        let path = item.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("lua") {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            LoadProblem::new(
                id,
                "EXTENSION_SCRIPT_MISSING",
                format!("script \"{name}\" could not be read: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(LoadProblem::new(
                id,
                "EXTENSION_SCRIPT_MISSING",
                format!("script \"{name}\" is not a regular file"),
            ));
        }
        total += metadata.len();
        let source = std::fs::read_to_string(&path).map_err(|error| {
            LoadProblem::new(
                id,
                "EXTENSION_MANIFEST_INVALID",
                format!("script \"{name}\" is not readable UTF-8: {error}"),
            )
        })?;
        if name == named {
            if metadata.len() > MAX_SCRIPT_BYTES {
                return Err(LoadProblem::new(
                    id,
                    "EXTENSION_SCRIPT_TOO_LARGE",
                    format!("script \"{name}\" exceeds {MAX_SCRIPT_BYTES} bytes"),
                ));
            }
            entry_source = source;
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
            if super::valid_identifier(stem) {
                scripts.insert(stem.to_string(), source);
            }
        }
    }
    if total > MAX_SCRIPTS_BYTES {
        return Err(LoadProblem::new(
            id,
            "EXTENSION_SCRIPT_TOO_LARGE",
            format!("the definition's scripts exceed {MAX_SCRIPTS_BYTES} bytes together"),
        ));
    }
    Ok((named.to_string(), entry_source, scripts))
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/// The hash a node records when it is inserted, and a run compares before it
/// starts. Only what changes execution is inside: ports, slots, parameters and
/// the API version. Names, order, colours, limits and the script itself are
/// not.
pub fn contract_hash(
    inputs: &[DefinitionPort],
    outputs: &[DefinitionPort],
    models: &[DefinitionSlot],
    parameters: &[DefinitionParameter],
    api_version: u32,
) -> String {
    let mut ports: Vec<serde_json::Value> = inputs
        .iter()
        .chain(outputs.iter())
        .map(|port| {
            let mut kinds: Vec<&str> = port
                .data_types
                .iter()
                .copied()
                .map(data_type_name)
                .collect();
            kinds.sort_unstable();
            serde_json::json!({
                "id": port.id,
                "direction": match port.direction {
                    PortDirection::Input => "input",
                    PortDirection::Output => "output",
                },
                "dataTypes": kinds,
                "required": port.required,
                "cardinality": match port.cardinality {
                    Cardinality::One => "one",
                    Cardinality::Many => "many",
                },
                "primary": port.primary,
            })
        })
        .collect();
    ports.sort_by(|one, two| {
        one["id"]
            .as_str()
            .unwrap_or_default()
            .cmp(two["id"].as_str().unwrap_or_default())
    });

    let mut slots: Vec<serde_json::Value> = models
        .iter()
        .map(|slot| {
            serde_json::json!({
                "id": slot.id,
                "capability": slot.capability.as_str(),
                "required": slot.required,
            })
        })
        .collect();
    slots.sort_by(|one, two| {
        one["id"]
            .as_str()
            .unwrap_or_default()
            .cmp(two["id"].as_str().unwrap_or_default())
    });

    let mut declared: Vec<serde_json::Value> = parameters
        .iter()
        .map(|parameter| {
            let mut options = parameter.options.clone();
            options.sort();
            serde_json::json!({
                "key": parameter.key,
                "type": parameter.kind.as_str(),
                "required": parameter.required,
                "multiline": parameter.multiline,
                "default": parameter.default.clone().unwrap_or(serde_json::Value::Null),
                "min": parameter.min,
                "max": parameter.max,
                "step": parameter.step,
                "options": options,
            })
        })
        .collect();
    declared.sort_by(|one, two| {
        one["key"]
            .as_str()
            .unwrap_or_default()
            .cmp(two["key"].as_str().unwrap_or_default())
    });

    let canonical = canonical_json(&serde_json::json!({
        "apiVersion": api_version,
        "ports": ports,
        "models": slots,
        "parameters": declared,
    }));
    format!(
        "sha256:{}",
        hex::encode(sha2::Sha256::digest(canonical.as_bytes()))
    )
}

/// JSON with every object's keys sorted, so declaration order never changes a
/// contract's hash while a genuine change always does.
pub fn canonical_json(value: &serde_json::Value) -> String {
    serde_json::to_string(&sorted(value)).unwrap_or_default()
}

fn sorted(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for key in keys {
                out.insert(key.clone(), sorted(&map[key]));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(sorted).collect())
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, document: &str, scripts: &[(&str, &str)]) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("node.json"), document).unwrap();
        for (name, source) in scripts {
            std::fs::write(dir.join(name), source).unwrap();
        }
    }

    const DOCUMENT: &str = r#"{
      "apiVersion": 1,
      "version": 3,
      "displayName": "Expander",
      "labels": {"zh": "扩写"},
      "description": "Expands a prompt.",
      "script": "main.lua",
      "order": 20,
      "inputs": [{"id": "text", "dataTypes": ["text"], "required": true, "label": "Text"}],
      "outputs": [{"id": "out", "dataTypes": ["text"], "required": true, "label": "Text", "primary": true}],
      "models": [{"id": "writer", "capability": "text", "required": true, "label": "Writer"}],
      "parameters": [
        {"key": "style", "type": "enum", "label": "Style", "default": "ink", "options": ["ink", "flat"]},
        {"key": "count", "type": "integer", "label": "Count", "default": 1, "min": 1, "max": 4}
      ]
    }"#;

    fn loaded() -> NodeDefinition {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            DOCUMENT,
            &[("main.lua", "function run(ctx) end")],
        );
        let definition = load(dir.path(), "expander").unwrap();
        std::mem::forget(dir);
        definition
    }

    #[test]
    fn a_complete_definition_loads_with_its_contract() {
        let definition = loaded();
        assert_eq!(definition.id, "expander");
        assert_eq!(definition.version, 3);
        assert_eq!(definition.inputs.len(), 1);
        assert_eq!(definition.outputs.len(), 1);
        assert_eq!(definition.models[0].capability, Capability::Text);
        assert!(definition.contract_hash.starts_with("sha256:"));
        assert_eq!(definition.primary_output().unwrap().id, "out");
    }

    #[test]
    fn declaration_order_does_not_change_the_contract_but_a_value_does() {
        let one = loaded();
        let mut reordered = DOCUMENT.replace(
            r#""inputs": [{"id": "text", "dataTypes": ["text"], "required": true, "label": "Text"}],"#,
            "",
        );
        reordered = reordered.replace(
            r#""outputs": ["#,
            r#""inputs": [{"id": "text", "dataTypes": ["text"], "required": true, "label": "Text"}], "outputs": ["#,
        );
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            &reordered,
            &[("main.lua", "function run(ctx) end")],
        );
        let two = load(dir.path(), "expander").unwrap();
        assert_eq!(
            one.contract_hash, two.contract_hash,
            "same contract, same hash"
        );

        let changed = DOCUMENT.replace(
            r#""required": true, "label": "Text"}"#,
            r#""required": false, "label": "Text"}"#,
        );
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            &changed,
            &[("main.lua", "function run(ctx) end")],
        );
        let three = load(dir.path(), "expander").unwrap();
        assert_ne!(one.contract_hash, three.contract_hash);
    }

    #[test]
    fn an_unknown_top_level_field_is_a_defect_rather_than_a_missing_port() {
        let broken = DOCUMENT.replace(r#""outputs""#, r#""output": [], "outputs""#);
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &broken, &[("main.lua", "")]);
        let problem = load(dir.path(), "expander").unwrap_err();
        assert_eq!(problem.code, "EXTENSION_MANIFEST_INVALID");
        assert!(problem.message.contains("output"), "{}", problem.message);
    }

    #[test]
    fn an_api_version_this_build_does_not_implement_is_named_as_such() {
        let future = DOCUMENT.replace(r#""apiVersion": 1"#, r#""apiVersion": 2"#);
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &future, &[("main.lua", "")]);
        let problem = load(dir.path(), "expander").unwrap_err();
        assert_eq!(problem.code, "EXTENSION_API_VERSION_UNSUPPORTED");
    }

    #[test]
    fn a_missing_or_climbing_script_is_refused() {
        for script in ["missing.lua", "../main.lua", "sub/main.lua", "main.txt"] {
            let document = DOCUMENT.replace(
                r#""script": "main.lua""#,
                &format!(r#""script": "{script}""#),
            );
            let dir = tempfile::tempdir().unwrap();
            write(dir.path(), &document, &[("main.lua", "")]);
            let problem = load(dir.path(), "expander").unwrap_err();
            assert_eq!(problem.code, "EXTENSION_SCRIPT_MISSING", "{script}");
        }
        // A symlink is not a file beside the document, whatever it points at.
        #[cfg(unix)]
        {
            let dir = tempfile::tempdir().unwrap();
            write(dir.path(), DOCUMENT, &[]);
            std::os::unix::fs::symlink(
                dir.path().join("elsewhere.lua"),
                dir.path().join("main.lua"),
            )
            .unwrap();
            let problem = load(dir.path(), "expander").unwrap_err();
            assert_eq!(problem.code, "EXTENSION_SCRIPT_MISSING");
        }
    }

    #[test]
    fn a_default_outside_its_own_range_is_refused_when_the_definition_loads() {
        let broken = DOCUMENT.replace(
            r#""default": 1, "min": 1, "max": 4"#,
            r#""default": 9, "min": 1, "max": 4"#,
        );
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &broken, &[("main.lua", "")]);
        let problem = load(dir.path(), "expander").unwrap_err();
        assert_eq!(problem.code, "EXTENSION_MANIFEST_INVALID");
        assert!(problem.message.contains("default"), "{}", problem.message);
    }

    #[test]
    fn limits_are_clamped_rather_than_refused() {
        let document = DOCUMENT.replace(
            r#""script": "main.lua","#,
            r#""script": "main.lua", "limits": {"timeoutSeconds": 99999, "maxModelCalls": 0},"#,
        );
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &document, &[("main.lua", "")]);
        assert!(
            load(dir.path(), "expander").is_err(),
            "zero is not positive"
        );

        let document = DOCUMENT.replace(
            r#""script": "main.lua","#,
            r#""script": "main.lua", "limits": {"timeoutSeconds": 99999},"#,
        );
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &document, &[("main.lua", "")]);
        let definition = load(dir.path(), "expander").unwrap();
        assert_eq!(definition.limits.timeout_seconds, MAX_TIMEOUT_SECONDS);
    }

    #[test]
    fn parameters_are_resolved_with_defaults_and_checked() {
        let definition = loaded();
        let resolved = definition
            .resolved_parameters(Some(&serde_json::json!({"style": "flat", "unknown": 1})))
            .unwrap();
        assert_eq!(resolved["style"], "flat");
        assert_eq!(resolved["count"], 1);
        assert!(resolved.get("unknown").is_none());

        let error = definition
            .resolved_parameters(Some(&serde_json::json!({"style": "crayon"})))
            .unwrap_err();
        assert!(error.contains("options"), "{error}");
        let error = definition
            .resolved_parameters(Some(&serde_json::json!({"count": 9})))
            .unwrap_err();
        assert!(error.contains("maximum"), "{error}");
    }

    #[test]
    fn helper_scripts_become_modules_but_the_entry_does_not() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            DOCUMENT,
            &[
                ("main.lua", "function run(ctx) end"),
                ("prompts.lua", "return {}"),
                ("not a module.lua", "return {}"),
            ],
        );
        let definition = load(dir.path(), "expander").unwrap();
        assert!(definition.scripts.contains_key("prompts"));
        assert!(!definition.scripts.contains_key("main"));
        assert!(!definition.scripts.contains_key("not a module"));
    }

    #[test]
    fn the_first_port_that_can_make_media_is_the_primary_one_when_none_is_marked() {
        let dir = tempfile::tempdir().unwrap();
        let document = DOCUMENT.replace(r#", "primary": true"#, "");
        // Replace the single text output with a text then an image output.
        let document = document.replace(
            r#"{"id": "out", "dataTypes": ["text"], "required": true, "label": "Text"}"#,
            r#"{"id": "words", "dataTypes": ["text"], "label": "Words"}, {"id": "picture", "dataTypes": ["image"], "label": "Picture"}"#,
        );
        write(dir.path(), &document, &[("main.lua", "")]);
        let definition = load(dir.path(), "expander").unwrap();
        assert_eq!(definition.primary_output().unwrap().id, "picture");
    }
}
