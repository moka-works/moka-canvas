//! What a model is shown about the project.
//!
//! A model does not read the document: it reads a summary bounded by a budget
//! and asks for the details it needs through read tools. Two callers share
//! this: `/agent/chat` injects the summary into the system prompt, and
//! `context.get` returns a larger one for a named section.
//!
//! Everything here is server-side truth. A title a client sent in its scope is
//! never trusted; the document answers for its own names.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::domain::MokaFile;

/// The budget a chat prompt spends on the room summary. Details beyond it are
/// available through `context.get`; the prompt is for orientation.
pub const SUMMARY_BUDGET_CHARS: usize = 6_000;

const TITLE_CHARS: usize = 80;
const PROMPT_CHARS: usize = 240;
const TEXT_CHARS: usize = 400;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScope {
    pub room: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clip_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playhead_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_filter: Option<AssetFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub story_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub act_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyframe_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unused: Option<bool>,
}

impl AgentScope {
    pub fn valid_room(&self) -> bool {
        matches!(self.room.as_str(), "canvas" | "clip" | "assets" | "story")
    }
}

/// The project as a whole: counts, rooms, and what may be worked on.
pub fn project_summary(moka: &MokaFile, sessions: usize) -> Value {
    let canvases: Vec<Value> = moka
        .canvas
        .iter()
        .map(|canvas| {
            json!({
                "id": canvas.id,
                "name": truncate(&canvas.name, TITLE_CHARS),
                "folderId": canvas.folder_id,
                "nodeCount": canvas.nodes.len(),
            })
        })
        .collect();
    let timelines: Vec<Value> = moka
        .timelines
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|timeline| {
            json!({
                "id": timeline.id,
                "name": truncate(&timeline.name, TITLE_CHARS),
                "trackCount": timeline.tracks.len(),
                "clipCount": timeline.clips.len(),
                "durationMs": duration_of(timeline),
            })
        })
        .collect();
    let stories: Vec<Value> = moka
        .stories
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|story| {
            json!({
                "id": story.id,
                "name": truncate(&story.name, TITLE_CHARS),
                "chapters": story.chapters.len(),
                "elements": story.elements.len(),
                "confirmedSteps": story.confirmed_steps,
            })
        })
        .collect();
    json!({
        "project": {
            "id": moka.metadata.id,
            "name": moka.metadata.name,
            "revision": moka.metadata.revision,
            "description": moka.metadata.description,
        },
        "counts": {
            "canvases": moka.canvas.len(),
            "nodes": moka.canvas.iter().map(|canvas| canvas.nodes.len()).sum::<usize>(),
            "timelines": moka.timelines.as_ref().map(Vec::len).unwrap_or(0),
            "stories": moka.stories.as_ref().map(Vec::len).unwrap_or(0),
            "assets": moka.resources.all().count(),
            "agentSessions": sessions,
        },
        "rooms": {"canvases": canvases, "timelines": timelines, "stories": stories},
    })
}

/// The summary of the room the reader is in, trimmed to its budget.
///
/// Ids in the scope that no longer exist are dropped rather than invented, and
/// the caller is told what was dropped so it can say so to the model.
pub fn room_summary(moka: &MokaFile, scope: &AgentScope) -> (Value, Vec<String>) {
    let mut warnings = Vec::new();
    let summary = match scope.room.as_str() {
        "clip" => clip_summary(moka, scope, &mut warnings),
        "assets" => asset_summary(moka, scope, &mut warnings),
        "story" => story_summary(moka, scope, &mut warnings),
        _ => canvas_summary(moka, scope, &mut warnings),
    };
    (within_budget(summary, SUMMARY_BUDGET_CHARS), warnings)
}

/// The whole context a chat step is given: project first, then the room.
pub fn chat_context(moka: &MokaFile, scope: &AgentScope, sessions: usize) -> Value {
    let (room, warnings) = room_summary(moka, scope);
    json!({
        "project": project_summary(moka, sessions),
        "scope": scope,
        "room": room,
        "warnings": warnings,
    })
}

