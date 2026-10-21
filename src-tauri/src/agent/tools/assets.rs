//! The shelf's tools.
//!
//! Reading an asset's references is the centre of this module: a deletion is
//! only allowed when nothing points at the file, and the answer that refuses
//! says which node, clip, or slot does. Clearing node references is a document
//! change and can be undone; deleting the file is an external effect and
//! cannot.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::api::{ApiState, ProjectSession};
use crate::domain::commands::make_node;
use crate::domain::{DocumentCommand, MokaFile, NodeKind, NodePatch, ResourceEntry};
use crate::project::{AssetShelfEdit, ProjectStore};

use super::super::error::ToolError;
use super::{Args, ToolOutcome};

struct Uses {
    nodes: Vec<Value>,
    clips: Vec<Value>,
    story_slots: Vec<Value>,
    drawings: Vec<Value>,
    voice_reference: Vec<Value>,
}

impl Uses {
    fn empty() -> Self {
        Self {
            nodes: Vec::new(),
            clips: Vec::new(),
            story_slots: Vec::new(),
            drawings: Vec::new(),
            voice_reference: Vec::new(),
        }
    }

    fn blockers(&self) -> Vec<&'static str> {
        let mut blockers = Vec::new();
        if !self.clips.is_empty() {
            blockers.push("clips");
        }
        if !self.story_slots.is_empty() {
            blockers.push("storySlots");
        }
        if !self.drawings.is_empty() {
            blockers.push("drawings");
        }
        if !self.voice_reference.is_empty() {
            blockers.push("voiceReference");
        }
        blockers
    }
}

fn uses_of(moka: &MokaFile, asset_id: &str) -> Uses {
    let mut uses = Uses::empty();
    for canvas in &moka.canvas {
        for node in &canvas.nodes {
            if node.data.asset_id.as_deref() == Some(asset_id)
                || node.data.poster_asset_id.as_deref() == Some(asset_id)
                || node
                    .data
                    .result_slots
                    .iter()
                    .flatten()
                    .any(|slot| slot.asset_id.as_deref() == Some(asset_id))
            {
                uses.nodes.push(json!({
                    "canvasId": canvas.id,
                    "nodeId": node.id,
                    "title": node.title,
                    "kind": node.kind,
                }));
            }
            if let Some(director) = &node.data.director {
                if director.frame_asset_id.as_deref() == Some(asset_id)
                    || director.blocking_asset_id.as_deref() == Some(asset_id)
                {
                    uses.drawings.push(json!({
                        "canvasId": canvas.id,
                        "nodeId": node.id,
                        "title": node.title,
                        "role": if director.frame_asset_id.as_deref() == Some(asset_id) { "frame" } else { "blocking" },
                    }));
                }
            }
        }
    }
    for timeline in moka.timelines.as_deref().unwrap_or_default() {
        for clip in &timeline.clips {
            if clip.asset_id.as_deref() == Some(asset_id) {
                uses.clips.push(json!({
                    "timelineId": timeline.id,
                    "clipId": clip.id,
                    "label": clip.label,
                    "startMs": clip.start_ms,
                }));
            }
        }
    }
    for scene in moka.director_scenes.as_deref().unwrap_or_default() {
        if crate::domain::director::scene_asset_ids(scene)
            .iter()
            .any(|id| id == asset_id)
        {
            uses.drawings.push(json!({
                "sceneId": scene.id,
                "title": scene.title,
                "role": "scene",
            }));
        }
    }
    for story in moka.stories.as_deref().unwrap_or_default() {
        for element in &story.elements {
            let mut slots = vec![&element.main];
            if let Some(turnaround) = &element.turnaround {
                slots.push(turnaround);
            }
            for slot in slots {
                if slot
                    .takes
                    .iter()
                    .any(|take| take.asset_ids.iter().any(|id| id == asset_id))
                {
                    uses.story_slots.push(json!({
                        "storyId": story.id,
                        "target": {"kind": "element", "elementId": element.id},
                        "takeCount": slot.takes.len(),
                    }));
                }
            }
            if let Some(voice) = &element.voice {
                if voice.reference_asset_id.as_deref() == Some(asset_id) {
                    uses.voice_reference.push(json!({
                        "storyId": story.id,
                        "elementId": element.id,
                    }));
                }
            }
        }
        for chapter in &story.chapters {
            for act in &chapter.acts {
                let mut slots: Vec<(&str, &crate::domain::story::StorySlot)> =
                    vec![("video", &act.video)];
                if let Some(voice) = &act.voice {
                    slots.push(("voice", voice));
                }
                if let Some(music) = &act.music {
                    slots.push(("music", music));
                }
                for keyframe in &act.keyframes {
                    slots.push(("keyframeArt", &keyframe.art));
                    slots.push(("keyframeVideo", &keyframe.video));
                }
                for (kind, slot) in slots {
                    if slot
                        .takes
                        .iter()
                        .any(|take| take.asset_ids.iter().any(|id| id == asset_id))
                    {
                        uses.story_slots.push(json!({
                            "storyId": story.id,
                            "target": {"kind": kind, "chapterId": chapter.id, "actId": act.id},
                            "takeCount": slot.takes.len(),
                        }));
                    }
                }
            }
        }
    }
    uses
}

