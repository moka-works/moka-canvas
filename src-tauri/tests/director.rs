//! The director scene half the two languages share: commands, cleanup, and
//! the codec round trip that keeps a staged scene with its project.

use moka_canvas::domain::commands::apply_commands;
use moka_canvas::domain::director::{
    DirectorAspectRatio, DirectorCamera, DirectorCameraMove, DirectorLight, DirectorLightType,
    DirectorScene, DirectorShot, DirectorShotSize, DirectorState, DirectorTransform,
    DIRECTOR_SCHEMA_VERSION,
};
use moka_canvas::domain::validate::validate_moka_file;
use moka_canvas::domain::{
    derive_ports, new_id, now_iso, CanvasDocument, DocumentCommand, MokaFile, NodeData, NodeKind,
    ProjectMetadata, ResourceRegistry, WorkflowNode, CANVAS_SCHEMA_VERSION, MOKA_FILE_VERSION,
};
use moka_canvas::project::codec::{decode_moka_file, encode_moka_file};

fn transform(position: [f64; 3]) -> DirectorTransform {
    DirectorTransform {
        position,
        rotation: [0.0, 0.0, 0.0],
        scale: [1.0, 1.0, 1.0],
    }
}

fn scene(title: &str) -> DirectorScene {
    let now = now_iso();
    let camera = DirectorCamera {
        id: "camera-1".into(),
        name: "Camera".into(),
        transform: transform([6.0, 2.6, 7.8]),
        target: [0.0, 1.05, 0.0],
        focal_length: 40.0,
        aperture: 2.8,
        focus_distance: 5.5,
        near: 0.08,
        far: 400.0,
        keyframes: Vec::new(),
    };
    let shot = DirectorShot {
        id: "shot-1".into(),
        name: "Shot".into(),
        camera_id: camera.id.clone(),
        duration: 6.0,
        fps: 30,
        aspect_ratio: DirectorAspectRatio::Wide,
        shot_size: DirectorShotSize::Medium,
        camera_move: DirectorCameraMove::Static,
        prompt: String::new(),
    };
    let light = DirectorLight {
        id: "light-1".into(),
        name: "Key".into(),
        light_type: DirectorLightType::Directional,
        transform: transform([4.0, 6.0, 4.0]),
        color: "#fff1e0".into(),
        intensity: 2.6,
        angle: None,
        penumbra: None,
        cast_shadow: true,
    };
    DirectorScene {
        id: new_id(),
        schema_version: DIRECTOR_SCHEMA_VERSION,
        title: title.into(),
        background: "#202630".into(),
        environment_intensity: 0.6,
        environment: None,
        grid_visible: true,
        objects: Vec::new(),
        cameras: vec![camera],
        lights: vec![light],
        shots: vec![shot],
        active_shot_id: "shot-1".into(),
        created_at: now.clone(),
        updated_at: now,
    }
}

