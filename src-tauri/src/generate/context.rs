//! Turning a node's generation spec, and its place in the graph, into the one
//! request the gateway is handed.
//!
//! This resolves on the server rather than in the editor so that a run started
//! from the desktop window, from the web client, or from anything else that can
//! reach the API all read a node's surroundings the same way. It also lets a
//! preview ask for the very answer a run will get, and a preview that
//! disagrees with the run is worse than no preview.
//!
//! The spec's `input_mode` picks which surroundings count: everything wired
//! into the node, an explicit list, or only the nodes the prompt names. All
//! three end in the same place — text folded into the prompt behind numbered
//! labels, and media travelling beside it under the role its port implies.

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use crate::domain::validate::{mention_spans, MAX_PROMPT_LENGTH};
use crate::domain::{
    AssetId, CanvasDocument, GenerationInputMode, GenerationSpec, NodeId, NodeKind,
    ResultSlotStatus, WorkflowNode,
};

use super::{GenerateInput, GenerateRequest, InputRole};

/// A prompt with its upstream text folded in, the media travelling beside it,
/// and which nodes contributed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ResolvedInputs {
    /// The spec's own prompt, then one labelled block per contributing text.
    /// The label appears where a mention was, so the prompt can point at the
    /// block that carries it.
    pub prompt: String,
    /// Reference media, in the order it was found.
    pub inputs: Vec<GenerateInput>,
    /// Which node each entry of [`Self::inputs`] came from, position by
    /// position. A request carries no node ids — a provider has no use for one
    /// — but a preview has to say which card each reference is, and the two
    /// lists are filled in the same pass so they cannot disagree.
    pub input_sources: Vec<NodeId>,
    /// Every node that contributed, in contribution order and without repeats.
    /// A node with nothing to give is not in here, which is what makes this
    /// list safe to record as provenance.
    pub used_node_ids: Vec<NodeId>,
    /// Characters cut off the contributing text to keep the whole prompt inside
    /// [`MAX_PROMPT_LENGTH`]. Zero unless something had to go, and the amount
    /// rather than a flag so that "the upstream text was too long" can say by
    /// how much.
    pub truncated_chars: usize,
    /// Ids named by a mention the canvas has no node for. Nothing is sent for
    /// one: it is reported so that the ask can be refused before a run pays for
    /// a prompt with a hole in it.
    pub unresolved: Vec<String>,
}

impl ResolvedInputs {
    /// The request these inputs form for one node's spec.
    ///
    /// Built beside the resolver rather than by whoever calls the gateway, so
    /// that a run, a preview, and anything else that can reach a node asks in
    /// the same words. The prompt is the resolved one — the spec's own with the
    /// contributing text folded in behind the labels that point at it — and the
    /// media travels under the role its port implied.
    ///
    /// No instruction is set as its own field: one a node asked for travels in
    /// the parameters and is read from there, which keeps the framing of an
    /// answer and the direction to a voice in the one place a node states it. A
    /// global one is offered by the gateway, which is the only place that knows
    /// the preferences.
    pub fn request_for(&self, spec: &GenerationSpec) -> GenerateRequest {
        GenerateRequest {
            capability: spec.capability,
            model: spec.model.clone(),
            prompt: self.prompt.clone(),
            system: None,
            params: spec
                .params
                .as_ref()
                .and_then(|params| params.as_object())
                .cloned()
                .unwrap_or_default(),
            inputs: self.inputs.clone(),
        }
    }
}

/// What a connection, or a reference picked by hand, is allowed to contribute.
#[derive(Debug, Clone, Copy)]
enum Sink {
    /// Only what the node has to say.
    Text,
    /// Only the node's asset, travelling under this role.
    Media(InputRole),
    /// Either, whichever the node has: a reference picked by hand has no port
    /// to say which was meant.
    Any(InputRole),
}

/// One node's share of a request: words that fold into the prompt, or media
/// that travels beside it under the role its port implied.
struct Contribution {
    node_id: NodeId,
    /// The kind name its label is built from.
    word: &'static str,
    /// Empty until [`label`] has numbered the set.
    label: String,
    share: Share,
}

enum Share {
    Text(String),
    Media { role: InputRole, asset_id: AssetId },
}