fn entry_value(entry: &ResourceEntry, uses: &Uses) -> Value {
    json!({
        "id": entry.id,
        "name": entry.name,
        "kind": kind_of(entry),
        "mime": entry.mime,
        "bytes": entry.bytes,
        "width": entry.probe.as_ref().and_then(|probe| probe.width),
        "height": entry.probe.as_ref().and_then(|probe| probe.height),
        "durationMs": entry.probe.as_ref().and_then(|probe| probe.duration_ms),
        "tags": entry.tags,
        "favorite": entry.favorite,
        "keyword": entry.keyword,
        "note": entry.note,
        "createdAt": entry.created_at,
        "usedBy": {
            "nodes": uses.nodes.len(),
            "clips": uses.clips.len(),
            "storySlots": uses.story_slots.len(),
        },
        "provenance": entry.provenance,
    })
}

fn kind_of(entry: &ResourceEntry) -> &'static str {
    match entry.path.split('/').nth(1).unwrap_or_default() {
        "images" => "image",
        "videos" => "video",
        "music" | "voice" => "audio",
        "texts" => "text",
        "models" => "model",
        _ => "other",
    }
}

fn generated(entry: &ResourceEntry) -> bool {
    entry
        .provenance
        .as_ref()
        .map(|provenance| {
            provenance.run_id.is_some()
                || provenance.story_job_id.is_some()
                || provenance.assistant_session_id.is_some()
        })
        .unwrap_or(false)
}

pub async fn command(
    _state: &ApiState,
    _root: &std::path::Path,
    moka: &MokaFile,
    name: &str,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    let args = Args::new(name, input)?;
    match name {
        "asset.list" => {
            let kind = args.opt_str("kind").unwrap_or("all");
            let query = args.opt_str("query").map(str::to_lowercase);
            let tags = args.opt_strings("tags");
            let favorite = args.raw("favorite").and_then(Value::as_bool);
            let unused = args.opt_bool("unused", false);
            let origin = args.opt_str("origin").unwrap_or("any");
            let limit = args.opt_i64("limit").unwrap_or(50).clamp(1, 200) as usize;
            let mut matched: Vec<Value> = Vec::new();
            let mut all: Vec<&ResourceEntry> = moka.resources.all().collect();
            all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            for entry in all {
                if kind != "all" && kind_of(entry) != kind {
                    continue;
                }
                if let Some(query) = &query {
                    let haystack = format!(
                        "{} {} {} {}",
                        entry.name,
                        entry.keyword.as_deref().unwrap_or_default(),
                        entry.note.as_deref().unwrap_or_default(),
                        entry.tags.as_deref().unwrap_or_default().join(" ")
                    )
                    .to_lowercase();
                    if !haystack.contains(query) {
                        continue;
                    }
                }
                if !tags.is_empty() {
                    let entry_tags = entry.tags.clone().unwrap_or_default();
                    if !tags.iter().all(|tag| entry_tags.contains(tag)) {
                        continue;
                    }
                }
                if favorite == Some(true) && entry.favorite != Some(true) {
                    continue;
                }
                if origin == "generated" && !generated(entry) {
                    continue;
                }
                if origin == "uploaded" && generated(entry) {
                    continue;
                }
                let uses = uses_of(moka, &entry.id);
                if unused
                    && (!uses.nodes.is_empty()
                        || !uses.clips.is_empty()
                        || !uses.story_slots.is_empty()
                        || !uses.drawings.is_empty())
                {
                    continue;
                }
                matched.push(entry_value(entry, &uses));
            }
            let total = matched.len();
            matched.truncate(limit);
            Ok(ToolOutcome::read(
                format!("{total} assets"),
                json!({"assets": matched, "total": total, "truncated": total > limit}),
            ))
        }
        "asset.get" => {
            let asset_id = args.req_str("assetId")?;
            let entry = moka.resources.find(asset_id).ok_or_else(|| {
                ToolError::new(
                    "ASSET_NOT_FOUND",
                    format!("asset {asset_id} does not exist"),
                )
            })?;
            let uses = uses_of(moka, asset_id);
            let blockers = uses.blockers();
            Ok(ToolOutcome::read(
                format!("{} ({})", entry.name, kind_of(entry)),
                json!({
                    "asset": entry_value(entry, &uses),
                    "uses": {
                        "nodes": uses.nodes,
                        "clips": uses.clips,
                        "storySlots": uses.story_slots,
                        "drawings": uses.drawings,
                        "voiceReference": uses.voice_reference,
                    },
                    "delete": {"allowed": blockers.is_empty(), "blockers": blockers},
                }),
            ))
        }
        "asset.detach_references" => detach_references(moka, &args),
        "asset.place_in_canvas" => place_in_canvas(moka, &args),
        "asset.place_in_timeline" => place_in_timeline(moka, &args).await,
        "asset.place_in_story" => place_in_story(moka, &args).await,
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not an asset command"),
        )),
    }
}

