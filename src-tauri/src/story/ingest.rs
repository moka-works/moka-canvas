//! Filing what a story job was answered with.
//!
//! A generation is a file like any other once it exists, so the write itself is
//! the shared ingest's — all registered or none. What this adds is the little a
//! story's answer carries that a node's does not: a name a reader can place
//! ("keyframe art", "act video" and the short id of the batch), a shelf
//! category for the one modality a sniffer cannot settle, and the trace back to
//! the batch and the story that asked.
//!
//! Nothing here reads the document. A job's target names a slot in a story, and
//! the story is the client's: the label is made of the kind of thing that was
//! asked for and not of what the story calls it, which is why a book's
//! characters are filed as "element art" rather than by name.

use super::jobs::{StoryArtView, StoryJobItem, StoryJobKind, StoryTarget};
use crate::domain::{id_tag, now_iso, AssetId, AssetProvenance, ResourceEntry};
use crate::generate::{file_incoming, GenerateResult, Incoming};
use crate::project::{ProjectError, ProjectStore};

/// How much of a job id an asset's name carries: enough to tell two batches of
/// the same slot apart, short enough to stay readable beside the label.
const JOB_NAME_CHARS: usize = 8;

/// Writes one piece's answer into the project, and reports what landed.
pub async fn ingest_story_result(
    store: &dyn ProjectStore,
    job_id: &str,
    story_id: &str,
    item: &StoryJobItem,
    result: &GenerateResult,
) -> Result<Vec<ResourceEntry>, ProjectError> {
    let label = target_label(&item.target);
    let consumed: Vec<AssetId> = {
        let mut seen = Vec::new();
        for input in &item.inputs {
            if !seen.contains(&input.asset_id) {
                seen.push(input.asset_id.clone());
            }
        }
        seen
    };
    let provenance = AssetProvenance {
        run_id: None,
        canvas_id: None,
        operation_node_id: None,
        assistant_session_id: None,
        story_job_id: Some(job_id.to_string()),
        story_id: Some(story_id.to_string()),
        input_asset_ids: (!consumed.is_empty()).then_some(consumed),
        parameter_snapshot: Some(serde_json::json!({
            "storyJobId": job_id,
            "kind": kind_word(item.target.kind()),
            "target": item.target,
            "prompt": item.prompt,
            "params": item.params,
        })),
        created_at: now_iso(),
    };

    let pieces = pieces(result);
    let count = pieces.len();
    let incoming = pieces
        .into_iter()
        .enumerate()
        .map(|(index, (bytes, mime))| Incoming {
            name: asset_name(&label, job_id, index, count),
            bytes,
            mime,
            category_hint: category_hint(item),
            provenance: provenance.clone(),
        })
        .collect();
    file_incoming(store, incoming).await
}

/// The parts of an answer worth keeping, with the mime each is declared as.
///
/// A caption beside a picture is not a file: it describes the picture and
/// belongs wherever the picture is applied. Text becomes a file only when it is
/// the whole answer, which for a story is never — words are kept on the piece
/// itself and read into the document by the room.
fn pieces(result: &GenerateResult) -> Vec<(Vec<u8>, String)> {
    if !result.items.is_empty() {
        return result
            .items
            .iter()
            .map(|item| (item.bytes.clone(), item.mime.clone()))
            .collect();
    }
    match result.text.as_deref() {
        Some(text) if !text.trim().is_empty() => {
            vec![(text.as_bytes().to_vec(), "text/plain".to_string())]
        }
        _ => Vec::new(),
    }
}

/// The name the shelf shows. The batch's short id keeps two answers for the
/// same slot apart; the index appears only when there is more than one file, so
/// a single answer is never called the first of one.
fn asset_name(label: &str, job_id: &str, index: usize, count: usize) -> String {
    let short = id_tag(job_id, JOB_NAME_CHARS);
    if count > 1 {
        format!("{label}-{short}-{}", index + 1)
    } else {
        format!("{label}-{short}")
    }
}

/// What an answer was for, in the words a shelf can carry.
///
/// Neutral words rather than the story's own: a job does not read the document,
/// so the name of the character a drawing is of is not here to be used. What a
/// reader sees beside the file is the slot it fills and the batch it came from,
/// and the story it belongs to is a reference away.
fn target_label(target: &StoryTarget) -> String {
    match target {
        StoryTarget::Outline => "outline".to_string(),
        StoryTarget::Elements => "elements".to_string(),
        StoryTarget::Storyboard { .. } => "storyboard".to_string(),
        StoryTarget::ElementArt { view, .. } => match view {
            StoryArtView::Main => "element art".to_string(),
            StoryArtView::Turnaround => "element sheet".to_string(),
        },
        StoryTarget::KeyframeArt { .. } => "keyframe art".to_string(),
        StoryTarget::ActVideo { .. } => "act video".to_string(),
        StoryTarget::KeyframeVideo { .. } => "keyframe video".to_string(),
        StoryTarget::Voice { .. } => "act voice".to_string(),
        StoryTarget::LineVoice { .. } => "line voice".to_string(),
        StoryTarget::Music { .. } => "act music".to_string(),
    }
}

/// The batch's kind as one word, for the snapshot a reader may look at later.
fn kind_word(kind: StoryJobKind) -> &'static str {
    match kind {
        StoryJobKind::Outline => "outline",
        StoryJobKind::Elements => "elements",
        StoryJobKind::Storyboard => "storyboard",
        StoryJobKind::ElementArt => "elementArt",
        StoryJobKind::KeyframeArt => "keyframeArt",
        StoryJobKind::ActVideo => "actVideo",
        StoryJobKind::KeyframeVideo => "keyframeVideo",
        StoryJobKind::Voice => "voice",
        StoryJobKind::Music => "music",
    }
}

/// Sound is the one family a sniffer cannot settle, and the capability is
/// what tells the two kinds apart. Everything else follows its mime.
fn category_hint(item: &StoryJobItem) -> Option<String> {
    match item.capability {
        crate::domain::Capability::Speech => Some("voice".to_string()),
        crate::domain::Capability::Music => Some("music".to_string()),
        _ => None,
    }
}