fn canvas_summary(moka: &MokaFile, scope: &AgentScope, warnings: &mut Vec<String>) -> Value {
    let canvas = scope
        .canvas_id
        .as_deref()
        .and_then(|id| moka.canvas.iter().find(|canvas| canvas.id == id))
        .or_else(|| moka.canvas.first());
    let Some(canvas) = canvas else {
        return json!({"room": "canvas", "canvas": null});
    };
    if let Some(id) = &scope.canvas_id {
        if id != &canvas.id {
            warnings.push(format!("canvas {id} no longer exists; using {}", canvas.id));
        }
    }
    let selected = scope
        .node_ids
        .iter()
        .filter(|id| !canvas.nodes.iter().any(|node| &node.id == *id))
        .cloned()
        .collect::<Vec<_>>();
    for id in selected {
        warnings.push(format!("node {id} no longer exists"));
    }
    let nodes: Vec<Value> = canvas
        .nodes
        .iter()
        .take(40)
        .map(|node| {
            let value = serde_json::to_value(node).unwrap_or_default();
            json!({
                "id": node.id,
                "kind": node.kind,
                "title": truncate(&node.title, TITLE_CHARS),
                "bounds": value.get("bounds"),
                "assetId": value.get("assetId"),
                "generation": value.get("generation").map(|generation| json!({
                    "capability": generation.get("capability"),
                    "mode": generation.get("mode"),
                    "prompt": generation.get("prompt").and_then(Value::as_str).map(|text| truncate(text, PROMPT_CHARS)),
                })),
            })
        })
        .collect();
    json!({
        "room": "canvas",
        "canvas": {
            "id": canvas.id,
            "name": truncate(&canvas.name, TITLE_CHARS),
            "settings": canvas.settings,
            "nodeCount": canvas.nodes.len(),
            "edgeCount": canvas.edges.len(),
            "selectedNodeIds": scope.node_ids,
        },
        "nodes": nodes,
        "nodesTruncated": canvas.nodes.len() > 40,
    })
}

fn clip_summary(moka: &MokaFile, scope: &AgentScope, warnings: &mut Vec<String>) -> Value {
    let timelines = moka.timelines.as_deref().unwrap_or_default();
    let timeline = scope
        .timeline_id
        .as_deref()
        .and_then(|id| timelines.iter().find(|timeline| timeline.id == id))
        .or_else(|| timelines.first());
    let Some(timeline) = timeline else {
        return json!({"room": "clip", "timeline": null});
    };
    if let Some(id) = &scope.timeline_id {
        if id != &timeline.id {
            warnings.push(format!(
                "timeline {id} no longer exists; using {}",
                timeline.id
            ));
        }
    }
    for id in &scope.clip_ids {
        if !timeline.clips.iter().any(|clip| &clip.id == id) {
            warnings.push(format!("clip {id} no longer exists"));
        }
    }
    let selected: Vec<Value> = timeline
        .clips
        .iter()
        .filter(|clip| scope.clip_ids.iter().any(|id| id == &clip.id))
        .map(|clip| clip_summary_of(clip))
        .collect();
    let nearby: Vec<Value> = match scope.playhead_ms {
        Some(playhead) => timeline
            .clips
            .iter()
            .filter(|clip| {
                clip.start_ms <= playhead && clip.start_ms + clip.duration_ms >= playhead
                    || (clip.start_ms - playhead).abs() <= 15_000
            })
            .take(12)
            .map(|clip| clip_summary_of(clip))
            .collect(),
        None => timeline
            .clips
            .iter()
            .take(12)
            .map(|clip| clip_summary_of(clip))
            .collect(),
    };
    json!({
        "room": "clip",
        "timeline": {
            "id": timeline.id,
            "name": truncate(&timeline.name, TITLE_CHARS),
            "settings": timeline.settings,
            "durationMs": duration_of(timeline),
            "playheadMs": scope.playhead_ms,
            "tracks": timeline.tracks.iter().map(|track| json!({
                "id": track.id,
                "kind": track.kind,
                "name": track.name,
                "locked": track.locked,
                "muted": track.muted,
                "hidden": track.hidden,
            })).collect::<Vec<_>>(),
            "selectedClips": selected,
            "nearbyClips": nearby,
            "transitionCount": timeline.transitions.len(),
        },
    })
}

fn clip_summary_of(clip: &crate::domain::TimelineClip) -> Value {
    json!({
        "id": clip.id,
        "trackId": clip.track_id,
        "kind": clip.kind,
        "label": truncate(&clip.label, TITLE_CHARS),
        "assetId": clip.asset_id,
        "startMs": clip.start_ms,
        "durationMs": clip.duration_ms,
        "inPointMs": clip.in_point_ms,
        "outPointMs": clip.out_point_ms,
        "speed": clip.speed,
        "text": clip.text.as_ref().map(|text| truncate(&text.content, TEXT_CHARS)),
    })
}

