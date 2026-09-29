use std::collections::{HashMap, HashSet};

use super::folders::{
    canvas_folder_of, canvas_sibling_index, child_folders, descendant_folder_ids, folder_by_id,
    folder_canvases, folder_depth, folder_sibling_index, folders_of, subtree_depth,
};
use super::validate::{
    bounds_valid, resource_path_valid, validate_edge_candidate, MAX_ASSISTANT_MESSAGES_PER_SESSION,
    MAX_ASSISTANT_MESSAGE_LENGTH, MAX_ASSISTANT_SESSIONS_PER_CANVAS, MAX_ASSISTANT_TITLE_LENGTH,
    MAX_CANVASES_PER_PROJECT, MAX_CANVAS_NAME_LENGTH, MAX_EDGES_PER_CANVAS,
    MAX_FOLDERS_PER_PROJECT, MAX_FOLDER_DEPTH, MAX_FOLDER_NAME_LENGTH, MAX_NODES_PER_CANVAS,
    MAX_TITLE_LENGTH, ZOOM_MAX, ZOOM_MIN,
};
use super::{
    story, timeline, AssistantMessage, AssistantSession, CanvasDocument, CanvasFolder,
    DocumentCommand, GroupMembership, MessageId, MokaFile, NodeData, NodeId, NodeKind, PointValue,
    SettingsPatch, WorkflowNode,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub struct CommandError {
    pub code: &'static str,
    #[source]
    pub cause: anyhow::Error,
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.cause)
    }
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            cause: anyhow::anyhow!(message.into()),
        }
    }
}

fn canvas_of<'a>(moka: &'a MokaFile, canvas_id: &str) -> Result<&'a CanvasDocument, CommandError> {
    moka.canvas(canvas_id)
        .ok_or_else(|| CommandError::new("CANVAS_NOT_FOUND", "Canvas not found"))
}

/// A project carrying these folders, or carrying the field not at all when it
/// has none, so a tree emptied of its folders writes what it would have written
/// had nobody ever tidied it.
fn with_folders(moka: &MokaFile, folders: Vec<CanvasFolder>) -> MokaFile {
    MokaFile {
        folders: if folders.is_empty() {
            None
        } else {
            Some(folders)
        },
        ..moka.clone()
    }
}

fn check_folder_name(name: &str) -> Result<(), CommandError> {
    if name.is_empty() {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Folder name is empty",
        ));
    }
    if name.chars().count() > MAX_FOLDER_NAME_LENGTH {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            "Folder name is too long",
        ));
    }
    Ok(())
}

/// The folder named here, checked against the document: a canvas or a folder
/// put somewhere the tree does not hold would be somewhere no reader can reach.
fn folder_of<'a>(
    moka: &'a MokaFile,
    folder_id: Option<&str>,
) -> Result<Option<&'a str>, CommandError> {
    match folder_id {
        None => Ok(None),
        Some(id) => folder_by_id(moka, id)
            .map(|folder| Some(folder.id.as_str()))
            .ok_or_else(|| CommandError::new("FOLDER_NOT_FOUND", "Folder not found")),
    }
}

/// Whether a folder put here would take the tree past the depth it is kept to.
///
/// Measured over the document as it would be, so what the folder carries under
/// it counts as well as the folder itself: a drawer with two levels in it needs
/// two levels of room where it is dropped.
fn check_folder_depth(candidate: &MokaFile, folder_id: &str) -> Result<(), CommandError> {
    let depth = folder_depth(candidate, folder_id) + subtree_depth(candidate, folder_id) - 1;
    if depth > MAX_FOLDER_DEPTH {
        return Err(CommandError::new(
            "VALIDATION_FAILED",
            format!("Folders nest at most {MAX_FOLDER_DEPTH} deep"),
        ));
    }
    Ok(())
}

/// Puts `item` into `list` at the place `index` names among `peers`.
///
/// The two lists a tree is made of are each a slice of one flat list, so a place
/// among siblings has to be turned back into a place in the flat list: before
/// the sibling it was asked to land ahead of, after the last of them when it was
/// asked for the end, and at the end of everything when it has no siblings at
/// all — where among none it lands cannot be seen.
///
/// `peers` must already exclude the item, which is what a move does first.
fn splice_among<T: Clone, F: Fn(&T) -> &str>(
    list: Vec<T>,
    peers: &[T],
    index: usize,
    item: T,
    id_of: F,
) -> Vec<T> {
    let at = index.min(peers.len());
    let mut next = list;
    let flat = if at < peers.len() {
        let wanted = id_of(&peers[at]);
        next.iter().position(|held| id_of(held) == wanted)
    } else if let Some(last) = peers.last() {
        let wanted = id_of(last);
        next.iter()
            .position(|held| id_of(held) == wanted)
            .map(|position| position + 1)
    } else {
        None
    };
    match flat {
        Some(position) => next.insert(position, item),
        None => next.push(item),
    }
    next
}

fn clamp_zoom(zoom: f64) -> f64 {
    zoom.clamp(ZOOM_MIN, ZOOM_MAX)
}

fn session_of<'a>(
    canvas: &'a CanvasDocument,
    session_id: &str,
) -> Result<&'a AssistantSession, CommandError> {
    canvas
        .sessions
        .iter()
        .flatten()
        .find(|session| session.id == session_id)
        .ok_or_else(|| CommandError::new("SESSION_NOT_FOUND", "Session not found"))
}

