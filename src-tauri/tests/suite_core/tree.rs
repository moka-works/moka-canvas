use moka_canvas::domain::commands::apply_commands;
use moka_canvas::domain::folders::{child_folders, folder_canvases, folder_depth};
use moka_canvas::domain::validate::{validate_moka_file, MAX_FOLDER_DEPTH};
use moka_canvas::domain::{now_iso, CanvasFolder, DocumentCommand, MokaFile};
use std::path::PathBuf;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name)
}

/// A document with two boards and no folders, to build a tree out of.
fn flat() -> MokaFile {
    let raw = std::fs::read_to_string(fixture_path("minimal.moka.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn folder(id: &str, name: &str, parent_id: Option<&str>) -> CanvasFolder {
    CanvasFolder {
        id: id.to_string(),
        name: name.to_string(),
        parent_id: parent_id.map(str::to_string),
        created_at: now_iso(),
    }
}

fn apply(moka: &MokaFile, commands: &[DocumentCommand]) -> MokaFile {
    apply_commands(moka, commands).unwrap().0
}

fn code_of(moka: &MokaFile, command: DocumentCommand) -> String {
    match apply_commands(moka, &[command]) {
        Ok(_) => "OK".to_string(),
        Err(error) => error.code.to_string(),
    }
}

/// The names the tree reads, folders before canvases among their siblings.
fn tree_of(moka: &MokaFile, parent_id: Option<&str>) -> Vec<String> {
    let mut names: Vec<String> = child_folders(moka, parent_id)
        .into_iter()
        .flat_map(|folder| {
            let mut held = vec![format!("{}/", folder.name)];
            held.extend(tree_of(moka, Some(folder.id.as_str())));
            held
        })
        .collect();
    names.extend(
        folder_canvases(moka, parent_id)
            .into_iter()
            .map(|canvas| canvas.name.clone()),
    );
    names
}

/// A board by the name it is read by, since a move changes the flat order.
fn canvas_named(moka: &MokaFile, name: &str) -> String {
    moka.canvas
        .iter()
        .find(|canvas| canvas.name == name)
        .unwrap_or_else(|| panic!("no canvas called {name}"))
        .id
        .clone()
}

/// A document with Drafts holding a board and a folder of its own, and Kept
/// beside it: the same tree the TypeScript suite builds.
fn build_tree() -> MokaFile {
    let moka = flat();
    let canvas_id = moka.canvas[0].id.clone();
    apply(
        &moka,
        &[
            DocumentCommand::AddFolder {
                folder: folder("f-drafts", "Drafts", None),
                index: None,
            },
            DocumentCommand::AddFolder {
                folder: folder("f-kept", "Kept", None),
                index: None,
            },
            DocumentCommand::AddFolder {
                folder: folder("f-inside", "Inside", Some("f-drafts")),
                index: None,
            },
            DocumentCommand::MoveCanvas {
                canvas_id,
                folder_id: Some("f-drafts".to_string()),
                index: 0,
            },
        ],
    )
}

#[test]
fn a_canvas_sits_in_the_folder_it_was_put_in() {
    let moka = build_tree();
    assert_eq!(
        tree_of(&moka, None),
        vec!["Drafts/", "Inside/", "Canvas 1", "Kept/", "Canvas 2"]
    );
    assert!(validate_moka_file(&moka).is_empty());
    assert_eq!(folder_depth(&moka, "f-inside"), 2);
}

#[test]
fn a_move_is_undone_by_the_inverse_it_gives_back() {
    let moka = build_tree();
    let canvas_id = canvas_named(&moka, "Canvas 1");
    let (next, inverse) = apply_commands(
        &moka,
        &[DocumentCommand::MoveCanvas {
            canvas_id,
            folder_id: None,
            index: 0,
        }],
    )
    .unwrap();
    assert_eq!(
        tree_of(&next, None),
        vec!["Drafts/", "Inside/", "Kept/", "Canvas 1", "Canvas 2"]
    );
    let undone = apply(&next, &inverse);
    assert_eq!(tree_of(&undone, None), tree_of(&moka, None));
}

#[test]
fn what_a_folder_held_moves_up_into_the_folder_that_held_it() {
    let moka = build_tree();
    let (next, inverse) = apply_commands(
        &moka,
        &[DocumentCommand::RemoveFolder {
            folder_id: "f-drafts".to_string(),
        }],
    )
    .unwrap();
    // The board and the folder it held are both still reachable, and the folder
    // takes the place the one that held it had rather than going to the end.
    assert_eq!(
        tree_of(&next, None),
        vec!["Inside/", "Kept/", "Canvas 2", "Canvas 1"]
    );
    assert_eq!(tree_of(&apply(&next, &inverse), None), tree_of(&moka, None));
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::RemoveFolder {
                folder_id: "nope".to_string()
            }
        ),
        "FOLDER_NOT_FOUND"
    );
}