fn asset_summary(moka: &MokaFile, scope: &AgentScope, warnings: &mut Vec<String>) -> Value {
    let filter = scope.asset_filter.clone().unwrap_or_default();
    let all = moka.resources.all();
    let mut matching: Vec<&crate::domain::ResourceEntry> = all
        .into_iter()
        .filter(|entry| {
            filter
                .query
                .as_deref()
                .map(|query| {
                    let query = query.to_lowercase();
                    entry.name.to_lowercase().contains(&query)
                        || entry
                            .keyword
                            .as_deref()
                            .map(|keyword| keyword.to_lowercase().contains(&query))
                            .unwrap_or(false)
                })
                .unwrap_or(true)
        })
        .collect();
    matching.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    if let Some(id) = &scope.asset_id {
        if !all_ids(moka).contains(id) {
            warnings.push(format!("asset {id} no longer exists"));
        }
    }
    let assets: Vec<Value> = matching
        .iter()
        .take(30)
        .map(|entry| {
            json!({
                "id": entry.id,
                "name": truncate(&entry.name, TITLE_CHARS),
                "mime": entry.mime,
                "bytes": entry.bytes,
                "tags": entry.tags,
                "favorite": entry.favorite,
                "keyword": entry.keyword,
            })
        })
        .collect();
    json!({
        "room": "assets",
        "inspectedAssetId": scope.asset_id,
        "filter": filter,
        "total": matching.len(),
        "assets": assets,
        "truncated": matching.len() > 30,
    })
}

fn story_summary(moka: &MokaFile, scope: &AgentScope, warnings: &mut Vec<String>) -> Value {
    let stories = moka.stories.as_deref().unwrap_or_default();
    let story = scope
        .story_id
        .as_deref()
        .and_then(|id| stories.iter().find(|story| story.id == id))
        .or_else(|| stories.first());
    let Some(story) = story else {
        return json!({"room": "story", "story": null});
    };
    if let Some(id) = &scope.story_id {
        if id != &story.id {
            warnings.push(format!("story {id} no longer exists; using {}", story.id));
        }
    }
    let chapters: Vec<Value> = story
        .chapters
        .iter()
        .map(|chapter| {
            json!({
                "id": chapter.id,
                "title": truncate(&chapter.title, TITLE_CHARS),
                "synopsis": truncate(&chapter.synopsis, PROMPT_CHARS),
                "actCount": chapter.acts.len(),
                "targetDurationMs": chapter.target_duration_ms,
            })
        })
        .collect();
    let focus_act = scope.chapter_id.as_deref().and_then(|chapter_id| {
        story
            .chapters
            .iter()
            .find(|chapter| chapter.id == chapter_id)
            .and_then(|chapter| {
                scope
                    .act_id
                    .as_deref()
                    .and_then(|act_id| chapter.acts.iter().find(|act| act.id == act_id))
                    .or_else(|| chapter.acts.first())
            })
    });
    let acts: Vec<Value> = focus_act
        .map(|act| {
            vec![json!({
                "id": act.id,
                "title": truncate(&act.title, TITLE_CHARS),
                "summary": truncate(&act.summary, PROMPT_CHARS),
                "keyframes": act.keyframes.iter().take(20).map(|keyframe| json!({
                    "id": keyframe.id,
                    "title": truncate(&keyframe.title, TITLE_CHARS),
                    "durationMs": keyframe.duration_ms,
                    "content": truncate(&keyframe.content, PROMPT_CHARS),
                    "dialogue": keyframe.dialogue.iter().take(6).map(|line| json!({
                        "speaker": line.speaker,
                        "text": truncate(&line.text, PROMPT_CHARS),
                    })).collect::<Vec<_>>(),
                    "artTakes": keyframe.art.takes.len(),
                    "videoTakes": keyframe.video.takes.len(),
                })).collect::<Vec<_>>(),
            })]
        })
        .unwrap_or_default();
    let elements: Vec<Value> = story
        .elements
        .iter()
        .map(|element| {
            json!({
                "id": element.id,
                "kind": element.kind,
                "name": truncate(&element.name, TITLE_CHARS),
                "description": truncate(&element.description, PROMPT_CHARS),
                "chapterIds": element.chapter_ids,
            })
        })
        .collect();
    json!({
        "room": "story",
        "story": {
            "id": story.id,
            "name": truncate(&story.name, TITLE_CHARS),
            "step": scope.step,
            "shotGranularity": story.shot_granularity,
            "maxReferenceImages": story.max_reference_images,
            "confirmedSteps": story.confirmed_steps,
            "brief": {
                "idea": truncate(&story.brief.idea, PROMPT_CHARS),
                "totalDurationMs": story.brief.total_duration_ms,
                "aspect": story.brief.aspect,
                "genre": story.brief.genre,
                "style": story.brief.style,
            },
            "chapters": chapters,
            "elements": elements,
        },
        "focus": {
            "chapterId": scope.chapter_id,
            "actId": scope.act_id,
            "keyframeId": scope.keyframe_id,
            "elementId": scope.element_id,
        },
        "acts": acts,
    })
}

