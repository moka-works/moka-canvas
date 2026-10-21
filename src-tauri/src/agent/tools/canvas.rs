//! Canvas tools: the boards, their cards, the edges between them, and a run.
//!
//! Everything except `canvas.run` plans `DocumentCommand`s, so every change
//! is exactly what the reader's own gesture would have produced and undo works
//! the same way. A run is external work and is only started here.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::api::{ApiState, ProjectSession};
use crate::domain::commands::make_node;
use crate::domain::validate::validate_edge_candidate;
use crate::domain::{
    now_iso, DocumentCommand, EdgeEndpoint, GenerationSpec, MokaFile, NodeData, NodeKind,
    NodePatch, PointValue, Rect, WorkflowEdge, WorkflowNode,
};

use super::super::error::ToolError;
use super::{Args, TaskRef, ToolOutcome};

const GROUP_MARGIN: f64 = 24.0;

pub async fn command(
    _state: &ApiState,
    _root: &std::path::Path,
    moka: &MokaFile,
    name: &str,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    let args = Args::new(name, input)?;
    match name {
        "canvas.list" => {
            let folders = moka.folders.clone().unwrap_or_default();
            let canvases: Vec<Value> = moka
                .canvas
                .iter()
                .map(|canvas| {
                    json!({
                        "id": canvas.id,
                        "name": canvas.name,
                        "folderId": canvas.folder_id,
                        "nodeCount": canvas.nodes.len(),
                        "edgeCount": canvas.edges.len(),
                    })
                })
                .collect();
            Ok(ToolOutcome::read(
                format!("{} canvases", canvases.len()),
                json!({"folders": folders, "canvases": canvases}),
            ))
        }
        "canvas.get" => {
            let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
            let limit = args.opt_i64("nodeLimit").unwrap_or(100).clamp(1, 200) as usize;
            let nodes: Vec<Value> = canvas.nodes.iter().take(limit).map(node_summary).collect();
            let edges: Vec<Value> = canvas
                .edges
                .iter()
                .map(|edge| {
                    json!({
                        "id": edge.id,
                        "source": edge.source,
                        "target": edge.target,
                    })
                })
                .collect();
            Ok(ToolOutcome::read(
                format!("canvas {} has {} nodes", canvas.name, canvas.nodes.len()),
                json!({
                    "canvas": {
                        "id": canvas.id,
                        "name": canvas.name,
                        "settings": canvas.settings,
                        "viewport": canvas.viewport,
                        "folderId": canvas.folder_id,
                    },
                    "nodes": nodes,
                    "edges": edges,
                    "groups": canvas.groups,
                    "nodeCount": canvas.nodes.len(),
                    "truncated": canvas.nodes.len() > limit,
                }),
            ))
        }
        "canvas.get_node" => {
            let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
            let node_id = args.req_str("nodeId")?;
            let node = canvas.node(node_id).ok_or_else(|| {
                ToolError::new("NODE_NOT_FOUND", format!("node {node_id} does not exist"))
            })?;
            let runs: Vec<Value> = vec![];
            let data = serde_json::to_value(&node.data).unwrap_or_default();
            let asset = node
                .data
                .asset_id
                .as_deref()
                .and_then(|id| moka.resources.find(id))
                .map(|entry| serde_json::to_value(entry).unwrap_or_default());
            Ok(ToolOutcome::read(
                format!("{} ({})", node.title, node.kind.as_str()),
                json!({
                    "id": node.id,
                    "kind": node.kind,
                    "title": node.title,
                    "bounds": node.bounds,
                    "zIndex": node.z_index,
                    "data": data,
                    "ports": node.ports,
                    "asset": asset,
                    "runs": runs,
                    "createdAt": node.created_at,
                    "updatedAt": node.updated_at,
                }),
            ))
        }
        "canvas.create" => {
            let canvas_name = args.req_str("name")?.to_string();
            let folder_id = args.opt_str("folderId").map(str::to_string);
            let index = args.opt_i64("index").map(|index| index.max(0) as usize);
            let canvas = crate::domain::CanvasDocument {
                folder_id,
                ..crate::domain::CanvasDocument::empty(crate::domain::new_id(), canvas_name.clone())
            };
            Ok(ToolOutcome::write(
                format!("Created canvas {canvas_name}"),
                json!({"canvasId": canvas.id}),
                vec![DocumentCommand::AddCanvas { canvas, index }],
            ))
        }
        "canvas.update" => {
            let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
            let mut commands = Vec::new();
            if let Some(new_name) = args.opt_str("name") {
                commands.push(DocumentCommand::RenameCanvas {
                    canvas_id: canvas.id.clone(),
                    name: new_name.to_string(),
                });
            }
            if let Some(settings) = args.opt_object("settings") {
                let patch: crate::domain::SettingsPatch =
                    serde_json::from_value(Value::Object(settings.clone())).map_err(|error| {
                        ToolError::validation(format!("settings is not valid: {error}"))
                    })?;
                commands.push(DocumentCommand::SetCanvasSettings {
                    canvas_id: canvas.id.clone(),
                    settings: patch,
                });
            }
            if let Some(folder) = args.raw("folderId") {
                let folder_id = folder.as_str().map(str::to_string);
                let index = args
                    .opt_i64("index")
                    .map(|index| index.max(0) as usize)
                    .unwrap_or_else(|| {
                        moka.canvas
                            .iter()
                            .filter(|other| other.folder_id == folder_id && other.id != canvas.id)
                            .count()
                    });
                commands.push(DocumentCommand::MoveCanvas {
                    canvas_id: canvas.id.clone(),
                    folder_id,
                    index,
                });
            }
            if commands.is_empty() {
                return Err(ToolError::validation(
                    "canvas.update needs a name, settings, or folderId",
                ));
            }
            Ok(ToolOutcome::write(
                format!("Updated canvas {}", canvas.name),
                json!({"canvasId": canvas.id}),
                commands,
            ))
        }
        "canvas.delete" => {
            args.confirmed()?;
            let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
            Ok(ToolOutcome::write(
                format!(
                    "Deleted canvas {} ({} nodes)",
                    canvas.name,
                    canvas.nodes.len()
                ),
                json!({"canvasId": canvas.id, "deletedNodes": canvas.nodes.len()}),
                vec![DocumentCommand::RemoveCanvas {
                    canvas_id: canvas.id.clone(),
                }],
            ))
        }
        "canvas.add_node" => add_node(moka, &args),
        "canvas.update_node" => update_node(moka, &args),
        "canvas.move_nodes" => move_nodes(moka, &args),
        "canvas.resize_nodes" => resize_nodes(moka, &args),
        "canvas.remove_nodes" => remove_nodes(moka, &args),
        "canvas.connect" => connect(moka, &args),
        "canvas.disconnect" => disconnect(moka, &args),
        "canvas.group_nodes" => group_nodes(moka, &args),
        "canvas.ungroup" => ungroup(moka, &args),
        "canvas.duplicate_nodes" => duplicate_nodes(moka, &args),
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not a canvas command"),
        )),
    }
}

