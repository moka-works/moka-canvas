use std::collections::{HashMap, HashSet};

use super::folders::{folder_depth, folders_of, holds_itself};
use super::{
    director, story, timeline, CanvasDocument, Capability, Cardinality, DataType, MokaFile, NodeId,
    NodeKind, PortDirection, ResourceEntry, ValidationIssue, WorkflowEdge, WorkflowNode,
    ASSET_CATEGORIES, ASSET_ORIGINS,
};

pub const COORDINATE_LIMIT: f64 = 1_000_000.0;
pub const MAX_TITLE_LENGTH: usize = 200;
pub const MAX_CANVAS_NAME_LENGTH: usize = 80;
pub const MAX_NODES_PER_CANVAS: usize = 5_000;
pub const MAX_EDGES_PER_CANVAS: usize = 10_000;
pub const MAX_CANVASES_PER_PROJECT: usize = 64;
/// How many directories one project's canvas tree holds.
pub const MAX_FOLDERS_PER_PROJECT: usize = 256;
pub const MAX_FOLDER_NAME_LENGTH: usize = 80;
/// How deep a folder may sit in another.
///
/// A ceiling on the tree rather than on the work: past this a reader is
/// navigating a filing system instead of choosing a board, and a document that
/// arrives deeper is refused rather than silently flattened.
pub const MAX_FOLDER_DEPTH: usize = 8;
pub const MAX_PROMPT_LENGTH: usize = 20_000;
pub const MAX_RESULT_SLOTS: usize = 16;
/// How many model slots one extension node may bind.
pub const MAX_EXTENSION_BINDINGS: usize = 16;
/// How large an extension node's parameters may be, serialized. A canvas is a
/// document, and a node that carried an essay in one field would make every
/// save and every read pay for it.
pub const MAX_EXTENSION_PARAM_BYTES: usize = 64 * 1024;
/// How many characters a definition id and a port or slot id may hold.
pub const MAX_EXTENSION_IDENTIFIER: usize = 64;
pub const MAX_EXTENSION_PORT_ID: usize = 32;
pub const ZOOM_MIN: f64 = 0.05;
pub const ZOOM_MAX: f64 = 5.0;
/// How many conversations one canvas carries.
pub const MAX_ASSISTANT_SESSIONS_PER_CANVAS: usize = 16;
/// How many lines one conversation is kept to.
///
/// A ceiling rather than a refusal: a conversation that ran past it would be one
/// nobody could read through, and the oldest lines are the ones to lose. Losing
/// them is said, and undoing the turn that pushed past it gives them back.
pub const MAX_ASSISTANT_MESSAGES_PER_SESSION: usize = 200;
pub const MAX_ASSISTANT_TITLE_LENGTH: usize = 120;
/// The most a line of a conversation holds, which is the most a text card holds:
/// an answer is offered the chance to become one, and an answer too long for a
/// card could not be put on the canvas whole.
pub const MAX_ASSISTANT_MESSAGE_LENGTH: usize = 50_000;
/// How many words a reader may put on one asset to find it again.
pub const MAX_ASSET_TAGS: usize = 24;
/// How long one of those words may be.
pub const MAX_ASSET_TAG_LENGTH: usize = 32;
pub const MAX_ASSET_NOTE_LENGTH: usize = 2_000;
/// What an asset is a picture of, in words: kept to the size of an ask rather
/// than a document.
pub const MAX_ASSET_KEYWORD_LENGTH: usize = 2_000;

pub fn bounds_valid(bounds: &super::Rect) -> bool {
    bounds.x.is_finite()
        && bounds.y.is_finite()
        && bounds.width.is_finite()
        && bounds.height.is_finite()
        && bounds.width > 0.0
        && bounds.height > 0.0
        && bounds.x.abs() <= COORDINATE_LIMIT
        && bounds.y.abs() <= COORDINATE_LIMIT
        && bounds.width <= COORDINATE_LIMIT * 2.0
        && bounds.height <= COORDINATE_LIMIT * 2.0
}