fn document() -> MokaFile {
    let now = now_iso();
    MokaFile {
        version: MOKA_FILE_VERSION.to_string(),
        metadata: ProjectMetadata {
            id: "project-1".into(),
            name: "Director".into(),
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
        director_scenes: None,
        canvas: vec![CanvasDocument {
            id: "canvas-1".into(),
            name: "Canvas".into(),
            schema_version: CANVAS_SCHEMA_VERSION,
            viewport: moka_canvas::domain::Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            nodes: Vec::new(),
            edges: Vec::new(),
            groups: Vec::new(),
            settings: Default::default(),
            sessions: None,
            folder_id: None,
        }],
    }
}

fn director_node(scene: &DirectorScene) -> WorkflowNode {
    let now = now_iso();
    WorkflowNode {
        id: new_id(),
        kind: NodeKind::Director,
        title: scene.title.clone(),
        bounds: moka_canvas::domain::Rect {
            x: 0.0,
            y: 0.0,
            width: 500.0,
            height: 320.0,
        },
        z_index: 0,
        ports: derive_ports(NodeKind::Director),
        data: NodeData {
            director: Some(DirectorState {
                scene_id: scene.id.clone(),
                frame_asset_id: None,
                blocking_asset_id: None,
                frame_shot_id: None,
                direction_text: None,
                delivered_at: None,
            }),
            ..NodeData::default()
        },
        created_at: now.clone(),
        updated_at: now,
    }
}

fn add_batch(scene: &DirectorScene) -> (MokaFile, WorkflowNode) {
    let base = document();
    let node = director_node(scene);
    let commands = vec![
        DocumentCommand::AddDirectorScene {
            scene: scene.clone(),
            index: None,
        },
        DocumentCommand::AddNode {
            canvas_id: "canvas-1".into(),
            node: node.clone(),
        },
    ];
    let (next, _) = apply_commands(&base, &commands).expect("the batch applies");
    (next, node)
}

#[test]
fn a_scene_and_its_card_are_made_and_undone_together() {
    let scene = scene("Shot 1");
    let (project, node) = add_batch(&scene);
    assert_eq!(project.director_scenes.as_ref().map(Vec::len), Some(1));
    assert_eq!(project.canvas[0].nodes.len(), 1);
    assert_eq!(project.canvas[0].nodes[0].id, node.id);

    let base = document();
    let commands = vec![
        DocumentCommand::AddDirectorScene {
            scene: scene.clone(),
            index: None,
        },
        DocumentCommand::AddNode {
            canvas_id: base.canvas[0].id.clone(),
            node,
        },
    ];
    let (made, inverse) = apply_commands(&base, &commands).unwrap();
    let (undone, _) = apply_commands(&made, &inverse).expect("the undo applies");
    assert!(undone.director_scenes.is_none());
    assert!(undone.canvas[0].nodes.is_empty());
}

#[test]
fn removing_the_last_card_clears_the_scene_and_undo_brings_it_back() {
    let scene = scene("Shot 1");
    let (project, node) = add_batch(&scene);
    let (removed, inverse) = apply_commands(
        &project,
        &[DocumentCommand::RemoveNodes {
            canvas_id: "canvas-1".into(),
            node_ids: vec![node.id.clone()],
        }],
    )
    .unwrap();
    assert!(removed.director_scenes.is_none());
    assert!(removed.canvas[0].nodes.is_empty());

    let (restored, _) = apply_commands(&removed, &inverse).expect("the undo applies");
    assert_eq!(restored.director_scenes.as_ref().map(Vec::len), Some(1));
    assert_eq!(restored.canvas[0].nodes[0].id, node.id);
}

#[test]
fn replacing_a_scene_keeps_its_id_and_restores_the_previous_whole() {
    let scene = scene("Shot 1");
    let (project, _) = add_batch(&scene);
    let mut next = scene.clone();
    next.title = "Changed".into();
    let (replaced, inverse) = apply_commands(
        &project,
        &[DocumentCommand::ReplaceDirectorScene {
            scene_id: scene.id.clone(),
            scene: next,
        }],
    )
    .unwrap();
    assert_eq!(
        replaced.director_scenes.as_ref().unwrap()[0].title,
        "Changed"
    );
    let (undone, _) = apply_commands(&replaced, &inverse).unwrap();
    assert_eq!(undone.director_scenes.as_ref().unwrap()[0].title, "Shot 1");
}

#[test]
fn a_scene_survives_the_document_codec() {
    let scene = scene("Shot 1");
    let (project, _) = add_batch(&scene);
    let bytes = encode_moka_file(&project, None).expect("the document encodes");
    let read = decode_moka_file(&bytes).expect("the document decodes");
    assert_eq!(read.director_scenes, project.director_scenes);
    let again = encode_moka_file(&read, None).unwrap();
    assert_eq!(bytes, again);
    assert!(validate_moka_file(&read).is_empty());
}

#[test]
fn a_scene_pointing_at_a_missing_camera_is_refused_by_validation() {
    let mut scene = scene("Shot 1");
    scene.shots[0].camera_id = "missing".into();
    let mut project = document();
    project.director_scenes = Some(vec![scene]);
    let issues = validate_moka_file(&project);
    assert!(
        issues
            .iter()
            .any(|issue| issue.code == "DIRECTOR_REFERENCE_INVALID"),
        "{issues:?}"
    );
}

#[test]
fn adding_a_scene_twice_is_refused() {
    let scene = scene("Shot 1");
    let (project, _) = add_batch(&scene);
    let failure = apply_commands(
        &project,
        &[DocumentCommand::AddDirectorScene {
            scene: scene.clone(),
            index: None,
        }],
    );
    assert!(failure.is_err());
}