fn node_summary(node: &WorkflowNode) -> Value {
    let generation = node.data.generation.as_ref().map(|generation| {
        json!({
            "capability": generation.capability,
            "mode": generation.mode,
            "model": generation.model,
            "prompt": shorten(&generation.prompt, 200),
        })
    });
    json!({
        "id": node.id,
        "kind": node.kind,
        "title": node.title,
        "bounds": node.bounds,
        "zIndex": node.z_index,
        "assetId": node.data.asset_id,
        "text": node.data.content.as_deref().map(|text| shorten(text, 200)),
        "textLength": node.data.content.as_deref().map(|text| text.chars().count()),
        "generation": generation,
    })
}

fn shorten(text: &str, limit: usize) -> String {
    let mut value: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        value.push('…');
    }
    value
}

fn node_of<'a>(
    canvas: &'a crate::domain::CanvasDocument,
    id: &str,
) -> Result<&'a WorkflowNode, ToolError> {
    canvas.node(id).ok_or_else(|| {
        ToolError::new("NODE_NOT_FOUND", format!("node {id} does not exist"))
            .details(json!({"nodeId": id}))
    })
}

fn parse_kind(value: &str) -> Result<NodeKind, ToolError> {
    match value {
        "text" => Ok(NodeKind::Text),
        "image" => Ok(NodeKind::Image),
        "audio" => Ok(NodeKind::Audio),
        "video" => Ok(NodeKind::Video),
        "operation" => Ok(NodeKind::Operation),
        "group" => Ok(NodeKind::Group),
        "export" => Ok(NodeKind::Export),
        other => Err(ToolError::validation(format!(
            "kind '{other}' is not a card this tool can add"
        ))),
    }
}

