//! Authoritative run validation and the immutable snapshot a run executes
//! against. Edit-time checks live in `domain::validate`; this module adds the
//! run-specific phases from the execution contract.

use super::{
    data_type_for, executor_key_for, operation_type_for, ExecutionRequest, ValueProvenance,
    WorkflowExecutor, WorkflowValue,
};
use crate::domain::validate::topological_order;
use crate::domain::{
    CanvasDocument, CanvasId, MokaFile, NodeId, NodeKind, ValidationIssue, WorkflowEdge,
    WorkflowNode,
};
use crate::generate::{
    collect_generation_inputs, context_node_ids, DeltaSink, GenerateRequest, ResolvedInputs,
};
use sha2::Digest;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

/// The frozen graph a run executes: closure nodes/edges in deterministic
/// order plus the content hash recorded on the run record.
#[derive(Debug, Clone)]
pub struct RunSnapshot {
    pub canvas_id: CanvasId,
    pub order: Vec<NodeId>,
    pub nodes: BTreeMap<NodeId, WorkflowNode>,
    /// Edges inside the closure, sorted by creation time then id — the
    /// input resolution order the contract mandates.
    pub edges: Vec<WorkflowEdge>,
    pub graph_hash: String,
    /// The canvas a generation step reads its inputs from: the closure, plus
    /// whatever a node names by hand, names in its prompt, or reaches through a
    /// group. Those neighbours are not in `nodes`, and deliberately so — every
    /// node in `order` becomes a step, so widening the closure would turn
    /// readable neighbours into work nobody asked for.
    pub readable: CanvasDocument,
}

impl RunSnapshot {
    /// Resolves one node's input ports from the snapshot. Upstream operation
    /// outputs become empty placeholders of the right type — validation only
    /// needs shape, not content.
    pub fn resolved_inputs(&self, node_id: &str) -> BTreeMap<String, Vec<WorkflowValue>> {
        let mut inputs: BTreeMap<String, Vec<WorkflowValue>> = BTreeMap::new();
        let Some(node) = self.nodes.get(node_id) else {
            return inputs;
        };
        for edge in self.edges_for_target(node_id) {
            let Some(source) = self.nodes.get(&edge.source.node_id) else {
                continue;
            };
            let value = snapshot_value(source, &edge.source.port_id);
            inputs
                .entry(edge.target.port_id.clone())
                .or_default()
                .push(value);
        }
        for port in &node.ports {
            if port.direction == crate::domain::PortDirection::Input {
                inputs.entry(port.id.clone()).or_default();
            }
        }
        inputs
    }

    pub fn edges_for_target<'a>(
        &'a self,
        node_id: &'a str,
    ) -> impl Iterator<Item = &'a WorkflowEdge> + 'a {
        self.edges
            .iter()
            .filter(move |edge| edge.target.node_id == node_id)
    }

    /// The snapshot-time value a source node emits on its output port.
    pub fn source_value(&self, node_id: &str) -> Option<WorkflowValue> {
        self.nodes
            .get(node_id)
            .map(|node| snapshot_value(node, "out"))
    }

    /// What one scheduled node will ask a provider for. Resolved against the
    /// readable canvas rather than the closure, which is the only reason the
    /// readable canvas exists.
    pub fn generation_inputs(&self, node_id: &str) -> ResolvedInputs {
        let Some(node) = self.readable.node(node_id) else {
            return ResolvedInputs::default();
        };
        collect_generation_inputs(&self.readable, node)
    }

    /// The request one scheduled generation step sends, or `None` for a node
    /// that has nothing to generate.
    pub fn generation_request(&self, node_id: &str) -> Option<GenerateRequest> {
        let spec = self.nodes.get(node_id)?.data.generation.as_ref()?;
        Some(self.generation_inputs(node_id).request_for(spec))
    }

    /// Folds a finished step's answer into the canvas the next step resolves
    /// against.
    ///
    /// A generation reads its inputs from this document, and without this an
    /// upstream node's answer from the same run would be invisible to it: the
    /// document says what was true when the run started, not what the run has
    /// made since. Only the two fields a resolver reads are written. The order,
    /// the closure and the hash stay frozen, because they are what the run
    /// record claims was run and changing them mid-run would make that claim
    /// false.
    pub fn record_output(&mut self, node_id: &str, value: &WorkflowValue) {
        let Some(node) = self
            .readable
            .nodes
            .iter_mut()
            .find(|node| node.id == node_id)
        else {
            return;
        };
        match value {
            WorkflowValue::Text { text, .. } => node.data.content = Some(text.clone()),
            WorkflowValue::Media { asset_id, .. } | WorkflowValue::Artifact { asset_id, .. } => {
                node.data.asset_id = Some(asset_id.clone())
            }
        }
    }
}