pub fn resource_path_valid(path: &str) -> bool {
    if path.is_empty() || path.contains('\\') || path.contains('\t') {
        return false;
    }
    if path.starts_with('/') || path.as_bytes().get(1) == Some(&b':') {
        return false;
    }
    path.split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

const MENTION_PREFIX: &str = "@[node:";

/// Every `@[node:<id>]` mention in a prompt, in order of appearance, with the
/// span the whole token occupies so a caller can replace exactly that much and
/// leave the prose around it alone.
///
/// A token with no closing bracket ends the scan: what follows is prose that
/// happens to contain the opening, not a reference. A token naming nothing
/// (`@[node:]`) is still a token, and replacing it is the caller's business.
pub fn mention_spans(prompt: &str) -> Vec<(std::ops::Range<usize>, String)> {
    let mut found = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = prompt[cursor..].find(MENTION_PREFIX) {
        let start = cursor + offset;
        let body = start + MENTION_PREFIX.len();
        let Some(close) = prompt[body..].find(']') else {
            break;
        };
        found.push((
            start..body + close + 1,
            prompt[body..body + close].to_string(),
        ));
        cursor = body + close + 1;
    }
    found
}

/// Node ids referenced by `@[node:<id>]` mentions inside a prompt.
pub fn mention_node_ids(prompt: &str) -> Vec<String> {
    mention_spans(prompt)
        .into_iter()
        .map(|(_, node_id)| node_id)
        .filter(|node_id| !node_id.is_empty())
        .collect()
}

/// True when `model` is shaped like a model configuration identifier: one
/// piece, no whitespace, and no legacy `channelId::modelId` separator — the
/// halves of an old reference name nothing now, so one that arrives is a node
/// saved before model configurations replaced channels, and saying so at
/// validation is clearer than an opaque refusal at run time.
pub fn model_identifier_shaped(model: &str) -> bool {
    !model.is_empty()
        && !model.contains("::")
        && !model.chars().any(|character| character.is_whitespace())
}

/// The parameters an ask of each capability may carry: the keys its
/// converters read. Every surface that states an ask — a canvas node, a story
/// piece — is held to the same list, and the web half keeps the same keys in
/// the same order (`GENERATION_PARAM_KEYS` in `src/shared/domain/constants.ts`,
/// which a test reads and compares).
pub fn generation_param_keys(capability: Capability) -> &'static [&'static str] {
    match capability {
        Capability::Text => &[
            "temperature",
            "maxTokens",
            "reasoningEffort",
            "instructions",
        ],
        Capability::Image => &["size", "quality", "background", "count"],
        Capability::Speech => &[
            "voice",
            "format",
            "speed",
            "instructions",
            "sampleRate",
            "volume",
            "rate",
            "pitch",
        ],
        Capability::Music => &[
            "format",
            // What a score is asked with: whether it carries words, and the
            // fields a music service reads them from.
            "instrumental",
            "lyrics",
            "gender",
            "watermark",
        ],
        Capability::Video => &[
            "seconds",
            "resolution",
            "ratio",
            "generateAudio",
            "watermark",
            "mode",
        ],
        Capability::Asr => &[
            "language",
            "channelId",
            "speakerCount",
            "disfluency",
            "speakerLabel",
        ],
    }
}

fn port_types_intersect(a: &[DataType], b: &[DataType]) -> bool {
    a.iter().any(|t| b.contains(t))
}

#[derive(Debug)]
pub struct EdgeRejection {
    pub code: &'static str,
    pub message: String,
}

pub fn validate_edge_candidate(
    canvas: &CanvasDocument,
    source: &super::EdgeEndpoint,
    target: &super::EdgeEndpoint,
) -> Result<(), EdgeRejection> {
    let source_node = canvas.node(&source.node_id).ok_or(EdgeRejection {
        code: "NODE_NOT_FOUND",
        message: "Source node missing".into(),
    })?;
    let target_node = canvas.node(&target.node_id).ok_or(EdgeRejection {
        code: "NODE_NOT_FOUND",
        message: "Target node missing".into(),
    })?;
    let source_port = source_node.port(&source.port_id).ok_or(EdgeRejection {
        code: "PORT_NOT_FOUND",
        message: "Source port missing".into(),
    })?;
    let target_port = target_node.port(&target.port_id).ok_or(EdgeRejection {
        code: "PORT_NOT_FOUND",
        message: "Target port missing".into(),
    })?;

    if source_port.direction != PortDirection::Output
        || target_port.direction != PortDirection::Input
    {
        return Err(EdgeRejection {
            code: "PORT_TYPE_MISMATCH",
            message: "Edges must run from an output port to an input port".into(),
        });
    }

    if source.node_id == target.node_id {
        return Err(EdgeRejection {
            code: "SELF_LOOP",
            message: "A node cannot connect to itself".into(),
        });
    }

    if !port_types_intersect(&source_port.data_types, &target_port.data_types) {
        return Err(EdgeRejection {
            code: "PORT_TYPE_MISMATCH",
            message: "Port types are incompatible".into(),
        });
    }

    if target_port.cardinality == Cardinality::One
        && canvas
            .edges
            .iter()
            .any(|e| e.target.node_id == target.node_id && e.target.port_id == target.port_id)
    {
        return Err(EdgeRejection {
            code: "CARDINALITY_VIOLATION",
            message: "This input accepts a single connection; replace it explicitly".into(),
        });
    }

    if canvas.edges.iter().any(|e| {
        e.source.node_id == source.node_id
            && e.source.port_id == source.port_id
            && e.target.node_id == target.node_id
            && e.target.port_id == target.port_id
    }) {
        return Err(EdgeRejection {
            code: "CONFLICT",
            message: "This connection already exists".into(),
        });
    }

    if would_create_cycle(&canvas.edges, &source.node_id, &target.node_id) {
        return Err(EdgeRejection {
            code: "GRAPH_CYCLE",
            message: "This connection would create a cycle".into(),
        });
    }

    Ok(())
}