fn add_node(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let kind = parse_kind(args.req_str("kind")?)?;
    let title = args
        .opt_str("title")
        .map(str::to_string)
        .unwrap_or_else(|| title_for(kind));
    let (x, y) = match args.opt_object("position") {
        Some(position) => (
            position.get("x").and_then(Value::as_f64).unwrap_or(0.0),
            position.get("y").and_then(Value::as_f64).unwrap_or(0.0),
        ),
        None => {
            let bottom = canvas
                .nodes
                .iter()
                .map(|node| node.bounds.y + node.bounds.height)
                .fold(0.0_f64, f64::max);
            (canvas.viewport.x, bottom + 40.0)
        }
    };
    let mut node = make_node(kind, title, x, y);
    if let Some(asset_id) = args.opt_str("assetId") {
        let entry = moka.resources.find(asset_id).ok_or_else(|| {
            ToolError::new(
                "ASSET_NOT_FOUND",
                format!("asset {asset_id} is not in this project"),
            )
        })?;
        if !kind_accepts_asset(kind, &entry.path) {
            return Err(ToolError::validation(format!(
                "{} cannot hold a {kind} card",
                entry.name,
                kind = kind.as_str()
            )));
        }
        node.data.asset_id = Some(asset_id.to_string());
    }
    if let Some(text) = args.opt_str("text") {
        if kind != NodeKind::Text {
            return Err(ToolError::validation("only a text card holds text"));
        }
        node.data.content = Some(text.to_string());
    }
    if let Some(generation) = args.opt_object("generation") {
        let mut spec = generation.clone();
        spec.entry("updatedAt").or_insert_with(|| json!(now_iso()));
        spec.entry("capability")
            .or_insert_with(|| json!(default_capability(kind)));
        spec.entry("mode").or_insert_with(|| json!("generate"));
        spec.entry("inputMode").or_insert_with(|| json!("upstream"));
        spec.entry("model").or_insert_with(|| json!(""));
        spec.entry("prompt").or_insert_with(|| json!(""));
        let spec: GenerationSpec = serde_json::from_value(Value::Object(spec))
            .map_err(|error| ToolError::validation(format!("generation is not valid: {error}")))?;
        node.data.generation = Some(spec);
    }
    let node_id = node.id.clone();
    Ok(ToolOutcome::write(
        format!("Added {} card \"{}\"", kind.as_str(), node.title),
        json!({"nodeId": node_id, "kind": kind, "title": node.title, "bounds": node.bounds}),
        vec![DocumentCommand::AddNode {
            canvas_id: canvas.id.clone(),
            node,
        }],
    ))
}

fn title_for(kind: NodeKind) -> String {
    match kind {
        NodeKind::Text => "Text",
        NodeKind::Image => "Image",
        NodeKind::Audio => "Audio",
        NodeKind::Video => "Video",
        NodeKind::Operation => "Operation",
        NodeKind::Group => "Group",
        NodeKind::Export => "Export",
        _ => "Card",
    }
    .to_string()
}

fn default_capability(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Image => "image",
        NodeKind::Audio => "speech",
        NodeKind::Video => "video",
        _ => "text",
    }
}

fn kind_accepts_asset(kind: NodeKind, path: &str) -> bool {
    let category = path.split('/').nth(1).unwrap_or_default();
    match kind {
        NodeKind::Image => category == "images",
        NodeKind::Audio => matches!(category, "music" | "voice"),
        NodeKind::Video => category == "videos",
        NodeKind::Text => category == "texts",
        _ => false,
    }
}