/// A canvas carrying these conversations, or carrying the field not at all when
/// there are none.
///
/// A canvas emptied of its conversations writes what it would have written had
/// nobody ever asked it anything, which is the honest reading of it: there is
/// nothing left to say about, and an empty list would claim a place was made.
fn with_sessions(canvas: &CanvasDocument, sessions: Vec<AssistantSession>) -> CanvasDocument {
    let mut next = canvas.clone();
    next.sessions = if sessions.is_empty() {
        None
    } else {
        Some(sessions)
    };
    next
}

fn with_session(canvas: &CanvasDocument, session: AssistantSession) -> CanvasDocument {
    let mut sessions = canvas.sessions.clone().unwrap_or_default();
    if let Some(slot) = sessions.iter_mut().find(|held| held.id == session.id) {
        *slot = session;
    }
    with_sessions(canvas, sessions)
}

fn sync_group_node_data(canvas: &mut CanvasDocument) {
    for node in &mut canvas.nodes {
        if node.kind != NodeKind::Group {
            continue;
        }
        let membership = canvas
            .groups
            .iter()
            .find(|group| group.group_id == node.id)
            .map(|group| group.child_node_ids.clone())
            .unwrap_or_default();
        if node.data.child_node_ids.as_ref() != Some(&membership) {
            node.data.child_node_ids = Some(membership);
        }
    }
}

/// Applies one command to a cloned document and returns the new document
/// plus the inverse commands that restore the previous state.
pub fn apply_commands(
    moka: &MokaFile,
    commands: &[DocumentCommand],
) -> Result<(MokaFile, Vec<DocumentCommand>), CommandError> {
    let mut current = moka.clone();
    let mut inverses: Vec<DocumentCommand> = Vec::new();
    for command in commands {
        let (next, inverse) = apply_one(&current, command)?;
        current = next;
        // Later inverses must run first when unwinding.
        for item in inverse.into_iter().rev() {
            inverses.insert(0, item);
        }
    }
    Ok((current, inverses))
}