/// A node's value as fixed at snapshot time (operations resolve for real
/// during the run).
fn snapshot_value(node: &WorkflowNode, port_id: &str) -> WorkflowValue {
    let source = ValueProvenance {
        node_id: node.id.clone(),
        port_id: port_id.to_string(),
    };
    match node.kind {
        NodeKind::Text => WorkflowValue::Text {
            text: node.data.content.clone().unwrap_or_default(),
            source,
        },
        NodeKind::Image | NodeKind::Audio | NodeKind::Video => WorkflowValue::Media {
            media_type: data_type_for(node.kind),
            asset_id: node.data.asset_id.clone().unwrap_or_default(),
            source,
        },
        _ => WorkflowValue::Text {
            text: String::new(),
            source,
        },
    }
}

fn issue(
    code: &str,
    message: impl Into<String>,
    canvas_id: &str,
    node_id: Option<NodeId>,
    port_id: Option<String>,
) -> ValidationIssue {
    ValidationIssue {
        code: code.to_string(),
        message: message.into(),
        canvas_id: Some(canvas_id.to_string()),
        node_id,
        port_id,
        edge_id: None,
        timeline_id: None,
        track_id: None,
        clip_id: None,
        transition_id: None,
    }
}

/// Validates a run request against the current document and returns the
/// executable snapshot on success. Every actionable problem is reported in
/// one pass; nothing starts when this fails.
pub async fn validate_run(
    root: &Path,
    moka: &MokaFile,
    canvas_id: &str,
    requested: &[NodeId],
    executors: &[Arc<dyn WorkflowExecutor>],
    enabled_executors: &[String],
) -> Result<RunSnapshot, Vec<ValidationIssue>> {
    let mut issues = Vec::new();
    let Some(canvas) = moka.canvas(canvas_id) else {
        return Err(vec![issue(
            "CANVAS_NOT_FOUND",
            "The requested canvas does not exist",
            canvas_id,
            None,
            None,
        )]);
    };

    if requested.is_empty() {
        issues.push(issue(
            "VALIDATION_FAILED",
            "No nodes requested",
            canvas_id,
            None,
            None,
        ));
    }
    let mut seen_requested = HashSet::new();
    for node_id in requested {
        if !seen_requested.insert(node_id) {
            issues.push(issue(
                "VALIDATION_FAILED",
                "Duplicate requested node",
                canvas_id,
                Some(node_id.clone()),
                None,
            ));
            continue;
        }
        match canvas.node(node_id) {
            None => issues.push(issue(
                "NODE_NOT_FOUND",
                "Requested node does not exist",
                canvas_id,
                Some(node_id.clone()),
                None,
            )),
            Some(node) if executor_key_for(node).is_none() => issues.push(issue(
                "NOT_EXECUTABLE",
                format!(
                    "{} node \"{}\" cannot be run",
                    kind_label(node.kind),
                    node.title
                ),
                canvas_id,
                Some(node_id.clone()),
                None,
            )),
            _ => {}
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }

    let closure = upstream_closure(canvas, requested);
    let scoped = scoped_canvas(canvas, &closure);
    issues.extend(crate::domain::validate::validate_canvas(&scoped));

    let mut edges: Vec<WorkflowEdge> = scoped.edges.clone();
    edges.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let snapshot = build_snapshot(canvas_id, canvas, &scoped, &closure, edges);

    for node_id in &snapshot.order {
        let node = &snapshot.nodes[node_id];
        if executor_key_for(node).is_some() {
            validate_step(
                node,
                &snapshot,
                executors,
                enabled_executors,
                canvas_id,
                &mut issues,
            )
            .await;
            continue;
        }
        if matches!(
            node.kind,
            NodeKind::Image | NodeKind::Audio | NodeKind::Video
        ) {
            validate_media_node(root, moka, node, canvas_id, &mut issues);
        }
    }

    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(snapshot)
}

fn kind_label(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Text => "Text",
        NodeKind::Image => "Image",
        NodeKind::Audio => "Audio",
        NodeKind::Video => "Video",
        NodeKind::Operation => "Operation",
        NodeKind::Group => "Group",
        NodeKind::Export => "Export",
    }
}