#[test]
fn a_folder_cannot_be_put_inside_itself_or_inside_one_it_holds() {
    let moka = build_tree();
    let into_itself = DocumentCommand::MoveFolder {
        folder_id: "f-drafts".to_string(),
        parent_id: Some("f-drafts".to_string()),
        index: 0,
    };
    assert_eq!(code_of(&moka, into_itself), "VALIDATION_FAILED");
    let into_its_own = DocumentCommand::MoveFolder {
        folder_id: "f-drafts".to_string(),
        parent_id: Some("f-inside".to_string()),
        index: 0,
    };
    assert_eq!(code_of(&moka, into_its_own), "VALIDATION_FAILED");
}

#[test]
fn the_tree_is_kept_to_the_depth_it_is_kept_to() {
    let mut moka = flat();
    let mut parent: Option<String> = None;
    for level in 0..MAX_FOLDER_DEPTH {
        let id = format!("f-level-{level}");
        moka = apply(
            &moka,
            &[DocumentCommand::AddFolder {
                folder: folder(&id, &format!("Level {}", level + 1), parent.as_deref()),
                index: None,
            }],
        );
        parent = Some(id);
    }
    assert!(validate_moka_file(&moka).is_empty());
    let too_deep = DocumentCommand::AddFolder {
        folder: folder("f-too-deep", "Too deep", parent.as_deref()),
        index: None,
    };
    assert_eq!(code_of(&moka, too_deep), "VALIDATION_FAILED");

    // What a folder carries under it counts as well as the folder itself: two
    // levels of room are needed for a folder holding one level of its own.
    moka = apply(
        &moka,
        &[
            DocumentCommand::AddFolder {
                folder: folder("f-carried", "Carried", None),
                index: None,
            },
            DocumentCommand::AddFolder {
                folder: folder("f-carried-in", "Inside carried", Some("f-carried")),
                index: None,
            },
        ],
    );
    // One level down from there it fits; one level further it does not.
    let refused = DocumentCommand::MoveFolder {
        folder_id: "f-carried".to_string(),
        parent_id: Some(format!("f-level-{}", MAX_FOLDER_DEPTH - 2)),
        index: 0,
    };
    assert_eq!(code_of(&moka, refused), "VALIDATION_FAILED");
    let accepted = DocumentCommand::MoveFolder {
        folder_id: "f-carried".to_string(),
        parent_id: Some(format!("f-level-{}", MAX_FOLDER_DEPTH - 3)),
        index: 0,
    };
    let moved = apply(&moka, &[accepted]);
    assert!(validate_moka_file(&moved).is_empty());
}

#[test]
fn a_tree_a_document_arrived_with_says_what_is_wrong_with_it() {
    let moka = build_tree();

    let mut dangling = moka.clone();
    dangling.canvas[0].folder_id = Some("nope".to_string());
    assert!(validate_moka_file(&dangling)
        .iter()
        .any(|issue| issue.code == "FOLDER_NOT_FOUND"));

    // A parent that leads back round is named as a circle rather than reported
    // as too deep, which is what a reader has to be told to fix it.
    let mut circles = moka.clone();
    let folders = circles.folders.as_mut().unwrap();
    for entry in folders.iter_mut() {
        if entry.id == "f-drafts" {
            entry.parent_id = Some("f-inside".to_string());
        }
    }
    assert!(validate_moka_file(&circles)
        .iter()
        .any(|issue| issue.message.contains("is inside itself")));
}

#[test]
fn a_document_with_no_folders_says_nothing_about_a_tree() {
    assert!(validate_moka_file(&flat()).is_empty());
    assert!(flat().folders.is_none());
}