fn update_node(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let node = node_of(canvas, args.req_str("nodeId")?)?;
    let mut patch = NodePatch {
        title: None,
        z_index: None,
        data: None,
        ports: None,
    };
    if let Some(title) = args.opt_str("title") {
        patch.title = Some(title.to_string());
    }
    if let Some(z_index) = args.opt_i64("zIndex") {
        patch.z_index = Some(z_index as i32);
    }
    if let Some(partial) = args.opt_object("data") {
        let mut data = serde_json::to_value(&node.data).unwrap_or_else(|_| json!({}));
        let map = data.as_object_mut().expect("a node data is an object");
        for (key, value) in partial {
            map.insert(key.clone(), value.clone());
        }
        let merged: NodeData = serde_json::from_value(data)
            .map_err(|error| ToolError::validation(format!("data is not valid: {error}")))?;
        patch.data = Some(merged);
    }
    if patch.title.is_none() && patch.z_index.is_none() && patch.data.is_none() {
        return Err(ToolError::validation(
            "canvas.update_node needs title, data, or zIndex",
        ));
    }
    Ok(ToolOutcome::write(
        format!("Updated node {}", node.title),
        json!({"nodeId": node.id}),
        vec![DocumentCommand::UpdateNode {
            canvas_id: canvas.id.clone(),
            node_id: node.id.clone(),
            patch,
        }],
    ))
}

fn move_nodes(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let mut positions: BTreeMap<String, PointValue> = BTreeMap::new();
    if let Some(moves) = args.opt_array("moves") {
        for movement in moves {
            let node_id = movement
                .get("nodeId")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::validation("every move needs nodeId"))?;
            node_of(canvas, node_id)?;
            let x = movement.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = movement.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            positions.insert(node_id.to_string(), PointValue { x, y });
        }
    } else if let Some(layout) = args.opt_str("layout") {
        let ids = args.opt_strings("nodeIds");
        let nodes: Vec<&WorkflowNode> = if ids.is_empty() {
            canvas.nodes.iter().collect()
        } else {
            ids.iter()
                .map(|id| node_of(canvas, id))
                .collect::<Result<Vec<_>, _>>()?
        };
        let gap = args.opt_f64("gap").unwrap_or(40.0);
        let (mut x, mut y) = args
            .opt_object("origin")
            .map(|origin| {
                (
                    origin.get("x").and_then(Value::as_f64).unwrap_or(0.0),
                    origin.get("y").and_then(Value::as_f64).unwrap_or(0.0),
                )
            })
            .unwrap_or((0.0, 0.0));
        let columns = args.opt_i64("columns").unwrap_or(3).clamp(1, 20) as usize;
        let mut row_height = 0.0_f64;
        for (index, node) in nodes.iter().enumerate() {
            positions.insert(node.id.clone(), PointValue { x, y });
            match layout {
                "row" => {
                    x += node.bounds.width + gap;
                }
                "column" => {
                    y += node.bounds.height + gap;
                }
                "grid" => {
                    if (index + 1) % columns == 0 {
                        x = args
                            .opt_object("origin")
                            .and_then(|origin| origin.get("x").and_then(Value::as_f64))
                            .unwrap_or(0.0);
                        y += row_height + gap;
                        row_height = 0.0;
                    } else {
                        x += node.bounds.width + gap;
                        row_height = row_height.max(node.bounds.height);
                    }
                }
                other => {
                    return Err(ToolError::validation(format!(
                        "layout '{other}' is not row, column, or grid"
                    )))
                }
            }
        }
    } else {
        return Err(ToolError::validation(
            "canvas.move_nodes needs moves or a layout",
        ));
    }
    Ok(ToolOutcome::write(
        format!("Moved {} nodes", positions.len()),
        json!({"moved": positions.len()}),
        vec![DocumentCommand::MoveNodes {
            canvas_id: canvas.id.clone(),
            positions,
        }],
    ))
}