/// Reads one node's surroundings into a single request's worth of inputs. A
/// node with no generation spec has nothing to resolve.
pub fn collect_generation_inputs(canvas: &CanvasDocument, node: &WorkflowNode) -> ResolvedInputs {
    let Some(spec) = node.data.generation.as_ref() else {
        return ResolvedInputs::default();
    };
    match spec.input_mode {
        GenerationInputMode::Upstream => from_upstream(canvas, node, spec),
        GenerationInputMode::Manual => from_references(canvas, spec),
        GenerationInputMode::Mentions => from_mentions(canvas, spec),
    }
}

/// The nodes [`collect_generation_inputs`] will look up for this node, groups
/// opened the same way.
///
/// A run's edge closure cannot answer this on its own. A reference picked by
/// hand, a node the prompt names, or a member of a group can sit anywhere on
/// the canvas, and a resolver that cannot see them resolves to nothing.
pub fn context_node_ids(canvas: &CanvasDocument, node: &WorkflowNode) -> Vec<NodeId> {
    let Some(spec) = node.data.generation.as_ref() else {
        return Vec::new();
    };
    let named: Vec<NodeId> = match spec.input_mode {
        GenerationInputMode::Upstream => canvas
            .edges
            .iter()
            .filter(|edge| edge.target.node_id == node.id)
            .map(|edge| edge.source.node_id.clone())
            .collect(),
        GenerationInputMode::Manual => spec.reference_node_ids.clone().unwrap_or_default(),
        GenerationInputMode::Mentions => mention_spans(&spec.prompt)
            .into_iter()
            .map(|(_, node_id)| node_id)
            .collect(),
    };
    let mut ids = Vec::new();
    for name in named {
        // Opening a group looks the group itself up, so it is on the list too.
        ids.push(name.clone());
        for source in expand(canvas, &name) {
            ids.push(source.id.clone());
        }
    }
    ids
}

/// Everything wired into the node, one edge at a time in document order. The
/// port an edge lands on says whether its source contributes words or media,
/// and which role that media travels under.
fn from_upstream(
    canvas: &CanvasDocument,
    node: &WorkflowNode,
    spec: &GenerationSpec,
) -> ResolvedInputs {
    let mut taken = HashSet::new();
    let mut contributions = Vec::new();
    for edge in canvas
        .edges
        .iter()
        .filter(|edge| edge.target.node_id == node.id)
    {
        let Some(sink) = sink_for_port(&edge.target.port_id) else {
            continue;
        };
        for source in expand(canvas, &edge.source.node_id) {
            contribute(source, sink, &mut taken, &mut contributions);
        }
    }
    label(&mut contributions);
    finish(&spec.prompt, contributions, Vec::new())
}

/// Only the listed references, in the order they were listed. The wiring is
/// ignored, which is the point of choosing this mode.
fn from_references(canvas: &CanvasDocument, spec: &GenerationSpec) -> ResolvedInputs {
    let mut taken = HashSet::new();
    let mut contributions = Vec::new();
    for node_id in spec.reference_node_ids.as_deref().unwrap_or_default() {
        for source in expand(canvas, node_id) {
            contribute(
                source,
                Sink::Any(InputRole::Reference),
                &mut taken,
                &mut contributions,
            );
        }
    }
    label(&mut contributions);
    finish(&spec.prompt, contributions, Vec::new())
}

/// Only the nodes the prompt names. Each `@[node:<id>]` becomes the label of
/// the block carrying that node's share, so the sentence keeps its shape and
/// the model can still tell which piece of context the user meant.
fn from_mentions(canvas: &CanvasDocument, spec: &GenerationSpec) -> ResolvedInputs {
    let mut taken = HashSet::new();
    let mut contributions = Vec::new();
    let mut tokens: Vec<(Range<usize>, Vec<NodeId>)> = Vec::new();
    let mut unresolved = Vec::new();
    for (span, node_id) in mention_spans(&spec.prompt) {
        // A token naming a node the canvas has never heard of is a hole in the
        // sentence rather than a reference. Nothing can be sent for it, so it is
        // said out loud instead of quietly leaving the prose with a gap.
        if canvas.node(&node_id).is_none() && !unresolved.contains(&node_id) {
            unresolved.push(node_id.clone());
        }
        let sources = expand(canvas, &node_id);
        tokens.push((span, sources.iter().map(|node| node.id.clone()).collect()));
        for source in sources {
            contribute(
                source,
                Sink::Any(InputRole::Reference),
                &mut taken,
                &mut contributions,
            );
        }
    }
    label(&mut contributions);

    // A node mentioned twice keeps one label, so both mentions point at the
    // same block rather than the second one pointing at nothing.
    let labels: HashMap<&str, &str> = contributions
        .iter()
        .map(|item| (item.node_id.as_str(), item.label.as_str()))
        .collect();
    let mut prompt = String::new();
    let mut cursor = 0;
    for (span, members) in &tokens {
        prompt.push_str(&spec.prompt[cursor..span.start]);
        let replaced: Vec<&str> = members
            .iter()
            .filter_map(|node_id| labels.get(node_id.as_str()).copied())
            .collect();
        prompt.push_str(&replaced.join(" "));
        cursor = span.end;
    }
    prompt.push_str(&spec.prompt[cursor..]);

    finish(&prompt, contributions, unresolved)
}