pub fn would_create_cycle(
    edges: &[WorkflowEdge],
    source_node: &NodeId,
    target_node: &NodeId,
) -> bool {
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        adjacency
            .entry(edge.source.node_id.as_str())
            .or_default()
            .push(edge.target.node_id.as_str());
    }
    adjacency
        .entry(source_node.as_str())
        .or_default()
        .push(target_node.as_str());

    let mut stack = vec![target_node.as_str()];
    let mut visited: HashSet<&str> = HashSet::new();
    while let Some(current) = stack.pop() {
        if current == source_node.as_str() {
            return true;
        }
        if !visited.insert(current) {
            continue;
        }
        if let Some(next) = adjacency.get(current) {
            stack.extend(next.iter().copied());
        }
    }
    false
}

/// Deterministic graph order: topological layer, then z-index, then id.
pub fn topological_order(canvas: &CanvasDocument) -> Vec<&WorkflowNode> {
    let mut indegree: HashMap<&str, usize> = HashMap::new();
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for node in &canvas.nodes {
        indegree.insert(node.id.as_str(), 0);
    }
    for edge in &canvas.edges {
        if !indegree.contains_key(edge.source.node_id.as_str())
            || !indegree.contains_key(edge.target.node_id.as_str())
        {
            continue;
        }
        *indegree.entry(edge.target.node_id.as_str()).or_insert(0) += 1;
        outgoing
            .entry(edge.source.node_id.as_str())
            .or_default()
            .push(edge.target.node_id.as_str());
    }

    let by_rank = |a: &&WorkflowNode, b: &&WorkflowNode| {
        a.z_index.cmp(&b.z_index).then_with(|| a.id.cmp(&b.id))
    };

    let node_by_id: HashMap<&str, &WorkflowNode> = canvas
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();

    let mut frontier: Vec<&WorkflowNode> = canvas
        .nodes
        .iter()
        .filter(|node| indegree.get(node.id.as_str()).copied().unwrap_or(0) == 0)
        .collect();
    frontier.sort_by(by_rank);

    let mut ordered = Vec::new();
    while !frontier.is_empty() {
        let mut next_frontier = Vec::new();
        for node in frontier {
            ordered.push(node);
            if let Some(targets) = outgoing.get(node.id.as_str()) {
                for target in targets {
                    let remaining = indegree.get_mut(*target).map(|value| {
                        *value -= 1;
                        *value
                    });
                    if remaining == Some(0) {
                        if let Some(target_node) = node_by_id.get(*target) {
                            next_frontier.push(*target_node);
                        }
                    }
                }
            }
        }
        next_frontier.sort_by(by_rank);
        frontier = next_frontier;
    }
    ordered
}

fn generation_issues(
    canvas: &CanvasDocument,
    node: &WorkflowNode,
    node_ids: &HashSet<&str>,
) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let issue = |code: &'static str, message: String| ValidationIssue {
        code: code.into(),
        message,
        canvas_id: Some(canvas.id.clone()),
        node_id: Some(node.id.clone()),
        port_id: None,
        edge_id: None,
        timeline_id: None,
        track_id: None,
        clip_id: None,
        transition_id: None,
    };

    let slots = node.data.result_slots.as_deref().unwrap_or(&[]);
    if slots.len() > MAX_RESULT_SLOTS {
        issues.push(issue(
            "RESULT_SLOT_LIMIT",
            format!(
                "Node \"{}\" exceeds the result slot limit ({MAX_RESULT_SLOTS})",
                node.title
            ),
        ));
    }

    let Some(spec) = node.data.generation.as_ref() else {
        return issues;
    };

    if !spec.capability.serves(node.kind) {
        issues.push(issue(
            "GENERATION_CAPABILITY_MISMATCH",
            format!(
                "Generation capability \"{}\" does not match node kind \"{}\"",
                spec.capability.as_str(),
                node.kind.as_str()
            ),
        ));
    }
    if !spec.model.is_empty() && !model_identifier_shaped(&spec.model) {
        issues.push(issue(
            "GENERATION_MODEL_MISSING",
            format!(
                "Generation model \"{}\" is not a model configuration identifier",
                spec.model
            ),
        ));
    }
    if spec.prompt.chars().count() > MAX_PROMPT_LENGTH {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!("Generation prompt exceeds the {MAX_PROMPT_LENGTH} character limit"),
        ));
    }

    let references = spec.reference_node_ids.as_deref().unwrap_or(&[]);
    let has_prompt_edge = canvas
        .edges
        .iter()
        .any(|edge| edge.target.node_id == node.id && edge.target.port_id == "prompt");
    if spec.prompt.trim().is_empty() && !has_prompt_edge && references.is_empty() {
        issues.push(issue(
            "GENERATION_PROMPT_EMPTY",
            format!(
                "Node \"{}\" has no prompt, no upstream prompt connection, and no references",
                node.title
            ),
        ));
    }

    for mentioned in mention_node_ids(&spec.prompt) {
        if mentioned == node.id {
            issues.push(issue(
                "MENTION_SELF_REFERENCE",
                "Prompt mentions its own node".into(),
            ));
        } else if !node_ids.contains(mentioned.as_str()) {
            issues.push(issue(
                "MENTION_NODE_NOT_FOUND",
                format!("Prompt mentions missing node {mentioned}"),
            ));
        }
    }

    if let Some(params) = spec.params.as_ref().and_then(|value| value.as_object()) {
        let allowed = generation_param_keys(spec.capability);
        for key in params.keys() {
            if !allowed.contains(&key.as_str()) {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!(
                        "Unknown parameter \"{key}\" for {} generation",
                        spec.capability.as_str()
                    ),
                ));
            }
        }
    }

    issues
}

