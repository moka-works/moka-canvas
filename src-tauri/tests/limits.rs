use moka_canvas::domain::commands::{apply_commands, apply_commands_with_limits, make_node};
use moka_canvas::domain::validate::{
    CanvasLimits, MAX_CANVASES_PER_PROJECT, MAX_EDGES_PER_CANVAS, MAX_NODES_PER_CANVAS,
};
use moka_canvas::domain::{DocumentCommand, MokaFile, NodeKind};
use std::path::PathBuf;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name)
}

fn minimal() -> MokaFile {
    let raw = std::fs::read_to_string(fixture_path("minimal.moka.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn empty_canvas_id(moka: &MokaFile) -> String {
    moka.canvas
        .iter()
        .find(|canvas| canvas.nodes.is_empty())
        .expect("the fixture holds an empty board")
        .id
        .clone()
}

fn add_node(canvas_id: &str, title: &str) -> DocumentCommand {
    DocumentCommand::AddNode {
        canvas_id: canvas_id.to_string(),
        node: make_node(NodeKind::Text, title.to_string(), 0.0, 0.0),
    }
}

#[test]
fn a_configured_limit_can_only_tighten_the_host_ceilings() {
    let clamped = CanvasLimits::new(0, usize::MAX, 0);
    assert_eq!(clamped.max_nodes_per_canvas, 1);
    assert_eq!(clamped.max_edges_per_canvas, MAX_EDGES_PER_CANVAS);
    assert_eq!(clamped.max_canvases_per_project, 1);

    let roomy = CanvasLimits::new(usize::MAX, usize::MAX, usize::MAX);
    assert_eq!(roomy.max_nodes_per_canvas, MAX_NODES_PER_CANVAS);
    assert_eq!(roomy.max_edges_per_canvas, MAX_EDGES_PER_CANVAS);
    assert_eq!(roomy.max_canvases_per_project, MAX_CANVASES_PER_PROJECT);
}

#[test]
fn a_tightened_node_limit_is_enforced_while_the_default_still_applies() {
    let moka = minimal();
    let canvas_id = empty_canvas_id(&moka);
    let limits = CanvasLimits {
        max_nodes_per_canvas: 1,
        ..CanvasLimits::default()
    };

    let first = add_node(&canvas_id, "first");
    let (filled, _) = apply_commands_with_limits(&moka, &[first], &limits).unwrap();

    let second = add_node(&canvas_id, "second");
    let failure =
        apply_commands_with_limits(&filled, std::slice::from_ref(&second), &limits).unwrap_err();
    assert_eq!(failure.code, "VALIDATION_FAILED");
    assert!(failure.to_string().contains("node limit"), "{failure}");

    // The default ceiling is what a project without a configured limit gets.
    let (spacious, _) = apply_commands(&filled, &[second]).unwrap();
    assert_eq!(
        spacious
            .canvas(&canvas_id)
            .expect("the board is still there")
            .nodes
            .len(),
        2
    );
}
