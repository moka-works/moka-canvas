use super::{CanvasDocument, CanvasFolder, MokaFile};

/// Reading the canvas tree; mirrors `src/shared/domain/folders.ts`.
///
/// The document holds two flat lists — folders and canvases — and a folder
/// named on each canvas saying where it sits, so the tree is derived rather
/// than stored: there is one order to keep, and no nested copy of it free to
/// disagree with the list a command just moved. Among their siblings folders
/// come before canvases, each in the order its own list holds it.
///
/// Everything here is total over a malformed document as well as a sound one: a
/// document out of the wild can name a parent that is not there, or a parent
/// that is its own grandchild, and a reader walking that has to stop rather
/// than spin.
pub fn folders_of(moka: &MokaFile) -> &[CanvasFolder] {
    moka.folders.as_deref().unwrap_or(&[])
}

pub fn folder_by_id<'a>(moka: &'a MokaFile, folder_id: &str) -> Option<&'a CanvasFolder> {
    folders_of(moka)
        .iter()
        .find(|folder| folder.id == folder_id)
}

/// The folder a canvas sits in, or `None` for one at the project root.
pub fn canvas_folder_of(canvas: &CanvasDocument) -> Option<&str> {
    canvas.folder_id.as_deref()
}

/// The folders directly in `parent_id`, in the order the list holds them.
pub fn child_folders<'a>(moka: &'a MokaFile, parent_id: Option<&str>) -> Vec<&'a CanvasFolder> {
    folders_of(moka)
        .iter()
        .filter(|folder| folder.parent_id.as_deref() == parent_id)
        .collect()
}

/// The canvases directly in `parent_id`, in the order the list holds them.
pub fn folder_canvases<'a>(moka: &'a MokaFile, parent_id: Option<&str>) -> Vec<&'a CanvasDocument> {
    moka.canvas
        .iter()
        .filter(|canvas| canvas_folder_of(canvas) == parent_id)
        .collect()
}

/// How deep a folder sits, counting a folder at the project root as one.
///
/// The walk stops at a name it has already passed, so a document carrying a
/// circle reads as a finite depth rather than a walk that never ends; naming
/// the circle is validation's job. The depth is allowed past the ceiling on
/// purpose: a caller has to be able to see one level too deep to refuse it.
pub fn folder_depth(moka: &MokaFile, folder_id: &str) -> usize {
    let mut seen = vec![folder_id.to_string()];
    let mut depth = 1usize;
    let mut parent = folder_by_id(moka, folder_id).and_then(|folder| folder.parent_id.clone());
    while let Some(id) = parent {
        if seen.contains(&id) {
            break;
        }
        seen.push(id.clone());
        depth += 1;
        parent = folder_by_id(moka, &id).and_then(|folder| folder.parent_id.clone());
    }
    depth
}

/// Every folder under this one, not counting it.
pub fn descendant_folder_ids(moka: &MokaFile, folder_id: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut queue = vec![folder_id.to_string()];
    while let Some(holder) = queue.pop() {
        for child in child_folders(moka, Some(holder.as_str())) {
            if child.id == folder_id || found.iter().any(|id| id == &child.id) {
                continue;
            }
            queue.push(child.id.clone());
            found.push(child.id.clone());
        }
    }
    found
}

/// Whether walking up from a folder leads back to it.
pub fn holds_itself(moka: &MokaFile, folder_id: &str) -> bool {
    let mut seen: Vec<String> = Vec::new();
    let mut current = folder_by_id(moka, folder_id).and_then(|folder| folder.parent_id.clone());
    while let Some(id) = current {
        if seen.contains(&id) {
            return true;
        }
        seen.push(id.clone());
        current = folder_by_id(moka, &id).and_then(|folder| folder.parent_id.clone());
    }
    false
}

/// How deep the tree under a folder reaches, counting the folder itself as one.
///
/// What a move is measured against: a folder carrying two levels of its own
/// cannot be dropped six levels down, and saying so before the move is made is
/// the only way a tree is kept to a depth a reader can follow.
pub fn subtree_depth(moka: &MokaFile, folder_id: &str) -> usize {
    let own = folder_depth(moka, folder_id);
    let mut deepest = 1usize;
    for descendant in descendant_folder_ids(moka, folder_id) {
        let relative = folder_depth(moka, &descendant).saturating_sub(own) + 1;
        if relative > deepest {
            deepest = relative;
        }
    }
    deepest
}

/// The place a canvas holds among the canvases of the folder it sits in.
///
/// The order the tree shows, and so the order a move is asked for and undone in:
/// a canvas moving back to where it was lands at this index beside the same
/// neighbours however the flat list underneath was rearranged.
pub fn canvas_sibling_index(moka: &MokaFile, canvas_id: &str) -> usize {
    let folder = moka
        .canvas
        .iter()
        .find(|canvas| canvas.id == canvas_id)
        .and_then(canvas_folder_of);
    folder_canvases(moka, folder)
        .iter()
        .position(|canvas| canvas.id == canvas_id)
        .unwrap_or(0)
}

/// The place a folder holds among the folders of the folder it sits in.
pub fn folder_sibling_index(moka: &MokaFile, folder_id: &str) -> usize {
    let parent = folder_by_id(moka, folder_id).and_then(|folder| folder.parent_id.clone());
    child_folders(moka, parent.as_deref())
        .iter()
        .position(|folder| folder.id == folder_id)
        .unwrap_or(0)
}