fn detach_references(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let asset_id = args.req_str("assetId")?;
    let canvases = args.opt_strings("canvasIds");
    let detach_poster = args.opt_bool("detachPoster", true);
    let mut commands = Vec::new();
    for canvas in &moka.canvas {
        if !canvases.is_empty() && !canvases.contains(&canvas.id) {
            continue;
        }
        for node in &canvas.nodes {
            let clear_asset = node.data.asset_id.as_deref() == Some(asset_id);
            let clear_poster =
                detach_poster && node.data.poster_asset_id.as_deref() == Some(asset_id);
            if !clear_asset && !clear_poster {
                continue;
            }
            let mut data = node.data.clone();
            if clear_asset {
                data.asset_id = None;
            }
            if clear_poster {
                data.poster_asset_id = None;
            }
            commands.push(DocumentCommand::UpdateNode {
                canvas_id: canvas.id.clone(),
                node_id: node.id.clone(),
                patch: NodePatch {
                    title: None,
                    z_index: None,
                    data: Some(data),
                    ports: None,
                },
            });
        }
    }
    Ok(ToolOutcome::write(
        if commands.is_empty() {
            "no node references".to_string()
        } else {
            format!("Cleared {asset_id} from {} nodes", commands.len())
        },
        json!({"assetId": asset_id, "detached": commands.len()}),
        commands,
    ))
}

fn place_in_canvas(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let canvas = super::canvas_of(moka, args.req_str("canvasId")?)?;
    let asset_ids = args.req_strings("assetIds")?;
    let title = args.opt_str("title");
    let origin = args.opt_object("position").map(|position| {
        (
            position.get("x").and_then(Value::as_f64).unwrap_or(0.0),
            position.get("y").and_then(Value::as_f64).unwrap_or(0.0),
        )
    });
    let mut commands = Vec::new();
    let mut node_ids = Vec::new();
    let mut x = origin.map(|(x, _)| x).unwrap_or(canvas.viewport.x);
    let mut y = origin.map(|(_, y)| y).unwrap_or_else(|| {
        canvas
            .nodes
            .iter()
            .map(|node| node.bounds.y + node.bounds.height)
            .fold(0.0_f64, f64::max)
            + 40.0
    });
    for (index, asset_id) in asset_ids.iter().enumerate() {
        let entry = moka.resources.find(asset_id).ok_or_else(|| {
            ToolError::new(
                "ASSET_NOT_FOUND",
                format!("asset {asset_id} is not in this project"),
            )
        })?;
        let kind = match kind_of(entry) {
            "image" => NodeKind::Image,
            "video" => NodeKind::Video,
            "audio" => NodeKind::Audio,
            "text" => NodeKind::Text,
            other => {
                return Err(ToolError::validation(format!(
                    "a {other} asset cannot be placed as a card"
                )))
            }
        };
        if index > 0 && index % 3 == 0 {
            x = origin.map(|(x, _)| x).unwrap_or(canvas.viewport.x);
            y += 240.0;
        }
        let node_title = title
            .map(str::to_string)
            .unwrap_or_else(|| entry.name.clone());
        let mut node = make_node(kind, node_title, x, y);
        node.data.asset_id = Some(asset_id.clone());
        if kind == NodeKind::Text {
            node.data.content = entry.name.clone().into();
        }
        x += 320.0;
        node_ids.push(node.id.clone());
        commands.push(DocumentCommand::AddNode {
            canvas_id: canvas.id.clone(),
            node,
        });
    }
    Ok(ToolOutcome::write(
        format!("Placed {} assets on the canvas", node_ids.len()),
        json!({"nodeIds": node_ids}),
        commands,
    ))
}