/// What is wrong with the conversations a canvas carries.
///
/// A line naming a card that has since been deleted is not among them. The line
/// kept that card's title and kind for exactly this case, so what it says is
/// still what was asked about; only the card is gone, and saying so is the
/// reader's job rather than a fault in the document.
/// Whether a string is a definition id: what a directory under `nodes/` may be
/// called, which is also what a node stores.
pub fn extension_id_shaped(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_EXTENSION_IDENTIFIER
        && !id.starts_with('.')
        && !id.contains("..")
        && id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
        && id.starts_with(|character: char| {
            character.is_ascii_lowercase() || character.is_ascii_digit()
        })
}

/// Whether a string is a port or slot id: a letter, then letters, digits and
/// underscores.
pub fn extension_identifier_shaped(id: &str) -> bool {
    let mut characters = id.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    id.len() <= MAX_EXTENSION_PORT_ID
        && first.is_ascii_alphabetic()
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// What is wrong with an extension node as the document holds it.
///
/// A definition may be gone, in which case the node keeps its ports and its
/// outputs and simply cannot run; nothing here asks the disk. What is checked
/// is that the node itself is shaped like one: an installed definition, a
/// contract it was inserted against, bounds-sized parameters, and port/output
/// values that a run and a panel can read.
fn extension_issues(canvas: &CanvasDocument, node: &WorkflowNode) -> Vec<ValidationIssue> {
    let Some(extension) = node.data.extension.as_ref() else {
        return vec![ValidationIssue {
            code: "EXTENSION_NODE_INVALID".into(),
            message: format!(
                "Extension node \"{}\" carries no extension state",
                node.title
            ),
            canvas_id: Some(canvas.id.clone()),
            node_id: Some(node.id.clone()),
            port_id: None,
            edge_id: None,
            timeline_id: None,
            track_id: None,
            clip_id: None,
            transition_id: None,
        }];
    };
    let mut issues = Vec::new();
    let mut issue = |message: String| {
        issues.push(ValidationIssue {
            code: "EXTENSION_NODE_INVALID".into(),
            message: format!("Node \"{}\": {message}", node.title),
            canvas_id: Some(canvas.id.clone()),
            node_id: Some(node.id.clone()),
            port_id: None,
            edge_id: None,
            timeline_id: None,
            track_id: None,
            clip_id: None,
            transition_id: None,
        });
    };

    if !extension_id_shaped(&extension.extension_id) {
        issue(format!(
            "the extension id \"{}\" is not a directory name",
            extension.extension_id
        ));
    }
    if extension.api_version == 0 {
        issue("the extension contract version is missing".into());
    }
    if extension.contract_hash.trim().is_empty() {
        issue("the extension contract hash is empty".into());
    }
    if extension.bindings.len() > MAX_EXTENSION_BINDINGS {
        issue(format!(
            "more than {MAX_EXTENSION_BINDINGS} model slots are bound"
        ));
    }
    for (slot, model) in &extension.bindings {
        if !extension_identifier_shaped(slot) {
            issue(format!("slot id \"{slot}\" is not shaped like one"));
        }
        if model.trim().is_empty() || model.chars().count() > 128 {
            issue(format!(
                "the model bound to slot \"{slot}\" is not a configuration id"
            ));
        }
    }
    if let Some(parameters) = &node.data.parameters {
        if !parameters.is_object() {
            issue("the node's parameters are not an object".into());
        }
        let bytes = serde_json::to_vec(parameters)
            .map(|held| held.len())
            .unwrap_or(usize::MAX);
        if bytes > MAX_EXTENSION_PARAM_BYTES {
            issue(format!(
                "the node's parameters exceed {MAX_EXTENSION_PARAM_BYTES} bytes"
            ));
        }
    }

    let mut outputs = 0;
    let mut port_ids = HashSet::new();
    for port in &node.ports {
        if !extension_identifier_shaped(&port.id) {
            issue(format!("port id \"{}\" is not shaped like one", port.id));
        }
        if !port_ids.insert(port.id.as_str()) {
            issue(format!("port id \"{}\" is declared twice", port.id));
        }
        if port.data_types.is_empty() || port.data_types.contains(&DataType::Timeline) || {
            let mut seen = HashSet::new();
            !port.data_types.iter().all(|kind| seen.insert(*kind))
        } {
            issue(format!("port \"{}\" declares unusable data types", port.id));
        }
        if port.direction == PortDirection::Output {
            outputs += 1;
        }
    }
    if outputs == 0 {
        issue("an extension node needs at least one output port".into());
    }

    let output_port = |port_id: &str| {
        node.ports
            .iter()
            .any(|port| port.id == port_id && port.direction == PortDirection::Output)
    };
    for (port_id, values) in extension.outputs.iter().flatten() {
        if !output_port(port_id) {
            issue(format!(
                "stored output port \"{port_id}\" is not an output of this node"
            ));
        }
        for value in values {
            let text = value.data_type == DataType::Text;
            if value.data_type == DataType::Timeline {
                issue(format!("output port \"{port_id}\" holds a timeline"));
            }
            if text && (value.text.is_none() || value.asset_id.is_some()) {
                issue(format!("a text value on port \"{port_id}\" has no words"));
            }
            if !text
                && (value.asset_id.as_deref().unwrap_or_default().is_empty()
                    || value.text.is_some())
            {
                issue(format!(
                    "a media value on port \"{port_id}\" names no asset"
                ));
            }
        }
    }

    issues
}

fn session_issues(canvas: &CanvasDocument) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let issue = |message: String| ValidationIssue {
        code: "VALIDATION_FAILED".into(),
        message,
        canvas_id: Some(canvas.id.clone()),
        node_id: None,
        port_id: None,
        edge_id: None,
        timeline_id: None,
        track_id: None,
        clip_id: None,
        transition_id: None,
    };

    let sessions = canvas.sessions.as_deref().unwrap_or(&[]);
    if sessions.len() > MAX_ASSISTANT_SESSIONS_PER_CANVAS {
        issues.push(issue(format!(
            "Canvas exceeds the session limit ({MAX_ASSISTANT_SESSIONS_PER_CANVAS})"
        )));
    }

    let mut session_ids = HashSet::new();
    for session in sessions {
        if !session_ids.insert(session.id.as_str()) {
            issues.push(issue(format!("Duplicate session id {}", session.id)));
        }
        if session.messages.len() > MAX_ASSISTANT_MESSAGES_PER_SESSION {
            issues.push(issue(format!(
                "Session \"{}\" exceeds the message limit ({MAX_ASSISTANT_MESSAGES_PER_SESSION})",
                session.title
            )));
        }
    }

    issues
}