fn apply_one(
    moka: &MokaFile,
    command: &DocumentCommand,
) -> Result<(MokaFile, Vec<DocumentCommand>), CommandError> {
    match command {
        DocumentCommand::UpdateProjectMetadata { name, description } => {
            let name = name.trim();
            if name.is_empty() {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Project name is empty",
                ));
            }
            let description = description.trim();
            let mut next = moka.clone();
            next.metadata.name = name.to_string();
            next.metadata.description = if description.is_empty() {
                None
            } else {
                Some(description.to_string())
            };
            Ok((
                next,
                vec![DocumentCommand::UpdateProjectMetadata {
                    name: moka.metadata.name.clone(),
                    description: moka.metadata.description.clone().unwrap_or_default(),
                }],
            ))
        }

        DocumentCommand::AddNode { canvas_id, node } => {
            let canvas = canvas_of(moka, canvas_id)?;
            if canvas.node(&node.id).is_some() {
                return Err(CommandError::new("CONFLICT", "Node id already exists"));
            }
            if canvas.nodes.len() + 1 > MAX_NODES_PER_CANVAS {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Canvas node limit reached",
                ));
            }
            if !bounds_valid(&node.bounds) {
                return Err(CommandError::new(
                    "BOUNDS_INVALID",
                    "Node bounds are invalid",
                ));
            }
            if node.title.chars().count() > MAX_TITLE_LENGTH {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Node title is too long",
                ));
            }
            let mut next = moka.clone();
            next.canvas_mut(canvas_id)
                .expect("canvas checked above")
                .nodes
                .push(node.clone());
            Ok((
                next,
                vec![DocumentCommand::RemoveNodes {
                    canvas_id: canvas_id.clone(),
                    node_ids: vec![node.id.clone()],
                }],
            ))
        }

        DocumentCommand::UpdateNode {
            canvas_id,
            node_id,
            patch,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let node = canvas
                .node(node_id)
                .ok_or_else(|| CommandError::new("NODE_NOT_FOUND", "Node not found"))?;
            if let Some(title) = &patch.title {
                if title.chars().count() > MAX_TITLE_LENGTH {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "Node title is too long",
                    ));
                }
            }
            let mut inverse_patch = super::NodePatch::default();
            if patch.title.is_some() {
                inverse_patch.title = Some(node.title.clone());
            }
            if patch.z_index.is_some() {
                inverse_patch.z_index = Some(node.z_index);
            }
            if patch.data.is_some() {
                inverse_patch.data = Some(node.data.clone());
            }
            let mut next = moka.clone();
            let target = next
                .canvas_mut(canvas_id)
                .expect("canvas checked above")
                .nodes
                .iter_mut()
                .find(|node| &node.id == node_id)
                .expect("node checked above");
            if let Some(title) = &patch.title {
                target.title = title.clone();
            }
            if let Some(z_index) = patch.z_index {
                target.z_index = z_index;
            }
            if let Some(data) = &patch.data {
                target.data = data.clone();
            }
            Ok((
                next,
                vec![DocumentCommand::UpdateNode {
                    canvas_id: canvas_id.clone(),
                    node_id: node_id.clone(),
                    patch: inverse_patch,
                }],
            ))
        }

        DocumentCommand::MoveNodes {
            canvas_id,
            positions,
        } => {
            canvas_of(moka, canvas_id)?;
            for point in positions.values() {
                if !point.x.is_finite() || !point.y.is_finite() {
                    return Err(CommandError::new(
                        "BOUNDS_INVALID",
                        "Position is not finite",
                    ));
                }
            }
            let mut previous: std::collections::BTreeMap<NodeId, PointValue> =
                std::collections::BTreeMap::new();
            let mut next = moka.clone();
            let canvas_mut = next.canvas_mut(canvas_id).expect("canvas checked above");
            for node in &mut canvas_mut.nodes {
                if let Some(position) = positions.get(&node.id) {
                    previous.insert(
                        node.id.clone(),
                        PointValue {
                            x: node.bounds.x,
                            y: node.bounds.y,
                        },
                    );
                    node.bounds.x = position.x;
                    node.bounds.y = position.y;
                }
            }
            sync_group_node_data(canvas_mut);
            Ok((
                next,
                vec![DocumentCommand::MoveNodes {
                    canvas_id: canvas_id.clone(),
                    positions: previous,
                }],
            ))
        }

        DocumentCommand::ResizeNode {
            canvas_id,
            node_id,
            bounds,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let node = canvas
                .node(node_id)
                .ok_or_else(|| CommandError::new("NODE_NOT_FOUND", "Node not found"))?;
            if !bounds_valid(bounds) {
                return Err(CommandError::new("BOUNDS_INVALID", "Bounds are invalid"));
            }
            let previous = node.bounds;
            let mut next = moka.clone();
            let target = next
                .canvas_mut(canvas_id)
                .expect("canvas checked above")
                .nodes
                .iter_mut()
                .find(|node| &node.id == node_id)
                .expect("node checked above");
            target.bounds = *bounds;
            Ok((
                next,
                vec![DocumentCommand::ResizeNode {
                    canvas_id: canvas_id.clone(),
                    node_id: node_id.clone(),
                    bounds: previous,
                }],
            ))
        }

        DocumentCommand::RemoveNodes {
            canvas_id,
            node_ids,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let mut removing: std::collections::HashSet<&str> =
                node_ids.iter().map(|id| id.as_str()).collect();
            for id in &removing {
                if canvas.node(id).is_none() {
                    return Err(CommandError::new(
                        "NODE_NOT_FOUND",
                        "Some nodes were not found",
                    ));
                }
            }
            let removed_edges: Vec<super::WorkflowEdge> = canvas
                .edges
                .iter()
                .filter(|edge| {
                    removing.contains(edge.source.node_id.as_str())
                        || removing.contains(edge.target.node_id.as_str())
                })
                .cloned()
                .collect();
            let previous_groups = canvas.groups.clone();

            // Groups that drop below two members dissolve with their group nodes.
            let mut dissolved: Vec<String> = Vec::new();
            for group in &canvas.groups {
                if removing.contains(group.group_id.as_str()) {
                    continue;
                }
                let remaining = group
                    .child_node_ids
                    .iter()
                    .filter(|id| !removing.contains(id.as_str()))
                    .count();
                if remaining < 2 {
                    dissolved.push(group.group_id.clone());
                }
            }
            for id in &dissolved {
                removing.insert(id.as_str());
            }

            let mut inverse: Vec<DocumentCommand> = Vec::new();
            for node in &canvas.nodes {
                if removing.contains(node.id.as_str()) {
                    inverse.push(DocumentCommand::AddNode {
                        canvas_id: canvas_id.clone(),
                        node: node.clone(),
                    });
                }
            }
            let mut removed_edges_all = removed_edges;
            for edge in &canvas.edges {
                if (dissolved.contains(&edge.source.node_id)
                    || dissolved.contains(&edge.target.node_id))
                    && !removed_edges_all.iter().any(|e| e.id == edge.id)
                {
                    removed_edges_all.push(edge.clone());
                }
            }
            for edge in &removed_edges_all {
                inverse.push(DocumentCommand::AddEdge {
                    canvas_id: canvas_id.clone(),
                    edge: edge.clone(),
                });
            }

            let mut next = moka.clone();
            let canvas_mut = next.canvas_mut(canvas_id).expect("canvas checked above");
            canvas_mut
                .nodes
                .retain(|node| !removing.contains(node.id.as_str()));
            canvas_mut.edges.retain(|edge| {
                !removing.contains(edge.source.node_id.as_str())
                    && !removing.contains(edge.target.node_id.as_str())
            });
            canvas_mut.groups.retain_mut(|group| {
                if removing.contains(group.group_id.as_str()) {
                    return false;
                }
                group
                    .child_node_ids
                    .retain(|id| !removing.contains(id.as_str()));
                true
            });

            for group in &previous_groups {
                let current = canvas_mut
                    .groups
                    .iter()
                    .find(|candidate| candidate.group_id == group.group_id);
                if current.map(|g| &g.child_node_ids) != Some(&group.child_node_ids) {
                    inverse.push(DocumentCommand::SetGroupMembership {
                        canvas_id: canvas_id.clone(),
                        group_id: group.group_id.clone(),
                        child_node_ids: group.child_node_ids.clone(),
                    });
                }
            }

            sync_group_node_data(canvas_mut);
            Ok((next, inverse))
        }

        DocumentCommand::AddEdge { canvas_id, edge } => {
            let canvas = canvas_of(moka, canvas_id)?;
            if canvas.edges.iter().any(|candidate| candidate.id == edge.id) {
                return Err(CommandError::new("CONFLICT", "Edge id already exists"));
            }
            if canvas.edges.len() + 1 > MAX_EDGES_PER_CANVAS {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Canvas edge limit reached",
                ));
            }
            validate_edge_candidate(canvas, &edge.source, &edge.target)
                .map_err(|rejection| CommandError::new(rejection.code, rejection.message))?;
            let mut next = moka.clone();
            next.canvas_mut(canvas_id)
                .expect("canvas checked above")
                .edges
                .push(edge.clone());
            Ok((
                next,
                vec![DocumentCommand::RemoveEdges {
                    canvas_id: canvas_id.clone(),
                    edge_ids: vec![edge.id.clone()],
                }],
            ))
        }

        DocumentCommand::RemoveEdges {
            canvas_id,
            edge_ids,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let removing: std::collections::HashSet<&str> =
                edge_ids.iter().map(|id| id.as_str()).collect();
            let removed: Vec<super::WorkflowEdge> = canvas
                .edges
                .iter()
                .filter(|edge| removing.contains(edge.id.as_str()))
                .cloned()
                .collect();
            if removed.len() != removing.len() {
                return Err(CommandError::new(
                    "EDGE_NOT_FOUND",
                    "Some edges were not found",
                ));
            }
            let mut next = moka.clone();
            next.canvas_mut(canvas_id)
                .expect("canvas checked above")
                .edges
                .retain(|edge| !removing.contains(edge.id.as_str()));
            Ok((
                next,
                removed
                    .into_iter()
                    .map(|edge| DocumentCommand::AddEdge {
                        canvas_id: canvas_id.clone(),
                        edge,
                    })
                    .collect(),
            ))
        }

        DocumentCommand::SetGroupMembership {
            canvas_id,
            group_id,
            child_node_ids,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let group_node = canvas
                .node(group_id)
                .filter(|node| node.kind == NodeKind::Group)
                .ok_or_else(|| CommandError::new("GROUP_INVALID", "Group node not found"))?;
            let unique: std::collections::HashSet<&str> =
                child_node_ids.iter().map(|id| id.as_str()).collect();
            if unique.len() != child_node_ids.len() {
                return Err(CommandError::new("GROUP_INVALID", "Duplicate group member"));
            }
            if unique.contains(group_id.as_str()) {
                return Err(CommandError::new(
                    "GROUP_INVALID",
                    "A group cannot contain itself",
                ));
            }
            for id in child_node_ids {
                let child = canvas
                    .node(id)
                    .ok_or_else(|| CommandError::new("NODE_NOT_FOUND", "Member not found"))?;
                if child.kind == NodeKind::Group {
                    return Err(CommandError::new(
                        "GROUP_INVALID",
                        "Nested groups are not supported",
                    ));
                }
            }
            let previous = canvas
                .groups
                .iter()
                .find(|group| &group.group_id == group_id)
                .map(|group| group.child_node_ids.clone())
                .unwrap_or_default();

            let mut inverse: Vec<DocumentCommand> = Vec::new();
            let mut next = moka.clone();
            let canvas_mut = next.canvas_mut(canvas_id).expect("canvas checked above");
            canvas_mut
                .groups
                .retain(|group| &group.group_id != group_id);

            if child_node_ids.len() >= 2 {
                canvas_mut.groups.push(GroupMembership {
                    group_id: group_id.clone(),
                    child_node_ids: child_node_ids.clone(),
                });
            } else {
                // Dissolve: drop the group node and its incident edges.
                inverse.push(DocumentCommand::AddNode {
                    canvas_id: canvas_id.clone(),
                    node: group_node.clone(),
                });
                for edge in &canvas.edges {
                    if edge.source.node_id == *group_id || edge.target.node_id == *group_id {
                        inverse.push(DocumentCommand::AddEdge {
                            canvas_id: canvas_id.clone(),
                            edge: edge.clone(),
                        });
                    }
                }
                canvas_mut.nodes.retain(|node| &node.id != group_id);
                canvas_mut.edges.retain(|edge| {
                    edge.source.node_id != *group_id && edge.target.node_id != *group_id
                });
            }
            inverse.push(DocumentCommand::SetGroupMembership {
                canvas_id: canvas_id.clone(),
                group_id: group_id.clone(),
                child_node_ids: previous,
            });

            sync_group_node_data(canvas_mut);
            Ok((next, inverse))
        }

        DocumentCommand::SetViewport {
            canvas_id,
            viewport,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            if !viewport.x.is_finite() || !viewport.y.is_finite() {
                return Err(CommandError::new(
                    "BOUNDS_INVALID",
                    "Viewport is not finite",
                ));
            }
            let previous = canvas.viewport;
            let mut next = moka.clone();
            next.canvas_mut(canvas_id)
                .expect("canvas checked above")
                .viewport = super::Viewport {
                x: viewport.x,
                y: viewport.y,
                zoom: clamp_zoom(viewport.zoom),
            };
            Ok((
                next,
                vec![DocumentCommand::SetViewport {
                    canvas_id: canvas_id.clone(),
                    viewport: previous,
                }],
            ))
        }

        DocumentCommand::SetCanvasSettings {
            canvas_id,
            settings,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let previous = canvas.settings.clone();
            let mut next = moka.clone();
            let target = next.canvas_mut(canvas_id).expect("canvas checked above");
            if let Some(background) = settings.background {
                target.settings.background = background;
            }
            if let Some(show_minimap) = settings.show_minimap {
                target.settings.show_minimap = show_minimap;
            }
            if let Some(snap_to_grid) = settings.snap_to_grid {
                target.settings.snap_to_grid = snap_to_grid;
            }
            Ok((
                next,
                vec![DocumentCommand::SetCanvasSettings {
                    canvas_id: canvas_id.clone(),
                    settings: SettingsPatch {
                        background: Some(previous.background),
                        show_minimap: Some(previous.show_minimap),
                        snap_to_grid: Some(previous.snap_to_grid),
                    },
                }],
            ))
        }

        DocumentCommand::AddSession {
            canvas_id,
            session,
            index,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let sessions: Vec<AssistantSession> = canvas.sessions.clone().unwrap_or_default();
            if sessions.iter().any(|held| held.id == session.id) {
                return Err(CommandError::new("CONFLICT", "Session id already exists"));
            }
            if sessions.len() + 1 > MAX_ASSISTANT_SESSIONS_PER_CANVAS {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Canvas session limit reached",
                ));
            }
            if session.title.is_empty() {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Session title is empty",
                ));
            }
            if session.title.chars().count() > MAX_ASSISTANT_TITLE_LENGTH {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Session title is too long",
                ));
            }
            if session.messages.len() > MAX_ASSISTANT_MESSAGES_PER_SESSION {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Session message limit reached",
                ));
            }
            let inserted_at = (*index).unwrap_or(sessions.len()).min(sessions.len());
            let mut list = sessions;
            list.insert(inserted_at, session.clone());
            let mut next = moka.clone();
            *next.canvas_mut(canvas_id).expect("canvas checked above") =
                with_sessions(canvas, list);
            Ok((
                next,
                vec![DocumentCommand::RemoveSession {
                    canvas_id: canvas_id.clone(),
                    session_id: session.id.clone(),
                }],
            ))
        }

        DocumentCommand::RenameSession {
            canvas_id,
            session_id,
            title,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let session = session_of(canvas, session_id)?;
            if title.is_empty() {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Session title is empty",
                ));
            }
            if title.chars().count() > MAX_ASSISTANT_TITLE_LENGTH {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Session title is too long",
                ));
            }
            let previous = session.title.clone();
            // What a conversation is called is not something said in it, so renaming
            // leaves the moment something was last said alone: the newest conversation
            // is found by it, and a rename would otherwise make this one that.
            let mut renamed = session.clone();
            renamed.title = title.clone();
            let mut next = moka.clone();
            *next.canvas_mut(canvas_id).expect("canvas checked above") =
                with_session(canvas, renamed);
            Ok((
                next,
                vec![DocumentCommand::RenameSession {
                    canvas_id: canvas_id.clone(),
                    session_id: session_id.clone(),
                    title: previous,
                }],
            ))
        }

        DocumentCommand::RemoveSession {
            canvas_id,
            session_id,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let mut list = canvas.sessions.clone().unwrap_or_default();
            let index = list
                .iter()
                .position(|session| &session.id == session_id)
                .ok_or_else(|| CommandError::new("SESSION_NOT_FOUND", "Session not found"))?;
            let removed = list.remove(index);
            let mut next = moka.clone();
            *next.canvas_mut(canvas_id).expect("canvas checked above") =
                with_sessions(canvas, list);
            Ok((
                next,
                vec![DocumentCommand::AddSession {
                    canvas_id: canvas_id.clone(),
                    session: removed,
                    index: Some(index),
                }],
            ))
        }

        DocumentCommand::AppendMessages {
            canvas_id,
            session_id,
            messages: incoming,
            at,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let session = session_of(canvas, session_id)?;
            if incoming.is_empty() {
                return Err(CommandError::new("VALIDATION_FAILED", "Nothing to append"));
            }
            let mut known: HashSet<&str> = session
                .messages
                .iter()
                .map(|line| line.id.as_str())
                .collect();
            for message in incoming {
                if !known.insert(message.id.as_str()) {
                    return Err(CommandError::new("CONFLICT", "Message id already exists"));
                }
                if message.text.chars().count() > MAX_ASSISTANT_MESSAGE_LENGTH {
                    return Err(CommandError::new(
                        "VALIDATION_FAILED",
                        "Message is too long",
                    ));
                }
            }

            let mut messages = session.messages.clone();
            let inserted_at = (*at).unwrap_or(messages.len()).min(messages.len());
            for (offset, message) in incoming.iter().enumerate() {
                messages.insert(inserted_at + offset, message.clone());
            }

            // The oldest lines go to keep a conversation a length that can still be
            // read through. They go from the document and not only from the screen, so
            // the undo that takes the new lines back gives these back too, each at the
            // place it held: putting them back oldest first lands them where they were.
            let overflow = messages
                .len()
                .saturating_sub(MAX_ASSISTANT_MESSAGES_PER_SESSION);
            let dropped: Vec<AssistantMessage> = messages.drain(..overflow).collect();
            let kept: HashSet<&str> = messages.iter().map(|line| line.id.as_str()).collect();
            let appended: Vec<MessageId> = incoming
                .iter()
                .map(|message| message.id.clone())
                .filter(|id| kept.contains(id.as_str()))
                .collect();

            let mut inverse = Vec::new();
            if !appended.is_empty() {
                inverse.push(DocumentCommand::RemoveMessages {
                    canvas_id: canvas_id.clone(),
                    session_id: session_id.clone(),
                    message_ids: appended,
                });
            }
            for (held_at, message) in dropped.into_iter().enumerate() {
                inverse.push(DocumentCommand::AppendMessages {
                    canvas_id: canvas_id.clone(),
                    session_id: session_id.clone(),
                    messages: vec![message],
                    at: Some(held_at),
                });
            }

            let mut updated = session.clone();
            // Only ever moves forward, so taking a line back does not put this back
            // with it: a conversation just taken back out of is still the one to
            // open onto.
            if let Some(spoken_at) = messages.last().map(|line| line.created_at.clone()) {
                if spoken_at > session.updated_at {
                    updated.updated_at = spoken_at;
                }
            }
            updated.messages = messages;
            let mut next = moka.clone();
            *next.canvas_mut(canvas_id).expect("canvas checked above") =
                with_session(canvas, updated);
            Ok((next, inverse))
        }

        DocumentCommand::RemoveMessages {
            canvas_id,
            session_id,
            message_ids,
        } => {
            let canvas = canvas_of(moka, canvas_id)?;
            let session = session_of(canvas, session_id)?;
            let removing: HashSet<&str> = message_ids.iter().map(|id| id.as_str()).collect();
            let removed: Vec<AssistantMessage> = session
                .messages
                .iter()
                .filter(|line| removing.contains(line.id.as_str()))
                .cloned()
                .collect();
            if removed.len() != removing.len() {
                return Err(CommandError::new(
                    "MESSAGE_NOT_FOUND",
                    "Some messages not found",
                ));
            }
            let held: HashMap<&str, usize> = session
                .messages
                .iter()
                .enumerate()
                .map(|(position, line)| (line.id.as_str(), position))
                .collect();
            let mut updated = session.clone();
            updated
                .messages
                .retain(|line| !removing.contains(line.id.as_str()));
            // Each line goes back to the place it held, oldest first, which is the
            // order that lands them all where they were.
            let inverse = removed
                .into_iter()
                .map(|message| DocumentCommand::AppendMessages {
                    canvas_id: canvas_id.clone(),
                    session_id: session_id.clone(),
                    at: held.get(message.id.as_str()).copied(),
                    messages: vec![message],
                })
                .collect();
            let mut next = moka.clone();
            *next.canvas_mut(canvas_id).expect("canvas checked above") =
                with_session(canvas, updated);
            Ok((next, inverse))
        }

        DocumentCommand::AddCanvas { canvas, index } => {
            if moka.canvas.len() + 1 > MAX_CANVASES_PER_PROJECT {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Canvas limit reached",
                ));
            }
            if moka.canvas(&canvas.id).is_some() {
                return Err(CommandError::new("CONFLICT", "Canvas id already exists"));
            }
            // A canvas born into a folder names it, so the folder has to be
            // there: one that is not would leave the board somewhere no tree can
            // show it.
            folder_of(moka, canvas.folder_id.as_deref())?;
            let mut next = moka.clone();
            let index = (*index).unwrap_or(next.canvas.len()).min(next.canvas.len());
            next.canvas.insert(index, canvas.clone());
            Ok((
                next,
                vec![DocumentCommand::RemoveCanvas {
                    canvas_id: canvas.id.clone(),
                }],
            ))
        }

        DocumentCommand::RenameCanvas { canvas_id, name } => {
            let canvas = canvas_of(moka, canvas_id)?;
            if name.is_empty() {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Canvas name is empty",
                ));
            }
            if name.chars().count() > MAX_CANVAS_NAME_LENGTH {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Canvas name is too long",
                ));
            }
            let previous = canvas.name.clone();
            let mut next = moka.clone();
            next.canvas_mut(canvas_id)
                .expect("canvas checked above")
                .name = name.clone();
            Ok((
                next,
                vec![DocumentCommand::RenameCanvas {
                    canvas_id: canvas_id.clone(),
                    name: previous,
                }],
            ))
        }

        DocumentCommand::ReorderCanvas { canvas_id, index } => {
            let position = moka
                .canvas
                .iter()
                .position(|canvas| &canvas.id == canvas_id)
                .ok_or_else(|| CommandError::new("CANVAS_NOT_FOUND", "Canvas not found"))?;
            let target = (*index).min(moka.canvas.len() - 1);
            let mut next = moka.clone();
            let moved = next.canvas.remove(position);
            next.canvas.insert(target, moved);
            Ok((
                next,
                vec![DocumentCommand::ReorderCanvas {
                    canvas_id: canvas_id.clone(),
                    index: position,
                }],
            ))
        }

        DocumentCommand::RemoveCanvas { canvas_id } => {
            let position = moka
                .canvas
                .iter()
                .position(|canvas| &canvas.id == canvas_id)
                .ok_or_else(|| CommandError::new("CANVAS_NOT_FOUND", "Canvas not found"))?;
            if moka.canvas.len() <= 1 {
                return Err(CommandError::new(
                    "CANVAS_REQUIRED",
                    "The last canvas cannot be removed",
                ));
            }
            let removed = moka.canvas[position].clone();
            let mut next = moka.clone();
            next.canvas.remove(position);
            Ok((
                next,
                vec![DocumentCommand::AddCanvas {
                    canvas: removed,
                    index: Some(position),
                }],
            ))
        }

        DocumentCommand::AddFolder { folder, index } => {
            let folders = folders_of(moka).to_vec();
            if folders.len() + 1 > MAX_FOLDERS_PER_PROJECT {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "Folder limit reached",
                ));
            }
            if folders.iter().any(|item| item.id == folder.id) {
                return Err(CommandError::new("CONFLICT", "Folder id already exists"));
            }
            check_folder_name(&folder.name)?;
            let parent_id = folder_of(moka, folder.parent_id.as_deref())?;
            let placed = CanvasFolder {
                parent_id: parent_id.map(str::to_string),
                ..folder.clone()
            };
            let siblings: Vec<CanvasFolder> = folders
                .iter()
                .filter(|item| item.parent_id.as_deref() == parent_id)
                .cloned()
                .collect();
            let at = index.unwrap_or(siblings.len());
            let next = splice_among(
                folders,
                &siblings,
                at,
                placed.clone(),
                |folder: &CanvasFolder| folder.id.as_str(),
            );
            let candidate = with_folders(moka, next);
            check_folder_depth(&candidate, &placed.id)?;
            Ok((
                candidate,
                vec![DocumentCommand::RemoveFolder {
                    folder_id: placed.id.clone(),
                }],
            ))
        }

        DocumentCommand::RenameFolder { folder_id, name } => {
            let folder = folder_by_id(moka, folder_id)
                .ok_or_else(|| CommandError::new("FOLDER_NOT_FOUND", "Folder not found"))?
                .clone();
            check_folder_name(name)?;
            let previous = folder.name.clone();
            let next = folders_of(moka)
                .iter()
                .map(|item| {
                    if item.id == folder.id {
                        CanvasFolder {
                            name: name.clone(),
                            ..item.clone()
                        }
                    } else {
                        item.clone()
                    }
                })
                .collect();
            Ok((
                with_folders(moka, next),
                vec![DocumentCommand::RenameFolder {
                    folder_id: folder.id.clone(),
                    name: previous,
                }],
            ))
        }

        DocumentCommand::MoveFolder {
            folder_id,
            parent_id,
            index,
        } => {
            let folder = folder_by_id(moka, folder_id)
                .ok_or_else(|| CommandError::new("FOLDER_NOT_FOUND", "Folder not found"))?
                .clone();
            let parent = folder_of(moka, parent_id.as_deref())?;
            if parent == Some(folder.id.as_str()) {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "A folder cannot be moved into itself",
                ));
            }
            if descendant_folder_ids(moka, folder_id)
                .iter()
                .any(|id| Some(id.as_str()) == parent)
            {
                return Err(CommandError::new(
                    "VALIDATION_FAILED",
                    "A folder cannot be moved into one it holds",
                ));
            }
            let previous_parent = folder.parent_id.clone();
            let previous_index = folder_sibling_index(moka, folder_id);
            let without: Vec<CanvasFolder> = folders_of(moka)
                .iter()
                .filter(|item| item.id != folder.id)
                .cloned()
                .collect();
            let siblings: Vec<CanvasFolder> = without
                .iter()
                .filter(|item| item.parent_id.as_deref() == parent)
                .cloned()
                .collect();
            let moved = CanvasFolder {
                parent_id: parent.map(str::to_string),
                ..folder
            };
            let next = splice_among(
                without,
                &siblings,
                *index,
                moved,
                |folder: &CanvasFolder| folder.id.as_str(),
            );
            let candidate = with_folders(moka, next);
            check_folder_depth(&candidate, folder_id)?;
            Ok((
                candidate,
                vec![DocumentCommand::MoveFolder {
                    folder_id: folder_id.clone(),
                    parent_id: previous_parent,
                    index: previous_index,
                }],
            ))
        }

        DocumentCommand::RemoveFolder { folder_id } => {
            let folders = folders_of(moka);
            let position = folders
                .iter()
                .position(|item| item.id == *folder_id)
                .ok_or_else(|| CommandError::new("FOLDER_NOT_FOUND", "Folder not found"))?;
            let removed = folders[position].clone();
            let parent_id = removed.parent_id.clone();
            let previous_index = folder_sibling_index(moka, folder_id);
            // What the folder held is not held by nothing: its folders and its
            // canvases go up into the folder that held it, which is what makes
            // tidying the tree something a reader can do without risking a board.
            let held_folders = child_folders(moka, Some(folder_id));
            let held_canvases = folder_canvases(moka, Some(folder_id));
            let held_ids: HashSet<&str> = held_canvases
                .iter()
                .map(|canvas| canvas.id.as_str())
                .collect();
            // Each folder it held takes its place in the list, in the order they
            // were read, so what a drawer held stays where the drawer was rather
            // than going to the end of the shelf it was poured into.
            let mut next_folders: Vec<CanvasFolder> = Vec::with_capacity(folders.len());
            for item in folders {
                if item.id != removed.id {
                    next_folders.push(item.clone());
                    continue;
                }
                for held in &held_folders {
                    next_folders.push(CanvasFolder {
                        parent_id: parent_id.clone(),
                        ..(*held).clone()
                    });
                }
            }
            let next_canvas: Vec<CanvasDocument> = moka
                .canvas
                .iter()
                .map(|canvas| {
                    if held_ids.contains(canvas.id.as_str()) {
                        CanvasDocument {
                            folder_id: parent_id.clone(),
                            ..canvas.clone()
                        }
                    } else {
                        canvas.clone()
                    }
                })
                .collect();
            let mut inverse = vec![DocumentCommand::AddFolder {
                folder: removed.clone(),
                index: Some(previous_index),
            }];
            for (index, held) in held_folders.iter().enumerate() {
                inverse.push(DocumentCommand::MoveFolder {
                    folder_id: held.id.clone(),
                    parent_id: Some(removed.id.clone()),
                    index,
                });
            }
            for (index, held) in held_canvases.iter().enumerate() {
                inverse.push(DocumentCommand::MoveCanvas {
                    canvas_id: held.id.clone(),
                    folder_id: Some(removed.id.clone()),
                    index,
                });
            }
            let next = with_folders(moka, next_folders);
            Ok((
                MokaFile {
                    canvas: next_canvas,
                    ..next
                },
                inverse,
            ))
        }

        DocumentCommand::MoveCanvas {
            canvas_id,
            folder_id,
            index,
        } => {
            let canvas = canvas_of(moka, canvas_id)?.clone();
            let parent = folder_of(moka, folder_id.as_deref())?;
            let previous_parent = canvas_folder_of(&canvas).map(str::to_string);
            let previous_index = canvas_sibling_index(moka, canvas_id);
            let without: Vec<CanvasDocument> = moka
                .canvas
                .iter()
                .filter(|item| item.id != canvas.id)
                .cloned()
                .collect();
            let peers: Vec<CanvasDocument> = without
                .iter()
                .filter(|item| item.folder_id.as_deref() == parent)
                .cloned()
                .collect();
            let moved = CanvasDocument {
                folder_id: parent.map(str::to_string),
                ..canvas
            };
            Ok((
                MokaFile {
                    canvas: splice_among(
                        without,
                        &peers,
                        *index,
                        moved,
                        |canvas: &CanvasDocument| canvas.id.as_str(),
                    ),
                    ..moka.clone()
                },
                vec![DocumentCommand::MoveCanvas {
                    canvas_id: canvas_id.clone(),
                    folder_id: previous_parent,
                    index: previous_index,
                }],
            ))
        }

        // The cutting room's commands live in `timeline.rs`, which holds the
        // same rules the document validator reads so a command and a
        // validation cannot disagree.
        // The story room's commands live in `story.rs`, which holds the same
        // rules the document validator reads so a command and a validation
        // cannot disagree, for the same reason the cutting room's do.
        command @ (DocumentCommand::AddStory { .. }
        | DocumentCommand::RemoveStory { .. }
        | DocumentCommand::RenameStory { .. }
        | DocumentCommand::UpdateStoryBrief { .. }
        | DocumentCommand::UpdateStoryGranularity { .. }
        | DocumentCommand::UpdateStoryReferenceLimit { .. }
        | DocumentCommand::SetStoryChapters { .. }
        | DocumentCommand::SetStoryElements { .. }
        | DocumentCommand::UpdateStoryElement { .. }
        | DocumentCommand::UpdateStoryNarrator { .. }
        | DocumentCommand::SetStoryActs { .. }
        | DocumentCommand::UpdateStoryAct { .. }
        | DocumentCommand::UpdateStoryKeyframe { .. }
        | DocumentCommand::SetStorySlot { .. }
        | DocumentCommand::ConfirmStoryStep { .. }
        | DocumentCommand::SetStoryEdit { .. }) => story::apply_story_command(moka, command),
        command @ (DocumentCommand::AddTimeline { .. }
        | DocumentCommand::RemoveTimeline { .. }
        | DocumentCommand::RenameTimeline { .. }
        | DocumentCommand::UpdateTimelineSettings { .. }
        | DocumentCommand::AddTrack { .. }
        | DocumentCommand::RemoveTrack { .. }
        | DocumentCommand::UpdateTrack { .. }
        | DocumentCommand::AddClips { .. }
        | DocumentCommand::RemoveClips { .. }
        | DocumentCommand::UpdateClips { .. }
        | DocumentCommand::MoveClips { .. }
        | DocumentCommand::AddTransitions { .. }
        | DocumentCommand::RemoveTransitions { .. }) => {
            timeline::apply_timeline_command(moka, command)
        }
    }
}