/// All nodes reachable upstream from the requested set, requested included.
fn upstream_closure(canvas: &CanvasDocument, requested: &[NodeId]) -> HashSet<NodeId> {
    let mut incoming: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &canvas.edges {
        incoming
            .entry(edge.target.node_id.as_str())
            .or_default()
            .push(edge.source.node_id.as_str());
    }
    let mut closure = HashSet::new();
    let mut stack: Vec<&str> = requested.iter().map(String::as_str).collect();
    while let Some(node_id) = stack.pop() {
        if !closure.insert(node_id.to_string()) {
            continue;
        }
        if let Some(sources) = incoming.get(node_id) {
            stack.extend(sources.iter().copied());
        }
    }
    closure
}

fn scoped_canvas(canvas: &CanvasDocument, closure: &HashSet<NodeId>) -> CanvasDocument {
    let mut scoped = canvas.clone();
    scoped.nodes.retain(|node| closure.contains(&node.id));
    scoped.edges.retain(|edge| {
        closure.contains(&edge.source.node_id) && closure.contains(&edge.target.node_id)
    });
    // A membership whose nodes are not all in scope is not in scope either.
    // Keeping it without them reads as a broken group rather than as a group
    // the run has no business with.
    scoped.groups.retain(|group| {
        closure.contains(&group.group_id)
            && group
                .child_node_ids
                .iter()
                .all(|child| closure.contains(child))
    });
    scoped
}

fn build_snapshot(
    canvas_id: &str,
    canvas: &CanvasDocument,
    scoped: &CanvasDocument,
    closure: &HashSet<NodeId>,
    edges: Vec<WorkflowEdge>,
) -> RunSnapshot {
    let order: Vec<NodeId> = topological_order(scoped)
        .into_iter()
        .map(|node| node.id.clone())
        .collect();
    let nodes: BTreeMap<NodeId, WorkflowNode> = scoped
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node.clone()))
        .collect();
    let canonical = serde_json::json!({
        "nodes": order.iter().map(|id| &nodes[id]).collect::<Vec<_>>(),
        "edges": edges,
    });
    let hash = hex::encode(sha2::Sha256::digest(canonical.to_string().as_bytes()));
    let mut readable = scoped_canvas(canvas, &readable_closure(canvas, closure));
    // The same edges in the same order, so a resolver reads a node's inputs the
    // way the run will rather than the way the document happens to list them.
    readable.edges = edges.clone();
    RunSnapshot {
        canvas_id: canvas_id.to_string(),
        order,
        nodes,
        edges,
        graph_hash: hash,
        readable,
    }
}

