//! What is checked before a batch is started.
//!
//! A job is refused here rather than half-run: nothing about asking a provider
//! for twelve drawings should be discovered halfway through, when eleven are
//! paid for and the twelfth is not. What is checked is what can be known from
//! where the request arrives — the story it names, the pieces it carries, the
//! files it points at — and never what the story says, which this layer does
//! not read.

use super::jobs::{StoryJobItem, StoryJobKind, StoryTarget};
use super::{STORY_JOB_BUSY, STORY_JOB_ITEM_LIMIT, STORY_NOT_FOUND, STORY_TARGET_INVALID};
use crate::config::StoryConfig;
use crate::domain::validate::{generation_param_keys, MAX_PROMPT_LENGTH};
use crate::domain::{Capability, MokaFile, ResourceRegistry, ValidationIssue};

/// The longest an item id may be, and the characters it may be made of.
///
/// The id is the client's to choose and is echoed back on every answer, so it
/// is bounded like one: long enough for a path through a story — a line of
/// dialogue is a place too, and its path names four of them — and plain enough
/// that nothing has to escape it.
const MAX_ITEM_ID: usize = 200;

fn issue(code: &str, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        code: code.to_string(),
        message: message.into(),
        canvas_id: None,
        node_id: None,
        port_id: None,
        edge_id: None,
        timeline_id: None,
        track_id: None,
        clip_id: None,
        transition_id: None,
    }
}

/// Whether a batch may be started against this document.
///
/// The document is read for the two things only it knows — that the story is
/// there, and that the files the pieces point at exist — and for nothing else.
pub fn validate_start(
    moka: &MokaFile,
    story_id: &str,
    kind: StoryJobKind,
    items: &[StoryJobItem],
    assets: &ResourceRegistry,
    limits: &StoryConfig,
) -> Result<(), Vec<ValidationIssue>> {
    let mut issues = Vec::new();

    if !moka
        .stories
        .as_ref()
        .is_some_and(|stories| stories.iter().any(|story| story.id == story_id))
    {
        issues.push(issue(
            STORY_NOT_FOUND,
            format!("No story {story_id} in this project"),
        ));
    }

    if items.is_empty() || items.len() > limits.max_items_per_job {
        issues.push(issue(
            STORY_JOB_ITEM_LIMIT,
            format!(
                "A job asks for between 1 and {} pieces",
                limits.max_items_per_job
            ),
        ));
    }

    let mut seen: Vec<&str> = Vec::with_capacity(items.len());
    for (position, item) in items.iter().enumerate() {
        let at = position + 1;
        if item.prompt.trim().is_empty() {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("Item {at} asks with an empty prompt"),
            ));
        } else if item.prompt.chars().count() > MAX_PROMPT_LENGTH {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("Item {at} asks for more than {MAX_PROMPT_LENGTH} characters"),
            ));
        }
        if !item_id_shaped(&item.id) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("Item {at} is not named by a plain id"),
            ));
        } else if seen.contains(&item.id.as_str()) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("Item {at} repeats the id {}", item.id),
            ));
        }
        seen.push(&item.id);
        if item.target.kind() != kind {
            issues.push(issue(
                STORY_TARGET_INVALID,
                format!(
                    "Item {at} is aimed at {:?}, which is not the kind of this job",
                    item.target.kind()
                ),
            ));
        }
        // The capability is stated by the client and is what the piece would be
        // sent with; the target is what the room reads the answer back by. A
        // pair that disagrees is a piece that would come home to the wrong slot.
        if item.capability != capability_for(&item.target) {
            issues.push(issue(
                STORY_TARGET_INVALID,
                format!(
                    "Item {at} is a {} piece aimed at a {} target",
                    item.capability.as_str(),
                    capability_for(&item.target).as_str()
                ),
            ));
        }
        if let Some(key) = unknown_param(item) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!(
                    "Item {at} asks for {key:?}, which {} does not take",
                    item.capability.as_str()
                ),
            ));
        }
        for input in &item.inputs {
            if assets.find(&input.asset_id).is_none() {
                issues.push(issue(
                    "ASSET_MISSING",
                    format!("Item {at} points at the missing asset {}", input.asset_id),
                ));
            }
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// The issue a batch is refused with when something is already running.
pub fn busy_issue(message: impl Into<String>) -> ValidationIssue {
    issue(STORY_JOB_BUSY, message)
}

fn item_id_shaped(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_ITEM_ID
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ":_-".contains(character))
}

/// The first parameter a piece carries that its capability does not take.
fn unknown_param(item: &StoryJobItem) -> Option<String> {
    let asked = item.params.as_object()?;
    let allowed = generation_param_keys(item.capability);
    asked
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
        .cloned()
}

/// The capability a piece is asked for, read off its target rather than
/// trusted from the request: a piece whose stated capability disagreed with its
/// target would be sent to the wrong endpoint, and the target is the half the
/// client reads back into a slot.
pub fn capability_for(target: &StoryTarget) -> Capability {
    target.kind().capability()
}