/// Validates the persisted resource registry for a project about to be saved.
pub fn registry_errors(moka: &MokaFile) -> Option<&'static str> {
    for entry in moka.resources.all() {
        if !resource_path_valid(&entry.path) {
            return Some("PATH_ESCAPE");
        }
    }
    None
}

pub fn default_node_data(kind: NodeKind) -> NodeData {
    let mut data = NodeData::default();
    match kind {
        NodeKind::Text => data.content = Some(String::new()),
        NodeKind::Audio => data.audio_category = Some("music".into()),
        NodeKind::Operation => {
            data.operation_type = Some("deterministic.text".into());
            data.parameters = Some(serde_json::json!({}));
            data.executor_key = Some("deterministic".into());
            data.result_slots = Some(Vec::new());
            data.result_node_ids = Some(Vec::new());
        }
        NodeKind::Group => {
            data.color = Some("#3b82f6".into());
            data.child_node_ids = Some(Vec::new());
        }
        NodeKind::Export => {
            data.format = Some("mp4".into());
            data.parameters = Some(serde_json::json!({}));
        }
        _ => {}
    }
    data
}

pub fn make_node(kind: NodeKind, title: String, x: f64, y: f64) -> WorkflowNode {
    let now = super::now_iso();
    WorkflowNode {
        id: super::new_id(),
        kind,
        title,
        bounds: super::Rect {
            x,
            y,
            width: 280.0,
            height: 200.0,
        },
        z_index: 0,
        ports: super::derive_ports(kind),
        data: default_node_data(kind),
        created_at: now.clone(),
        updated_at: now,
    }
}
