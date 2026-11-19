use moka_canvas::domain::validate::{
    generation_param_keys, mention_node_ids, mention_spans, model_identifier_shaped,
    resource_path_valid, topological_order, validate_canvas, validate_moka_file, MAX_ASSET_TAGS,
    MAX_ASSET_TAG_LENGTH, MAX_ASSISTANT_MESSAGES_PER_SESSION, MAX_ASSISTANT_SESSIONS_PER_CANVAS,
    MAX_PROMPT_LENGTH, MAX_RESULT_SLOTS,
};
use moka_canvas::domain::{
    AssistantMessage, AssistantReference, AssistantRole, AssistantSession, CanvasDocument,
    Capability, EdgeEndpoint, GenerationInputMode, GenerationMode, GenerationSpec, MokaFile,
    NodeKind, ResultSlot, ResultSlotStatus, WorkflowEdge, WorkflowNode,
};
use moka_canvas::project::codec::{decode_moka_file, encode_moka_file, CodecError};
use std::path::PathBuf;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name)
}

fn golden_from_json() -> MokaFile {
    let raw = std::fs::read_to_string(fixture_path("minimal.moka.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn golden_binary_decodes_to_golden_json_model() {
    let bytes = std::fs::read(fixture_path("minimal.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    let expected = golden_from_json();
    assert_eq!(decoded, expected);
}

#[test]
fn re_encode_is_byte_canonical() {
    let bytes = std::fs::read(fixture_path("minimal.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    let reencoded = encode_moka_file(&decoded, None).unwrap();
    assert_eq!(
        bytes, reencoded,
        "Rust re-encode must reproduce the golden bytes exactly"
    );
}

/// The document the other language writes when it has a conversation to keep,
/// as the model it says the binary holds.
fn conversation_from_json() -> MokaFile {
    let raw = std::fs::read_to_string(fixture_path("conversation.moka.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn conversation_binary_decodes_to_conversation_json_model() {
    let bytes = std::fs::read(fixture_path("conversation.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    assert_eq!(decoded, conversation_from_json());
}

#[test]
fn conversation_re_encode_is_byte_canonical() {
    let bytes = std::fs::read(fixture_path("conversation.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    assert_eq!(
        bytes,
        encode_moka_file(&decoded, None).unwrap(),
        "a conversation is written the same bytes whichever language writes it"
    );
}

/// What a reader says about its assets, as the other language wrote it to disk.
fn shelf_from_json() -> MokaFile {
    let raw = std::fs::read_to_string(fixture_path("shelf.moka.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn shelf_binary_decodes_to_shelf_json_model() {
    let bytes = std::fs::read(fixture_path("shelf.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    assert_eq!(decoded, shelf_from_json());
}

#[test]
fn shelf_re_encode_is_byte_canonical() {
    let bytes = std::fs::read(fixture_path("shelf.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    assert_eq!(
        bytes,
        encode_moka_file(&decoded, None).unwrap(),
        "what a reader says about an asset is written the same bytes whichever language writes it"
    );
}

#[test]
fn shelf_words_are_held_to_their_sizes_and_their_vocabulary() {
    let mut crowded = shelf_from_json();
    crowded.resources.images[0].tags = Some(
        (0..=MAX_ASSET_TAGS)
            .map(|index| index.to_string())
            .collect(),
    );
    assert!(validate_moka_file(&crowded)
        .iter()
        .any(|issue| issue.message.contains("more tags than")));

    let mut long_tag = shelf_from_json();
    long_tag.resources.images[0].tags = Some(vec!["k".repeat(MAX_ASSET_TAG_LENGTH + 1)]);
    assert!(validate_moka_file(&long_tag)
        .iter()
        .any(|issue| issue.message.contains("a tag over")));

    let mut unknown_origin = shelf_from_json();
    unknown_origin.resources.images[0].origin = Some("inherited".into());
    assert!(validate_moka_file(&unknown_origin)
        .iter()
        .any(|issue| issue.message.contains("an origin nothing recognises")));

    assert!(validate_moka_file(&shelf_from_json()).is_empty());
}

/// The cutting room's golden fixture, as the other language wrote it: every
/// timeline shape the document may hold, one per field and enum branch.
fn cut_from_json() -> MokaFile {
    let raw = std::fs::read_to_string(fixture_path("cut.moka.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn cut_binary_decodes_to_cut_json_model() {
    let bytes = std::fs::read(fixture_path("cut.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    assert_eq!(decoded, cut_from_json());
}

#[test]
fn cut_re_encode_is_byte_canonical() {
    let bytes = std::fs::read(fixture_path("cut.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    assert_eq!(
        bytes,
        encode_moka_file(&decoded, None).unwrap(),
        "a timeline is written the same bytes whichever language writes it"
    );
}

#[test]
fn cut_fixture_validates_clean() {
    assert!(validate_moka_file(&cut_from_json()).is_empty());
}

#[test]
fn rejects_bad_magic() {
    let mut bytes = std::fs::read(fixture_path("minimal.canvas.moka")).unwrap();
    bytes[1] = 0x00;
    let error = decode_moka_file(&bytes).unwrap_err();
    assert!(matches!(error, CodecError::MagicInvalid));
    assert_eq!(error.code(), "MOKA_MAGIC_INVALID");
}

#[test]
fn rejects_truncated_bson() {
    let bytes = std::fs::read(fixture_path("minimal.canvas.moka")).unwrap();
    let truncated = &bytes[..bytes.len() - 4];
    let error = decode_moka_file(truncated).unwrap_err();
    assert_eq!(error.code(), "MOKA_BSON_INVALID");
}

#[test]
fn rejects_unknown_version() {
    let mut moka = golden_from_json();
    moka.version = "v2".into();
    let bytes = encode_moka_file(&moka, None).unwrap();
    let error = decode_moka_file(&bytes).unwrap_err();
    assert!(matches!(error, CodecError::VersionUnsupported(_)));
}

#[test]
fn enforces_size_cap() {
    let moka = golden_from_json();
    let error = encode_moka_file(&moka, Some(16)).unwrap_err();
    assert!(matches!(error, CodecError::TooLarge { .. }));
}

#[test]
fn golden_document_passes_validation() {
    let moka = golden_from_json();
    assert!(validate_moka_file(&moka).is_empty());
}

#[test]
fn golden_canvas_has_deterministic_topological_order() {
    let moka = golden_from_json();
    let canvas = &moka.canvas[0];
    let order: Vec<&str> = topological_order(canvas)
        .iter()
        .map(|node| node.id.as_str())
        .collect();
    let text = "00000000-0000-7000-8000-00000000000a";
    let operation = "00000000-0000-7000-8000-00000000000c";
    let export = "00000000-0000-7000-8000-00000000000d";
    let pos = |id: &str| order.iter().position(|candidate| *candidate == id).unwrap();
    assert!(pos(text) < pos(operation));
    assert!(pos(operation) < pos(export));
}

#[test]
fn resource_path_rules() {
    assert!(resource_path_valid("assets/images/a.png"));
    assert!(!resource_path_valid("../a.png"));
    assert!(!resource_path_valid("/etc/passwd"));
    assert!(!resource_path_valid("assets//a.png"));
    assert!(!resource_path_valid("assets/./a.png"));
    assert!(!resource_path_valid("C:/a.png"));
}

const TEXT_NODE: &str = "00000000-0000-7000-8000-00000000000a";
const IMAGE_NODE: &str = "00000000-0000-7000-8000-00000000000b";
const OPERATION_NODE: &str = "00000000-0000-7000-8000-00000000000c";

fn golden_canvas() -> CanvasDocument {
    golden_from_json().canvas.into_iter().next().unwrap()
}

fn node_mut<'a>(canvas: &'a mut CanvasDocument, id: &str) -> &'a mut WorkflowNode {
    canvas
        .nodes
        .iter_mut()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("golden canvas has no node {id}"))
}

fn generation(capability: Capability, prompt: &str) -> GenerationSpec {
    GenerationSpec {
        capability,
        mode: GenerationMode::Generate,
        model: String::new(),
        prompt: prompt.into(),
        input_mode: GenerationInputMode::Upstream,
        params: Some(serde_json::json!({})),
        reference_node_ids: Some(Vec::new()),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

fn flagged(canvas: &CanvasDocument, node_id: &str, code: &str) -> bool {
    validate_canvas(canvas)
        .iter()
        .any(|issue| issue.code == code && issue.node_id.as_deref() == Some(node_id))
}

fn has_code(canvas: &CanvasDocument, code: &str) -> bool {
    validate_canvas(canvas)
        .iter()
        .any(|issue| issue.code == code)
}

fn messages(canvas: &CanvasDocument, code: &str) -> Vec<String> {
    validate_canvas(canvas)
        .iter()
        .filter(|issue| issue.code == code)
        .map(|issue| issue.message.clone())
        .collect()
}

#[test]
fn golden_canvas_stays_clean_without_generation_specs() {
    assert!(validate_canvas(&golden_canvas()).is_empty());
}

#[test]
fn flags_a_spec_that_disagrees_with_its_node() {
    let mut canvas = golden_canvas();
    let mut broken = generation(Capability::Image, "Redraw @[node:missing] in ink");
    // An old "channel::model" reference is not a model configuration id.
    broken.model = "channel-1::painter".into();
    node_mut(&mut canvas, TEXT_NODE).data.generation = Some(broken);

    assert!(flagged(
        &canvas,
        TEXT_NODE,
        "GENERATION_CAPABILITY_MISMATCH"
    ));
    assert!(flagged(&canvas, TEXT_NODE, "GENERATION_MODEL_MISSING"));
    assert!(flagged(&canvas, TEXT_NODE, "MENTION_NODE_NOT_FOUND"));
}

#[test]
fn structural_nodes_cannot_carry_a_spec() {
    let mut canvas = golden_canvas();
    node_mut(&mut canvas, OPERATION_NODE).data.generation =
        Some(generation(Capability::Text, "Summarise the board"));
    assert!(flagged(
        &canvas,
        OPERATION_NODE,
        "GENERATION_CAPABILITY_MISMATCH"
    ));
}

#[test]
fn flags_a_prompt_that_mentions_its_own_node() {
    let mut canvas = golden_canvas();
    node_mut(&mut canvas, TEXT_NODE).data.generation = Some(generation(
        Capability::Text,
        &format!("Rewrite @[node:{TEXT_NODE}]"),
    ));
    assert!(flagged(&canvas, TEXT_NODE, "MENTION_SELF_REFERENCE"));
}

#[test]
fn empty_prompt_needs_upstream_or_references() {
    let mut canvas = golden_canvas();
    node_mut(&mut canvas, TEXT_NODE).data.generation = Some(generation(Capability::Text, "   "));
    node_mut(&mut canvas, IMAGE_NODE).data.generation = Some(generation(Capability::Image, ""));
    assert!(flagged(&canvas, TEXT_NODE, "GENERATION_PROMPT_EMPTY"));
    assert!(flagged(&canvas, IMAGE_NODE, "GENERATION_PROMPT_EMPTY"));

    canvas.edges.push(WorkflowEdge {
        id: "00000000-0000-7000-8000-000000000021".into(),
        source: EdgeEndpoint {
            node_id: TEXT_NODE.into(),
            port_id: "out".into(),
        },
        target: EdgeEndpoint {
            node_id: IMAGE_NODE.into(),
            port_id: "prompt".into(),
        },
        created_at: "2026-01-01T00:00:00.000Z".into(),
    });

    assert!(!flagged(&canvas, IMAGE_NODE, "GENERATION_PROMPT_EMPTY"));
    assert!(!has_code(&canvas, "PORT_TYPE_MISMATCH"));
    assert!(flagged(&canvas, TEXT_NODE, "GENERATION_PROMPT_EMPTY"));
}

#[test]
fn references_alone_satisfy_an_empty_prompt() {
    let mut canvas = golden_canvas();
    let mut spec = generation(Capability::Image, "");
    spec.input_mode = GenerationInputMode::Manual;
    spec.reference_node_ids = Some(vec![TEXT_NODE.into()]);
    node_mut(&mut canvas, IMAGE_NODE).data.generation = Some(spec);
    assert!(!flagged(&canvas, IMAGE_NODE, "GENERATION_PROMPT_EMPTY"));
}

#[test]
fn rejects_unknown_generation_params() {
    let mut canvas = golden_canvas();
    let mut spec = generation(Capability::Image, "A poster of the lake");
    spec.params = Some(serde_json::json!({ "size": "1:1", "brush": "wet" }));
    node_mut(&mut canvas, IMAGE_NODE).data.generation = Some(spec);

    assert_eq!(
        messages(&canvas, "VALIDATION_FAILED"),
        ["Unknown parameter \"brush\" for image generation"]
    );
}

/// A sound node asks in either of the two sound capabilities, and in nothing
/// else: the kind says how the node is drawn, its spec says what it wants.
#[test]
fn a_sound_node_may_ask_in_both_sound_capabilities_and_no_other() {
    let mut canvas = golden_canvas();
    for (id, capability) in [
        (IMAGE_NODE, Capability::Speech),
        (OPERATION_NODE, Capability::Music),
    ] {
        let node = node_mut(&mut canvas, id);
        node.kind = NodeKind::Audio;
        node.data.generation = Some(generation(capability, "a spoken line"));
    }
    assert!(!flagged(
        &canvas,
        IMAGE_NODE,
        "GENERATION_CAPABILITY_MISMATCH"
    ));
    assert!(!flagged(
        &canvas,
        OPERATION_NODE,
        "GENERATION_CAPABILITY_MISMATCH"
    ));

    // A sound node asking for words is a spec that would reach the wrong
    // endpoint, and is said so.
    let text = node_mut(&mut canvas, OPERATION_NODE);
    text.data.generation = Some(generation(Capability::Text, "a written line"));
    assert!(flagged(
        &canvas,
        OPERATION_NODE,
        "GENERATION_CAPABILITY_MISMATCH"
    ));
}

#[test]
fn rejects_an_overlong_prompt() {
    let mut canvas = golden_canvas();
    let long = "a".repeat(MAX_PROMPT_LENGTH + 1);
    node_mut(&mut canvas, TEXT_NODE).data.generation = Some(generation(Capability::Text, &long));

    assert_eq!(
        messages(&canvas, "VALIDATION_FAILED"),
        [format!(
            "Generation prompt exceeds the {MAX_PROMPT_LENGTH} character limit"
        )]
    );
}

#[test]
fn enforces_the_result_slot_limit() {
    let mut canvas = golden_canvas();
    node_mut(&mut canvas, OPERATION_NODE).data.result_slots = Some(
        (0..MAX_RESULT_SLOTS + 1)
            .map(|index| ResultSlot {
                id: format!("slot-{index}"),
                status: ResultSlotStatus::Empty,
                asset_id: None,
                text: None,
                error: None,
                is_primary: index == 0,
            })
            .collect(),
    );
    assert!(flagged(&canvas, OPERATION_NODE, "RESULT_SLOT_LIMIT"));
}

const SAID_AT: &str = "2026-01-01T00:00:00.000Z";

fn line(index: usize) -> AssistantMessage {
    AssistantMessage {
        id: format!("message-{index}"),
        role: AssistantRole::User,
        text: format!("Line {index}"),
        created_at: SAID_AT.into(),
        references: None,
        tool_calls: None,
        failure: None,
    }
}

fn conversation(index: usize) -> AssistantSession {
    AssistantSession {
        id: format!("conversation-{index}"),
        title: format!("Conversation {index}"),
        messages: Vec::new(),
        created_at: SAID_AT.into(),
        updated_at: SAID_AT.into(),
    }
}

#[test]
fn golden_document_carries_no_conversations() {
    // The field came in without a schema version of its own, so a document
    // stored before it existed has to read as carrying none and write back the
    // bytes it arrived with — otherwise opening an old project would quietly
    // rewrite it.
    let canvas = golden_canvas();
    assert_eq!(canvas.sessions, None);
    assert!(validate_canvas(&canvas).is_empty());
}

#[test]
fn reports_a_canvas_carrying_more_conversations_than_it_can() {
    let mut canvas = golden_canvas();
    canvas.sessions = Some(
        (0..MAX_ASSISTANT_SESSIONS_PER_CANVAS + 1)
            .map(conversation)
            .collect(),
    );
    // The words are the contract: what a document is wrong about is said the
    // same way whichever language read it.
    assert_eq!(
        messages(&canvas, "VALIDATION_FAILED"),
        vec![format!(
            "Canvas exceeds the session limit ({MAX_ASSISTANT_SESSIONS_PER_CANVAS})"
        )]
    );
}

#[test]
fn reports_a_conversation_too_long_to_read_through() {
    let mut canvas = golden_canvas();
    let mut too_long = conversation(0);
    too_long.messages = (0..MAX_ASSISTANT_MESSAGES_PER_SESSION + 1)
        .map(line)
        .collect();
    let mut repeated = conversation(1);
    repeated.id = too_long.id.clone();
    canvas.sessions = Some(vec![too_long, repeated]);

    assert_eq!(
        messages(&canvas, "VALIDATION_FAILED"),
        vec![
            format!(
                "Session \"Conversation 0\" exceeds the message limit \
                 ({MAX_ASSISTANT_MESSAGES_PER_SESSION})"
            ),
            "Duplicate session id conversation-0".to_string(),
        ]
    );
}

#[test]
fn a_line_naming_a_card_that_has_gone_is_not_a_fault_in_the_document() {
    // The line kept the card's title and kind for exactly this case, so what it
    // says is still what was asked about; only the card is gone, and saying so
    // is the reader's job.
    let mut canvas = golden_canvas();
    let mut asked = conversation(0);
    asked.messages = vec![AssistantMessage {
        references: Some(vec![AssistantReference {
            node_id: "a-node-that-was-deleted".into(),
            title: "The lake".into(),
            kind: NodeKind::Image,
            asset_id: Some("an-asset-that-was-deleted".into()),
        }]),
        ..line(0)
    }];
    canvas.sessions = Some(vec![asked]);

    assert!(validate_canvas(&canvas).is_empty());
}

#[test]
fn mention_and_model_shapes() {
    assert_eq!(
        mention_node_ids("Paint @[node:a] beside @[node:b]"),
        vec!["a", "b"]
    );
    assert!(mention_node_ids("no mentions here").is_empty());
    assert!(mention_node_ids("@[node:] and @[node").is_empty());

    assert!(model_identifier_shaped("painter"));
    // An old "channel::model" reference names nothing now, and saying so at
    // validation beats an opaque refusal at run time.
    assert!(!model_identifier_shaped("main::painter"));
    assert!(!model_identifier_shaped("::painter"));
    assert!(!model_identifier_shaped(""));
    assert!(!model_identifier_shaped("two words"));
}

#[test]
fn a_mention_reports_the_span_it_occupies() {
    let prompt = "Paint @[node:a] beside @[node:b]";
    let spans = mention_spans(prompt);
    assert_eq!(spans.len(), 2);
    assert_eq!(&prompt[spans[0].0.clone()], "@[node:a]");
    assert_eq!(spans[0].1, "a");
    assert_eq!(&prompt[spans[1].0.clone()], "@[node:b]");
    assert_eq!(spans[1].1, "b");

    assert_eq!(
        mention_spans("@[node:]")
            .into_iter()
            .map(|(_, id)| id)
            .collect::<Vec<_>>(),
        vec![""]
    );
    assert!(mention_spans("Paint @[node:a").is_empty());
    assert_eq!(mention_spans("@[node:a] then @[node:b").len(), 1);
}

/// The canvas tree as the other language wrote it to disk.
fn tree_from_json() -> MokaFile {
    let raw = std::fs::read_to_string(fixture_path("tree.moka.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn tree_binary_decodes_to_tree_json_model() {
    let bytes = std::fs::read(fixture_path("tree.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    assert_eq!(decoded, tree_from_json());
}

#[test]
fn tree_re_encode_is_byte_canonical() {
    let bytes = std::fs::read(fixture_path("tree.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    assert_eq!(
        bytes,
        encode_moka_file(&decoded, None).unwrap(),
        "where a board sits in the tree is written the same bytes whichever language writes it"
    );
}

#[test]
fn a_document_with_no_folders_carries_no_folder_field() {
    // The golden document predates folders: it must read as carrying none and
    // write back the bytes it arrived with, rather than an empty list of them.
    let golden = golden_from_json();
    assert!(golden.folders.is_none());
    assert!(golden
        .canvas
        .iter()
        .all(|canvas| canvas.folder_id.is_none()));
    let bytes = std::fs::read(fixture_path("minimal.canvas.moka")).unwrap();
    assert_eq!(encode_moka_file(&golden, None).unwrap(), bytes);
}

/// The parameter keys the web half states for one capability, read out of the
/// TypeScript constant rather than restated here: the segment runs from its
/// own `name: [` to the bracket that closes it.
fn web_param_keys(source: &str, capability: &str) -> Vec<String> {
    let declaration = source
        .find("GENERATION_PARAM_KEYS")
        .expect("the web half states a parameter vocabulary");
    // The table itself, not the rest of the file: the port table above it names
    // the same capabilities in the same shape.
    let block = &source[declaration..];
    let end_of_block = block.find("\n};").expect("the parameter vocabulary ends");
    let block = &block[..end_of_block];

    let head = format!("\n  {capability}: [");
    let start = block
        .find(&head)
        .unwrap_or_else(|| panic!("the web half states no {capability} list"))
        + head.len();
    let end = block[start..]
        .find(']')
        .unwrap_or_else(|| panic!("the {capability} list never closes"))
        + start;
    block[start..end]
        .split(',')
        .map(|entry| entry.trim().trim_matches('"').to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// The vocabulary of an ask is one list, not two that are expected to agree.
///
/// A key a converter reads but this half refuses — or the reverse — reads as a
/// provider ignoring a parameter nobody sent, which is why the two lists are
/// held together here rather than by whoever edits them next.
#[test]
fn the_parameter_vocabulary_is_one_list_in_both_halves() {
    let source = include_str!("../../../src/shared/domain/constants.ts");
    for capability in [
        Capability::Text,
        Capability::Image,
        Capability::Speech,
        Capability::Music,
        Capability::Video,
        Capability::Asr,
    ] {
        assert_eq!(
            generation_param_keys(capability),
            web_param_keys(source, capability.as_str()),
            "both halves must read the same keys, in the same order, for {}",
            capability.as_str()
        );
    }
}