fn resize_nodes(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let mut commands = Vec::new();
    for resize in args.req_array("resizes")? {
        let node_id = resize
            .get("nodeId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::validation("every resize needs nodeId"))?;
        let node = node_of(canvas, node_id)?;
        let width = resize
            .get("width")
            .and_then(Value::as_f64)
            .ok_or_else(|| ToolError::validation("every resize needs width"))?;
        let height = resize
            .get("height")
            .and_then(Value::as_f64)
            .ok_or_else(|| ToolError::validation("every resize needs height"))?;
        if width < 80.0 || height < 60.0 {
            return Err(ToolError::validation(
                "a card cannot be smaller than 80 by 60",
            ));
        }
        commands.push(DocumentCommand::ResizeNode {
            canvas_id: canvas.id.clone(),
            node_id: node.id.clone(),
            bounds: Rect {
                x: node.bounds.x,
                y: node.bounds.y,
                width,
                height,
            },
        });
    }
    Ok(ToolOutcome::write(
        format!("Resized {} nodes", commands.len()),
        json!({"resized": commands.len()}),
        commands,
    ))
}

fn remove_nodes(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    args.confirmed()?;
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let node_ids = args.req_strings("nodeIds")?;
    for id in &node_ids {
        node_of(canvas, id)?;
    }
    let titles: Vec<String> = node_ids
        .iter()
        .filter_map(|id| canvas.node(id).map(|node| node.title.clone()))
        .collect();
    Ok(ToolOutcome::write(
        format!("Deleted {} nodes: {}", node_ids.len(), titles.join(", ")),
        json!({"nodeIds": node_ids}),
        vec![DocumentCommand::RemoveNodes {
            canvas_id: canvas.id.clone(),
            node_ids,
        }],
    ))
}

fn connect(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let source: EdgeEndpoint = serde_json::from_value(
        args.raw("source")
            .cloned()
            .ok_or_else(|| ToolError::validation("connect needs source"))?,
    )
    .map_err(|error| ToolError::validation(format!("source is not valid: {error}")))?;
    let target: EdgeEndpoint = serde_json::from_value(
        args.raw("target")
            .cloned()
            .ok_or_else(|| ToolError::validation("connect needs target"))?,
    )
    .map_err(|error| ToolError::validation(format!("target is not valid: {error}")))?;
    validate_edge_candidate(canvas, &source, &target)
        .map_err(|rejection| ToolError::new(rejection.code, rejection.message))?;
    let edge = WorkflowEdge {
        id: crate::domain::new_id(),
        source,
        target,
        created_at: now_iso(),
    };
    Ok(ToolOutcome::write(
        "Connected two ports",
        json!({"edgeId": edge.id}),
        vec![DocumentCommand::AddEdge {
            canvas_id: canvas.id.clone(),
            edge,
        }],
    ))
}

fn disconnect(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let edge_ids = args.req_strings("edgeIds")?;
    for id in &edge_ids {
        if !canvas.edges.iter().any(|edge| &edge.id == id) {
            return Err(ToolError::new(
                "EDGE_NOT_FOUND",
                format!("edge {id} does not exist"),
            ));
        }
    }
    Ok(ToolOutcome::write(
        format!("Removed {} edges", edge_ids.len()),
        json!({"edgeIds": edge_ids}),
        vec![DocumentCommand::RemoveEdges {
            canvas_id: canvas.id.clone(),
            edge_ids,
        }],
    ))
}

fn group_nodes(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let node_ids = args.req_strings("nodeIds")?;
    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    for id in &node_ids {
        let node = node_of(canvas, id)?;
        min_x = min_x.min(node.bounds.x);
        min_y = min_y.min(node.bounds.y);
        max_x = max_x.max(node.bounds.x + node.bounds.width);
        max_y = max_y.max(node.bounds.y + node.bounds.height);
    }
    let title = args.opt_str("title").unwrap_or("Group").to_string();
    let mut group = make_node(
        NodeKind::Group,
        title.clone(),
        min_x - GROUP_MARGIN,
        min_y - GROUP_MARGIN,
    );
    group.bounds = Rect {
        x: min_x - GROUP_MARGIN,
        y: min_y - GROUP_MARGIN,
        width: (max_x - min_x) + GROUP_MARGIN * 2.0,
        height: (max_y - min_y) + GROUP_MARGIN * 2.0,
    };
    group.data.child_node_ids = Some(node_ids.clone());
    if let Some(color) = args.opt_str("color") {
        group.data.color = Some(color.to_string());
    }
    let group_id = group.id.clone();
    Ok(ToolOutcome::write(
        format!("Grouped {} nodes", node_ids.len()),
        json!({"groupId": group_id}),
        vec![
            DocumentCommand::AddNode {
                canvas_id: canvas.id.clone(),
                node: group,
            },
            DocumentCommand::SetGroupMembership {
                canvas_id: canvas.id.clone(),
                group_id: group_id.clone(),
                child_node_ids: node_ids,
            },
        ],
    ))
}

fn ungroup(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let group_id = args.req_str("groupId")?.to_string();
    let group = node_of(canvas, &group_id)?;
    if group.kind != NodeKind::Group {
        return Err(ToolError::validation(format!("{group_id} is not a group")));
    }
    let mut commands = vec![DocumentCommand::SetGroupMembership {
        canvas_id: canvas.id.clone(),
        group_id: group_id.clone(),
        child_node_ids: Vec::new(),
    }];
    if !args.opt_bool("keepGroupNode", false) {
        commands.push(DocumentCommand::RemoveNodes {
            canvas_id: canvas.id.clone(),
            node_ids: vec![group_id.clone()],
        });
    }
    Ok(ToolOutcome::write(
        format!("Released group {}", group.title),
        json!({"groupId": group_id, "childNodeIds": group.data.child_node_ids}),
        commands,
    ))
}

fn duplicate_nodes(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let node_ids = args.req_strings("nodeIds")?;
    let offset_x = args
        .opt_object("offset")
        .and_then(|offset| offset.get("x").and_then(Value::as_f64))
        .unwrap_or(40.0);
    let offset_y = args
        .opt_object("offset")
        .and_then(|offset| offset.get("y").and_then(Value::as_f64))
        .unwrap_or(40.0);
    let mut commands = Vec::new();
    let mut id_map = BTreeMap::new();
    let now = now_iso();
    for id in &node_ids {
        let original = node_of(canvas, id)?;
        let mut copy = original.clone();
        copy.id = crate::domain::new_id();
        copy.title = format!("{} (copy)", original.title);
        copy.bounds.x += offset_x;
        copy.bounds.y += offset_y;
        copy.created_at = now.clone();
        copy.updated_at = now.clone();
        copy.data.result_slots = None;
        copy.data.result_node_ids = None;
        id_map.insert(original.id.clone(), copy.id.clone());
        commands.push(DocumentCommand::AddNode {
            canvas_id: canvas.id.clone(),
            node: copy,
        });
    }
    let mut edge_ids = Vec::new();
    for edge in &canvas.edges {
        if let (Some(source), Some(target)) = (
            id_map.get(&edge.source.node_id),
            id_map.get(&edge.target.node_id),
        ) {
            let id = crate::domain::new_id();
            edge_ids.push(id.clone());
            commands.push(DocumentCommand::AddEdge {
                canvas_id: canvas.id.clone(),
                edge: WorkflowEdge {
                    id,
                    source: EdgeEndpoint {
                        node_id: source.clone(),
                        port_id: edge.source.port_id.clone(),
                    },
                    target: EdgeEndpoint {
                        node_id: target.clone(),
                        port_id: edge.target.port_id.clone(),
                    },
                    created_at: now.clone(),
                },
            });
        }
    }
    let new_ids: Vec<String> = id_map.into_values().collect();
    Ok(ToolOutcome::write(
        format!("Copied {} nodes", new_ids.len()),
        json!({"nodeIds": new_ids, "edgeIds": edge_ids}),
        commands,
    ))
}

/// Starts a run. External work, so an effect: no commands, one audit, and a
/// handle the caller waits on itself.
pub async fn effect(
    state: &ApiState,
    session: &ProjectSession,
    input: &Value,
    session_id: Option<&str>,
) -> Result<ToolOutcome, ToolError> {
    let args = Args::new("canvas.run", input)?;
    let canvas_id = args.req_str("canvasId")?.to_string();
    let node_ids = args.req_strings("nodeIds")?;
    let asked_by = args
        .opt_str("sessionId")
        .map(str::to_string)
        .or_else(|| session_id.map(str::to_string));
    let run = state
        .runs
        .start(&session.0, &canvas_id, node_ids.clone(), None, asked_by)
        .await
        .map_err(|error| match error {
            crate::workflow::runner::StartRunError::Validation(issues) => {
                let first = issues
                    .first()
                    .map(|issue| issue.message.clone())
                    .unwrap_or_else(|| "the run was refused".into());
                ToolError::validation(first).details(json!({"issues": issues}))
            }
            crate::workflow::runner::StartRunError::Store(error) => error.into(),
        })?;
    Ok(ToolOutcome {
        summary: format!("Started a run for {} nodes", node_ids.len()),
        data: json!({"runId": run.id, "canvasId": canvas_id, "nodeIds": node_ids}),
        task: Some(TaskRef {
            kind: "run".into(),
            id: run.id,
        }),
        ..ToolOutcome::default()
    })
}