/// Folds the contributions into the answer: text blocks behind the prompt,
/// media in order, and the contributing nodes with them.
///
/// The whole thing is kept inside [`MAX_PROMPT_LENGTH`]. A spec's own prompt is
/// capped when the document is validated, but what upstream text folds in beside
/// it is not, and sending more than a provider will read is a refusal nobody can
/// diagnose from the answer. The budget is spent in contribution order, so the
/// text nearest the prompt is the text that survives.
fn finish(
    prompt: &str,
    contributions: Vec<Contribution>,
    unresolved: Vec<String>,
) -> ResolvedInputs {
    let mut body = prompt.trim_end().to_string();
    let mut budget = MAX_PROMPT_LENGTH.saturating_sub(body.chars().count());
    let mut truncated_chars = 0;
    let mut inputs = Vec::new();
    let mut input_sources = Vec::new();
    let mut used_node_ids = Vec::new();
    for contribution in contributions {
        let Contribution {
            node_id,
            label,
            share,
            ..
        } = contribution;
        match share {
            Share::Text(text) => {
                // The blank line and the label travel with the text, so the
                // budget pays for them before the text is cut to what is left.
                let framing = if body.is_empty() { 0 } else { 2 } + label.chars().count() + 1;
                let kept = cut_at(&text, budget.saturating_sub(framing));
                truncated_chars += text.chars().count() - kept.chars().count();
                // A label pointing at a block that was cut away whole points at
                // nothing, and the node behind it contributed nothing a run will
                // carry — so it is not recorded as having contributed.
                if kept.trim().is_empty() {
                    continue;
                }
                budget = budget.saturating_sub(framing + kept.chars().count());
                if !body.is_empty() {
                    body.push_str("\n\n");
                }
                body.push_str(&label);
                body.push('\n');
                body.push_str(kept);
            }
            Share::Media { role, asset_id } => {
                // A node hands along a whole card rather than a window of one:
                // what part of it to use is the generation's business.
                inputs.push(GenerateInput {
                    role,
                    asset_id,
                    window: None,
                });
                input_sources.push(node_id.clone());
            }
        }
        used_node_ids.push(node_id);
    }
    ResolvedInputs {
        prompt: body,
        inputs,
        input_sources,
        used_node_ids,
        truncated_chars,
        unresolved,
    }
}