pub fn validate_canvas(canvas: &CanvasDocument) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let canvas_id = Some(canvas.id.clone());

    if canvas.nodes.len() > MAX_NODES_PER_CANVAS {
        issues.push(ValidationIssue {
            code: "VALIDATION_FAILED".into(),
            message: format!("Canvas exceeds the node limit ({MAX_NODES_PER_CANVAS})"),
            canvas_id: canvas_id.clone(),
            node_id: None,
            port_id: None,
            edge_id: None,
            timeline_id: None,
            track_id: None,
            clip_id: None,
            transition_id: None,
        });
    }
    if canvas.edges.len() > MAX_EDGES_PER_CANVAS {
        issues.push(ValidationIssue {
            code: "VALIDATION_FAILED".into(),
            message: format!("Canvas exceeds the edge limit ({MAX_EDGES_PER_CANVAS})"),
            canvas_id: canvas_id.clone(),
            node_id: None,
            port_id: None,
            edge_id: None,
            timeline_id: None,
            track_id: None,
            clip_id: None,
            transition_id: None,
        });
    }
    issues.extend(session_issues(canvas));

    let mut node_ids = HashSet::new();
    for node in &canvas.nodes {
        if !node_ids.insert(node.id.as_str()) {
            issues.push(ValidationIssue {
                code: "VALIDATION_FAILED".into(),
                message: format!("Duplicate node id {}", node.id),
                canvas_id: canvas_id.clone(),
                node_id: Some(node.id.clone()),
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
        if !bounds_valid(&node.bounds) {
            issues.push(ValidationIssue {
                code: "BOUNDS_INVALID".into(),
                message: format!("Node \"{}\" has invalid bounds", node.title),
                canvas_id: canvas_id.clone(),
                node_id: Some(node.id.clone()),
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
        let mut port_ids = HashSet::new();
        for port in &node.ports {
            if !port_ids.insert(port.id.as_str()) {
                issues.push(ValidationIssue {
                    code: "VALIDATION_FAILED".into(),
                    message: format!("Duplicate port id {} on node \"{}\"", port.id, node.title),
                    canvas_id: canvas_id.clone(),
                    node_id: Some(node.id.clone()),
                    port_id: Some(port.id.clone()),
                    edge_id: None,
                    timeline_id: None,
                    track_id: None,
                    clip_id: None,
                    transition_id: None,
                });
            }
        }
    }

    for node in &canvas.nodes {
        issues.extend(generation_issues(canvas, node, &node_ids));
        if node.kind == NodeKind::Extension {
            issues.extend(extension_issues(canvas, node));
        }
    }

    let mut edge_ids = HashSet::new();
    for (index, edge) in canvas.edges.iter().enumerate() {
        if !edge_ids.insert(edge.id.as_str()) {
            issues.push(ValidationIssue {
                code: "VALIDATION_FAILED".into(),
                message: format!("Duplicate edge id {}", edge.id),
                canvas_id: canvas_id.clone(),
                node_id: None,
                port_id: None,
                edge_id: Some(edge.id.clone()),
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
        let remaining: Vec<WorkflowEdge> = canvas
            .edges
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .map(|(_, e)| e.clone())
            .collect();
        let mut scoped = canvas.clone();
        scoped.edges = remaining;
        if let Err(rejection) = validate_edge_candidate(&scoped, &edge.source, &edge.target) {
            issues.push(ValidationIssue {
                code: rejection.code.into(),
                message: rejection.message,
                canvas_id: canvas_id.clone(),
                node_id: Some(edge.target.node_id.clone()),
                port_id: Some(edge.target.port_id.clone()),
                edge_id: Some(edge.id.clone()),
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
    }

    let mut group_of: HashMap<&str, &str> = HashMap::new();
    for group in &canvas.groups {
        let group_node = canvas.node(&group.group_id);
        if !matches!(group_node.map(|n| n.kind), Some(NodeKind::Group)) {
            issues.push(ValidationIssue {
                code: "GROUP_INVALID".into(),
                message: "Membership references a missing or non-group node".into(),
                canvas_id: canvas_id.clone(),
                node_id: Some(group.group_id.clone()),
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
            continue;
        }
        let mut seen = HashSet::new();
        for child_id in &group.child_node_ids {
            if child_id == &group.group_id {
                issues.push(ValidationIssue {
                    code: "GROUP_INVALID".into(),
                    message: "A group cannot contain itself".into(),
                    canvas_id: canvas_id.clone(),
                    node_id: Some(group.group_id.clone()),
                    port_id: None,
                    edge_id: None,
                    timeline_id: None,
                    track_id: None,
                    clip_id: None,
                    transition_id: None,
                });
            }
            if !seen.insert(child_id.as_str()) {
                issues.push(ValidationIssue {
                    code: "GROUP_INVALID".into(),
                    message: "Group membership contains a duplicate node".into(),
                    canvas_id: canvas_id.clone(),
                    node_id: Some(child_id.clone()),
                    port_id: None,
                    edge_id: None,
                    timeline_id: None,
                    track_id: None,
                    clip_id: None,
                    transition_id: None,
                });
            }
            if !node_ids.contains(child_id.as_str()) {
                issues.push(ValidationIssue {
                    code: "GROUP_INVALID".into(),
                    message: "Group membership references a missing node".into(),
                    canvas_id: canvas_id.clone(),
                    node_id: Some(child_id.clone()),
                    port_id: None,
                    edge_id: None,
                    timeline_id: None,
                    track_id: None,
                    clip_id: None,
                    transition_id: None,
                });
            }
            if group_of
                .insert(child_id.as_str(), group.group_id.as_str())
                .is_some()
            {
                issues.push(ValidationIssue {
                    code: "GROUP_INVALID".into(),
                    message: "A node belongs to more than one group".into(),
                    canvas_id: canvas_id.clone(),
                    node_id: Some(child_id.clone()),
                    port_id: None,
                    edge_id: None,
                    timeline_id: None,
                    track_id: None,
                    clip_id: None,
                    transition_id: None,
                });
            }
        }
        if group.child_node_ids.len() < 2 {
            issues.push(ValidationIssue {
                code: "GROUP_INVALID".into(),
                message: "A group requires at least two member nodes".into(),
                canvas_id: canvas_id.clone(),
                node_id: Some(group.group_id.clone()),
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
    }

    issues
}

/// What a reader says about an asset, held to its sizes and its vocabulary.
///
/// These are the only registry fields written by hand, so a document out of the
/// wild can carry an asset too tagged to read through, or an origin nothing here
/// recognises.
fn shelf_issues(entry: &ResourceEntry) -> Vec<ValidationIssue> {
    let say = |message: String| ValidationIssue {
        code: "VALIDATION_FAILED".into(),
        message,
        canvas_id: None,
        node_id: None,
        port_id: None,
        edge_id: None,
        timeline_id: None,
        track_id: None,
        clip_id: None,
        transition_id: None,
    };
    let over = |text: &str, limit: usize| text.chars().count() > limit;
    let mut issues = Vec::new();
    if let Some(tags) = &entry.tags {
        if tags.len() > MAX_ASSET_TAGS {
            issues.push(say(format!(
                "Asset \"{}\" carries more tags than the {MAX_ASSET_TAGS} allowed",
                entry.name
            )));
        }
        if tags.iter().any(|tag| over(tag, MAX_ASSET_TAG_LENGTH)) {
            issues.push(say(format!(
                "Asset \"{}\" carries a tag over {MAX_ASSET_TAG_LENGTH} characters",
                entry.name
            )));
        }
    }
    if entry
        .note
        .as_deref()
        .is_some_and(|note| over(note, MAX_ASSET_NOTE_LENGTH))
    {
        issues.push(say(format!(
            "Asset \"{}\" carries a note over {MAX_ASSET_NOTE_LENGTH}",
            entry.name
        )));
    }
    if entry
        .keyword
        .as_deref()
        .is_some_and(|word| over(word, MAX_ASSET_KEYWORD_LENGTH))
    {
        issues.push(say(format!(
            "Asset \"{}\" carries a summary over {MAX_ASSET_KEYWORD_LENGTH}",
            entry.name
        )));
    }
    if let Some(origin) = &entry.origin {
        if !ASSET_ORIGINS.contains(&origin.as_str()) {
            issues.push(say(format!(
                "Asset \"{}\" says an origin nothing recognises: {origin}",
                entry.name
            )));
        }
    }
    issues
}

/// What is wrong with the canvas tree; mirrors `folderIssues` in TypeScript.
///
/// A folder naming a parent that is not there is a fault in the document rather
/// than an empty drawer: the boards under it would sit somewhere no tree can
/// show, so it is said outright instead of being quietly read as a folder at the
/// project root. A name that leads round in a circle is a fault for the same
/// reason, and is named as one rather than reported as too deep.
fn folder_issues(moka: &MokaFile) -> Vec<ValidationIssue> {
    let say = |message: String| ValidationIssue {
        code: "VALIDATION_FAILED".into(),
        message,
        canvas_id: None,
        node_id: None,
        port_id: None,
        edge_id: None,
        timeline_id: None,
        track_id: None,
        clip_id: None,
        transition_id: None,
    };
    let mut issues = Vec::new();
    let folders = folders_of(moka);
    if folders.len() > MAX_FOLDERS_PER_PROJECT {
        issues.push(say(format!(
            "Project exceeds the folder limit ({MAX_FOLDERS_PER_PROJECT})"
        )));
    }
    let ids: HashSet<&str> = folders.iter().map(|folder| folder.id.as_str()).collect();
    if ids.len() != folders.len() {
        issues.push(say("Duplicate folder id".into()));
    }
    for folder in folders {
        if folder.name.is_empty() {
            issues.push(say(format!("Folder {} has no name", folder.id)));
        }
        if folder.name.chars().count() > MAX_FOLDER_NAME_LENGTH {
            issues.push(say(format!(
                "Folder \"{}\" has a name over {MAX_FOLDER_NAME_LENGTH} characters",
                folder.name
            )));
        }
        if let Some(parent_id) = &folder.parent_id {
            if !ids.contains(parent_id.as_str()) {
                issues.push(say(format!(
                    "Folder \"{}\" sits in a folder that is not there",
                    folder.name
                )));
                continue;
            }
        }
        if holds_itself(moka, &folder.id) {
            issues.push(say(format!("Folder \"{}\" is inside itself", folder.name)));
            continue;
        }
        if folder_depth(moka, &folder.id) > MAX_FOLDER_DEPTH {
            issues.push(say(format!(
                "Folder \"{}\" sits deeper than the {MAX_FOLDER_DEPTH} levels allowed",
                folder.name
            )));
        }
    }
    for canvas in &moka.canvas {
        if let Some(folder_id) = &canvas.folder_id {
            if !ids.contains(folder_id.as_str()) {
                issues.push(ValidationIssue {
                    code: "FOLDER_NOT_FOUND".into(),
                    message: format!(
                        "Canvas \"{}\" sits in a folder that is not there",
                        canvas.name
                    ),
                    canvas_id: Some(canvas.id.clone()),
                    node_id: None,
                    port_id: None,
                    edge_id: None,
                    timeline_id: None,
                    track_id: None,
                    clip_id: None,
                    transition_id: None,
                });
            }
        }
    }
    issues
}

pub fn validate_moka_file(moka: &MokaFile) -> Vec<ValidationIssue> {
    let mut issues = folder_issues(moka);
    let mut canvas_ids = HashSet::new();
    for canvas in &moka.canvas {
        if !canvas_ids.insert(canvas.id.as_str()) {
            issues.push(ValidationIssue {
                code: "VALIDATION_FAILED".into(),
                message: format!("Duplicate canvas id {}", canvas.id),
                canvas_id: Some(canvas.id.clone()),
                node_id: None,
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
        issues.extend(validate_canvas(canvas));
    }

    let mut resource_ids = HashSet::new();
    for entry in moka.resources.all() {
        if !resource_ids.insert(entry.id.as_str()) {
            issues.push(ValidationIssue {
                code: "VALIDATION_FAILED".into(),
                message: format!("Duplicate resource id {}", entry.id),
                canvas_id: None,
                node_id: None,
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
        if !resource_path_valid(&entry.path) {
            issues.push(ValidationIssue {
                code: "PATH_ESCAPE".into(),
                message: format!("Resource path escapes the project root: {}", entry.path),
                canvas_id: None,
                node_id: None,
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
        issues.extend(shelf_issues(entry));
    }

    for timeline in moka.timelines.iter().flatten() {
        issues.extend(timeline::validate_timeline(timeline, moka));
    }

    let stories = moka.stories.iter().flatten().collect::<Vec<_>>();
    if stories.len() > story::MAX_STORIES_PER_PROJECT {
        issues.push(story::issue(
            "STORY_LIMIT_REACHED",
            "The project holds more stories than the limit".into(),
        ));
    }
    let mut story_ids = HashSet::new();
    for held in stories {
        if !story_ids.insert(held.id.as_str()) {
            issues.push(story::issue(
                "STORY_ID_EXISTS",
                format!("Duplicate story id {}", held.id),
            ));
        }
        issues.extend(story::validate_story(held));
        // What the story laid down in the cutting room has to still be there:
        // a story pointing at a timeline nobody holds is one step five cannot
        // open, which is worth saying before the reader gets there.
        if let Some(timeline_id) = &held.edit.timeline_id {
            let known = moka
                .timelines
                .iter()
                .flatten()
                .any(|timeline| &timeline.id == timeline_id);
            if !known {
                issues.push(story::issue(
                    "STORY_TARGET_INVALID",
                    format!("Story points at timeline {timeline_id}, which is not here"),
                ));
            }
        }
    }

    let scenes = moka.director_scenes.iter().flatten().collect::<Vec<_>>();
    if scenes.len() > director::MAX_DIRECTOR_SCENES_PER_PROJECT {
        issues.push(ValidationIssue {
            code: "DIRECTOR_LIMIT_EXCEEDED".into(),
            message: format!(
                "The project holds more director scenes than the {} allowed",
                director::MAX_DIRECTOR_SCENES_PER_PROJECT
            ),
            canvas_id: None,
            node_id: None,
            port_id: None,
            edge_id: None,
            timeline_id: None,
            track_id: None,
            clip_id: None,
            transition_id: None,
        });
    }
    let mut scene_ids = HashSet::new();
    for scene in scenes {
        if !scene_ids.insert(scene.id.as_str()) {
            issues.push(ValidationIssue {
                code: "DIRECTOR_REFERENCE_INVALID".into(),
                message: format!("Duplicate director scene id {}", scene.id),
                canvas_id: None,
                node_id: None,
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
        for problem in director::scene_issues(scene) {
            issues.push(ValidationIssue {
                code: problem.code.into(),
                message: format!(
                    "Director scene \"{}\" is invalid at {}: {}",
                    scene.title, problem.path, problem.message
                ),
                canvas_id: None,
                node_id: None,
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
    }

    // The references a document's two halves hold are read together: a timeline
    // clip is as much a use of an asset as a canvas node is.
    for asset_id in moka.asset_references().keys() {
        if !resource_ids.contains(asset_id.as_str()) {
            issues.push(ValidationIssue {
                code: "ASSET_MISSING".into(),
                message: format!(
                    "Something in the project references unregistered asset {asset_id}"
                ),
                canvas_id: None,
                node_id: None,
                port_id: None,
                edge_id: None,
                timeline_id: None,
                track_id: None,
                clip_id: None,
                transition_id: None,
            });
        }
    }

    // Every category key stays within the known set: unknown categories are
    // tolerated on decode only if empty is never required — v1 rejects them
    // so forward edits cannot smuggle data past the registry.
    let _ = ASSET_CATEGORIES;

    issues
}
