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
//! asked for, or of the name the client sends beside it where it has one — a
//! character's four views are filed under the character's own name rather than
//! a generic label.

use super::jobs::{StoryArtView, StoryJobItem, StoryJobKind, StoryTarget};
use crate::domain::{
    id_tag, now_iso, AssetGeneration, AssetId, AssetProvenance, Capability, ResourceEntry,
};
use crate::generate::{file_incoming, recorded_generation, GenerateResult, Incoming};
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
    let chosen = item
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let provenance = story_provenance(job_id, story_id, item);

    let pieces = pieces(result);
    let count = pieces.len();
    let incoming = pieces
        .into_iter()
        .enumerate()
        .map(|(index, (bytes, mime))| Incoming {
            name: match chosen {
                Some(name) => named_asset_name(name, index, count),
                None => asset_name(&label, job_id, index, count),
            },
            bytes,
            mime,
            category_hint: category_hint(item),
            provenance: provenance.clone(),
        })
        .collect();
    file_incoming(store, incoming).await
}

/// Where an answer came from, as the files it became carry it.
fn story_provenance(job_id: &str, story_id: &str, item: &StoryJobItem) -> AssetProvenance {
    let consumed: Vec<AssetId> = {
        let mut seen = Vec::new();
        for input in &item.inputs {
            if !seen.contains(&input.asset_id) {
                seen.push(input.asset_id.clone());
            }
        }
        seen
    };
    AssetProvenance {
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
        generation: film_generation(item),
        created_at: now_iso(),
    }
}

/// The ask a filmed piece answered, kept with the files it became.
///
/// Pictures, lines and scores are asked for again from the card that holds
/// them, so only a film carries its ask: a cutting room has the file alone
/// and needs the words and the pictures that made it. An act filmed in pieces
/// files each piece under the ask that piece was.
fn film_generation(item: &StoryJobItem) -> Option<AssetGeneration> {
    (item.capability == Capability::Video).then(|| {
        let params = (!item.params.is_null()).then(|| item.params.clone());
        recorded_generation(
            item.prompt.clone(),
            item.system.clone(),
            params,
            &item.inputs,
        )
    })
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

/// The name the client chose, kept as it stands: a character's four views are
/// filed under the character's name and a fixed suffix, not a generic label
/// carrying a batch's random tag. The index appears only when the answer is
/// several files, as it does for a label.
fn named_asset_name(name: &str, index: usize, count: usize) -> String {
    if count > 1 {
        format!("{name} {}", index + 1)
    } else {
        name.to_string()
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
        StoryTarget::ActPlan { .. } => "act plan".to_string(),
        StoryTarget::Continuity { .. } => "continuity".to_string(),
        StoryTarget::OutlineRevision { .. } => "outline revision".to_string(),
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
        StoryJobKind::ActPlan => "actPlan",
        StoryJobKind::Continuity => "continuity",
        StoryJobKind::OutlineRevision => "outlineRevision",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn piece(capability: &str) -> StoryJobItem {
        serde_json::from_value(serde_json::json!({
            "id": "act",
            "target": { "kind": "actVideo", "chapterId": "chapter-1", "actId": "act-1" },
            "capability": capability,
            "prompt": "站台上的灯一盏一盏亮起来",
            "system": "Describe only what the camera sees.",
            "inputs": [
                { "role": "firstFrame", "assetId": "asset-frame-a" },
                { "role": "lastFrame", "assetId": "asset-clip-b", "frame": "last" },
                { "role": "reference", "assetId": "asset-sketch" },
            ],
            "params": { "seconds": 5, "ratio": "16:9" },
            "status": "queued"
        }))
        .expect("a story piece")
    }

    #[test]
    fn a_filed_film_keeps_the_words_and_pictures_it_was_asked_with() {
        let provenance = story_provenance("job-1", "story-1", &piece("video"));
        let generation = provenance
            .generation
            .as_ref()
            .expect("a film keeps the ask that made it");

        assert_eq!(generation.prompt, "站台上的灯一盏一盏亮起来");
        assert_eq!(
            generation.system.as_deref(),
            Some("Describe only what the camera sees.")
        );
        assert_eq!(
            generation
                .inputs
                .iter()
                .map(|input| (input.role.as_str(), input.asset_id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("firstFrame", "asset-frame-a"),
                ("lastFrame", "asset-clip-b"),
                ("reference", "asset-sketch"),
            ]
        );
        assert_eq!(
            generation.inputs[1].frame.as_deref(),
            Some("last"),
            "which end of the clip it means travels with it"
        );
        assert_eq!(
            generation.params.as_ref().unwrap()["seconds"],
            serde_json::json!(5)
        );
        assert_eq!(
            provenance.input_asset_ids.as_deref(),
            Some(
                [
                    "asset-frame-a".to_string(),
                    "asset-clip-b".to_string(),
                    "asset-sketch".to_string()
                ]
                .as_slice()
            ),
            "the plain list stays for a reader that does not know the roles"
        );
    }

    #[test]
    fn a_filed_picture_keeps_no_ask_beyond_its_batch() {
        let provenance = story_provenance("job-1", "story-1", &piece("image"));
        assert!(
            provenance.generation.is_none(),
            "a still is asked for again from the shot that holds it"
        );
    }

    #[test]
    fn a_chosen_name_is_kept_as_it_stands() {
        // A character's four views are filed under the character's name and a
        // fixed suffix, with no random batch tag.
        assert_eq!(named_asset_name("林 四视图", 0, 1), "林 四视图");
        assert_eq!(named_asset_name("林 四视图", 1, 2), "林 四视图 2");
    }

    #[test]
    fn a_label_is_tagged_by_its_batch() {
        assert!(asset_name("element sheet", "job-1", 0, 1).starts_with("element sheet-"));
    }
}