/// The first `limit` characters of `text`, cut on a character boundary so that
/// a character taking several bytes is never split in half.
fn cut_at(text: &str, limit: usize) -> &str {
    match text.char_indices().nth(limit) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

/// Numbers the contributions, one run per kind, so a prompt full of images
/// does not call them all `[Image 1]`.
///
/// The brackets and the numbering are markup rather than words, and the noun
/// inside them comes from [`label_word`], which is the same name the canvas gives
/// a kind of node everywhere else: a resolver that asked a template for it would
/// be the one place a node's kind was called something of its own.
fn label(contributions: &mut [Contribution]) {
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for contribution in contributions.iter_mut() {
        let count = seen.entry(contribution.word).or_insert(0);
        *count += 1;
        contribution.label = format!("[{} {}]", contribution.word, count);
    }
}

fn contribute(
    source: &WorkflowNode,
    sink: Sink,
    taken: &mut HashSet<NodeId>,
    out: &mut Vec<Contribution>,
) {
    // A node reached twice — two edges from it, or a mention repeated — gives
    // its share once. Labelling it twice would leave the prompt pointing at a
    // block that says the same thing.
    if taken.contains(&source.id) {
        return;
    }
    let share = match sink {
        Sink::Text => text_output(source).map(Share::Text),
        Sink::Media(role) => media_share(source, role),
        Sink::Any(role) => text_output(source)
            .map(Share::Text)
            .or_else(|| media_share(source, role)),
    };
    // Nothing to give is nothing recorded, so a node that had no words for one
    // port is still free to give its asset to another.
    let Some(share) = share else {
        return;
    };
    taken.insert(source.id.clone());
    out.push(Contribution {
        node_id: source.id.clone(),
        word: match &share {
            Share::Text(_) => "Text",
            Share::Media { .. } => label_word(source.kind),
        },
        label: String::new(),
        share,
    });
}

fn media_share(source: &WorkflowNode, role: InputRole) -> Option<Share> {
    source
        .data
        .asset_id
        .clone()
        .map(|asset_id| Share::Media { role, asset_id })
}

/// What a node has to say. Written content wins; otherwise the primary result
/// a previous run left behind, which is how an operation node's output reaches
/// the node downstream of it.
fn text_output(node: &WorkflowNode) -> Option<String> {
    if let Some(content) = node.data.content.as_deref() {
        if !content.trim().is_empty() {
            return Some(content.to_string());
        }
    }
    node.data
        .result_slots
        .as_ref()?
        .iter()
        .find(|slot| slot.is_primary && slot.status == ResultSlotStatus::Succeeded)
        .and_then(|slot| slot.text.as_deref())
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
}

/// A group stands for its members, and a group inside a group is opened too.
/// Anything else stands for itself, whether or not it has content — deciding
/// that is [`contribute`]'s job.
fn expand<'a>(canvas: &'a CanvasDocument, node_id: &str) -> Vec<&'a WorkflowNode> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    walk(canvas, node_id, &mut seen, &mut found);
    found
}

fn walk<'a>(
    canvas: &'a CanvasDocument,
    node_id: &str,
    seen: &mut HashSet<NodeId>,
    found: &mut Vec<&'a WorkflowNode>,
) {
    if !seen.insert(node_id.to_string()) {
        return;
    }
    let Some(node) = canvas.node(node_id) else {
        return;
    };
    if node.kind != NodeKind::Group {
        found.push(node);
        return;
    }
    let members = canvas
        .groups
        .iter()
        .find(|group| group.group_id == node.id)
        .map(|group| group.child_node_ids.clone())
        .unwrap_or_default();
    for member in members {
        walk(canvas, &member, seen, found);
    }
}

/// What the port an edge lands on says about its source's share. A port this
/// table does not know contributes nothing rather than guessing.
fn sink_for_port(port_id: &str) -> Option<Sink> {
    match port_id {
        "prompt" => Some(Sink::Text),
        "mask" => Some(Sink::Media(InputRole::Mask)),
        "firstFrame" => Some(Sink::Media(InputRole::FirstFrame)),
        "lastFrame" => Some(Sink::Media(InputRole::LastFrame)),
        "images" | "videos" | "audios" | "audio" | "video" => {
            Some(Sink::Media(InputRole::Reference))
        }
        _ => None,
    }
}