async fn place_in_timeline(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let asset_id = args.req_str("assetId")?;
    let timeline_id = args.req_str("timelineId")?;
    let entry = moka.resources.find(asset_id).ok_or_else(|| {
        ToolError::new(
            "ASSET_NOT_FOUND",
            format!("asset {asset_id} is not in this project"),
        )
    })?;
    let kind = match kind_of(entry) {
        "image" | "video" => "video",
        "audio" => "audio",
        "text" => "text",
        other => {
            return Err(ToolError::validation(format!(
                "a {other} asset cannot be placed on a timeline"
            )))
        }
    };
    let mut request = json!({
        "timelineId": timeline_id,
        "kind": kind,
        "assetId": asset_id,
        "startMs": args.opt_i64("startMs").unwrap_or(0),
        "durationMs": args
            .opt_i64("durationMs")
            .or_else(|| entry.probe.as_ref().and_then(|probe| probe.duration_ms))
            .unwrap_or(5_000),
        "inPointMs": args.opt_i64("inPointMs").unwrap_or(0),
    });
    if let Some(track_id) = args.opt_str("trackId") {
        request["trackId"] = json!(track_id);
    }
    super::clip::command(std::path::Path::new(""), moka, "clip.add", &request).await
}

async fn place_in_story(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story_id = args.req_str("storyId")?;
    let target = args
        .raw("target")
        .cloned()
        .ok_or_else(|| ToolError::validation("place_in_story needs target"))?;
    let request = json!({
        "storyId": story_id,
        "target": target,
        "action": "append",
        "assetIds": [args.req_str("assetId")?],
        "makeCurrent": args.opt_bool("makeCurrent", true),
    });
    super::story::command(moka, "story.set_slot", &request).await
}