/// The closure plus every node a scheduled generation reads but the wiring
/// never reaches. Those nodes stay readable and unscheduled: a run only does
/// what was asked for, and being read is not being asked for.
fn readable_closure(canvas: &CanvasDocument, closure: &HashSet<NodeId>) -> HashSet<NodeId> {
    let mut readable = closure.clone();
    for node_id in closure {
        let Some(node) = canvas.node(node_id) else {
            continue;
        };
        readable.extend(context_node_ids(canvas, node));
    }
    readable
}

async fn validate_step(
    node: &WorkflowNode,
    snapshot: &RunSnapshot,
    executors: &[Arc<dyn WorkflowExecutor>],
    enabled_executors: &[String],
    canvas_id: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let executor_key = executor_key_for(node).unwrap_or_default();
    if executor_key.is_empty() {
        issues.push(issue(
            "EXECUTOR_DISABLED",
            format!("Operation \"{}\" declares no executor", node.title),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    }
    if !enabled_executors.iter().any(|key| key == executor_key) {
        issues.push(issue(
            "EXECUTOR_DISABLED",
            format!("Executor \"{executor_key}\" is disabled in the startup configuration"),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    }
    let operation_type = operation_type_for(node);
    let Some(executor) = executors
        .iter()
        .find(|executor| executor.key() == executor_key && executor.supports(&operation_type))
    else {
        issues.push(issue(
            "OPERATION_UNSUPPORTED",
            format!("No enabled executor supports \"{operation_type}\""),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    };

    let request = ExecutionRequest {
        run_id: String::new(),
        node_id: node.id.clone(),
        operation_type,
        parameters: node
            .data
            .parameters
            .clone()
            .unwrap_or(serde_json::Value::Null),
        inputs: snapshot.resolved_inputs(&node.id),
        generation: snapshot.generation_request(&node.id),
        // Unwatched: nothing has been asked for yet, so there are no words to
        // send anywhere and a provider must not be asked to stream them.
        deltas: DeltaSink::default(),
    };
    if let Err(error) = executor.validate(&request).await {
        issues.extend(error.issues.into_iter().map(|mut item| {
            item.canvas_id = Some(canvas_id.to_string());
            if item.node_id.is_none() {
                item.node_id = Some(node.id.clone());
            }
            item
        }));
    }
}

fn validate_media_node(
    root: &Path,
    moka: &MokaFile,
    node: &WorkflowNode,
    canvas_id: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let Some(asset_id) = node.data.asset_id.clone() else {
        issues.push(issue(
            "ASSET_MISSING",
            format!(
                "{} node \"{}\" has no asset bound",
                kind_label(node.kind),
                node.title
            ),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    };
    let Some(entry) = moka.resources.find(&asset_id) else {
        issues.push(issue(
            "ASSET_MISSING",
            format!("Node \"{}\" references an unregistered asset", node.title),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    };
    // What the run has to know is whether the file under the node is the
    // material the node was placed with, and the size answers that: a file that
    // kept its recorded length but changed its bytes is what the project's own
    // check reports behind the room, and a run does not read gigabytes of video
    // to learn it a second time.
    let path = root.join(&entry.path);
    let reason = match std::fs::metadata(&path) {
        Err(_) => Some("missing on disk"),
        Ok(meta) if !meta.is_file() || meta.len() == 0 => Some("missing on disk"),
        Ok(meta) if entry.bytes.map(|b| b as u64 != meta.len()).unwrap_or(false) => {
            Some("changed on disk")
        }
        Ok(_) => None,
    };
    if let Some(reason) = reason {
        issues.push(issue(
            "ASSET_NOT_READY",
            format!("Asset \"{}\" is {reason}", entry.name),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        derive_ports, now_iso, Capability, GenerationInputMode, GenerationSpec, GroupMembership,
        NodeData, ProjectMetadata, Rect, ResourceRegistry, RunId, MOKA_FILE_VERSION,
    };
    use crate::workflow::{
        ExecutionError, ExecutionOutput, ExecutionValidationError, ProgressReporter,
        PROVIDER_EXECUTOR_KEY,
    };
    use std::sync::Arc;

    /// Stands in for the provider executor, which lives on the other side of
    /// the gateway. Scheduling only ever asks an executor whether it takes the
    /// operation, so that is all this one has to answer.
    struct StandInProvider;

    #[async_trait::async_trait]
    impl WorkflowExecutor for StandInProvider {
        fn key(&self) -> &str {
            PROVIDER_EXECUTOR_KEY
        }

        fn supports(&self, operation_type: &str) -> bool {
            operation_type.starts_with("generate.")
        }

        async fn validate(
            &self,
            _request: &ExecutionRequest,
        ) -> Result<(), ExecutionValidationError> {
            Ok(())
        }

        async fn execute(
            &self,
            _request: ExecutionRequest,
            _progress: ProgressReporter,
        ) -> Result<ExecutionOutput, ExecutionError> {
            Ok(ExecutionOutput::default())
        }

        async fn cancel(&self, _run_id: &RunId) -> Result<(), ExecutionError> {
            Ok(())
        }
    }

    fn id(name: &str) -> NodeId {
        format!("node-{name}")
    }

    fn node(kind: NodeKind, name: &str, data: NodeData) -> WorkflowNode {
        let now = now_iso();
        WorkflowNode {
            id: id(name),
            kind,
            title: name.to_string(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 280.0,
                height: 200.0,
            },
            z_index: 0,
            ports: derive_ports(kind),
            data,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn image(name: &str, asset_id: &str) -> WorkflowNode {
        node(
            NodeKind::Image,
            name,
            NodeData {
                asset_id: Some(asset_id.to_string()),
                ..NodeData::default()
            },
        )
    }

    /// The node under test: an image node asking for a poster, with nothing
    /// generated yet and so no asset of its own.
    fn asking(mode: GenerationInputMode, prompt: &str) -> WorkflowNode {
        node(
            NodeKind::Image,
            "poster",
            NodeData {
                generation: Some(GenerationSpec {
                    capability: Capability::Image,
                    input_mode: mode,
                    prompt: prompt.to_string(),
                    updated_at: now_iso(),
                    ..GenerationSpec::default()
                }),
                ..NodeData::default()
            },
        )
    }

    fn document(nodes: Vec<WorkflowNode>, groups: Vec<GroupMembership>) -> MokaFile {
        let mut canvas = CanvasDocument::empty("canvas-1".to_string(), "Canvas 1".to_string());
        canvas.nodes = nodes;
        canvas.groups = groups;
        let now = now_iso();
        MokaFile {
            version: MOKA_FILE_VERSION.to_string(),
            metadata: ProjectMetadata {
                id: "project-1".to_string(),
                name: "Project".to_string(),
                description: None,
                cover_path: None,
                revision: 1,
                created_at: now.clone(),
                updated_at: now,
            },
            resources: ResourceRegistry::default(),
            folders: None,
            timelines: None,
            stories: None,
            canvas: vec![canvas],
        }
    }

    async fn schedule(
        moka: &MokaFile,
        requested: &[&str],
        enabled: &[&str],
    ) -> Result<RunSnapshot, Vec<ValidationIssue>> {
        let root = tempfile::tempdir().unwrap();
        let requested: Vec<NodeId> = requested.iter().map(|name| id(name)).collect();
        let enabled: Vec<String> = enabled.iter().map(|key| key.to_string()).collect();
        validate_run(
            root.path(),
            moka,
            "canvas-1",
            &requested,
            &[Arc::new(StandInProvider)],
            &enabled,
        )
        .await
    }

    const ON: [&str; 1] = [PROVIDER_EXECUTOR_KEY];

    fn codes(issues: &[ValidationIssue]) -> Vec<&str> {
        issues.iter().map(|issue| issue.code.as_str()).collect()
    }

    #[tokio::test]
    async fn a_node_with_nothing_to_generate_cannot_be_requested() {
        let written = node(
            NodeKind::Text,
            "brief",
            NodeData {
                content: Some("a lantern".to_string()),
                ..NodeData::default()
            },
        );
        let moka = document(vec![written, image("plate", "asset-plate")], vec![]);

        let issues = schedule(&moka, &["brief"], &ON).await.unwrap_err();
        assert_eq!(codes(&issues), vec!["NOT_EXECUTABLE"]);

        // Having an asset is not the same as having something to run.
        let issues = schedule(&moka, &["plate"], &ON).await.unwrap_err();
        assert_eq!(codes(&issues), vec!["NOT_EXECUTABLE"]);
    }

    #[tokio::test]
    async fn a_generation_node_needs_no_asset_of_its_own() {
        let moka = document(
            vec![asking(GenerationInputMode::Upstream, "a red cube")],
            vec![],
        );
        let snapshot = schedule(&moka, &["poster"], &ON).await.unwrap();

        assert_eq!(snapshot.order, vec![id("poster")]);
        assert_eq!(
            snapshot.generation_inputs("node-poster").prompt,
            "a red cube"
        );
    }

    #[tokio::test]
    async fn an_unwired_generation_complains_about_its_prompt_alone() {
        let moka = document(vec![asking(GenerationInputMode::Upstream, "  ")], vec![]);

        let issues = schedule(&moka, &["poster"], &ON).await.unwrap_err();
        assert_eq!(codes(&issues), vec!["GENERATION_PROMPT_EMPTY"]);
    }

    #[tokio::test]
    async fn a_generation_step_is_refused_while_the_provider_is_off() {
        let moka = document(
            vec![asking(GenerationInputMode::Upstream, "a red cube")],
            vec![],
        );

        let issues = schedule(&moka, &["poster"], &["deterministic"])
            .await
            .unwrap_err();
        assert_eq!(codes(&issues), vec!["EXECUTOR_DISABLED"]);
        assert!(issues[0].message.contains(PROVIDER_EXECUTOR_KEY));
    }

    #[tokio::test]
    async fn a_node_named_by_hand_is_readable_without_becoming_a_step() {
        let mut asked = asking(GenerationInputMode::Manual, "a red cube");
        asked.data.generation.as_mut().unwrap().reference_node_ids = Some(vec![id("plate")]);
        let moka = document(vec![asked, image("plate", "asset-plate")], vec![]);

        let snapshot = schedule(&moka, &["poster"], &ON).await.unwrap();

        // Read, not scheduled: being an input is not being asked for.
        assert_eq!(snapshot.order, vec![id("poster")]);
        assert!(!snapshot.nodes.contains_key("node-plate"));
        let inputs = snapshot.generation_inputs("node-poster");
        assert_eq!(
            inputs
                .inputs
                .iter()
                .map(|input| input.asset_id.as_str())
                .collect::<Vec<_>>(),
            vec!["asset-plate"]
        );
    }

    #[tokio::test]
    async fn a_group_a_generation_names_contributes_its_members() {
        let mut asked = asking(GenerationInputMode::Manual, "a red cube");
        asked.data.generation.as_mut().unwrap().reference_node_ids = Some(vec![id("tray")]);
        let moka = document(
            vec![
                asked,
                node(NodeKind::Group, "tray", NodeData::default()),
                image("plate", "asset-plate"),
                image("mask", "asset-mask"),
            ],
            vec![GroupMembership {
                group_id: id("tray"),
                child_node_ids: vec![id("plate"), id("mask")],
            }],
        );

        let snapshot = schedule(&moka, &["poster"], &ON).await.unwrap();

        assert_eq!(snapshot.order, vec![id("poster")]);
        let inputs = snapshot.generation_inputs("node-poster");
        assert_eq!(
            inputs
                .inputs
                .iter()
                .map(|input| input.asset_id.as_str())
                .collect::<Vec<_>>(),
            vec!["asset-plate", "asset-mask"]
        );
    }
}