fn label_word(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Text => "Text",
        NodeKind::Image => "Image",
        NodeKind::Audio => "Audio",
        NodeKind::Video => "Video",
        _ => "Node",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        derive_ports, now_iso, Capability, DocumentSettings, EdgeEndpoint, GroupMembership,
        NodeData, Rect, ResultSlot, Viewport, WorkflowEdge, CANVAS_SCHEMA_VERSION,
    };

    /// Stable ids, so a test can name the node it means.
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

    fn text(name: &str, content: &str) -> WorkflowNode {
        node(
            NodeKind::Text,
            name,
            NodeData {
                content: Some(content.to_string()),
                ..NodeData::default()
            },
        )
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

    /// An asset-only sound card: where a recording sits, and the kind of node
    /// a speech ask wires its voice from.
    fn audio(name: &str, asset_id: &str) -> WorkflowNode {
        node(
            NodeKind::Audio,
            name,
            NodeData {
                asset_id: Some(asset_id.to_string()),
                ..NodeData::default()
            },
        )
    }

    /// The node being resolved: a sound card asking to speak, with the input
    /// mode and prompt under test.
    fn speaking(prompt: &str) -> WorkflowNode {
        node(
            NodeKind::Audio,
            "speech",
            NodeData {
                generation: Some(GenerationSpec {
                    capability: Capability::Speech,
                    input_mode: GenerationInputMode::Upstream,
                    prompt: prompt.to_string(),
                    updated_at: now_iso(),
                    ..GenerationSpec::default()
                }),
                ..NodeData::default()
            },
        )
    }

    /// The node being resolved: an image node asking for a poster, with the
    /// input mode and prompt under test.
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

    /// Edges are given in the order they were written, which is the order they
    /// are read: nothing here sorts them.
    fn canvas(nodes: Vec<WorkflowNode>, edges: Vec<(&str, &str, &str)>) -> CanvasDocument {
        CanvasDocument {
            id: "canvas-1".to_string(),
            name: "Canvas 1".to_string(),
            schema_version: CANVAS_SCHEMA_VERSION,
            viewport: Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            nodes,
            edges: edges
                .into_iter()
                .enumerate()
                .map(|(position, (source, port, target))| WorkflowEdge {
                    id: format!("edge-{position}"),
                    source: EdgeEndpoint {
                        node_id: source.to_string(),
                        port_id: "out".to_string(),
                    },
                    target: EdgeEndpoint {
                        node_id: target.to_string(),
                        port_id: port.to_string(),
                    },
                    created_at: now_iso(),
                })
                .collect(),
            groups: Vec::new(),
            settings: DocumentSettings::default(),
            sessions: None,
            folder_id: None,
        }
    }

    fn assets(inputs: &[GenerateInput]) -> Vec<&str> {
        inputs.iter().map(|input| input.asset_id.as_str()).collect()
    }

    fn roles(inputs: &[GenerateInput]) -> Vec<&'static str> {
        inputs.iter().map(|input| input.role.as_str()).collect()
    }

    #[test]
    fn a_node_without_a_spec_has_nothing_to_resolve() {
        let bare = node(NodeKind::Image, "bare", NodeData::default());
        let document = canvas(vec![bare.clone(), text("brief", "ignored")], vec![]);
        assert_eq!(
            collect_generation_inputs(&document, &bare),
            ResolvedInputs::default()
        );
    }

    #[test]
    fn upstream_text_is_folded_in_behind_the_prompt_in_arrival_order() {
        let asked = asking(GenerationInputMode::Upstream, "Paint a poster.");
        let document = canvas(
            vec![
                text("first", "A lantern over a lake."),
                text("second", "Keep the palette cold."),
                asked.clone(),
            ],
            vec![
                (&id("first"), "prompt", &id("poster")),
                (&id("second"), "prompt", &id("poster")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(
            resolved.prompt,
            "Paint a poster.\n\n[Text 1]\nA lantern over a lake.\n\n[Text 2]\nKeep the palette cold."
        );
        assert!(resolved.inputs.is_empty());
        assert_eq!(resolved.used_node_ids, [id("first"), id("second")]);
    }

    /// An edge written first is read first, whatever the node order says.
    #[test]
    fn the_order_of_the_edges_decides_the_numbering() {
        let asked = asking(GenerationInputMode::Upstream, "");
        let document = canvas(
            vec![
                text("alpha", "Alpha."),
                text("beta", "Beta."),
                asked.clone(),
            ],
            vec![
                (&id("beta"), "prompt", &id("poster")),
                (&id("alpha"), "prompt", &id("poster")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        // No prompt of its own, so the first block opens the request rather
        // than leaving a blank line above it.
        assert_eq!(resolved.prompt, "[Text 1]\nBeta.\n\n[Text 2]\nAlpha.");
    }

    #[test]
    fn the_port_an_edge_lands_on_decides_the_role() {
        let asked = asking(GenerationInputMode::Upstream, "Paint it.");
        let document = canvas(
            vec![
                image("subject", "asset-subject"),
                image("stencil", "asset-stencil"),
                text("brief", "A lake."),
                asked.clone(),
            ],
            vec![
                (&id("brief"), "prompt", &id("poster")),
                (&id("subject"), "images", &id("poster")),
                (&id("stencil"), "mask", &id("poster")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(roles(&resolved.inputs), ["reference", "mask"]);
        assert_eq!(assets(&resolved.inputs), ["asset-subject", "asset-stencil"]);
        assert_eq!(
            resolved.used_node_ids,
            [id("brief"), id("subject"), id("stencil")]
        );
    }

    /// A recording wired into the sound card's audio port is the voice a
    /// voice-copying converter reads; words wired into its prompt port fold
    /// into the ask the way they always have.
    #[test]
    fn a_recording_wired_into_the_sound_card_travels_as_a_reference() {
        let asked = speaking("Say it warmly.");
        let document = canvas(
            vec![
                audio("recording", "asset-recording"),
                text("brief", "In a low voice."),
                asked.clone(),
            ],
            vec![
                (&id("recording"), "audio", &id("speech")),
                (&id("brief"), "prompt", &id("speech")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(roles(&resolved.inputs), ["reference"]);
        assert_eq!(assets(&resolved.inputs), ["asset-recording"]);
        assert_eq!(resolved.used_node_ids, [id("recording"), id("brief")]);
        assert_eq!(
            resolved.prompt,
            "Say it warmly.\n\n[Text 1]\nIn a low voice."
        );
    }

    /// A video node's frame ports are what the converter reads the shot's ends
    /// from, so the labels have to survive the trip from the graph.
    #[test]
    fn a_video_node_keeps_its_frames_apart_from_its_references() {
        let asked = node(
            NodeKind::Video,
            "shot",
            NodeData {
                generation: Some(GenerationSpec {
                    capability: Capability::Video,
                    input_mode: GenerationInputMode::Upstream,
                    prompt: "A slow push in.".to_string(),
                    updated_at: now_iso(),
                    ..GenerationSpec::default()
                }),
                ..NodeData::default()
            },
        );
        let document = canvas(
            vec![
                image("opening", "asset-opening"),
                image("closing", "asset-closing"),
                image("mood", "asset-mood"),
                asked.clone(),
            ],
            vec![
                (&id("mood"), "images", &id("shot")),
                (&id("closing"), "lastFrame", &id("shot")),
                (&id("opening"), "firstFrame", &id("shot")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(
            roles(&resolved.inputs),
            ["reference", "lastFrame", "firstFrame"]
        );
        assert_eq!(
            assets(&resolved.inputs),
            ["asset-mood", "asset-closing", "asset-opening"]
        );
    }

    #[test]
    fn a_reference_list_ignores_the_wiring_and_keeps_its_own_order() {
        let mut asked = asking(GenerationInputMode::Manual, "Paint from these.");
        asked.data.generation.as_mut().unwrap().reference_node_ids =
            Some(vec![id("second"), id("plate"), id("first")]);
        let document = canvas(
            vec![
                text("first", "First."),
                text("second", "Second."),
                text("unlisted", "Never asked for."),
                image("plate", "asset-plate"),
                asked.clone(),
            ],
            // Wired in, and still ignored: this mode is the user's list.
            vec![(&id("unlisted"), "prompt", &id("poster"))],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        // Listed words fold into the prompt in the order they were listed; a
        // listed image travels beside it instead of taking a block.
        assert_eq!(
            resolved.prompt,
            "Paint from these.\n\n[Text 1]\nSecond.\n\n[Text 2]\nFirst."
        );
        assert_eq!(assets(&resolved.inputs), ["asset-plate"]);
        assert_eq!(
            resolved.used_node_ids,
            [id("second"), id("plate"), id("first")]
        );
    }

    #[test]
    fn a_mention_becomes_the_label_of_the_block_carrying_it() {
        let asked = asking(
            GenerationInputMode::Mentions,
            "Paint @[node:node-brief] as a poster, in the style of @[node:node-plate].",
        );
        let document = canvas(
            vec![
                text("brief", "A lantern over a lake."),
                image("plate", "asset-plate"),
                text("unmentioned", "Not named, not sent."),
                asked.clone(),
            ],
            // Wired in and named nowhere, so it stays out.
            vec![(&id("unmentioned"), "prompt", &id("poster"))],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(
            resolved.prompt,
            "Paint [Text 1] as a poster, in the style of [Image 1].\n\n\
             [Text 1]\nA lantern over a lake."
        );
        assert_eq!(assets(&resolved.inputs), ["asset-plate"]);
        assert_eq!(resolved.used_node_ids, [id("brief"), id("plate")]);
    }

    /// Two mentions of one node are one block; the second points at the same
    /// label rather than at a block that was never written.
    #[test]
    fn a_repeated_mention_points_at_the_same_block() {
        let asked = asking(
            GenerationInputMode::Mentions,
            "@[node:node-brief] and again @[node:node-brief].",
        );
        let document = canvas(vec![text("brief", "Once."), asked.clone()], vec![]);

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(
            resolved.prompt,
            "[Text 1] and again [Text 1].\n\n[Text 1]\nOnce."
        );
        assert_eq!(resolved.used_node_ids, [id("brief")]);
    }

    /// A mention of a node that is gone must not leak the token to a provider,
    /// which would read it as an instruction.
    #[test]
    fn a_mention_of_a_missing_node_leaves_nothing_behind() {
        let asked = asking(
            GenerationInputMode::Mentions,
            "Paint @[node:node-deleted] and @[node:node-brief",
        );
        let document = canvas(vec![asked.clone()], vec![]);

        let resolved = collect_generation_inputs(&document, &asked);
        // The second token has no closing bracket, so it is prose and stays.
        assert_eq!(resolved.prompt, "Paint  and @[node:node-brief");
        assert!(resolved.used_node_ids.is_empty());
        // Dropped silently is a hole nobody can see; the id is reported so the
        // ask can be refused before a run pays for it.
        assert_eq!(resolved.unresolved, ["node-deleted"]);
    }

    #[test]
    fn a_group_contributes_the_members_that_have_something() {
        let asked = asking(GenerationInputMode::Upstream, "Paint from the set.");
        let group = node(
            NodeKind::Group,
            "set",
            NodeData {
                color: Some("#3b82f6".to_string()),
                child_node_ids: Some(vec![id("plate"), id("empty"), id("sketch")]),
                ..NodeData::default()
            },
        );
        let mut document = canvas(
            vec![
                group,
                image("plate", "asset-plate"),
                // Wired into the group but holding nothing, so it is skipped.
                node(NodeKind::Image, "empty", NodeData::default()),
                image("sketch", "asset-sketch"),
                asked.clone(),
            ],
            vec![(&id("set"), "images", &id("poster"))],
        );
        document.groups.push(GroupMembership {
            group_id: id("set"),
            child_node_ids: vec![id("plate"), id("empty"), id("sketch")],
        });

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(assets(&resolved.inputs), ["asset-plate", "asset-sketch"]);
        assert_eq!(resolved.used_node_ids, [id("plate"), id("sketch")]);
    }

    /// A group inside a group is opened too, and a membership that loops back
    /// on itself ends instead of hanging.
    #[test]
    fn a_group_inside_a_group_is_opened_and_a_loop_ends() {
        let inner = node(
            NodeKind::Group,
            "inner",
            NodeData {
                child_node_ids: Some(vec![id("outer"), id("plate")]),
                ..NodeData::default()
            },
        );
        let outer = node(
            NodeKind::Group,
            "outer",
            NodeData {
                child_node_ids: Some(vec![id("inner")]),
                ..NodeData::default()
            },
        );
        let mut asked = asking(GenerationInputMode::Manual, "Paint.");
        asked.data.generation.as_mut().unwrap().reference_node_ids = Some(vec![id("outer")]);
        let mut document = canvas(
            vec![outer, inner, image("plate", "asset-plate"), asked.clone()],
            vec![],
        );
        document.groups.push(GroupMembership {
            group_id: id("outer"),
            child_node_ids: vec![id("inner")],
        });
        document.groups.push(GroupMembership {
            group_id: id("inner"),
            child_node_ids: vec![id("outer"), id("plate")],
        });

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(assets(&resolved.inputs), ["asset-plate"]);
    }

    #[test]
    fn written_content_wins_over_a_result_a_run_left_behind() {
        let asked = asking(GenerationInputMode::Upstream, "");
        let both = node(
            NodeKind::Text,
            "both",
            NodeData {
                content: Some("What the user wrote.".to_string()),
                result_slots: Some(vec![slot(
                    true,
                    ResultSlotStatus::Succeeded,
                    "An old answer.",
                )]),
                ..NodeData::default()
            },
        );
        // An operation node has no content of its own, so its primary
        // succeeded result is what reaches the node below it.
        let operated = node(
            NodeKind::Operation,
            "operated",
            NodeData {
                result_slots: Some(vec![
                    slot(false, ResultSlotStatus::Succeeded, "Not the primary."),
                    slot(
                        true,
                        ResultSlotStatus::Failed,
                        "A failure is not an answer.",
                    ),
                    slot(true, ResultSlotStatus::Succeeded, "The answer."),
                ]),
                ..NodeData::default()
            },
        );
        let document = canvas(
            vec![both.clone(), operated.clone(), asked.clone()],
            vec![
                (&id("both"), "prompt", &id("poster")),
                (&id("operated"), "prompt", &id("poster")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(
            resolved.prompt,
            "[Text 1]\nWhat the user wrote.\n\n[Text 2]\nThe answer."
        );
    }

    /// Whitespace is not content, and an empty node must not claim a label —
    /// a prompt pointing at a blank block reads as a mistake to a model.
    #[test]
    fn an_empty_node_contributes_nothing() {
        let asked = asking(GenerationInputMode::Upstream, "Paint.");
        let blank = text("blank", "   ");
        let document = canvas(
            vec![blank, asked.clone()],
            vec![(&id("blank"), "prompt", &id("poster"))],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(resolved.prompt, "Paint.");
        assert!(resolved.used_node_ids.is_empty());
    }

    #[test]
    fn two_edges_from_one_node_give_their_share_once() {
        let asked = asking(GenerationInputMode::Upstream, "");
        let document = canvas(
            vec![text("brief", "Once."), asked.clone()],
            vec![
                (&id("brief"), "prompt", &id("poster")),
                (&id("brief"), "prompt", &id("poster")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(resolved.prompt, "[Text 1]\nOnce.");
        assert_eq!(resolved.used_node_ids, [id("brief")]);
    }

    /// A preview has to say which card each reference is, and the request the
    /// gateway gets carries no node ids to say it with.
    #[test]
    fn each_reference_says_which_node_it_came_from() {
        let asked = asking(GenerationInputMode::Upstream, "Paint it.");
        let document = canvas(
            vec![
                image("subject", "asset-subject"),
                image("stencil", "asset-stencil"),
                text("brief", "A lake."),
                asked.clone(),
            ],
            vec![
                (&id("brief"), "prompt", &id("poster")),
                (&id("subject"), "images", &id("poster")),
                (&id("stencil"), "mask", &id("poster")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(assets(&resolved.inputs), ["asset-subject", "asset-stencil"]);
        assert_eq!(
            resolved.input_sources,
            [id("subject"), id("stencil")],
            "position by position with the references"
        );
    }

    /// What upstream text folds in is not capped by validation, and sending more
    /// than a provider reads is a refusal nobody can diagnose from the answer.
    #[test]
    fn upstream_text_past_the_cap_is_cut_and_the_amount_is_said() {
        let asked = asking(GenerationInputMode::Upstream, "Paint.");
        let document = canvas(
            vec![
                text("near", &"a".repeat(19_990)),
                text("far", &"b".repeat(50)),
                asked.clone(),
            ],
            vec![
                (&id("near"), "prompt", &id("poster")),
                (&id("far"), "prompt", &id("poster")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(
            resolved.prompt.chars().count(),
            MAX_PROMPT_LENGTH,
            "the whole prompt lands on the cap and not past it"
        );
        // Seven off the block that partly fitted, and all fifty off the one that
        // could not fit at all.
        assert_eq!(resolved.truncated_chars, 57);
        assert!(resolved.prompt.contains("[Text 1]"));
    }

    /// A label pointing at a block that was cut away whole points at nothing,
    /// and the node behind it did not contribute anything a run will carry.
    #[test]
    fn a_block_that_cannot_fit_takes_its_label_and_its_node_with_it() {
        let asked = asking(GenerationInputMode::Upstream, "Paint.");
        let document = canvas(
            vec![
                text("near", &"a".repeat(19_990)),
                text("far", "The palette should stay cold."),
                asked.clone(),
            ],
            vec![
                (&id("near"), "prompt", &id("poster")),
                (&id("far"), "prompt", &id("poster")),
            ],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert!(!resolved.prompt.contains("[Text 2]"));
        assert!(!resolved.prompt.contains("cold"));
        assert_eq!(resolved.used_node_ids, [id("near")]);
    }

    /// The cap counts characters, so a cut has to land between them: a byte
    /// offset would split a character taking three of them.
    #[test]
    fn a_cut_lands_on_a_character_boundary() {
        let asked = asking(GenerationInputMode::Upstream, "画");
        let document = canvas(
            vec![text("lanterns", &"灯".repeat(19_990)), asked.clone()],
            vec![(&id("lanterns"), "prompt", &id("poster"))],
        );

        let resolved = collect_generation_inputs(&document, &asked);
        assert_eq!(resolved.prompt.chars().count(), MAX_PROMPT_LENGTH);
        assert_eq!(resolved.truncated_chars, 2);
        assert!(resolved.prompt.ends_with('灯'));
    }

    fn slot(is_primary: bool, status: ResultSlotStatus, text: &str) -> ResultSlot {
        ResultSlot {
            id: "result".to_string(),
            status,
            asset_id: None,
            text: Some(text.to_string()),
            error: None,
            is_primary,
        }
    }
}
