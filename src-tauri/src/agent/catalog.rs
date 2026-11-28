//! The tool catalog: the one contract the interface, the CLI, MCP, and a
//! third-party agent all read.
//!
//! A tool says what it does, whether it writes document commands or an
//! external effect, who may call it, how risky it is, and what shape its input
//! has. The catalog is data rather than a registry of trait objects because
//! everything an outside caller needs to decide whether to call a tool — the
//! name, the schema, the risk, the surface — is here, and the implementations
//! are dispatched by name in [`super::runner`].
//!
//! [`catalog_hash`] covers the whole of it. A chat request names the hash it
//! was built against, so a model is never handed one set of tools while the
//! server executes another.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const CATALOG_VERSION: &str = "2026-10-22.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    Command,
    Effect,
}

impl ToolKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Effect => "effect",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolSurface {
    Both,
    App,
    External,
}

impl ToolSurface {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Both => "both",
            Self::App => "app",
            Self::External => "external",
        }
    }

    /// Whether a caller of `wanted` may use this tool.
    pub fn allows(&self, wanted: ToolSurface) -> bool {
        match wanted {
            ToolSurface::Both => *self == ToolSurface::Both,
            ToolSurface::App => matches!(self, Self::Both | Self::App),
            ToolSurface::External => matches!(self, Self::Both | Self::External),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolRisk {
    Read,
    Write,
    Spend,
    Destroy,
    Export,
}

impl ToolRisk {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Spend => "spend",
            Self::Destroy => "destroy",
            Self::Export => "export",
        }
    }

    pub fn needs_acknowledgement(&self) -> bool {
        matches!(self, Self::Spend | Self::Destroy | Self::Export)
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "read" => Some(Self::Read),
            "write" => Some(Self::Write),
            "spend" => Some(Self::Spend),
            "destroy" => Some(Self::Destroy),
            "export" => Some(Self::Export),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub version: u32,
    pub kind: ToolKind,
    pub pack: String,
    pub surface: ToolSurface,
    pub title: String,
    pub description: String,
    pub risk: ToolRisk,
    pub risks: Vec<ToolRisk>,
    pub mutates: bool,
    pub idempotent: bool,
    pub supports_dry_run: bool,
    pub long_running: bool,
    pub requires_destination: bool,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_schema: Option<Value>,
    pub error_codes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<Value>,
}

impl ToolSpec {
    pub fn accepts_surface(&self, surface: ToolSurface) -> bool {
        self.surface.allows(surface)
    }

    /// The tool definition a model is given: its name, what it is for, and
    /// the shape of its arguments.
    pub fn model_def(&self) -> crate::generate::ToolDef {
        crate::generate::ToolDef {
            name: self.name.clone(),
            description: format!(
                "{} [{}; {}]",
                self.description,
                self.kind.as_str(),
                self.risk.as_str()
            ),
            parameters: self.input.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub name: String,
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct ToolCatalog {
    pub tools: Vec<ToolSpec>,
}

impl ToolCatalog {
    pub fn find(&self, name: &str) -> Option<&ToolSpec> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    /// The tools a surface may see, in stable catalog order.
    pub fn visible(&self, surface: ToolSurface) -> Vec<&ToolSpec> {
        self.tools
            .iter()
            .filter(|tool| tool.accepts_surface(surface))
            .collect()
    }

    /// The tools one chat round sends: the packs asked for, plus the
    /// cross-room read tools that make an unfamiliar id inspectable without
    /// loading a whole pack, plus the app tools the client declared.
    pub fn for_chat(&self, packs: &[String], client_tools: &[String]) -> Vec<&ToolSpec> {
        let wanted: BTreeSet<&str> = packs.iter().map(String::as_str).collect();
        self.tools
            .iter()
            .filter(|tool| {
                if tool.surface == ToolSurface::External {
                    return false;
                }
                if tool.surface == ToolSurface::App {
                    return client_tools.iter().any(|name| name == &tool.name);
                }
                wanted.contains(tool.pack.as_str())
                    || matches!(
                        tool.name.as_str(),
                        "context.get" | "asset.list" | "asset.get"
                    )
            })
            .collect()
    }

    pub fn packs(&self) -> Vec<Pack> {
        packs()
    }

    /// The fingerprint a chat request must name. The serialized catalog is
    /// stable — tools are declared in a fixed order and every map here is a
    /// struct — so the same build always hashes the same.
    pub fn hash(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(CATALOG_VERSION.as_bytes());
        for pack in self.packs() {
            hasher.update(pack.name.as_bytes());
            hasher.update(pack.title.as_bytes());
        }
        for tool in &self.tools {
            hasher.update(serde_json::to_vec(tool).unwrap_or_default());
        }
        format!("sha256:{}", hex::encode(hasher.finalize()))
    }
}

pub fn packs() -> Vec<Pack> {
    [
        ("core", "Core"),
        ("canvas", "Canvas"),
        ("clip", "Cutting room"),
        ("assets", "Assets"),
        ("story", "Story"),
    ]
    .into_iter()
    .map(|(name, title)| Pack {
        name: name.into(),
        title: title.into(),
    })
    .collect()
}

/// The default packs for a room, as the interface sends them.
pub fn default_packs(room: &str) -> Vec<String> {
    let room = match room {
        "canvas" | "clip" | "assets" | "story" => room,
        _ => "canvas",
    };
    vec!["core".to_string(), room.to_string()]
}

type Props<'a> = &'a [(&'a str, &'a str, &'a str)];

fn schema(required: &[&str], props: Props) -> Value {
    let mut map = serde_json::Map::new();
    for (name, kind, description) in props {
        map.insert(
            (*name).to_string(),
            json!({ "type": kind, "description": description }),
        );
    }
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": required,
        "properties": map,
    })
}

#[allow(clippy::too_many_arguments)]
fn base(
    name: &str,
    pack: &str,
    kind: ToolKind,
    surface: ToolSurface,
    risk: ToolRisk,
    title: &str,
    description: &str,
    input: Value,
) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        version: 1,
        kind,
        pack: pack.into(),
        surface,
        title: title.into(),
        description: description.into(),
        risk,
        risks: vec![risk],
        mutates: risk != ToolRisk::Read,
        idempotent: kind == ToolKind::Command || risk == ToolRisk::Read,
        supports_dry_run: kind == ToolKind::Command && risk != ToolRisk::Read,
        long_running: false,
        requires_destination: matches!(name, "project.export" | "timeline.export" | "asset.copy"),
        input,
        data_schema: None,
        error_codes: vec!["VALIDATION_FAILED".into()],
        examples: Vec::new(),
    }
}

fn command(name: &str, pack: &str, risk: ToolRisk, description: &str, input: Value) -> ToolSpec {
    let title = name.rsplit('.').next().unwrap_or(name).replace('_', " ");
    base(
        name,
        pack,
        ToolKind::Command,
        ToolSurface::Both,
        risk,
        &title,
        description,
        input,
    )
}

fn app(name: &str, pack: &str, risk: ToolRisk, description: &str, input: Value) -> ToolSpec {
    let mut spec = command(name, pack, risk, description, input);
    spec.surface = ToolSurface::App;
    spec.supports_dry_run = false;
    spec
}

fn effect(name: &str, pack: &str, risk: ToolRisk, description: &str, input: Value) -> ToolSpec {
    let title = name.rsplit('.').next().unwrap_or(name).replace('_', " ");
    base(
        name,
        pack,
        ToolKind::Effect,
        ToolSurface::Both,
        risk,
        &title,
        description,
        input,
    )
}

fn external_effect(name: &str, risk: ToolRisk, description: &str, input: Value) -> ToolSpec {
    let mut spec = effect(name, "core", risk, description, input);
    spec.surface = ToolSurface::External;
    spec
}

pub fn catalog() -> ToolCatalog {
    let mut tools = Vec::new();
    tools.extend(core_tools());
    tools.extend(canvas_tools());
    tools.extend(clip_tools());
    tools.extend(asset_tools());
    tools.extend(story_tools());
    ToolCatalog { tools }
}

fn core_tools() -> Vec<ToolSpec> {
    let none = schema(&[], &[]);
    let mut tools = vec![
        command(
            "project.overview",
            "core",
            ToolRisk::Read,
            "Read the project's rooms, counts, and the models available for text, image, video, and speech. Start most tasks here.",
            none.clone(),
        ),
        command(
            "project.update",
            "core",
            ToolRisk::Write,
            "Change the project's name and one-line description. Both are submitted together.",
            schema(
                &["name"],
                &[
                    ("name", "string", "The project's new name"),
                    ("description", "string", "A one-line description; empty clears it"),
                ],
            ),
        ),
        command(
            "project.self_check",
            "core",
            ToolRisk::Read,
            "Read the project's file-reference check: missing or changed asset files and the nodes that use them.",
            none.clone(),
        ),
        command(
            "project.describe_models",
            "core",
            ToolRisk::Read,
            "List configured models by capability. Never returns credentials or endpoint addresses. A video model whose converter declares audioReference is reported with audioReference: true, plus audioReferenceSeconds and audioReferenceSpeakers where the converter names them.",
            schema(
                &[],
                &[("capability", "string", "text, image, speech, music, video, or asr")],
            ),
        ),
        effect(
            "project.export",
            "core",
            ToolRisk::Export,
            "Write a portable .moka package of the project to a destination the user chose.",
            schema(
                &["destination"],
                &[
                    ("destination", "string", "Full output path chosen by the user"),
                    ("includePersonalHistory", "boolean", "Carry agent sessions and change history"),
                    ("onlyReferencedAssets", "boolean", "Leave out unreferenced assets"),
                    ("allowIncomplete", "boolean", "Export even when the file check found issues"),
                ],
            ),
        ),
        command(
            "context.get",
            "core",
            ToolRisk::Read,
            "Read a detailed section of the project: project, canvas, timeline, asset, or story. Use it before editing when the id alone is not enough.",
            schema(
                &["section"],
                &[
                    ("section", "string", "project, canvas, timeline, asset, or story"),
                    ("canvasId", "string", "Canvas to read"),
                    ("timelineId", "string", "Timeline to read"),
                    ("assetId", "string", "Asset to read"),
                    ("storyId", "string", "Story to read"),
                    ("nodeIds", "array", "Nodes to include"),
                    ("limit", "integer", "Page size, default 50, max 200"),
                    ("cursor", "string", "Paging cursor from a previous answer"),
                ],
            ),
        ),
        command(
            "task.get",
            "core",
            ToolRisk::Read,
            "Read the status of a task started by a tool: run, storyJob, asr, or clipExport.",
            schema(
                &["kind", "id"],
                &[
                    ("kind", "string", "run, storyJob, asr, or clipExport"),
                    ("id", "string", "Task handle"),
                ],
            ),
        ),
        effect(
            "task.cancel",
            "core",
            ToolRisk::Write,
            "Cancel a running task. Stopping a paid generation is not undoable.",
            schema(
                &["kind", "id"],
                &[
                    ("kind", "string", "run, storyJob, asr, or clipExport"),
                    ("id", "string", "Task handle"),
                ],
            ),
        ),
        app(
            "agent.plan",
            "core",
            ToolRisk::Read,
            "Show or update a short checklist for a task that takes more than three steps. Use it before starting and when the plan changes.",
            schema(
                &["items"],
                &[(
                    "items",
                    "array",
                    "Items with id, title, and status (todo, doing, done, failed)",
                )],
            ),
        ),
        app(
            "agent.ask",
            "core",
            ToolRisk::Read,
            "Ask the user one question when the goal is genuinely ambiguous or a destructive choice needs a decision. Do not ask what the context already answers.",
            schema(
                &["question"],
                &[
                    ("question", "string", "One question"),
                    ("options", "array", "Suggested answers, when a choice is offered"),
                ],
            ),
        ),
        app(
            "agent.load_pack",
            "core",
            ToolRisk::Read,
            "Load another room's tools for the rest of this turn. Load clip, assets, story, or canvas before writing there.",
            schema(
                &["packs"],
                &[("packs", "array", "Pack names: canvas, clip, assets, story")],
            ),
        ),
        app(
            "view.focus",
            "core",
            ToolRisk::Read,
            "Move the reader to a room, entity, selection, story step, or timeline position. It does not change the document.",
            schema(
                &[],
                &[
                    ("room", "string", "canvas, clip, assets, or story"),
                    ("canvasId", "string", "Canvas to show"),
                    ("nodeIds", "array", "Nodes to select"),
                    ("timelineId", "string", "Timeline to show"),
                    ("clipIds", "array", "Clips to select"),
                    ("playheadMs", "integer", "Playhead position"),
                    ("assetId", "string", "Asset to inspect"),
                    ("storyId", "string", "Story to show"),
                    ("step", "string", "Story step"),
                    ("chapterId", "string", "Chapter focus"),
                    ("actId", "string", "Act focus"),
                    ("keyframeId", "string", "Keyframe focus"),
                    ("elementId", "string", "Element focus"),
                ],
            ),
        ),
    ];
    tools.extend([
        external_effect(
            "project.create",
            ToolRisk::Write,
            "Create a project in a directory the caller names. External agents only.",
            schema(
                &["directory", "name"],
                &[
                    ("directory", "string", "Parent directory"),
                    ("name", "string", "Project name"),
                    ("useSubdirectory", "boolean", "Create a folder when the directory is not empty"),
                ],
            ),
        ),
        external_effect(
            "project.open",
            ToolRisk::Write,
            "Open a project folder or .moka package. External agents only; returns the project id.",
            schema(&["path"], &[("path", "string", "Project directory or package path")]),
        ),
        external_effect(
            "project.import",
            ToolRisk::Write,
            "Import a .moka package into a directory. External agents only.",
            schema(
                &["archivePath", "directory"],
                &[
                    ("archivePath", "string", "Package to import"),
                    ("directory", "string", "Where the project lands"),
                    ("name", "string", "Optional project name"),
                ],
            ),
        ),
        {
            let mut spec = command(
                "project.list_recent",
                "core",
                ToolRisk::Read,
                "List recently opened projects. External agents only.",
                none,
            );
            spec.surface = ToolSurface::External;
            spec
        },
        external_effect(
            "project.remove_recent",
            ToolRisk::Write,
            "Remove a project from the recent list without deleting its files. External agents only.",
            schema(&["id"], &[("id", "string", "Project id")]),
        ),
    ]);
    tools
}

fn canvas_tools() -> Vec<ToolSpec> {
    vec![
        command("canvas.list", "canvas", ToolRisk::Read, "List canvases and folders, with node counts.", schema(&[], &[])),
        command(
            "canvas.get",
            "canvas",
            ToolRisk::Read,
            "Read a canvas's nodes, edges, groups, settings, and viewport. Long text is shortened; use canvas.get_node for full data.",
            schema(&["canvasId"], &[
                ("canvasId", "string", "Canvas id"),
                ("include", "array", "nodes, edges, groups, settings"),
                ("nodeLimit", "integer", "Default 100"),
                ("cursor", "string", "Paging cursor"),
            ]),
        ),
        command(
            "canvas.get_node",
            "canvas",
            ToolRisk::Read,
            "Read one node's full data, ports, asset summary, and recent runs.",
            schema(&["canvasId", "nodeId"], &[
                ("canvasId", "string", "Canvas id"),
                ("nodeId", "string", "Node id"),
                ("include", "array", "data, ports, asset, runs"),
            ]),
        ),
        command("canvas.create", "canvas", ToolRisk::Write, "Create an empty canvas in a folder.", schema(&["name"], &[
            ("name", "string", "Canvas name"),
            ("folderId", "string", "Folder to put it in; null at the top level"),
            ("index", "integer", "Position among siblings"),
        ])),
        command("canvas.update", "canvas", ToolRisk::Write, "Rename a canvas, change its settings, or move it to a folder.", schema(&["canvasId"], &[
            ("canvasId", "string", "Canvas id"),
            ("name", "string", "New name"),
            ("folderId", "string", "Folder id, or null for the top level"),
            ("index", "integer", "Position in the folder"),
            ("settings", "object", "background, showMinimap, snapToGrid"),
        ])),
        command("canvas.delete", "canvas", ToolRisk::Destroy, "Delete a canvas and everything on it. Requires confirm.", schema(&["canvasId", "confirm"], &[
            ("canvasId", "string", "Canvas id"),
            ("confirm", "string", "Must be non-empty; confirms the deletion"),
        ])),
        command("canvas.add_node", "canvas", ToolRisk::Write, "Add a card to a canvas. Ports and default data follow the kind.", schema(&["canvasId", "kind"], &[
            ("canvasId", "string", "Canvas id"),
            ("kind", "string", "text, image, audio, video, operation, group, or export"),
            ("title", "string", "Card title"),
            ("position", "object", "x and y"),
            ("assetId", "string", "Asset for a media card"),
            ("text", "string", "Text content for a text card"),
            ("generation", "object", "capability, mode, model, prompt, params, referenceNodeIds"),
        ])),
        command("canvas.update_node", "canvas", ToolRisk::Write, "Change a node's title, data, or generation settings. Only the named fields move.", schema(&["canvasId", "nodeId"], &[
            ("canvasId", "string", "Canvas id"),
            ("nodeId", "string", "Node id"),
            ("title", "string", "New title"),
            ("data", "object", "Partial data merged into the node's own"),
            ("zIndex", "integer", "Stacking order"),
        ])),
        command("canvas.move_nodes", "canvas", ToolRisk::Write, "Move nodes to exact positions or lay them out in a row, column, or grid.", schema(&["canvasId"], &[
            ("canvasId", "string", "Canvas id"),
            ("moves", "array", "Objects with nodeId, x, y"),
            ("layout", "string", "row, column, or grid"),
            ("nodeIds", "array", "Nodes to lay out, in order"),
            ("gap", "number", "Spacing in pixels"),
            ("columns", "integer", "Grid columns"),
            ("origin", "object", "x and y of the layout origin"),
        ])),
        command("canvas.resize_nodes", "canvas", ToolRisk::Write, "Resize nodes.", schema(&["canvasId", "resizes"], &[
            ("canvasId", "string", "Canvas id"),
            ("resizes", "array", "Objects with nodeId, width, height"),
        ])),
        command("canvas.remove_nodes", "canvas", ToolRisk::Destroy, "Delete nodes and their edges. Requires confirm.", schema(&["canvasId", "nodeIds", "confirm"], &[
            ("canvasId", "string", "Canvas id"),
            ("nodeIds", "array", "Nodes to delete"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("canvas.connect", "canvas", ToolRisk::Write, "Connect an output port to an input port.", schema(&["canvasId", "source", "target"], &[
            ("canvasId", "string", "Canvas id"),
            ("source", "object", "nodeId and portId"),
            ("target", "object", "nodeId and portId"),
        ])),
        command("canvas.disconnect", "canvas", ToolRisk::Write, "Remove edges.", schema(&["canvasId", "edgeIds"], &[
            ("canvasId", "string", "Canvas id"),
            ("edgeIds", "array", "Edges to remove"),
        ])),
        command("canvas.group_nodes", "canvas", ToolRisk::Write, "Put nodes into a new group card.", schema(&["canvasId", "nodeIds"], &[
            ("canvasId", "string", "Canvas id"),
            ("nodeIds", "array", "Nodes to group"),
            ("title", "string", "Group title"),
            ("color", "string", "Group colour"),
        ])),
        command("canvas.ungroup", "canvas", ToolRisk::Write, "Release a group's members, optionally removing the group card.", schema(&["canvasId", "groupId"], &[
            ("canvasId", "string", "Canvas id"),
            ("groupId", "string", "Group node id"),
            ("keepGroupNode", "boolean", "Keep the group card when true"),
        ])),
        command("canvas.duplicate_nodes", "canvas", ToolRisk::Write, "Copy nodes and the edges between them.", schema(&["canvasId", "nodeIds"], &[
            ("canvasId", "string", "Canvas id"),
            ("nodeIds", "array", "Nodes to copy"),
            ("offset", "object", "x and y offset"),
        ])),
        effect("canvas.run", "canvas", ToolRisk::Spend, "Start generation for one or more nodes and return a run task. Check the node's generation settings first; does not wait.", schema(&["canvasId", "nodeIds"], &[
            ("canvasId", "string", "Canvas id"),
            ("nodeIds", "array", "Nodes to run"),
            ("sessionId", "string", "Agent session to record on generated assets"),
        ])),
        app("canvas.export_image", "canvas", ToolRisk::Export, "Render the open canvas to a PNG the user chooses where to save.", schema(&["canvasId"], &[
            ("canvasId", "string", "Canvas id"),
            ("suggestedName", "string", "Suggested file name"),
        ])),
    ]
}

fn clip_tools() -> Vec<ToolSpec> {
    vec![
        command("timeline.list", "clip", ToolRisk::Read, "List timelines with duration and clip count.", schema(&[], &[])),
        command("timeline.get", "clip", ToolRisk::Read, "Read a timeline's settings, tracks, clips, and transitions. Times are milliseconds.", schema(&["timelineId"], &[
            ("timelineId", "string", "Timeline id"),
            ("include", "array", "settings, tracks, clips, transitions"),
            ("aroundMs", "integer", "Only clips near this time"),
            ("windowMs", "integer", "Window width around aroundMs"),
            ("clipLimit", "integer", "Default 200"),
        ])),
        command("timeline.create", "clip", ToolRisk::Write, "Create a timeline with default tracks.", schema(&["name"], &[
            ("name", "string", "Timeline name"),
            ("settings", "object", "fps, width, height, background"),
            ("tracks", "array", "Track kinds and names; omit for the default set"),
        ])),
        command("timeline.update", "clip", ToolRisk::Write, "Rename a timeline or change fps, size, or background.", schema(&["timelineId"], &[
            ("timelineId", "string", "Timeline id"),
            ("name", "string", "New name"),
            ("settings", "object", "fps, width, height, background"),
        ])),
        command("timeline.delete", "clip", ToolRisk::Destroy, "Delete a timeline and all its clips. Requires confirm.", schema(&["timelineId", "confirm"], &[
            ("timelineId", "string", "Timeline id"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("timeline.add_track", "clip", ToolRisk::Write, "Add an empty track.", schema(&["timelineId", "kind"], &[
            ("timelineId", "string", "Timeline id"),
            ("kind", "string", "video, audio, or text"),
            ("name", "string", "Track name"),
            ("index", "integer", "Position; appended when omitted"),
        ])),
        command("timeline.update_track", "clip", ToolRisk::Write, "Rename a track or change mute, hidden, lock, level, or solo.", schema(&["timelineId", "trackId"], &[
            ("timelineId", "string", "Timeline id"),
            ("trackId", "string", "Track id"),
            ("name", "string", "New name"),
            ("muted", "boolean", "Mute the track"),
            ("hidden", "boolean", "Hide the track"),
            ("locked", "boolean", "Lock the track against clip edits"),
            ("gainDb", "number", "Row level, −60 to 12 dB"),
            ("solo", "boolean", "Hear only soloed rows"),
        ])),
        command("timeline.remove_track", "clip", ToolRisk::Destroy, "Delete an empty track. Requires confirm.", schema(&["timelineId", "trackId", "confirm"], &[
            ("timelineId", "string", "Timeline id"),
            ("trackId", "string", "Track id"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("clip.add", "clip", ToolRisk::Write, "Add a clip from an asset or a text clip to a track.", schema(&["timelineId", "kind"], &[
            ("timelineId", "string", "Timeline id"),
            ("kind", "string", "video, audio, image, or text"),
            ("assetId", "string", "Asset for a media clip"),
            ("trackId", "string", "Track; chosen by kind when omitted"),
            ("startMs", "integer", "Start on the timeline"),
            ("durationMs", "integer", "Duration"),
            ("inPointMs", "integer", "Source in point"),
            ("outPointMs", "integer", "Source out point"),
            ("speed", "number", "Playback speed"),
            ("volume", "number", "Volume, 0 to 1"),
            ("text", "object", "Text content and style for a text clip"),
            ("placement", "string", "fit, overwrite, or ripple; fit refuses an occupied place"),
            ("rippleScope", "string", "all or track, for placement ripple"),
        ])),
        command("clip.ripple_delete", "clip", ToolRisk::Destroy, "Delete clips and pull what followed them back.", schema(&["timelineId", "clipIds", "confirm"], &[
            ("timelineId", "string", "Timeline id"),
            ("clipIds", "array", "Clips to delete"),
            ("scope", "string", "all or track"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("clip.close_gaps", "clip", ToolRisk::Write, "Pull each row's clips left until the gaps between them are gone.", schema(&["timelineId"], &[
            ("timelineId", "string", "Timeline id"),
            ("trackId", "string", "One row; every row when omitted"),
        ])),
        command("clip.delete_gap", "clip", ToolRisk::Write, "Take the empty stretch at a moment out and pull the rest back.", schema(&["timelineId", "trackId", "atMs"], &[
            ("timelineId", "string", "Timeline id"),
            ("trackId", "string", "Track holding the gap"),
            ("atMs", "integer", "A moment inside the gap"),
            ("scope", "string", "all or track"),
        ])),
        command("clip.slip", "clip", ToolRisk::Write, "Move clips' source windows under them without moving the clips.", schema(&["timelineId", "edits"], &[
            ("timelineId", "string", "Timeline id"),
            ("edits", "array", "Each {clipId, byMs}"),
        ])),
        command("clip.slide", "clip", ToolRisk::Write, "Slide clips along, trimming the clips beside them.", schema(&["timelineId", "moves"], &[
            ("timelineId", "string", "Timeline id"),
            ("moves", "array", "Each {clipId, byMs}"),
        ])),
        command("clip.roll", "clip", ToolRisk::Write, "Move one cut between two clips, changing both lengths.", schema(&["timelineId", "afterClipId", "byMs"], &[
            ("timelineId", "string", "Timeline id"),
            ("afterClipId", "string", "The clip before the cut"),
            ("byMs", "integer", "How far to roll, in milliseconds"),
        ])),
        command("timeline.remove_range", "clip", ToolRisk::Destroy, "Take a stretch of time out and pull the rest back.", schema(&["timelineId", "startMs", "endMs", "confirm"], &[
            ("timelineId", "string", "Timeline id"),
            ("startMs", "integer", "Range start"),
            ("endMs", "integer", "Range end"),
            ("scope", "string", "all or track"),
            ("trackId", "string", "The row, when scope is track"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("clip.add_marker", "clip", ToolRisk::Write, "Name a place on the cut.", schema(&["timelineId", "atMs"], &[
            ("timelineId", "string", "Timeline id"),
            ("atMs", "integer", "The moment to mark"),
            ("label", "string", "Marker name"),
            ("color", "string", "white, yellow, green, blue, purple, or red"),
        ])),
        command("clip.update_marker", "clip", ToolRisk::Write, "Change a marker's moment, name or colour.", schema(&["timelineId", "markerId"], &[
            ("timelineId", "string", "Timeline id"),
            ("markerId", "string", "Marker id"),
            ("atMs", "integer", "New moment"),
            ("label", "string", "New name"),
            ("color", "string", "New colour"),
        ])),
        command("clip.remove_markers", "clip", ToolRisk::Write, "Remove markers by id, or every marker.", schema(&["timelineId"], &[
            ("timelineId", "string", "Timeline id"),
            ("markerIds", "array", "Markers to remove"),
            ("all", "boolean", "Remove every marker"),
        ])),
        command("timeline.set_range", "clip", ToolRisk::Write, "Set or clear the timeline's working range.", schema(&["timelineId"], &[
            ("timelineId", "string", "Timeline id"),
            ("inMs", "integer", "Range start; omit both to clear"),
            ("outMs", "integer", "Range end"),
        ])),
        command("clip.update", "clip", ToolRisk::Write, "Change clip label, volume, fades, opacity, filter, colour adjustments, transform, or text. Not position or timing.", schema(&["timelineId", "clipId"], &[
            ("timelineId", "string", "Timeline id"),
            ("clipId", "string", "Clip id"),
            ("patch", "object", "Fields to merge into the clip"),
        ])),
        command("clip.move", "clip", ToolRisk::Write, "Move clips to a new start time or another track.", schema(&["timelineId", "moves"], &[
            ("timelineId", "string", "Timeline id"),
            ("moves", "array", "Objects with clipId, startMs, and optionally trackId"),
        ])),
        command("clip.trim", "clip", ToolRisk::Write, "Change in/out points, duration, or speed, keeping the clip identity equation.", schema(&["timelineId", "edits"], &[
            ("timelineId", "string", "Timeline id"),
            ("edits", "array", "Objects with clipId and the timing fields to change"),
        ])),
        command("clip.split", "clip", ToolRisk::Write, "Split clips at a time on the timeline.", schema(&["timelineId", "clipIds", "atMs"], &[
            ("timelineId", "string", "Timeline id"),
            ("clipIds", "array", "Clips to split"),
            ("atMs", "integer", "Split position"),
            ("keepTransitions", "boolean", "Rebuild neighbouring transitions"),
        ])),
        command("clip.remove", "clip", ToolRisk::Destroy, "Delete clips and their transitions. Requires confirm.", schema(&["timelineId", "clipIds", "confirm"], &[
            ("timelineId", "string", "Timeline id"),
            ("clipIds", "array", "Clips to delete"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("clip.duplicate", "clip", ToolRisk::Write, "Copy clips into free space on the same or another track.", schema(&["timelineId", "clipIds"], &[
            ("timelineId", "string", "Timeline id"),
            ("clipIds", "array", "Clips to copy"),
            ("offsetMs", "integer", "Optional shift"),
            ("trackId", "string", "Target track"),
        ])),
        command("clip.detach_audio", "clip", ToolRisk::Write, "Split the sound of a video clip onto an audio track and mute the video.", schema(&["timelineId", "clipId"], &[
            ("timelineId", "string", "Timeline id"),
            ("clipId", "string", "Video clip with sound"),
            ("trackName", "string", "Name for a new audio track"),
        ])),
        command("clip.align", "clip", ToolRisk::Write, "Align clips by start, end, or the playhead.", schema(&["timelineId", "clipIds", "mode"], &[
            ("timelineId", "string", "Timeline id"),
            ("clipIds", "array", "Clips to align"),
            ("mode", "string", "start, end, or playhead"),
            ("anchorMs", "integer", "Playhead position for mode playhead"),
        ])),
        command("clip.add_text", "clip", ToolRisk::Write, "Add a text clip with optional style.", schema(&["timelineId", "startMs", "durationMs", "content"], &[
            ("timelineId", "string", "Timeline id"),
            ("trackId", "string", "Text track; chosen when omitted"),
            ("startMs", "integer", "Start"),
            ("durationMs", "integer", "Duration"),
            ("content", "string", "Text content"),
            ("style", "object", "Text style, following the document's defaults when omitted"),
        ])),
        command("clip.import_srt", "clip", ToolRisk::Write, "Import SRT subtitles as a text track.", schema(&["timelineId", "srt"], &[
            ("timelineId", "string", "Timeline id"),
            ("srt", "string", "SRT document"),
            ("trackName", "string", "Text track name"),
        ])),
        effect("clip.export_srt", "clip", ToolRisk::Export, "Read a text track as SRT, or write it to a destination the caller named.", schema(&["timelineId"], &[
            ("timelineId", "string", "Timeline id"),
            ("trackId", "string", "Text track"),
            ("destination", "string", "Optional file path"),
            ("overwrite", "boolean", "Allow replacing an existing file"),
        ])),
        effect("clip.transcribe", "clip", ToolRisk::Spend, "Start speech recognition for a clip's audio window and return an ASR task. Does not wait.", schema(&["timelineId", "clipId"], &[
            ("timelineId", "string", "Timeline id"),
            ("clipId", "string", "Clip with audio"),
            ("language", "string", "Language hint"),
        ])),
        command("clip.apply_transcript", "clip", ToolRisk::Write, "Write a finished ASR task's text onto a new or existing text track as cues.", schema(&["timelineId", "sourceClipId", "taskId"], &[
            ("timelineId", "string", "Timeline id"),
            ("sourceClipId", "string", "Clip the transcript belongs to"),
            ("taskId", "string", "ASR task handle"),
            ("trackName", "string", "Text track name"),
            ("replaceExisting", "boolean", "Replace cues on a track of that name"),
        ])),
        command("clip.add_transition", "clip", ToolRisk::Write, "Add a transition on a butted seam between two clips.", schema(&["timelineId", "afterClipId", "kind"], &[
            ("timelineId", "string", "Timeline id"),
            ("afterClipId", "string", "The clip before the seam"),
            ("kind", "string", "Transition kind"),
            ("durationMs", "integer", "Transition window, 200 to 2000"),
        ])),
        command("clip.update_transition", "clip", ToolRisk::Write, "Change a transition's kind or window.", schema(&["timelineId", "transitionId"], &[
            ("timelineId", "string", "Timeline id"),
            ("transitionId", "string", "Transition id"),
            ("kind", "string", "Transition kind"),
            ("durationMs", "integer", "Window, 200 to 2000"),
        ])),
        command("clip.remove_transition", "clip", ToolRisk::Destroy, "Remove a transition and restore the butted seam.", schema(&["timelineId", "transitionId"], &[
            ("timelineId", "string", "Timeline id"),
            ("transitionId", "string", "Transition id"),
        ])),
        effect("timeline.export", "clip", ToolRisk::Export, "Render a timeline to a video file at a destination the user chose. Returns a clipExport task.", schema(&["timelineId", "destination"], &[
            ("timelineId", "string", "Timeline id"),
            ("destination", "string", "Output path chosen by the user"),
            ("overwrite", "boolean", "Allow replacing an existing file"),
        ])),
    ]
}

fn asset_tools() -> Vec<ToolSpec> {
    vec![
        command("asset.list", "assets", ToolRisk::Read, "List assets by kind, search, tags, favourite, or usage. Read this before picking an asset id.", schema(&[], &[
            ("kind", "string", "image, video, audio, text, model, or all"),
            ("query", "string", "Search name, keyword, tags, and note"),
            ("tags", "array", "Required tags"),
            ("favorite", "boolean", "Only favourites"),
            ("unused", "boolean", "Only assets nothing references"),
            ("origin", "string", "uploaded, generated, or any"),
            ("limit", "integer", "Page size, default 50"),
            ("cursor", "string", "Paging cursor"),
        ])),
        command("asset.get", "assets", ToolRisk::Read, "Read one asset's metadata and every place it is used.", schema(&["assetId"], &[
            ("assetId", "string", "Asset id"),
            ("include", "array", "metadata, probe, provenance, uses"),
        ])),
        effect("asset.update", "assets", ToolRisk::Write, "Change an asset's name, tags, note, favourite, or keyword. Not undoable.", schema(&["assetId"], &[
            ("assetId", "string", "Asset id"),
            ("patch", "object", "name, tags, note, favorite, keyword"),
        ])),
        command("asset.detach_references", "assets", ToolRisk::Write, "Clear asset references from canvas nodes so the asset can be deleted. Undoable.", schema(&["assetId"], &[
            ("assetId", "string", "Asset id"),
            ("canvasIds", "array", "Limit to these canvases"),
            ("detachPoster", "boolean", "Also clear poster references"),
        ])),
        effect("asset.delete", "assets", ToolRisk::Destroy, "Delete asset files and registry entries. Refuses while anything still uses them. Not undoable.", schema(&["assetIds", "confirm"], &[
            ("assetIds", "array", "Assets to delete"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        effect("asset.copy", "assets", ToolRisk::Export, "Copy an asset file to a destination the user chose.", schema(&["assetId", "destination"], &[
            ("assetId", "string", "Asset id"),
            ("destination", "string", "Full file path"),
            ("overwrite", "boolean", "Allow replacing an existing file"),
        ])),
        app("asset.import_files", "assets", ToolRisk::Write, "Ask the user for files and import them into the shelf. The interface runs the picker and upload.", schema(&[], &[
            ("categoryHint", "string", "Kind hint"),
            ("tags", "array", "Tags for the imported assets"),
            ("note", "string", "Note for the imported assets"),
        ])),
        {
            let mut spec = external_effect("asset.import_path", ToolRisk::Write, "Import files from paths on the server's machine. External agents only.", schema(&["paths"], &[
                ("paths", "array", "Local file paths"),
                ("categoryHint", "string", "Kind hint"),
                ("tags", "array", "Tags"),
                ("note", "string", "Note"),
            ]));
            spec.pack = "assets".into();
            spec
        },
        command("asset.place_in_canvas", "assets", ToolRisk::Write, "Place assets on a canvas as cards.", schema(&["assetIds", "canvasId"], &[
            ("assetIds", "array", "Assets to place"),
            ("canvasId", "string", "Canvas id"),
            ("position", "object", "x and y of the first card"),
            ("title", "string", "Card title"),
        ])),
        command("asset.place_in_timeline", "assets", ToolRisk::Write, "Place an asset on a timeline as a clip.", schema(&["assetId", "timelineId"], &[
            ("assetId", "string", "Asset id"),
            ("timelineId", "string", "Timeline id"),
            ("trackId", "string", "Target track"),
            ("startMs", "integer", "Start"),
            ("durationMs", "integer", "Duration; the asset's own when omitted"),
            ("inPointMs", "integer", "Source in point"),
        ])),
        command("asset.place_in_story", "assets", ToolRisk::Write, "Add an asset as a take on a story slot.", schema(&["assetId", "storyId", "target"], &[
            ("assetId", "string", "Asset id"),
            ("storyId", "string", "Story id"),
            ("target", "object", "Story slot target"),
            ("makeCurrent", "boolean", "Select the new take"),
        ])),
    ]
}

fn story_tools() -> Vec<ToolSpec> {
    vec![
        command("story.list", "story", ToolRisk::Read, "List stories with their current step and counts.", schema(&[], &[])),
        command("story.get", "story", ToolRisk::Read, "Read a story's brief, chapters, elements, acts, keyframes, slots, and progress. Text is shortened to 2000 characters unless fullText is set; include \"slots\" to read every take.", schema(&["storyId"], &[
            ("storyId", "string", "Story id"),
            ("include", "array", "brief, chapters, elements, storyboard, slots, progress"),
            ("chapterId", "string", "Limit to one chapter"),
            ("actId", "string", "Limit to one act"),
            ("limit", "integer", "Maximum acts and keyframes returned; omitted means all"),
            ("fullText", "boolean", "Return chapter, act and shot text whole"),
        ])),
        command("story.progress", "story", ToolRisk::Read, "Read which steps are ready, confirmed, and what is still missing.", schema(&["storyId"], &[])),
        command("story.board_report", "story", ToolRisk::Read, "Read a chapter's board as a review sheet: acts, shots, durations, missing pictures, clips, voices and scores. Optionally scoped to one chapter or act.", schema(&["storyId"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Limit to one chapter"),
            ("actId", "string", "Limit to one act"),
        ])),
        command("story.dubbing_report", "story", ToolRisk::Read, "Compare each spoken line's current reading with the shot it sits in: text length, shot length, overrun and missing readings.", schema(&["storyId"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Limit to one chapter"),
            ("actId", "string", "Limit to one act"),
        ])),
        command("story.plan_job", "story", ToolRisk::Read, "Plan the next story batch from the document: prompts, target, inputs and model, grouped into waves. Start each wave with story.start_job; nothing is written or spent. A video plan carries each speaking character's reference recording as a referenceAudio input when the chosen model's converter declares audioReference and the piece fits the recording window that converter declares (MiniMax H3 names 11 seconds); the prompt gains the matching <Audio k> lines.", schema(&["storyId", "kind"], &[
            ("storyId", "string", "Story id"),
            ("kind", "string", "outline (whole story, or chapterId for one chapter), elements, mergeElements, actPlan, storyboard, continuity, outlineRevision, elementArt, keyframeArt, pictureEdit, actVideo, keyframeVideo, lineVoice, voice, or music"),
            ("chapterId", "string", "Chapter to plan, where the kind is chapter-scoped"),
            ("actId", "string", "One act of the chapter"),
            ("keyframeIds", "array", "One or more shots of the chapter"),
            ("elementIds", "array", "One or more elements to draw"),
            ("views", "array", "For elementArt: main, turnaround"),
            ("count", "integer", "Pictures per place, 1 to 3"),
            ("model", "string", "Configured model id for the batch; per-place models are used when omitted"),
            ("budget", "integer", "For elements: characters one reading ask may carry, 1000 to 1000000; the story setting's splitChars when omitted"),
            ("videoModel", "string", "Video model whose clip window the storyboard is planned against"),
            ("includeExisting", "boolean", "Plan places that already have a current take too"),
            ("groups", "array", "For mergeElements: readings grouped by kind and name"),
            ("instruction", "string", "For pictureEdit: what should change"),
            ("maskAssetId", "string", "For pictureEdit: a white-on-black mask of the region that may change"),
            ("variantId", "string", "For pictureEdit: the element form to edit"),
        ])),
        command("story.create", "story", ToolRisk::Write, "Create a story with an optional brief.", schema(&["name"], &[
            ("name", "string", "Story name"),
            ("brief", "object", "idea, totalDurationMs, aspect, genre, style"),
        ])),
        command("story.update", "story", ToolRisk::Write, "Rename a story or change its shot granularity or reference image limit.", schema(&["storyId"], &[
            ("storyId", "string", "Story id"),
            ("name", "string", "New name"),
            ("shotGranularity", "string", "keyframe or shot"),
            ("maxReferenceImages", "integer", "Reference image ceiling"),
        ])),
        command("story.delete", "story", ToolRisk::Destroy, "Delete a story. Its assembled timeline is left standing. Requires confirm.", schema(&["storyId", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("story.update_brief", "story", ToolRisk::Write, "Change the idea, duration, aspect, genre, style, or source text of a story.", schema(&["storyId", "patch"], &[
            ("storyId", "string", "Story id"),
            ("patch", "object", "Brief fields to change"),
        ])),
        command("story.replace_chapters", "story", ToolRisk::Destroy, "Replace the whole outline. Only when the user asked to rewrite it; prefer update_chapter. Requires confirm.", schema(&["storyId", "chapters", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("chapters", "array", "Complete chapter list"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("story.replace_acts", "story", ToolRisk::Destroy, "Replace a chapter's whole act board. Only when the user asked to rewrite it. Requires confirm.", schema(&["storyId", "chapterId", "acts", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("acts", "array", "Complete act list"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("story.replace_keyframes", "story", ToolRisk::Destroy, "Replace an act's whole shot list. Only when the user asked to rewrite it. Requires confirm.", schema(&["storyId", "chapterId", "actId", "keyframes", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("actId", "string", "Act id"),
            ("keyframes", "array", "Complete keyframe list"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("story.replace_elements", "story", ToolRisk::Destroy, "Replace the whole cast. Only when the user asked to rewrite it. Requires confirm.", schema(&["storyId", "elements", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("elements", "array", "Complete element list"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("story.update_voice", "story", ToolRisk::Write, "Set or clear the narrator's voice, or one element's voice. A null voice clears it.", schema(&["storyId", "target"], &[
            ("storyId", "string", "Story id"),
            ("target", "object", "{\"kind\":\"narrator\"} or {\"kind\":\"element\",\"elementId\":\"...\"}"),
            ("voice", "object", "Voice profile: model, voice, rate, pitch, instructions, referenceAssetId; null clears"),
        ])),
        command("story.update_element", "story", ToolRisk::Write, "Change one element's name, description, chapters, or voice.", schema(&["storyId", "elementId", "patch"], &[
            ("storyId", "string", "Story id"),
            ("elementId", "string", "Element id"),
            ("patch", "object", "Fields to change"),
        ])),
        command("story.add_element", "story", ToolRisk::Write, "Add a character, location, or prop to the cast.", schema(&["storyId", "element"], &[
            ("storyId", "string", "Story id"),
            ("element", "object", "Element fields"),
        ])),
        command("story.remove_element", "story", ToolRisk::Destroy, "Remove one element from the cast. Requires confirm.", schema(&["storyId", "elementId", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("elementId", "string", "Element id"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("story.update_chapter", "story", ToolRisk::Write, "Change one chapter's title, synopsis, target duration, or outline lock. The outline is written whole but only the named fields move.", schema(&["storyId", "chapterId", "patch"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("patch", "object", "title, synopsis, targetDurationMs, outlineLocked"),
        ])),
        command("story.add_chapter", "story", ToolRisk::Write, "Insert a chapter into the outline. Its acts are added separately.", schema(&["storyId"], &[
            ("storyId", "string", "Story id"),
            ("index", "integer", "Position in the outline"),
            ("chapter", "object", "title, synopsis, targetDurationMs, outlineLocked"),
        ])),
        command("story.remove_chapter", "story", ToolRisk::Destroy, "Delete a chapter and its acts. Requires confirm.", schema(&["storyId", "chapterId", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("story.move_chapter", "story", ToolRisk::Write, "Move a chapter within the outline.", schema(&["storyId", "chapterId", "toIndex"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("toIndex", "integer", "New position"),
        ])),
        command("story.add_act", "story", ToolRisk::Write, "Insert an act into a chapter. An act object can carry cast, scene, sound, granularity, video model, a bridge transition and shots.", schema(&["storyId", "chapterId"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("index", "integer", "Position in the chapter"),
            ("title", "string", "Act title"),
            ("summary", "string", "Act summary"),
            ("act", "object", "A complete act; overrides title and summary"),
        ])),
        command("story.remove_act", "story", ToolRisk::Destroy, "Delete an act and its shots. Requires confirm.", schema(&["storyId", "chapterId", "actId", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("actId", "string", "Act id"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("story.move_act", "story", ToolRisk::Write, "Move an act within its chapter.", schema(&["storyId", "chapterId", "actId", "toIndex"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("actId", "string", "Act id"),
            ("toIndex", "integer", "New position"),
        ])),
        command("story.update_act", "story", ToolRisk::Write, "Change an act's title, summary, plan, cast, setting, props, sound, video model, shot granularity, or bridge transition.", schema(&["storyId", "chapterId", "actId", "patch"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("actId", "string", "Act id"),
            ("patch", "object", "Fields to change"),
        ])),
        command("story.add_keyframe", "story", ToolRisk::Write, "Add a shot to an act.", schema(&["storyId", "chapterId", "actId"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("actId", "string", "Act id"),
            ("index", "integer", "Position in the act"),
            ("keyframe", "object", "Shot fields"),
        ])),
        command("story.update_keyframe", "story", ToolRisk::Write, "Change one shot's still content, motion, dialogue, framing, or duration.", schema(&["storyId", "chapterId", "actId", "keyframeId", "patch"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("actId", "string", "Act id"),
            ("keyframeId", "string", "Shot id"),
            ("patch", "object", "Fields to change"),
        ])),
        command("story.remove_keyframe", "story", ToolRisk::Destroy, "Delete one shot. Requires confirm.", schema(&["storyId", "chapterId", "actId", "keyframeId", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("actId", "string", "Act id"),
            ("keyframeId", "string", "Shot id"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        command("story.move_keyframe", "story", ToolRisk::Write, "Move a shot within its act, keeping everything made for it.", schema(&["storyId", "chapterId", "actId", "keyframeId", "toIndex"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("actId", "string", "Act id"),
            ("keyframeId", "string", "Shot id"),
            ("toIndex", "integer", "New position"),
        ])),
        command("story.duplicate_keyframe", "story", ToolRisk::Write, "Copy a shot, its picture, clip and references, with fresh line ids.", schema(&["storyId", "chapterId", "actId", "keyframeId"], &[
            ("storyId", "string", "Story id"),
            ("chapterId", "string", "Chapter id"),
            ("actId", "string", "Act id"),
            ("keyframeId", "string", "Shot id"),
            ("index", "integer", "Where the copy goes; default after the original"),
        ])),
        command("story.set_slot", "story", ToolRisk::Write, "Add, select, or drop takes on a story slot. Existing takes are kept unless the action says otherwise.", schema(&["storyId", "target", "action"], &[
            ("storyId", "string", "Story id"),
            ("target", "object", "Story slot target"),
            ("action", "string", "append, select, or drop"),
            ("assetIds", "array", "Files of the take to append"),
            ("assetId", "string", "Asset to select, for action select"),
            ("takeIndex", "integer", "Take index to select or drop"),
            ("makeCurrent", "boolean", "Whether an appended take becomes current, default true"),
            ("take", "object", "A complete take for append: assetIds, inMs, outMs, jobId, itemId, note, createdAt"),
        ])),
        command("story.confirm_step", "story", ToolRisk::Write, "Confirm a story step. Only call when the user explicitly asks to confirm; gaps are refused. Steps cannot be unconfirmed through this tool.", schema(&["storyId", "step"], &[
            ("storyId", "string", "Story id"),
            ("step", "string", "idea, outline, elements, storyboard, or edit"),
        ])),
        command("story.import_canvas", "story", ToolRisk::Write, "Lay the telling's premise, cast, acts, shots, frames and clips onto a new canvas as cards that name the same files.", schema(&["storyId"], &[
            ("storyId", "string", "Story id"),
            ("name", "string", "Canvas name; the story's name by default"),
        ])),
        command("story.set_prompt", "story", ToolRisk::Write, "Write hand-written picture or clip prompts, keyed by the ask id plan_job returns. A null clears one.", schema(&["storyId", "kind", "prompts"], &[
            ("storyId", "string", "Story id"),
            ("kind", "string", "image or video"),
            ("prompts", "object", "Map of ask id to {prompt, auto} or null"),
        ])),
        command("story.assemble", "story", ToolRisk::Write, "Assemble a story into a timeline: pictures or clips, line readings, whole-act voice and score, optionally subtitles.", schema(&["storyId"], &[
            ("storyId", "string", "Story id"),
            ("timelineId", "string", "Existing timeline, or a new one when omitted"),
            ("timelineName", "string", "Name for a new timeline"),
            ("withSubtitles", "boolean", "Lay each spoken line on a text track"),
        ])),
        effect("story.focus", "story", ToolRisk::Read, "Ask the open window to move to a room and a place there. The window reads it once.", schema(&[], &[
            ("room", "string", "story (default), canvas, clip, assets, or director"),
            ("storyId", "string", "Story id, for the story room"),
            ("step", "string", "idea, outline, elements, storyboard, or edit"),
            ("chapterId", "string", "Chapter to open"),
            ("actId", "string", "Act to open"),
            ("keyframeId", "string", "Shot to open"),
            ("elementId", "string", "Element to open"),
            ("canvasId", "string", "Canvas to open"),
            ("nodeIds", "array", "Nodes to select"),
            ("timelineId", "string", "Timeline to open"),
            ("clipIds", "array", "Clips to select"),
            ("playheadMs", "integer", "Playhead position"),
            ("assetId", "string", "Asset to select"),
        ])),
        effect("story.list_jobs", "story", ToolRisk::Read, "List story batches, newest first, with status and unread mark. Set answers to include item texts and assets.", schema(&[], &[
            ("storyId", "string", "Only this story's batches"),
            ("answers", "boolean", "Include each item's answer, when it has one"),
        ])),
        effect("story.read_job", "story", ToolRisk::Write, "Mark a settled batch read. Only call after its answer is applied: the room will not apply a read batch again.", schema(&["jobId"], &[
            ("jobId", "string", "Story job id"),
        ])),
        effect("story.element_repeats", "story", ToolRisk::Read, "Read the names more than one elements part described, as merge groups for story.plan_job kind mergeElements.", schema(&["storyId"], &[
            ("storyId", "string", "Story id"),
            ("jobIds", "array", "Only these elements batches; every succeeded elements batch of the story when omitted"),
        ])),
        effect("story.audit_elements", "story", ToolRisk::Read, "Compare the cast with the telling's own cast lists and recurring scene headings, and report names and places no element covers.", schema(&["storyId"], &[
            ("storyId", "string", "Story id"),
        ])),
        effect("story.split_manuscript", "story", ToolRisk::Destroy, "Cut the story's manuscript into chapters through a text model, replacing the outline. Requires confirm; one paid call per window.", schema(&["storyId", "confirm"], &[
            ("storyId", "string", "Story id"),
            ("sourceAssetId", "string", "Manuscript asset; the story's own source by default"),
            ("model", "string", "Configured text model; the default when omitted"),
            ("budget", "integer", "Characters per ask, at least 1000"),
            ("confirm", "string", "Must be non-empty"),
        ])),
        effect("story.start_job", "story", ToolRisk::Spend, "Start a batch of story generations and return a storyJob task. Does not wait. With models, pieces take turns and each model's pieces start as their own batch; jobs lists every batch, the task covers the first.", schema(&["storyId", "kind", "items"], &[
            ("storyId", "string", "Story id"),
            ("kind", "string", "Job kind"),
            ("items", "array", "Targets to generate: id, target, capability, prompt, optional system, inputs (roles reference, firstFrame, lastFrame, referenceAudio, mask, controlVideo, controlAudio), params"),
            ("model", "string", "Configured model id; omitted asks the capability's default"),
            ("models", "array", "Configured model ids to answer in turns; pieces are spread over them round-robin, one batch per model"),
            ("parallel", "integer", "How many pieces may be in flight at once"),
        ])),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_named_consistently_and_lives_in_a_known_pack() {
        let catalog = catalog();
        let packs: BTreeSet<String> = packs().into_iter().map(|pack| pack.name).collect();
        for tool in &catalog.tools {
            assert!(tool.name.contains('.'), "{} has no domain", tool.name);
            assert!(
                packs.contains(&tool.pack),
                "{} has unknown pack {}",
                tool.name,
                tool.pack
            );
            assert!(
                !tool.description.trim().is_empty(),
                "{} has no description",
                tool.name
            );
            assert_eq!(
                tool.input["type"], "object",
                "{} input is not an object",
                tool.name
            );
            assert!(
                tool.kind == ToolKind::Effect || !tool.requires_destination,
                "{} is a command with a destination rule",
                tool.name
            );
        }
    }

    #[test]
    fn names_are_unique() {
        let catalog = catalog();
        let mut names = BTreeSet::new();
        for tool in &catalog.tools {
            assert!(
                names.insert(tool.name.clone()),
                "{} is declared twice",
                tool.name
            );
        }
    }

    #[test]
    fn the_hash_is_stable_and_changes_with_the_catalog() {
        let first = catalog();
        let second = catalog();
        assert_eq!(first.hash(), second.hash());
        assert!(first.hash().starts_with("sha256:"));
        assert_ne!(first.hash(), format!("{}x", first.hash()));
    }

    #[test]
    fn external_callers_never_see_app_tools_or_project_lifecycle() {
        let catalog = catalog();
        let visible = catalog.visible(ToolSurface::External);
        assert!(visible.iter().any(|tool| tool.name == "clip.trim"));
        assert!(!visible.iter().any(|tool| tool.name == "agent.ask"));
        assert!(!visible
            .iter()
            .any(|tool| tool.name == "canvas.export_image"));
        assert!(visible.iter().any(|tool| tool.name == "project.open"));
    }

    #[test]
    fn a_chat_round_receives_the_room_pack_and_cross_room_reads() {
        let catalog = catalog();
        let chosen = catalog.for_chat(
            &["core".to_string(), "clip".to_string()],
            &["agent.ask".to_string()],
        );
        let names: BTreeSet<&str> = chosen.iter().map(|tool| tool.name.as_str()).collect();
        assert!(names.contains("clip.trim"));
        assert!(names.contains("timeline.get"));
        assert!(!names.contains("canvas.add_node"));
        assert!(
            names.contains("asset.list"),
            "cross-room reads stay available"
        );
        assert!(names.contains("agent.ask"), "a declared app tool is sent");
        assert!(
            !names.contains("agent.plan"),
            "undeclared app tools are left out"
        );
        assert!(
            !names.contains("project.open"),
            "external tools never enter chat"
        );
    }
}