fn all_ids(moka: &MokaFile) -> Vec<String> {
    moka.resources.all().map(|entry| entry.id.clone()).collect()
}

fn duration_of(timeline: &crate::domain::TimelineDocument) -> i64 {
    timeline
        .clips
        .iter()
        .map(|clip| clip.start_ms + clip.duration_ms)
        .max()
        .unwrap_or(0)
}

fn truncate(text: &str, limit: usize) -> String {
    let mut shortened: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        shortened.push('…');
    }
    shortened
}

/// Keeps the summary inside its budget by dropping the room's longest lists
/// rather than cutting JSON in half.
fn within_budget(value: Value, budget: usize) -> Value {
    let text = serde_json::to_string(&value).unwrap_or_default();
    if text.chars().count() <= budget {
        return value;
    }
    let mut value = value;
    for key in ["nodes", "assets", "elements", "acts", "chapters", "acts"] {
        if let Some(list) = value.get_mut(key).and_then(Value::as_array_mut) {
            list.truncate(10);
        }
        if let Some(list) = value
            .get_mut("timeline")
            .and_then(|timeline| timeline.get_mut("nearbyClips"))
            .and_then(Value::as_array_mut)
        {
            list.truncate(6);
        }
        let text = serde_json::to_string(&value).unwrap_or_default();
        if text.chars().count() <= budget {
            return value;
        }
    }
    // Whatever is left, say so rather than hand over a partial object.
    json!({"room": value.get("room").cloned(), "truncated": true})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CanvasDocument, ProjectMetadata, ResourceRegistry};

    fn project() -> MokaFile {
        MokaFile {
            version: crate::domain::MOKA_FILE_VERSION.into(),
            metadata: ProjectMetadata {
                id: "p_1".into(),
                name: "A project".into(),
                description: None,
                cover_path: None,
                revision: 7,
                created_at: "2026-10-21T09:00:00Z".into(),
                updated_at: "2026-10-21T09:00:00Z".into(),
            },
            resources: ResourceRegistry::default(),
            folders: None,
            timelines: None,
            stories: None,
            director_scenes: None,
            canvas: vec![CanvasDocument::empty("cv_1".into(), "Board".into())],
        }
    }

    #[test]
    fn a_room_scope_that_names_a_missing_entity_warns_and_falls_back() {
        let moka = project();
        let scope = AgentScope {
            room: "canvas".into(),
            canvas_id: Some("missing".into()),
            node_ids: vec!["missing-node".into()],
            ..AgentScope::default()
        };
        let (summary, warnings) = room_summary(&moka, &scope);
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("missing-node")));
        assert_eq!(summary["canvas"]["id"], moka.canvas[0].id);
    }

    #[test]
    fn the_project_summary_counts_every_room() {
        let moka = project();
        let summary = project_summary(&moka, 3);
        assert_eq!(summary["counts"]["canvases"], moka.canvas.len());
        assert_eq!(summary["counts"]["agentSessions"], 3);
        assert!(summary["rooms"]["timelines"].is_array());
    }

    #[test]
    fn a_summary_over_budget_drops_lists_rather_than_cutting_json() {
        let big = json!({
            "room": "canvas",
            "nodes": (0..100).map(|index| json!({"id": index.to_string()})).collect::<Vec<_>>(),
        });
        let kept = within_budget(big, 200);
        assert!(kept["nodes"].as_array().expect("a list").len() <= 10);
    }
}