pub async fn effect(
    _state: &ApiState,
    session: &ProjectSession,
    name: &str,
    input: &Value,
    moka: &MokaFile,
) -> Result<ToolOutcome, ToolError> {
    match name {
        "asset.update" => {
            let args = Args::new(name, input)?;
            let asset_id = args.req_str("assetId")?.to_string();
            let patch = args
                .opt_object("patch")
                .ok_or_else(|| ToolError::validation("asset.update needs a patch"))?;
            let tags = patch.get("tags").map(|tags| {
                let mut tags: Vec<String> = tags
                    .as_array()
                    .map(|tags| {
                        tags.iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|tag| !tag.is_empty())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                tags.sort();
                tags.dedup();
                tags.truncate(24);
                tags
            });
            let edit = AssetShelfEdit {
                tags,
                note: patch
                    .get("note")
                    .and_then(Value::as_str)
                    .map(|note| note.chars().take(2000).collect()),
                favorite: patch.get("favorite").and_then(Value::as_bool),
                keyword: patch
                    .get("keyword")
                    .and_then(Value::as_str)
                    .map(|keyword| keyword.chars().take(2000).collect()),
            };
            let change = session.0.update_asset_shelf(&asset_id, edit).await?;
            Ok(ToolOutcome {
                summary: format!("Updated {}", change.entry.name),
                data: json!({"assetId": asset_id}),
                assets_updated: vec![change.entry],
                revision: Some(change.revision),
                updated_at: Some(change.updated_at),
                ..ToolOutcome::default()
            })
        }
        "asset.delete" => {
            let args = Args::new(name, input)?;
            args.confirmed()?;
            let asset_ids = args.req_strings("assetIds")?;
            let mut removed = Vec::new();
            let mut revision = None;
            let mut updated_at = None;
            for asset_id in &asset_ids {
                let uses = uses_of(moka, asset_id);
                let blockers = uses.blockers();
                if !blockers.is_empty() {
                    return Err(ToolError::new(
                        "ASSET_IN_USE",
                        format!("{asset_id} is still used by {}", blockers.join(", ")),
                    )
                    .details(json!({
                        "assetId": asset_id,
                        "blockers": blockers,
                        "uses": {
                            "clips": uses.clips,
                            "storySlots": uses.story_slots,
                            "drawings": uses.drawings,
                        }
                    })));
                }
                let saved = session.0.remove_asset(asset_id).await?;
                revision = Some(saved.revision);
                updated_at = Some(saved.updated_at);
                removed.push(asset_id.clone());
            }
            Ok(ToolOutcome {
                summary: format!("Deleted {} assets", removed.len()),
                data: json!({"assetIds": removed}),
                assets_removed: removed,
                revision,
                updated_at,
                ..ToolOutcome::default()
            })
        }
        "asset.copy" => {
            let args = Args::new(name, input)?;
            let asset_id = args.req_str("assetId")?;
            let destination = PathBuf::from(args.req_str("destination")?);
            if destination.exists() && !args.opt_bool("overwrite", false) {
                return Err(ToolError::new(
                    "DESTINATION_EXISTS",
                    format!("{} already exists", destination.display()),
                ));
            }
            if !destination.parent().is_some_and(|parent| parent.is_dir()) {
                return Err(ToolError::new(
                    "DESTINATION_NOT_FOUND",
                    "The destination's folder does not exist",
                ));
            }
            let file = session.0.asset_file(asset_id, None).await?;
            std::fs::copy(&file.path, &destination).map_err(|error| {
                ToolError::new("INTERNAL", format!("the file could not be copied: {error}"))
            })?;
            let bytes = std::fs::metadata(&destination)
                .map(|meta| meta.len())
                .unwrap_or(0);
            Ok(ToolOutcome::effect(
                format!("Copied {} to {}", file.entry.name, destination.display()),
                json!({"path": destination, "bytes": bytes}),
            ))
        }
        "asset.import_path" => {
            let args = Args::new(name, input)?;
            let paths = args.req_strings("paths")?;
            if paths.len() > 20 {
                return Err(ToolError::validation("import at most 20 files at a time"));
            }
            let tags = args.opt_strings("tags");
            let note = args.opt_str("note").map(str::to_string);
            let hint = args.opt_str("categoryHint");
            let mut added = Vec::new();
            let mut failures = Vec::new();
            let mut revision = None;
            let mut updated_at = None;
            for path in &paths {
                let staged = match super::super::runner::stage_path(
                    std::path::Path::new(path),
                    hint,
                )
                .await
                {
                    Ok(staged) => staged,
                    Err(error) => {
                        failures.push(json!({"path": path, "error": {"code": error.code, "message": error.message}}));
                        continue;
                    }
                };
                match session.0.add_asset(staged).await {
                    Ok(change) => {
                        let id = change.entry.id.clone();
                        if !tags.is_empty() || note.is_some() {
                            let edit = AssetShelfEdit {
                                tags: (!tags.is_empty()).then(|| tags.clone()),
                                note: note.clone(),
                                favorite: None,
                                keyword: None,
                            };
                            if let Ok(updated) = session.0.update_asset_shelf(&id, edit).await {
                                revision = Some(updated.revision);
                                updated_at = Some(updated.updated_at);
                                added.push(updated.entry);
                                continue;
                            }
                        }
                        revision = Some(change.revision);
                        updated_at = Some(change.updated_at);
                        added.push(change.entry);
                    }
                    Err(error) => {
                        failures.push(json!({
                            "path": path,
                            "error": {"code": error.code(), "message": error.to_string()},
                        }));
                    }
                }
            }
            let summary = if failures.is_empty() {
                format!("Imported {} files", added.len())
            } else {
                format!("Imported {} files; {} failed", added.len(), failures.len())
            };
            Ok(ToolOutcome {
                summary,
                data: json!({"added": added, "failures": failures}),
                assets_added: added,
                revision,
                updated_at,
                ..ToolOutcome::default()
            })
        }
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not an asset effect"),
        )),
    }
}
