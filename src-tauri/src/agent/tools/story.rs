//! The story room's tools.
//!
//! A story is a document of steps: an idea, an outline, a cast, a board, an
//! edit. The tools follow that shape — read a step, change one thing, confirm
//! when the reader says so — and a batch generation is a task, never a tool
//! that waits. Verification tools compute readiness from the content itself;
//! there is no second, tool-local definition of what a step still needs.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::{ApiState, ProjectSession};
use crate::domain::commands::make_node;
use crate::domain::story::{
    StoryAct, StoryActPatch, StoryBriefPatch, StoryChapter, StoryDocument, StoryEdit,
    StoryEditClip, StoryElement, StoryElementPatch, StoryKeyframe, StoryKeyframePatch, StorySlot,
    StorySlotTarget, StoryTake, StoryVoiceProfile, REFERENCE_IMAGES_MAX, STORY_SCHEMA_VERSION,
};
use crate::domain::{
    now_iso, DocumentCommand, MokaFile, TimelineClip, TimelineDocument, TimelineSettings,
    TimelineTrack, TrackKind,
};
use crate::generate::{Cancel, DeltaSink, GenerateRequest};
use crate::project::ProjectStore;

use super::super::error::ToolError;
use super::{Args, TaskRef, ToolOutcome};

pub async fn command(moka: &MokaFile, name: &str, input: &Value) -> Result<ToolOutcome, ToolError> {
    let args = Args::new(name, input)?;
    match name {
        "story.list" => {
            let list: Vec<Value> = moka
                .stories
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|story| {
                    json!({
                        "id": story.id,
                        "name": story.name,
                        "confirmedSteps": story.confirmed_steps,
                        "chapters": story.chapters.len(),
                        "elements": story.elements.len(),
                        "updatedAt": story.updated_at,
                    })
                })
                .collect();
            Ok(ToolOutcome::read(
                format!("{} stories", list.len()),
                json!({"stories": list}),
            ))
        }
        "story.get" => {
            let story = super::story_of(moka, args.req_str("storyId")?)?;
            let include: Vec<String> = args.opt_strings("include");
            let wants =
                |section: &str| include.is_empty() || include.iter().any(|item| item == section);
            // Slots are deliberately explicit: they carry every take of every
            // place, which is a large answer a reader who only wants the board
            // should not pay for.
            let wants_slots = include.iter().any(|item| item == "slots");
            let full_text = args.opt_bool("fullText", false);
            let limit = args.opt_i64("limit").map(|value| value.max(0) as usize);
            let chapter_filter = args.opt_str("chapterId").map(str::to_string);
            let act_filter = args.opt_str("actId").map(str::to_string);

            let chapters: Vec<&StoryChapter> = match chapter_filter.as_deref() {
                Some(id) => story
                    .chapters
                    .iter()
                    .filter(|chapter| chapter.id == id)
                    .collect(),
                None => story.chapters.iter().collect(),
            };
            if chapter_filter.is_some() && chapters.is_empty() {
                return Err(ToolError::new(
                    "CHAPTER_NOT_FOUND",
                    format!(
                        "chapter {} does not exist",
                        chapter_filter.as_deref().unwrap_or_default()
                    ),
                ));
            }
            if let Some(id) = act_filter.as_deref() {
                if !chapters
                    .iter()
                    .any(|chapter| chapter.acts.iter().any(|act| act.id == id))
                {
                    return Err(ToolError::new(
                        "ACT_NOT_FOUND",
                        format!("act {id} does not exist"),
                    ));
                }
            }

            let mut selected: Vec<(&StoryChapter, &StoryAct)> = Vec::new();
            for chapter in &chapters {
                for act in &chapter.acts {
                    if act_filter.as_deref().is_some_and(|id| act.id != id) {
                        continue;
                    }
                    selected.push((chapter, act));
                }
            }
            let acts_truncated = limit.is_some_and(|limit| selected.len() > limit);
            if let Some(limit) = limit {
                selected.truncate(limit);
            }

            let mut keyframes: Vec<(&StoryChapter, &StoryAct, &StoryKeyframe)> = Vec::new();
            for (chapter, act) in &selected {
                for keyframe in &act.keyframes {
                    keyframes.push((*chapter, *act, keyframe));
                }
            }
            let keyframes_truncated = limit.is_some_and(|limit| keyframes.len() > limit);
            if let Some(limit) = limit {
                keyframes.truncate(limit);
            }

            let mut data = json!({
                "story": {
                    "id": story.id,
                    "name": story.name,
                    "shotGranularity": story.shot_granularity,
                    "maxReferenceImages": story.max_reference_images,
                    "confirmedSteps": story.confirmed_steps,
                    "chapterCount": story.chapters.len(),
                    "narrator": story.narrator,
                    "imagePromptOverrides": story.image_prompt_overrides,
                    "videoPromptOverrides": story.video_prompt_overrides,
                    "edit": story.edit,
                },
            });
            if wants("brief") {
                data["brief"] = json!(story.brief);
            }
            if wants("chapters") {
                data["chapters"] = json!(chapters
                    .iter()
                    .map(|chapter| {
                        let (synopsis, truncated, length) =
                            shortened(&chapter.synopsis, 2_000, full_text);
                        json!({
                            "id": chapter.id,
                            "title": chapter.title,
                            "synopsis": synopsis,
                            "synopsisTruncated": truncated,
                            "synopsisLength": length,
                            "targetDurationMs": chapter.target_duration_ms,
                            "actCount": chapter.acts.len(),
                            "revision": chapter.revision,
                            "boardRevision": chapter.board_revision,
                            "outlineLocked": chapter.outline_locked,
                        })
                    })
                    .collect::<Vec<_>>());
            }
            if wants("elements") {
                data["elements"] = elements_with_current(story);
            }
            if wants("storyboard") {
                data["acts"] = json!(selected
                    .iter()
                    .map(|(chapter, act)| {
                        let (summary, truncated, length) =
                            shortened(&act.summary, 2_000, full_text);
                        json!({
                            "id": act.id,
                            "chapterId": chapter.id,
                            "title": act.title,
                            "summary": summary,
                            "summaryTruncated": truncated,
                            "summaryLength": length,
                            "plan": act.plan,
                            "characterIds": act.character_ids,
                            "sceneId": act.scene_id,
                            "propIds": act.prop_ids,
                            "sound": act.sound,
                            "transition": act.transition,
                            "shotGranularity": act.shot_granularity,
                            "videoModel": act.video_model,
                            "keyframeCount": act.keyframes.len(),
                            "plannedMs": act
                                .keyframes
                                .iter()
                                .map(|keyframe| keyframe.duration_ms)
                                .sum::<i64>(),
                            "video": slot_summary(&act.video),
                            "voice": act.voice.as_ref().map(slot_summary),
                            "music": act.music.as_ref().map(slot_summary),
                        })
                    })
                    .collect::<Vec<_>>());
                data["actsTruncated"] = json!(acts_truncated);
                data["keyframes"] = json!(keyframes
                    .iter()
                    .map(|(chapter, act, keyframe)| {
                        let (content, content_truncated, content_length) =
                            shortened(&keyframe.content, 2_000, full_text);
                        let (motion, motion_truncated, motion_length) = match &keyframe.motion {
                            Some(motion) => {
                                let (text, truncated, length) = shortened(motion, 2_000, full_text);
                                (Some(text), truncated, Some(length))
                            }
                            None => (None, false, None),
                        };
                        json!({
                            "id": keyframe.id,
                            "chapterId": chapter.id,
                            "actId": act.id,
                            "title": keyframe.title,
                            "shotSize": keyframe.shot_size,
                            "cameraMove": keyframe.camera_move,
                            "angle": keyframe.angle,
                            "filmRole": keyframe.film_role,
                            "durationMs": keyframe.duration_ms,
                            "content": content,
                            "contentTruncated": content_truncated,
                            "contentLength": content_length,
                            "motion": motion,
                            "motionTruncated": motion_truncated,
                            "motionLength": motion_length,
                            "dialogue": keyframe.dialogue,
                            "artNotNeeded": keyframe.art_not_needed,
                            "references": keyframe.references,
                            "variantChoices": keyframe.variant_choices,
                            "imageModel": keyframe.image_model,
                            "art": slot_summary(&keyframe.art),
                            "video": slot_summary(&keyframe.video),
                            "lineVoices": keyframe.voices.as_ref().map(|voices| {
                                voices
                                    .iter()
                                    .map(|voice| json!({
                                        "lineId": voice.line_id,
                                        "slot": slot_summary(&voice.slot),
                                    }))
                                    .collect::<Vec<_>>()
                            }),
                        })
                    })
                    .collect::<Vec<_>>());
                data["keyframesTruncated"] = json!(keyframes_truncated);
            }
            if wants_slots {
                data["slots"] = json!(slots_of(story, &selected));
            }
            if wants("progress") {
                let (ready, gaps) = readiness(story);
                data["progress"] = json!({
                    "ready": ready,
                    "confirmed": story.confirmed_steps,
                    "gaps": gaps,
                });
            }
            Ok(ToolOutcome::read(format!("story {}", story.name), data))
        }
        "story.progress" => {
            let story = super::story_of(moka, args.req_str("storyId")?)?;
            let (ready, gaps) = readiness(story);
            Ok(ToolOutcome::read(
                "story progress",
                json!({
                    "storyId": story.id,
                    "ready": ready,
                    "confirmed": story.confirmed_steps,
                    "gaps": gaps,
                }),
            ))
        }
        "story.create" => {
            let story_name = args.req_str("name")?.to_string();
            let brief = brief_of(args.opt_object("brief"))?;
            let now = now_iso();
            let story = StoryDocument {
                id: crate::domain::new_id(),
                name: story_name.clone(),
                schema_version: STORY_SCHEMA_VERSION,
                brief,
                chapters: Vec::new(),
                elements: Vec::new(),
                shot_granularity: parse_word("act")?,
                max_reference_images: 3,
                confirmed_steps: Vec::new(),
                edit: StoryEdit::default(),
                narrator: None,
                video_prompt_overrides: None,
                image_prompt_overrides: None,
                created_at: now.clone(),
                updated_at: now,
            };
            Ok(ToolOutcome::write(
                format!("Created story {story_name}"),
                json!({"storyId": story.id}),
                vec![DocumentCommand::AddStory { story, index: None }],
            ))
        }
        "story.update" => {
            let story = super::story_of(moka, args.req_str("storyId")?)?;
            let mut commands = Vec::new();
            if let Some(name) = args.opt_str("name") {
                commands.push(DocumentCommand::RenameStory {
                    story_id: story.id.clone(),
                    name: name.to_string(),
                });
            }
            if let Some(granularity) = args.opt_str("shotGranularity") {
                commands.push(DocumentCommand::UpdateStoryGranularity {
                    story_id: story.id.clone(),
                    shot_granularity: parse_word(granularity)?,
                });
            }
            let limit = args.opt_i64("maxReferenceImages");
            if let Some(limit) = limit {
                if !(1..=REFERENCE_IMAGES_MAX as i64).contains(&limit) {
                    return Err(ToolError::validation(format!(
                        "maxReferenceImages is between 1 and {REFERENCE_IMAGES_MAX}"
                    )));
                }
                commands.push(DocumentCommand::UpdateStoryReferenceLimit {
                    story_id: story.id.clone(),
                    max_reference_images: limit as u32,
                });
            }
            if commands.is_empty() {
                return Err(ToolError::validation(
                    "story.update needs a name, shotGranularity, or maxReferenceImages",
                ));
            }
            Ok(ToolOutcome::write(
                format!("Updated story {}", story.name),
                json!({"storyId": story.id}),
                commands,
            ))
        }
        "story.delete" => {
            args.confirmed()?;
            let story = super::story_of(moka, args.req_str("storyId")?)?;
            let acts: usize = story
                .chapters
                .iter()
                .map(|chapter| chapter.acts.len())
                .sum();
            let shots: usize = story
                .chapters
                .iter()
                .flat_map(|chapter| chapter.acts.iter())
                .map(|act| act.keyframes.len())
                .sum();
            Ok(ToolOutcome::write(
                format!(
                    "Deleted story {} ({} chapters, {acts} acts, {shots} shots)",
                    story.name,
                    story.chapters.len()
                ),
                json!({"storyId": story.id}),
                vec![DocumentCommand::RemoveStory {
                    story_id: story.id.clone(),
                }],
            ))
        }
        "story.update_brief" => {
            let story = super::story_of(moka, args.req_str("storyId")?)?;
            let patch: StoryBriefPatch = serde_json::from_value(
                args.raw("patch")
                    .cloned()
                    .ok_or_else(|| ToolError::validation("story.update_brief needs a patch"))?,
            )
            .map_err(|error| ToolError::validation(format!("patch is not valid: {error}")))?;
            Ok(ToolOutcome::write(
                "Updated the story's brief",
                json!({"storyId": story.id}),
                vec![DocumentCommand::UpdateStoryBrief {
                    story_id: story.id.clone(),
                    patch,
                }],
            ))
        }
        "story.replace_chapters" | "story.update_chapter" => {
            chapters(moka, &args, name == "story.replace_chapters")
        }
        "story.add_chapter" | "story.remove_chapter" | "story.move_chapter" => {
            chapter_ops(moka, &args, name)
        }
        "story.replace_acts" | "story.add_act" | "story.remove_act" | "story.move_act" => {
            acts(moka, &args, name)
        }
        "story.update_act" => update_act(moka, &args),
        "story.replace_keyframes" | "story.add_keyframe" | "story.remove_keyframe" => {
            keyframes(moka, &args, name)
        }
        "story.move_keyframe" | "story.duplicate_keyframe" => keyframe_ops(moka, &args, name),
        "story.update_keyframe" => update_keyframe(moka, &args),
        "story.replace_elements" | "story.add_element" | "story.remove_element" => {
            elements(moka, &args, name)
        }
        "story.update_element" => update_element(moka, &args),
        "story.set_slot" => set_slot(moka, &args),
        "story.update_voice" => update_voice(moka, &args),
        "story.confirm_step" => confirm_step(moka, &args),
        "story.board_report" => board_report(moka, &args),
        "story.dubbing_report" => dubbing_report(moka, &args),
        "story.assemble" => assemble(moka, &args),
        "story.import_canvas" => import_canvas(moka, &args),
        "story.set_prompt" => set_prompt(moka, &args),
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not a story command"),
        )),
    }
}

/// A text field as it is returned, with enough metadata for a caller to know
/// whether it is looking at the whole thing.
fn shortened(text: &str, limit: usize, full: bool) -> (String, bool, usize) {
    let length = text.chars().count();
    if full || length <= limit {
        (text.to_string(), false, length)
    } else {
        let mut value: String = text.chars().take(limit).collect();
        value.push('…');
        (value, true, length)
    }
}

/// The files of a slot's current take: the last take is the one in force.
fn current_assets(slot: &StorySlot) -> Vec<String> {
    slot.takes
        .last()
        .map(|take| take.asset_ids.clone())
        .unwrap_or_default()
}

/// A slot as a caller planning an ask reads it: how many takes it holds, the
/// files the current one carries, and whether a set is still waiting to be
/// chosen between.
fn slot_summary(slot: &StorySlot) -> Value {
    json!({
        "takes": slot.takes.len(),
        "current": current_assets(slot),
        "pending": slot.pending.as_ref().map(|pending| json!({
            "jobId": pending.job_id,
            "count": pending.count,
            "takes": pending.takes.len(),
        })),
    })
}

/// The cast with each element's current pictures lifted out of its slots, so a
/// caller does not have to know that a drawing is the last take's first file.
fn elements_with_current(story: &StoryDocument) -> Value {
    let mut value = serde_json::to_value(&story.elements).unwrap_or_else(|_| json!([]));
    if let Value::Array(items) = &mut value {
        for (at, element) in story.elements.iter().enumerate() {
            let Some(item) = items.get_mut(at) else {
                continue;
            };
            item["currentMain"] = json!(current_assets(&element.main));
            item["mainTakes"] = json!(element.main.takes.len());
            item["currentTurnaround"] = json!(element
                .turnaround
                .as_ref()
                .map(current_assets)
                .unwrap_or_default());
            item["turnaroundTakes"] = json!(element
                .turnaround
                .as_ref()
                .map(|slot| slot.takes.len())
                .unwrap_or(0));
            if let (Some(variants), Some(Value::Array(forms))) =
                (&element.variants, item.get_mut("variants"))
            {
                for (form_at, form) in variants.iter().enumerate() {
                    let Some(entry) = forms.get_mut(form_at) else {
                        continue;
                    };
                    entry["currentMain"] = json!(current_assets(&form.main));
                    entry["mainTakes"] = json!(form.main.takes.len());
                    entry["currentTurnaround"] = json!(form
                        .turnaround
                        .as_ref()
                        .map(current_assets)
                        .unwrap_or_default());
                    entry["turnaroundTakes"] = json!(form
                        .turnaround
                        .as_ref()
                        .map(|slot| slot.takes.len())
                        .unwrap_or(0));
                }
            }
        }
    }
    value
}

/// Every place a picture, a clip, a voice or a score is kept, as one list.
fn slots_of(story: &StoryDocument, selected: &[(&StoryChapter, &StoryAct)]) -> Vec<Value> {
    let mut slots = Vec::new();
    for element in &story.elements {
        slots.push(json!({
            "kind": "elementMain",
            "elementId": element.id,
            "view": "main",
            "slot": slot_summary(&element.main),
        }));
        if let Some(turnaround) = &element.turnaround {
            slots.push(json!({
                "kind": "elementTurnaround",
                "elementId": element.id,
                "view": "turnaround",
                "slot": slot_summary(turnaround),
            }));
        }
        if let Some(forms) = &element.variants {
            for form in forms {
                slots.push(json!({
                    "kind": "elementMain",
                    "elementId": element.id,
                    "variantId": form.id,
                    "view": "main",
                    "slot": slot_summary(&form.main),
                }));
                if let Some(turnaround) = &form.turnaround {
                    slots.push(json!({
                        "kind": "elementTurnaround",
                        "elementId": element.id,
                        "variantId": form.id,
                        "view": "turnaround",
                        "slot": slot_summary(turnaround),
                    }));
                }
            }
        }
    }
    for (chapter, act) in selected {
        slots.push(json!({
            "kind": "actVideo",
            "chapterId": chapter.id,
            "actId": act.id,
            "slot": slot_summary(&act.video),
        }));
        if let Some(voice) = &act.voice {
            slots.push(json!({
                "kind": "actVoice",
                "chapterId": chapter.id,
                "actId": act.id,
                "slot": slot_summary(voice),
            }));
        }
        if let Some(music) = &act.music {
            slots.push(json!({
                "kind": "actMusic",
                "chapterId": chapter.id,
                "actId": act.id,
                "slot": slot_summary(music),
            }));
        }
        for keyframe in &act.keyframes {
            slots.push(json!({
                "kind": "keyframeArt",
                "chapterId": chapter.id,
                "actId": act.id,
                "keyframeId": keyframe.id,
                "slot": slot_summary(&keyframe.art),
            }));
            slots.push(json!({
                "kind": "keyframeVideo",
                "chapterId": chapter.id,
                "actId": act.id,
                "keyframeId": keyframe.id,
                "slot": slot_summary(&keyframe.video),
            }));
            if let Some(voices) = &keyframe.voices {
                for voice in voices {
                    slots.push(json!({
                        "kind": "lineVoice",
                        "chapterId": chapter.id,
                        "actId": act.id,
                        "keyframeId": keyframe.id,
                        "lineId": voice.line_id,
                        "slot": slot_summary(&voice.slot),
                    }));
                }
            }
        }
    }
    slots
}

fn parse_word<T: serde::de::DeserializeOwned + super::super::super::domain::story::WordEnum>(
    word: &str,
) -> Result<T, ToolError> {
    T::from_word(word).ok_or_else(|| ToolError::validation(format!("unknown value '{word}'")))
}

fn brief_of(
    value: Option<&serde_json::Map<String, Value>>,
) -> Result<crate::domain::story::StoryBrief, ToolError> {
    let mut brief = json!({
        "idea": value.and_then(|brief| brief.get("idea")).and_then(Value::as_str).unwrap_or_default(),
        "totalDurationMs": value.and_then(|brief| brief.get("totalDurationMs")).and_then(Value::as_i64).unwrap_or(180_000),
        "aspect": value.and_then(|brief| brief.get("aspect")).and_then(Value::as_str).unwrap_or("16:9"),
        "genre": value.and_then(|brief| brief.get("genre")).and_then(Value::as_str).unwrap_or_default(),
        "style": value.and_then(|brief| brief.get("style")).and_then(Value::as_str).unwrap_or_default(),
    });
    for key in ["sourceAssetId", "sourceName", "sourceSplit"] {
        if let Some(entry) = value.and_then(|brief| brief.get(key)) {
            brief[key] = entry.clone();
        }
    }
    serde_json::from_value(brief)
        .map_err(|error| ToolError::validation(format!("brief is not valid: {error}")))
}

fn chapters(moka: &MokaFile, args: &Args<'_>, replace: bool) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    if replace {
        args.confirmed()?;
    }
    let mut list = args.opt_array("chapters").cloned().unwrap_or_default();
    let mut next = if replace {
        Vec::new()
    } else {
        story.chapters.clone()
    };
    if !replace {
        let chapter_id = args.req_str("chapterId")?;
        let patch = args
            .opt_object("patch")
            .ok_or_else(|| ToolError::validation("story.update_chapter needs a patch"))?;
        let chapter = next
            .iter_mut()
            .find(|chapter| chapter.id == chapter_id)
            .ok_or_else(|| {
                ToolError::new(
                    "CHAPTER_NOT_FOUND",
                    format!("chapter {chapter_id} does not exist"),
                )
            })?;
        if let Some(title) = patch.get("title").and_then(Value::as_str) {
            chapter.title = title.to_string();
        }
        if let Some(synopsis) = patch.get("synopsis").and_then(Value::as_str) {
            chapter.synopsis = synopsis.to_string();
        }
        if let Some(duration) = patch.get("targetDurationMs").and_then(Value::as_i64) {
            chapter.target_duration_ms = duration;
        }
        if let Some(locked) = patch.get("outlineLocked").and_then(Value::as_bool) {
            chapter.outline_locked = locked;
        }
        // New words are a revision, exactly as they are when the room confirms
        // an edit: a board built from the old outline has to know it moved.
        let before = story
            .chapters
            .iter()
            .find(|held| held.id == chapter.id)
            .cloned()
            .unwrap_or_else(|| chapter.clone());
        if before.title != chapter.title || before.synopsis != chapter.synopsis {
            *chapter = crate::domain::story::revise_chapter(&before, chapter);
        }
        return Ok(ToolOutcome::write(
            format!("Updated chapter {}", chapter.title),
            json!({"chapterId": chapter.id}),
            vec![DocumentCommand::SetStoryChapters {
                story_id: story.id.clone(),
                chapters: next,
            }],
        ));
    }
    for entry in list.drain(..) {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(crate::domain::new_id);
        let existing = story.chapters.iter().find(|chapter| chapter.id == id);
        let mut chapter = match existing {
            Some(chapter) => chapter.clone(),
            None => crate::domain::story::StoryChapter {
                id,
                title: String::new(),
                synopsis: String::new(),
                target_duration_ms: 60_000,
                acts: Vec::new(),
                revision: 1,
                board_revision: None,
                board_outline: None,
                outline_locked: false,
            },
        };
        if let Some(title) = entry.get("title").and_then(Value::as_str) {
            chapter.title = title.to_string();
        }
        if let Some(synopsis) = entry.get("synopsis").and_then(Value::as_str) {
            chapter.synopsis = synopsis.to_string();
        }
        if let Some(duration) = entry.get("targetDurationMs").and_then(Value::as_i64) {
            chapter.target_duration_ms = duration;
        }
        if let Some(locked) = entry.get("outlineLocked").and_then(Value::as_bool) {
            chapter.outline_locked = locked;
        }
        // New outline words are a revision: the board is told it no longer
        // stands on the outline it was written from.
        if let Some(held) = existing {
            if held.title != chapter.title || held.synopsis != chapter.synopsis {
                chapter = crate::domain::story::revise_chapter(held, &chapter);
            }
        }
        next.push(chapter);
    }
    Ok(ToolOutcome::write(
        format!("Replaced the outline with {} chapters", next.len()),
        json!({"chapters": next.len()}),
        vec![DocumentCommand::SetStoryChapters {
            story_id: story.id.clone(),
            chapters: next,
        }],
    ))
}

fn chapter_ops(moka: &MokaFile, args: &Args<'_>, name: &str) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let mut chapters = story.chapters.clone();
    match name {
        "story.add_chapter" => {
            let value = args.raw("chapter").cloned().unwrap_or_else(|| json!({}));
            let mut chapter = crate::domain::story::StoryChapter {
                id: value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(crate::domain::new_id),
                title: String::new(),
                synopsis: String::new(),
                target_duration_ms: 60_000,
                acts: Vec::new(),
                revision: 1,
                board_revision: None,
                board_outline: None,
                outline_locked: false,
            };
            if let Some(title) = value.get("title").and_then(Value::as_str) {
                chapter.title = title.to_string();
            }
            if let Some(synopsis) = value.get("synopsis").and_then(Value::as_str) {
                chapter.synopsis = synopsis.to_string();
            }
            if let Some(duration) = value.get("targetDurationMs").and_then(Value::as_i64) {
                chapter.target_duration_ms = duration;
            }
            if let Some(locked) = value.get("outlineLocked").and_then(Value::as_bool) {
                chapter.outline_locked = locked;
            }
            let index = args
                .opt_i64("index")
                .map(|index| (index.max(0) as usize).min(chapters.len()))
                .unwrap_or(chapters.len());
            let id = chapter.id.clone();
            chapters.insert(index, chapter);
            Ok(ToolOutcome::write(
                format!("Added chapter at {index}"),
                json!({"chapterId": id, "chapters": chapters.len()}),
                vec![DocumentCommand::SetStoryChapters {
                    story_id: story.id.clone(),
                    chapters,
                }],
            ))
        }
        "story.remove_chapter" => {
            args.confirmed()?;
            let id = args.req_str("chapterId")?;
            let index = chapters
                .iter()
                .position(|chapter| chapter.id == id)
                .ok_or_else(|| {
                    ToolError::new("CHAPTER_NOT_FOUND", format!("chapter {id} does not exist"))
                })?;
            chapters.remove(index);
            Ok(ToolOutcome::write(
                format!("Removed chapter at {index}"),
                json!({"chapterId": id, "chapters": chapters.len()}),
                vec![DocumentCommand::SetStoryChapters {
                    story_id: story.id.clone(),
                    chapters,
                }],
            ))
        }
        _ => {
            let id = args.req_str("chapterId")?;
            let from = chapters
                .iter()
                .position(|chapter| chapter.id == id)
                .ok_or_else(|| {
                    ToolError::new("CHAPTER_NOT_FOUND", format!("chapter {id} does not exist"))
                })?;
            let to = args.req_i64("toIndex")?;
            let chapter = chapters.remove(from);
            let to = (to.max(0) as usize).min(chapters.len());
            chapters.insert(to, chapter);
            Ok(ToolOutcome::write(
                format!("Moved chapter to {to}"),
                json!({"chapterId": id, "chapters": chapters.len()}),
                vec![DocumentCommand::SetStoryChapters {
                    story_id: story.id.clone(),
                    chapters,
                }],
            ))
        }
    }
}

fn keyframe_ops(moka: &MokaFile, args: &Args<'_>, name: &str) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let chapter = chapter_of(story, args.req_str("chapterId")?)?;
    let act_id = args.req_str("actId")?;
    let keyframe_id = args.req_str("keyframeId")?;
    let mut acts = chapter.acts.clone();
    let act = acts
        .iter_mut()
        .find(|act| act.id == act_id)
        .ok_or_else(|| ToolError::new("ACT_NOT_FOUND", format!("act {act_id} does not exist")))?;
    let index = act
        .keyframes
        .iter()
        .position(|keyframe| keyframe.id == keyframe_id)
        .ok_or_else(|| {
            ToolError::new(
                "KEYFRAME_NOT_FOUND",
                format!("shot {keyframe_id} does not exist"),
            )
        })?;
    if name == "story.move_keyframe" {
        let to = args.req_i64("toIndex")?;
        let keyframe = act.keyframes.remove(index);
        let to = (to.max(0) as usize).min(act.keyframes.len());
        act.keyframes.insert(to, keyframe);
    } else {
        let copy = act.keyframes[index].clone();
        let mut copied = copy;
        copied.id = crate::domain::new_id();
        copied.title = format!("#{}", index + 2);
        for line in &mut copied.dialogue {
            line.id = Some(crate::domain::new_id());
        }
        copied.voices = None;
        let at = args
            .opt_i64("index")
            .map(|at| (at.max(0) as usize).min(act.keyframes.len()))
            .unwrap_or(index + 1);
        act.keyframes.insert(at, copied);
    }
    let count = act.keyframes.len();
    Ok(ToolOutcome::write(
        format!("{name}: {count} shots"),
        json!({"actId": act_id, "keyframes": count}),
        vec![DocumentCommand::SetStoryActs {
            story_id: story.id.clone(),
            chapter_id: chapter.id.clone(),
            acts,
        }],
    ))
}

fn empty_slot() -> StorySlot {
    StorySlot::default()
}

fn act_from(
    value: &Value,
    existing: Option<&crate::domain::story::StoryAct>,
) -> Result<crate::domain::story::StoryAct, ToolError> {
    let mut act = match existing {
        Some(act) => act.clone(),
        None => crate::domain::story::StoryAct {
            id: value
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(crate::domain::new_id),
            title: String::new(),
            summary: String::new(),
            plan: None,
            continue_from_previous: false,
            character_ids: Vec::new(),
            scene_id: None,
            prop_ids: Vec::new(),
            sound: crate::domain::story::StoryActSound {
                music: String::new(),
                sfx: String::new(),
                ambience: None,
            },
            keyframes: Vec::new(),
            video: empty_slot(),
            shot_granularity: None,
            voice: None,
            music: None,
            video_model: None,
            transition: None,
        },
    };
    if let Some(title) = value.get("title").and_then(Value::as_str) {
        act.title = title.to_string();
    }
    if let Some(summary) = value.get("summary").and_then(Value::as_str) {
        act.summary = summary.to_string();
    }
    if let Some(ids) = value.get("characterIds").and_then(Value::as_array) {
        act.character_ids = ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    if let Some(scene) = value.get("sceneId") {
        act.scene_id = scene.as_str().map(str::to_string);
    }
    if let Some(ids) = value.get("propIds").and_then(Value::as_array) {
        act.prop_ids = ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    if let Some(sound) = value.get("sound") {
        act.sound = serde_json::from_value(sound.clone())
            .map_err(|error| ToolError::validation(format!("sound is not valid: {error}")))?;
    }
    if let Some(plan) = value.get("plan") {
        act.plan = plan
            .as_str()
            .map(str::to_string)
            .filter(|plan| !plan.trim().is_empty());
    }
    if let Some(granularity) = value.get("shotGranularity") {
        act.shot_granularity = serde_json::from_value(granularity.clone()).map_err(|error| {
            ToolError::validation(format!("shotGranularity is not valid: {error}"))
        })?;
    }
    if let Some(model) = value.get("videoModel") {
        act.video_model = model
            .as_str()
            .map(str::to_string)
            .filter(|model| !model.trim().is_empty());
    }
    if let Some(transition) = value.get("transition") {
        act.transition = serde_json::from_value(transition.clone())
            .map_err(|error| ToolError::validation(format!("transition is not valid: {error}")))?;
    }
    if let Some(keyframes) = value.get("keyframes").and_then(Value::as_array) {
        act.keyframes = keyframes
            .iter()
            .map(|keyframe| keyframe_from(keyframe, None))
            .collect::<Result<Vec<_>, _>>()?;
    }
    Ok(act)
}

fn chapter_of<'a>(
    story: &'a StoryDocument,
    chapter_id: &str,
) -> Result<&'a crate::domain::story::StoryChapter, ToolError> {
    story
        .chapters
        .iter()
        .find(|chapter| chapter.id == chapter_id)
        .ok_or_else(|| {
            ToolError::new(
                "CHAPTER_NOT_FOUND",
                format!("chapter {chapter_id} does not exist"),
            )
        })
}

fn acts(moka: &MokaFile, args: &Args<'_>, name: &str) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let chapter = chapter_of(story, args.req_str("chapterId")?)?;
    let mut acts = chapter.acts.clone();
    match name {
        "story.replace_acts" => {
            args.confirmed()?;
            let list = args.req_array("acts")?;
            acts = list
                .iter()
                .map(|value| {
                    let id = value.get("id").and_then(Value::as_str);
                    let existing = id.and_then(|id| chapter.acts.iter().find(|act| act.id == id));
                    act_from(value, existing)
                })
                .collect::<Result<Vec<_>, _>>()?;
        }
        "story.add_act" => {
            let value = args.raw("act").cloned().unwrap_or_else(|| {
                json!({
                    "title": args.opt_str("title").unwrap_or("Act"),
                    "summary": args.opt_str("summary").unwrap_or_default(),
                })
            });
            let act = act_from(&value, None)?;
            let index = args
                .opt_i64("index")
                .map(|index| (index.max(0) as usize).min(acts.len()))
                .unwrap_or(acts.len());
            acts.insert(index, act);
        }
        "story.remove_act" => {
            args.confirmed()?;
            let act_id = args.req_str("actId")?;
            let index = acts
                .iter()
                .position(|act| act.id == act_id)
                .ok_or_else(|| {
                    ToolError::new("ACT_NOT_FOUND", format!("act {act_id} does not exist"))
                })?;
            acts.remove(index);
        }
        _ => {
            let act_id = args.req_str("actId")?;
            let to = args.req_i64("toIndex")?;
            let from = acts
                .iter()
                .position(|act| act.id == act_id)
                .ok_or_else(|| {
                    ToolError::new("ACT_NOT_FOUND", format!("act {act_id} does not exist"))
                })?;
            let act = acts.remove(from);
            let to = (to.max(0) as usize).min(acts.len());
            acts.insert(to, act);
        }
    }
    Ok(ToolOutcome::write(
        format!("{name} on chapter {}", chapter.title),
        json!({"chapterId": chapter.id, "acts": acts.len()}),
        vec![DocumentCommand::SetStoryActs {
            story_id: story.id.clone(),
            chapter_id: chapter.id.clone(),
            acts,
        }],
    ))
}

fn update_act(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let chapter = chapter_of(story, args.req_str("chapterId")?)?;
    let act_id = args.req_str("actId")?;
    chapter
        .acts
        .iter()
        .find(|act| act.id == act_id)
        .ok_or_else(|| ToolError::new("ACT_NOT_FOUND", format!("act {act_id} does not exist")))?;
    let patch: StoryActPatch = serde_json::from_value(
        args.raw("patch")
            .cloned()
            .ok_or_else(|| ToolError::validation("story.update_act needs a patch"))?,
    )
    .map_err(|error| ToolError::validation(format!("patch is not valid: {error}")))?;
    Ok(ToolOutcome::write(
        format!("Updated act {act_id}"),
        json!({"actId": act_id}),
        vec![DocumentCommand::UpdateStoryAct {
            story_id: story.id.clone(),
            chapter_id: chapter.id.clone(),
            act_id: act_id.to_string(),
            patch,
        }],
    ))
}

fn keyframe_from(
    value: &Value,
    existing: Option<&crate::domain::story::StoryKeyframe>,
) -> Result<crate::domain::story::StoryKeyframe, ToolError> {
    let mut keyframe = existing
        .cloned()
        .unwrap_or_else(|| crate::domain::story::StoryKeyframe {
            id: value
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(crate::domain::new_id),
            title: String::new(),
            shot_size: parse_word("medium").expect("a known word"),
            camera_move: parse_word("static").expect("a known word"),
            angle: parse_word("eyeLevel").expect("a known word"),
            film_role: crate::domain::story::StoryFilmRole::Reference,
            content: String::new(),
            motion: None,
            dialogue: Vec::new(),
            duration_ms: 4_000,
            art: empty_slot(),
            art_not_needed: false,
            video: empty_slot(),
            voices: None,
            variant_choices: Default::default(),
            image_model: None,
            references: None,
        });
    if let Some(title) = value.get("title").and_then(Value::as_str) {
        keyframe.title = title.to_string();
    }
    if let Some(word) = value.get("shotSize").and_then(Value::as_str) {
        keyframe.shot_size = parse_word(word)?;
    }
    if let Some(word) = value.get("cameraMove").and_then(Value::as_str) {
        keyframe.camera_move = parse_word(word)?;
    }
    if let Some(word) = value.get("angle").and_then(Value::as_str) {
        keyframe.angle = parse_word(word)?;
    }
    if let Some(word) = value.get("filmRole").and_then(Value::as_str) {
        keyframe.film_role = parse_word(word)?;
    }
    if let Some(needed) = value.get("artNotNeeded").and_then(Value::as_bool) {
        keyframe.art_not_needed = needed;
    }
    if let Some(choices) = value.get("variantChoices") {
        keyframe.variant_choices = serde_json::from_value(choices.clone()).map_err(|error| {
            ToolError::validation(format!("variantChoices is not valid: {error}"))
        })?;
    }
    if let Some(model) = value.get("imageModel") {
        keyframe.image_model = model
            .as_str()
            .map(str::to_string)
            .filter(|model| !model.trim().is_empty());
    }
    if let Some(references) = value.get("references") {
        keyframe.references = serde_json::from_value(references.clone())
            .map_err(|error| ToolError::validation(format!("references is not valid: {error}")))?;
    }
    if let Some(content) = value.get("content").and_then(Value::as_str) {
        keyframe.content = content.to_string();
    }
    if let Some(motion) = value.get("motion").and_then(Value::as_str) {
        keyframe.motion = if motion.trim().is_empty() {
            None
        } else {
            Some(motion.to_string())
        };
    }
    if let Some(duration) = value.get("durationMs").and_then(Value::as_i64) {
        keyframe.duration_ms = duration;
    }
    if let Some(dialogue) = value.get("dialogue").and_then(Value::as_array) {
        keyframe.dialogue = dialogue
            .iter()
            .map(|line| serde_json::from_value(line.clone()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ToolError::validation(format!("dialogue is not valid: {error}")))?;
    }
    // A line is known by an id because its reading is filed under one; a line
    // written from a caller that has no id yet gets one here, before any voice
    // take can be asked for against a name that would not exist.
    ensure_line_ids(&mut keyframe.dialogue);
    Ok(keyframe)
}

fn ensure_line_ids(lines: &mut [crate::domain::story::StoryDialogueLine]) {
    for line in lines {
        if line.id.as_deref().is_none_or(|id| id.trim().is_empty()) {
            line.id = Some(crate::domain::new_id());
        }
    }
}

fn keyframes(moka: &MokaFile, args: &Args<'_>, name: &str) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let chapter = chapter_of(story, args.req_str("chapterId")?)?;
    let act_id = args.req_str("actId")?;
    let mut acts = chapter.acts.clone();
    let act = acts
        .iter_mut()
        .find(|act| act.id == act_id)
        .ok_or_else(|| ToolError::new("ACT_NOT_FOUND", format!("act {act_id} does not exist")))?;
    match name {
        "story.replace_keyframes" => {
            args.confirmed()?;
            let list = args.req_array("keyframes")?;
            act.keyframes = list
                .iter()
                .map(|value| {
                    let id = value.get("id").and_then(Value::as_str);
                    let existing =
                        id.and_then(|id| act.keyframes.iter().find(|keyframe| keyframe.id == id));
                    keyframe_from(value, existing)
                })
                .collect::<Result<Vec<_>, _>>()?;
        }
        "story.add_keyframe" => {
            let value = args.raw("keyframe").cloned().unwrap_or_else(|| json!({}));
            let keyframe = keyframe_from(&value, None)?;
            let index = args
                .opt_i64("index")
                .map(|index| (index.max(0) as usize).min(act.keyframes.len()))
                .unwrap_or(act.keyframes.len());
            act.keyframes.insert(index, keyframe);
        }
        _ => {
            args.confirmed()?;
            let id = args.req_str("keyframeId")?;
            let index = act
                .keyframes
                .iter()
                .position(|keyframe| keyframe.id == id)
                .ok_or_else(|| {
                    ToolError::new("KEYFRAME_NOT_FOUND", format!("shot {id} does not exist"))
                })?;
            act.keyframes.remove(index);
        }
    }
    let count = act.keyframes.len();
    Ok(ToolOutcome::write(
        format!("{name}: {count} shots"),
        json!({"actId": act_id, "keyframes": count}),
        vec![DocumentCommand::SetStoryActs {
            story_id: story.id.clone(),
            chapter_id: chapter.id.clone(),
            acts,
        }],
    ))
}

fn update_keyframe(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let chapter = chapter_of(story, args.req_str("chapterId")?)?;
    let act_id = args.req_str("actId")?;
    let keyframe_id = args.req_str("keyframeId")?;
    let act = chapter
        .acts
        .iter()
        .find(|act| act.id == act_id)
        .ok_or_else(|| ToolError::new("ACT_NOT_FOUND", format!("act {act_id} does not exist")))?;
    act.keyframes
        .iter()
        .find(|keyframe| keyframe.id == keyframe_id)
        .ok_or_else(|| {
            ToolError::new(
                "KEYFRAME_NOT_FOUND",
                format!("shot {keyframe_id} does not exist"),
            )
        })?;
    let mut patch: StoryKeyframePatch = serde_json::from_value(
        args.raw("patch")
            .cloned()
            .ok_or_else(|| ToolError::validation("story.update_keyframe needs a patch"))?,
    )
    .map_err(|error| ToolError::validation(format!("patch is not valid: {error}")))?;
    if let Some(dialogue) = &mut patch.dialogue {
        ensure_line_ids(dialogue);
    }
    Ok(ToolOutcome::write(
        format!("Updated shot {keyframe_id}"),
        json!({"keyframeId": keyframe_id}),
        vec![DocumentCommand::UpdateStoryKeyframe {
            story_id: story.id.clone(),
            chapter_id: chapter.id.clone(),
            act_id: act_id.to_string(),
            keyframe_id: keyframe_id.to_string(),
            patch,
        }],
    ))
}

fn element_from(value: &Value, existing: Option<&StoryElement>) -> Result<StoryElement, ToolError> {
    let mut element = existing.cloned().unwrap_or_else(|| StoryElement {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(crate::domain::new_id),
        kind: parse_word("prop").expect("a known word"),
        name: String::new(),
        description: String::new(),
        chapter_ids: Vec::new(),
        main: empty_slot(),
        turnaround: None,
        variants: None,
        reference: None,
        voice: None,
        image_model: None,
        ratio: None,
    });
    if let Some(word) = value.get("kind").and_then(Value::as_str) {
        element.kind = parse_word(word)?;
    }
    if let Some(name) = value.get("name").and_then(Value::as_str) {
        element.name = name.to_string();
    }
    if let Some(description) = value.get("description").and_then(Value::as_str) {
        element.description = description.to_string();
    }
    if let Some(ids) = value.get("chapterIds").and_then(Value::as_array) {
        element.chapter_ids = ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    if let Some(voice) = value.get("voice") {
        element.voice = serde_json::from_value(voice.clone())
            .map_err(|error| ToolError::validation(format!("voice is not valid: {error}")))?;
    }
    if let Some(model) = value.get("imageModel") {
        element.image_model = model
            .as_str()
            .map(str::to_string)
            .filter(|model| !model.trim().is_empty());
    }
    if let Some(ratio) = value.get("ratio") {
        element.ratio = serde_json::from_value(ratio.clone())
            .map_err(|error| ToolError::validation(format!("ratio is not valid: {error}")))?;
    }
    if let Some(variants) = value.get("variants") {
        element.variants = serde_json::from_value(variants.clone())
            .map_err(|error| ToolError::validation(format!("variants is not valid: {error}")))?;
    }
    if let Some(reference) = value.get("reference") {
        element.reference = serde_json::from_value(reference.clone())
            .map_err(|error| ToolError::validation(format!("reference is not valid: {error}")))?;
    }
    Ok(element)
}

fn elements(moka: &MokaFile, args: &Args<'_>, name: &str) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let mut elements = story.elements.clone();
    match name {
        "story.replace_elements" => {
            args.confirmed()?;
            elements = args
                .req_array("elements")?
                .iter()
                .map(|value| {
                    let id = value.get("id").and_then(Value::as_str);
                    let existing =
                        id.and_then(|id| story.elements.iter().find(|element| element.id == id));
                    element_from(value, existing)
                })
                .collect::<Result<Vec<_>, _>>()?;
        }
        "story.add_element" => {
            let value = args.raw("element").cloned().unwrap_or_else(|| json!({}));
            elements.push(element_from(&value, None)?);
        }
        _ => {
            args.confirmed()?;
            let id = args.req_str("elementId")?;
            elements.retain(|element| element.id != id);
        }
    }
    Ok(ToolOutcome::write(
        format!("{name}: {} elements", elements.len()),
        json!({"elements": elements.len()}),
        vec![DocumentCommand::SetStoryElements {
            story_id: story.id.clone(),
            elements,
        }],
    ))
}

fn update_element(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let element_id = args.req_str("elementId")?;
    story
        .elements
        .iter()
        .find(|element| element.id == element_id)
        .ok_or_else(|| {
            ToolError::new(
                "ELEMENT_NOT_FOUND",
                format!("element {element_id} does not exist"),
            )
        })?;
    let patch: StoryElementPatch = serde_json::from_value(
        args.raw("patch")
            .cloned()
            .ok_or_else(|| ToolError::validation("story.update_element needs a patch"))?,
    )
    .map_err(|error| ToolError::validation(format!("patch is not valid: {error}")))?;
    Ok(ToolOutcome::write(
        format!("Updated element {element_id}"),
        json!({"elementId": element_id}),
        vec![DocumentCommand::UpdateStoryElement {
            story_id: story.id.clone(),
            element_id: element_id.to_string(),
            patch,
        }],
    ))
}

fn slot_of<'a>(story: &'a StoryDocument, target: &StorySlotTarget) -> Option<&'a StorySlot> {
    match target {
        StorySlotTarget::Element {
            element_id,
            view,
            variant_id,
        } => story
            .elements
            .iter()
            .find(|element| element.id == *element_id)
            .and_then(|element| match variant_id {
                Some(variant_id) => element
                    .variants
                    .iter()
                    .flatten()
                    .find(|form| form.id == *variant_id)
                    .map(|form| match view {
                        crate::domain::story::StoryElementView::Main => &form.main,
                        crate::domain::story::StoryElementView::Turnaround => {
                            form.turnaround.as_ref().unwrap_or(&form.main)
                        }
                    }),
                None => Some(match view {
                    crate::domain::story::StoryElementView::Main => &element.main,
                    crate::domain::story::StoryElementView::Turnaround => {
                        element.turnaround.as_ref().unwrap_or(&element.main)
                    }
                }),
            }),
        StorySlotTarget::Keyframe {
            chapter_id,
            act_id,
            keyframe_id,
        } => story
            .chapters
            .iter()
            .find(|chapter| chapter.id == *chapter_id)
            .and_then(|chapter| chapter.acts.iter().find(|act| act.id == *act_id))
            .and_then(|act| {
                act.keyframes
                    .iter()
                    .find(|keyframe| keyframe.id == *keyframe_id)
            })
            .map(|keyframe| &keyframe.art),
        StorySlotTarget::KeyframeVideo {
            chapter_id,
            act_id,
            keyframe_id,
        } => story
            .chapters
            .iter()
            .find(|chapter| chapter.id == *chapter_id)
            .and_then(|chapter| chapter.acts.iter().find(|act| act.id == *act_id))
            .and_then(|act| {
                act.keyframes
                    .iter()
                    .find(|keyframe| keyframe.id == *keyframe_id)
            })
            .map(|keyframe| &keyframe.video),
        StorySlotTarget::ActVideo { chapter_id, act_id } => story
            .chapters
            .iter()
            .find(|chapter| chapter.id == *chapter_id)
            .and_then(|chapter| chapter.acts.iter().find(|act| act.id == *act_id))
            .map(|act| &act.video),
        StorySlotTarget::ActVoice { chapter_id, act_id } => story
            .chapters
            .iter()
            .find(|chapter| chapter.id == *chapter_id)
            .and_then(|chapter| chapter.acts.iter().find(|act| act.id == *act_id))
            .and_then(|act| act.voice.as_ref()),
        StorySlotTarget::ActMusic { chapter_id, act_id } => story
            .chapters
            .iter()
            .find(|chapter| chapter.id == *chapter_id)
            .and_then(|chapter| chapter.acts.iter().find(|act| act.id == *act_id))
            .and_then(|act| act.music.as_ref()),
        StorySlotTarget::LineVoice {
            chapter_id,
            act_id,
            keyframe_id,
            line_id,
        } => story
            .chapters
            .iter()
            .find(|chapter| chapter.id == *chapter_id)
            .and_then(|chapter| chapter.acts.iter().find(|act| act.id == *act_id))
            .and_then(|act| {
                act.keyframes
                    .iter()
                    .find(|keyframe| keyframe.id == *keyframe_id)
            })
            .and_then(|keyframe| keyframe.voices.as_ref())
            .and_then(|voices| voices.iter().find(|take| take.line_id == *line_id))
            .map(|take| &take.slot),
    }
}

fn set_slot(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let target: StorySlotTarget = serde_json::from_value(
        args.raw("target")
            .cloned()
            .ok_or_else(|| ToolError::validation("story.set_slot needs target"))?,
    )
    .map_err(|error| ToolError::validation(format!("target is not valid: {error}")))?;
    let existing = slot_of(story, &target).cloned().unwrap_or_else(empty_slot);
    let action = args.req_str("action")?;
    let mut slot = existing.clone();
    let mut warnings = Vec::new();
    match action {
        "append" => {
            let take = match args.raw("take") {
                Some(take) => {
                    let mut take = take.clone();
                    if take.get("createdAt").is_none() {
                        take["createdAt"] = json!(now_iso());
                    }
                    serde_json::from_value::<StoryTake>(take).map_err(|error| {
                        ToolError::validation(format!("take is not valid: {error}"))
                    })?
                }
                None => StoryTake {
                    asset_ids: args.req_strings("assetIds")?,
                    job_id: None,
                    item_id: None,
                    note: None,
                    in_ms: None,
                    out_ms: None,
                    created_at: now_iso(),
                },
            };
            if take.asset_ids.is_empty() || take.asset_ids.len() > 9 {
                return Err(ToolError::validation("a take carries one to nine assets"));
            }
            for asset_id in &take.asset_ids {
                if moka.resources.find(asset_id).is_none() {
                    return Err(ToolError::new(
                        "ASSET_NOT_FOUND",
                        format!("asset {asset_id} is not in this project"),
                    ));
                }
            }
            // A take appended beside the current one keeps the current take
            // last; appending it and then trying to put the old one back would
            // leave two copies of the old take instead of one new take.
            let previous_last = if args.opt_bool("makeCurrent", true) {
                None
            } else {
                slot.takes.pop()
            };
            slot.takes.push(take.clone());
            if let Some(previous) = previous_last {
                slot.takes.push(previous);
            }
            if slot.takes.len() > crate::domain::story::MAX_TAKES_PER_SLOT {
                slot.takes.remove(0);
                warnings.push("the oldest take was dropped to stay within 12".to_string());
            }
        }
        "select" => {
            let index = match args.opt_i64("takeIndex") {
                Some(index) => index.max(0) as usize,
                None => {
                    let asset_id = args.req_str("assetId")?;
                    slot.takes
                        .iter()
                        .position(|take| take.asset_ids.iter().any(|id| id == asset_id))
                        .ok_or_else(|| {
                            ToolError::new("TAKE_NOT_FOUND", "no take holds that asset")
                        })?
                }
            };
            if index >= slot.takes.len() {
                return Err(ToolError::new(
                    "TAKE_NOT_FOUND",
                    "that take index does not exist",
                ));
            }
            let take = slot.takes.remove(index);
            slot.takes.push(take);
        }
        "drop" => {
            let index = args
                .opt_i64("takeIndex")
                .map(|index| index.max(0) as usize)
                .ok_or_else(|| ToolError::validation("drop needs takeIndex"))?;
            if index + 1 >= slot.takes.len() {
                return Err(ToolError::validation(
                    "the current take cannot be dropped; select another first",
                ));
            }
            slot.takes.remove(index);
        }
        other => {
            return Err(ToolError::validation(format!(
                "action '{other}' is not append, select, or drop"
            )))
        }
    }
    let take_count = slot.takes.len();
    let current = slot.takes.last().cloned();
    Ok(ToolOutcome {
        summary: format!("{action} on a story slot ({take_count} takes)"),
        data: json!({"takeCount": take_count, "current": current}),
        warnings,
        commands: vec![DocumentCommand::SetStorySlot {
            story_id: story.id.clone(),
            target,
            slot,
            read: None,
        }],
        ..ToolOutcome::default()
    })
}

fn update_voice(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let target = args
        .opt_object("target")
        .ok_or_else(|| ToolError::validation("story.update_voice needs target"))?;
    let voice = match args.raw("voice") {
        Some(Value::Null) | None => None,
        Some(value) => Some(
            serde_json::from_value::<StoryVoiceProfile>(value.clone())
                .map_err(|error| ToolError::validation(format!("voice is not valid: {error}")))?,
        ),
    };
    let kind = target
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("element");
    match kind {
        "narrator" => Ok(ToolOutcome::write(
            "Updated the narrator voice",
            json!({"target": "narrator"}),
            vec![DocumentCommand::UpdateStoryNarrator {
                story_id: story.id.clone(),
                narrator: voice,
            }],
        )),
        "element" => {
            let element_id = target
                .get("elementId")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::validation("the voice target needs elementId"))?;
            let patch: StoryElementPatch = serde_json::from_value(json!({"voice": voice}))
                .map_err(|error| ToolError::validation(error.to_string()))?;
            Ok(ToolOutcome::write(
                format!("Updated the voice of {element_id}"),
                json!({"elementId": element_id}),
                vec![DocumentCommand::UpdateStoryElement {
                    story_id: story.id.clone(),
                    element_id: element_id.to_string(),
                    patch,
                }],
            ))
        }
        other => Err(ToolError::validation(format!(
            "voice target '{other}' is not narrator or element"
        ))),
    }
}

fn parse_step(word: &str) -> Result<crate::domain::story::StoryStep, ToolError> {
    use crate::domain::story::StoryStep;
    match word {
        "idea" => Ok(StoryStep::Idea),
        "outline" => Ok(StoryStep::Outline),
        "elements" => Ok(StoryStep::Elements),
        "storyboard" => Ok(StoryStep::Storyboard),
        "edit" => Ok(StoryStep::Edit),
        other => Err(ToolError::validation(format!(
            "'{other}' is not a story step"
        ))),
    }
}

fn step_word(step: &crate::domain::story::StoryStep) -> &'static str {
    use crate::domain::story::StoryStep;
    match step {
        StoryStep::Idea => "idea",
        StoryStep::Outline => "outline",
        StoryStep::Elements => "elements",
        StoryStep::Storyboard => "storyboard",
        StoryStep::Edit => "edit",
    }
}

fn readiness(story: &StoryDocument) -> (Value, Vec<Value>) {
    use crate::domain::story::StoryShotGranularity;
    let mut gaps = Vec::new();
    let idea_ok =
        story.brief.idea.trim().chars().count() >= 10 || story.brief.source_asset_id.is_some();

    let outline_ok = !story.chapters.is_empty()
        && story
            .chapters
            .iter()
            .all(|chapter| !chapter.title.trim().is_empty() && !chapter.synopsis.trim().is_empty());
    if !outline_ok {
        if story.chapters.is_empty() {
            gaps.push(json!({"step": "outline", "kind": "noChapters", "message": "the outline has no chapters"}));
        } else {
            let numbers: Vec<usize> = story
                .chapters
                .iter()
                .enumerate()
                .filter(|(_, chapter)| {
                    chapter.title.trim().is_empty() || chapter.synopsis.trim().is_empty()
                })
                .map(|(at, _)| at + 1)
                .collect();
            gaps.push(json!({"step": "outline", "kind": "chaptersUnwritten", "numbers": numbers, "message": "some chapters have no title or words"}));
        }
    }

    let elements_ok = !story.elements.is_empty()
        && story.elements.iter().all(|element| {
            !element.name.trim().is_empty() && !element.description.trim().is_empty()
        });
    if !elements_ok {
        if story.elements.is_empty() {
            gaps.push(
                json!({"step": "elements", "kind": "noElements", "message": "the cast is empty"}),
            );
        } else {
            let names: Vec<&str> = story
                .elements
                .iter()
                .filter(|element| {
                    element.name.trim().is_empty() || element.description.trim().is_empty()
                })
                .map(|element| element.name.as_str())
                .collect();
            gaps.push(json!({"step": "elements", "kind": "elementsUndescribed", "names": names, "message": "some elements have no description"}));
        }
    }

    let acts: Vec<&crate::domain::story::StoryAct> = story
        .chapters
        .iter()
        .flat_map(|chapter| chapter.acts.iter())
        .collect();
    let mut board_ok = !acts.is_empty();
    if acts.is_empty() {
        gaps.push(
            json!({"step": "storyboard", "kind": "noActs", "message": "no chapter has acts"}),
        );
    } else {
        let bare = acts
            .iter()
            .filter(|act| act.transition.is_none() && act.keyframes.is_empty())
            .count();
        if bare > 0 {
            board_ok = false;
            gaps.push(json!({"step": "storyboard", "kind": "actsWithoutShots", "count": bare, "message": format!("{bare} acts have no shots")}));
        }
        let frames = acts
            .iter()
            .flat_map(|act| act.keyframes.iter())
            .filter(|keyframe| keyframe.art.takes.is_empty() && !keyframe.art_not_needed)
            .count();
        if frames > 0 {
            board_ok = false;
            gaps.push(json!({"step": "storyboard", "kind": "framesMissing", "count": frames, "message": format!("{frames} shots have no picture")}));
        }
        let clips = acts
            .iter()
            .filter(|act| {
                if act.transition.is_some() {
                    return act.video.takes.is_empty();
                }
                match act.shot_granularity.unwrap_or(story.shot_granularity) {
                    StoryShotGranularity::Keyframe => {
                        act.keyframes.is_empty()
                            || act
                                .keyframes
                                .iter()
                                .any(|keyframe| keyframe.video.takes.is_empty())
                    }
                    StoryShotGranularity::Act => act.video.takes.is_empty(),
                }
            })
            .count();
        if clips > 0 {
            board_ok = false;
            gaps.push(json!({"step": "storyboard", "kind": "clipsMissing", "count": clips, "message": format!("{clips} acts are missing a clip")}));
        }
        let shots = acts
            .iter()
            .filter(|act| {
                act.transition.is_none()
                    && act.shot_granularity.unwrap_or(story.shot_granularity)
                        == StoryShotGranularity::Keyframe
            })
            .flat_map(|act| act.keyframes.iter())
            .filter(|keyframe| keyframe.video.takes.is_empty())
            .count();
        if shots > 0 {
            board_ok = false;
            gaps.push(json!({"step": "storyboard", "kind": "shotsMissing", "count": shots, "message": format!("{shots} shots have no clip")}));
        }
    }

    let edit_ok = story.edit.timeline_id.is_some();
    if !edit_ok {
        gaps.push(json!({"step": "edit", "kind": "noTimeline", "message": "the story has no assembled timeline"}));
    }
    let ready = json!({
        "idea": idea_ok,
        "outline": outline_ok,
        "elements": elements_ok,
        "storyboard": board_ok,
        "edit": edit_ok,
    });
    (ready, gaps)
}

fn confirm_step(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let step = parse_step(args.req_str("step")?)?;
    if story.confirmed_steps.contains(&step) {
        return Ok(ToolOutcome::read(
            "that step is already confirmed",
            json!({"confirmedSteps": story.confirmed_steps, "alreadyConfirmed": true}),
        ));
    }
    let (ready, gaps) = readiness(story);
    let key = step_word(&step);
    if ready[key] != true {
        return Err(ToolError::new("STEP_GAPS", format!("{key} still has gaps"))
            .details(json!({"gaps": gaps, "ready": ready})));
    }
    let index = [
        crate::domain::story::StoryStep::Idea,
        crate::domain::story::StoryStep::Outline,
        crate::domain::story::StoryStep::Elements,
        crate::domain::story::StoryStep::Storyboard,
        crate::domain::story::StoryStep::Edit,
    ]
    .iter()
    .position(|candidate| candidate == &step)
    .unwrap_or(0);
    if index > 0 {
        let previous = [
            crate::domain::story::StoryStep::Idea,
            crate::domain::story::StoryStep::Outline,
            crate::domain::story::StoryStep::Elements,
            crate::domain::story::StoryStep::Storyboard,
            crate::domain::story::StoryStep::Edit,
        ][index - 1];
        if !story.confirmed_steps.contains(&previous) {
            return Err(ToolError::new(
                "STEP_GAPS",
                format!("{} must be confirmed first", step_word(&previous)),
            ));
        }
    }
    let mut commands = vec![DocumentCommand::ConfirmStoryStep {
        story_id: story.id.clone(),
        step,
        confirmed: true,
    }];
    // The room settles an outline by locking it as well; a confirmation that
    // left the words open would be a step settled in name only.
    if step == crate::domain::story::StoryStep::Outline {
        let chapters = story
            .chapters
            .iter()
            .cloned()
            .map(|mut chapter| {
                chapter.outline_locked = true;
                chapter
            })
            .collect();
        commands.push(DocumentCommand::SetStoryChapters {
            story_id: story.id.clone(),
            chapters,
        });
    }
    let mut confirmed = story.confirmed_steps.clone();
    if !confirmed.contains(&step) {
        confirmed.push(step);
    }
    Ok(ToolOutcome::write(
        format!("Confirmed {key}"),
        json!({"confirmedSteps": confirmed, "step": key}),
        commands,
    ))
}

fn selected_acts<'a>(
    story: &'a StoryDocument,
    chapter_id: Option<&str>,
    act_id: Option<&str>,
) -> Result<Vec<(&'a StoryChapter, &'a StoryAct)>, ToolError> {
    let mut selected = Vec::new();
    let mut chapter_found = chapter_id.is_none();
    for chapter in &story.chapters {
        if let Some(id) = chapter_id {
            if chapter.id != id {
                continue;
            }
            chapter_found = true;
        }
        for act in &chapter.acts {
            if let Some(id) = act_id {
                if act.id != id {
                    continue;
                }
            }
            selected.push((chapter, act));
        }
    }
    if !chapter_found {
        return Err(ToolError::new(
            "CHAPTER_NOT_FOUND",
            format!("chapter {} does not exist", chapter_id.unwrap_or_default()),
        ));
    }
    if act_id.is_some() && selected.is_empty() {
        return Err(ToolError::new(
            "ACT_NOT_FOUND",
            format!("act {} does not exist", act_id.unwrap_or_default()),
        ));
    }
    Ok(selected)
}

fn board_report(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let chapter_id = args.opt_str("chapterId");
    let act_id = args.opt_str("actId");
    let selected = selected_acts(story, chapter_id, act_id)?;

    let mut chapter_order: Vec<&StoryChapter> = Vec::new();
    for (chapter, _) in &selected {
        if !chapter_order.iter().any(|held| held.id == chapter.id) {
            chapter_order.push(chapter);
        }
    }

    let mut acts = Vec::new();
    let mut shots = Vec::new();
    let mut missing_art = 0_usize;
    let mut missing_shot_video = 0_usize;
    let mut missing_voice = 0_usize;
    let mut missing_music = 0_usize;
    let mut missing_act_video = 0_usize;
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (chapter, act) in &selected {
        used.extend(act.character_ids.iter().cloned());
        used.extend(act.scene_id.iter().cloned());
        used.extend(act.prop_ids.iter().cloned());
        let planned_ms: i64 = act
            .keyframes
            .iter()
            .map(|keyframe| keyframe.duration_ms)
            .sum();
        let per_shot = act.shot_granularity.unwrap_or(story.shot_granularity)
            == crate::domain::story::StoryShotGranularity::Keyframe;
        let has_act_video = !current_assets(&act.video).is_empty();
        if !per_shot && !has_act_video {
            missing_act_video += 1;
        }
        let mut act_missing_art = 0_usize;
        let mut act_missing_video = 0_usize;
        let mut act_missing_voice = 0_usize;
        for keyframe in &act.keyframes {
            let art = current_assets(&keyframe.art).first().cloned();
            let video = current_assets(&keyframe.video).first().cloned();
            let missing = art.is_none() && !keyframe.art_not_needed;
            if missing {
                act_missing_art += 1;
            }
            let missing_video = per_shot && video.is_none();
            if missing_video {
                act_missing_video += 1;
            }
            let spoken = keyframe
                .dialogue
                .iter()
                .filter(|line| !line.text.trim().is_empty())
                .count();
            let voiced = keyframe
                .dialogue
                .iter()
                .filter(|line| line_voice_exists(keyframe, line.id.as_deref()))
                .count();
            act_missing_voice += spoken.saturating_sub(voiced);
            for name in mentioned_names(&keyframe.content) {
                if let Some(element) = story.elements.iter().find(|element| element.name == name) {
                    used.insert(element.id.clone());
                }
            }
            let (content, content_truncated, content_length) =
                shortened(&keyframe.content, 2_000, false);
            shots.push(json!({
                "id": keyframe.id,
                "chapterId": chapter.id,
                "actId": act.id,
                "title": keyframe.title,
                "shotSize": keyframe.shot_size,
                "cameraMove": keyframe.camera_move,
                "angle": keyframe.angle,
                "filmRole": keyframe.film_role,
                "durationMs": keyframe.duration_ms,
                "content": content,
                "contentTruncated": content_truncated,
                "contentLength": content_length,
                "art": art,
                "video": video,
                "missingArt": missing,
                "missingVideo": missing_video,
                "dialogueLines": spoken,
                "voicedLines": voiced,
                "missingVoice": spoken.saturating_sub(voiced),
                "artNotNeeded": keyframe.art_not_needed,
            }));
        }
        let sound = [
            act.sound.music.trim(),
            act.sound.sfx.trim(),
            act.sound.ambience.as_deref().unwrap_or("").trim(),
        ]
        .into_iter()
        .any(|part| !part.is_empty());
        let has_music = act
            .music
            .as_ref()
            .is_some_and(|slot| !current_assets(slot).is_empty());
        if sound && !has_music {
            missing_music += 1;
        }
        missing_art += act_missing_art;
        missing_shot_video += act_missing_video;
        missing_voice += act_missing_voice;
        acts.push(json!({
            "id": act.id,
            "chapterId": chapter.id,
            "title": act.title,
            "summary": shortened(&act.summary, 2_000, false).0,
            "shotCount": act.keyframes.len(),
            "plannedMs": planned_ms,
            "missingArt": act_missing_art,
            "missingShotVideo": act_missing_video,
            "missingVoice": act_missing_voice,
            "missingMusic": sound && !has_music,
            "actVideo": current_assets(&act.video).first().cloned(),
            "music": act.music.as_ref().and_then(|slot| current_assets(slot).first().cloned()),
            "transition": act.transition.is_some(),
        }));
    }

    let chapters: Vec<Value> = chapter_order
        .iter()
        .map(|chapter| {
            let acts = selected
                .iter()
                .filter(|(held, _)| held.id == chapter.id)
                .map(|(_, act)| *act)
                .collect::<Vec<_>>();
            let planned_ms: i64 = acts
                .iter()
                .flat_map(|act| act.keyframes.iter())
                .map(|keyframe| keyframe.duration_ms)
                .sum();
            json!({
                "id": chapter.id,
                "title": chapter.title,
                "targetDurationMs": chapter.target_duration_ms,
                "plannedMs": planned_ms,
                "actCount": acts.len(),
                "shotCount": acts.iter().map(|act| act.keyframes.len()).sum::<usize>(),
                "confirmed": story.confirmed_steps,
            })
        })
        .collect();

    let target_ms: i64 = chapter_order
        .iter()
        .map(|chapter| chapter.target_duration_ms)
        .sum();
    let planned_ms: i64 = shots
        .iter()
        .filter_map(|shot| shot.get("durationMs").and_then(Value::as_i64))
        .sum();

    let mut warnings = Vec::new();
    for chapter in &chapter_order {
        if chapter.target_duration_ms > 0 {
            let planned: i64 = selected
                .iter()
                .filter(|(held, _)| held.id == chapter.id)
                .flat_map(|(_, act)| act.keyframes.iter())
                .map(|keyframe| keyframe.duration_ms)
                .sum();
            let target = chapter.target_duration_ms;
            if (planned - target).abs() * 100 > target * 15 {
                warnings.push(format!(
                    "{} is planned for {} against a target of {}",
                    chapter.title,
                    format_duration(planned),
                    format_duration(target)
                ));
            }
        }
        if selected
            .iter()
            .filter(|(held, _)| held.id == chapter.id)
            .all(|(_, act)| act.keyframes.is_empty())
        {
            warnings.push(format!("{} has no shots", chapter.title));
        }
    }
    if missing_art > 0 {
        warnings.push(format!("{missing_art} shots still need a picture"));
    }
    if missing_shot_video > 0 {
        warnings.push(format!(
            "{missing_shot_video} shots have no clip of their own"
        ));
    }
    if missing_act_video > 0 {
        warnings.push(format!("{missing_act_video} acts have no clip"));
    }
    if missing_voice > 0 {
        warnings.push(format!("{missing_voice} spoken lines have no reading"));
    }
    if missing_music > 0 {
        warnings.push(format!("{missing_music} acts have sound but no score"));
    }
    if !story
        .confirmed_steps
        .contains(&crate::domain::story::StoryStep::Storyboard)
    {
        warnings.push("the storyboard step is not confirmed".to_string());
    }

    let elements: Vec<Value> = story
        .elements
        .iter()
        .filter(|element| {
            chapter_id.is_none()
                || used.contains(&element.id)
                || chapter_order
                    .iter()
                    .any(|chapter| element.chapter_ids.contains(&chapter.id))
        })
        .map(|element| {
            let main = current_assets(&element.main).first().cloned();
            let turnaround = element
                .turnaround
                .as_ref()
                .and_then(|slot| current_assets(slot).first().cloned());
            json!({
                "id": element.id,
                "kind": element.kind,
                "name": element.name,
                "chapterIds": element.chapter_ids,
                "main": main,
                "turnaround": turnaround,
                "complete": element.kind.as_str() != "character"
                    || (main.is_some() && turnaround.is_some()),
            })
        })
        .collect();

    Ok(ToolOutcome::read(
        format!("board report: {} acts, {} shots", acts.len(), shots.len()),
        json!({
            "storyId": story.id,
            "chapters": chapters,
            "acts": acts,
            "shots": shots,
            "elements": elements,
            "totals": {
                "chapters": chapter_order.len(),
                "acts": acts.len(),
                "shots": shots.len(),
                "plannedMs": planned_ms,
                "targetDurationMs": target_ms,
                "missingArt": missing_art,
                "missingShotVideo": missing_shot_video,
                "missingActVideo": missing_act_video,
                "missingVoice": missing_voice,
                "missingMusic": missing_music,
            },
            "warnings": warnings,
        }),
    ))
}

fn dubbing_report(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let chapter_id = args.opt_str("chapterId");
    let act_id = args.opt_str("actId");
    let selected = selected_acts(story, chapter_id, act_id)?;
    let mut lines = Vec::new();
    let mut missing = 0_usize;
    let mut overrun = 0_usize;
    let mut total_overrun = 0_i64;
    for (chapter, act) in &selected {
        for keyframe in &act.keyframes {
            for line in &keyframe.dialogue {
                if line.text.trim().is_empty() {
                    continue;
                }
                let voice = line.id.as_deref().and_then(|line_id| {
                    keyframe
                        .voices
                        .as_ref()
                        .and_then(|voices| voices.iter().find(|voice| voice.line_id == line_id))
                });
                let asset = voice
                    .and_then(|voice| voice.slot.takes.last())
                    .and_then(|take| take.asset_ids.first());
                let text_ms = asset
                    .and_then(|asset_id| moka.resources.find(asset_id))
                    .and_then(|entry| entry.probe.as_ref())
                    .and_then(|probe| probe.duration_ms);
                let shot_ms = keyframe.duration_ms;
                let over = text_ms.map(|ms| (ms - shot_ms).max(0)).unwrap_or(0);
                let fits = text_ms.map(|ms| ms <= shot_ms);
                if text_ms.is_none() {
                    missing += 1;
                }
                if over > 0 {
                    overrun += 1;
                    total_overrun += over;
                }
                lines.push(json!({
                    "chapterId": chapter.id,
                    "actId": act.id,
                    "keyframeId": keyframe.id,
                    "lineId": line.id,
                    "speaker": line.speaker,
                    "text": shortened(&line.text, 500, false).0,
                    "shotMs": shot_ms,
                    "textMs": text_ms,
                    "overrunMs": over,
                    "fits": fits,
                    "missing": text_ms.is_none(),
                }));
            }
        }
    }
    let mut warnings = Vec::new();
    if missing > 0 {
        warnings.push(format!("{missing} spoken lines have no reading"));
    }
    if overrun > 0 {
        warnings.push(format!(
            "{overrun} lines run past their shot by {} in all",
            format_duration(total_overrun)
        ));
    }
    Ok(ToolOutcome::read(
        format!("dubbing report: {} lines", lines.len()),
        json!({
            "storyId": story.id,
            "lines": lines,
            "totals": {
                "lines": lines.len(),
                "missing": missing,
                "overrun": overrun,
                "totalOverrunMs": total_overrun,
            },
            "warnings": warnings,
        }),
    ))
}

fn line_voice_exists(keyframe: &StoryKeyframe, line_id: Option<&str>) -> bool {
    let Some(line_id) = line_id else {
        return false;
    };
    keyframe.voices.as_ref().is_some_and(|voices| {
        voices
            .iter()
            .any(|voice| voice.line_id == line_id && !current_assets(&voice.slot).is_empty())
    })
}

fn mentioned_names(content: &str) -> Vec<String> {
    let chars: Vec<char> = content.chars().collect();
    let mut names = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        if chars[at] == '`' {
            if let Some(close) = chars[at + 1..].iter().position(|ch| *ch == '`') {
                let end = at + 1 + close;
                let name: String = chars[at + 1..end].iter().collect();
                let name = name.trim().to_string();
                if !name.is_empty() {
                    names.push(name);
                }
                at = end + 1;
                continue;
            }
        }
        at += 1;
    }
    names
}

fn format_duration(ms: i64) -> String {
    let total = (ms.max(0) as f64 / 1000.0).round() as i64;
    let seconds = total % 60;
    let minutes = (total / 60) % 60;
    let hours = total / 3600;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn set_prompt(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    use crate::domain::story::StoryPromptOverride;
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let kind = args.req_str("kind")?;
    let raw = args
        .raw("prompts")
        .and_then(Value::as_object)
        .ok_or_else(|| ToolError::validation("story.set_prompt needs a prompts object"))?;
    let mut prompts = std::collections::BTreeMap::new();
    for (ask_id, value) in raw {
        if value.is_null() {
            prompts.insert(ask_id.clone(), None);
            continue;
        }
        let prompt = value
            .get("prompt")
            .and_then(Value::as_str)
            .or_else(|| value.as_str())
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
            .ok_or_else(|| ToolError::validation(format!("prompt {ask_id} has no words")))?;
        let auto = value
            .get("auto")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        prompts.insert(
            ask_id.clone(),
            Some(StoryPromptOverride {
                prompt: prompt.to_string(),
                auto,
            }),
        );
    }
    let command = match kind {
        "image" => DocumentCommand::SetStoryImagePromptOverrides {
            story_id: story.id.clone(),
            prompts,
        },
        "video" => DocumentCommand::SetStoryVideoPromptOverrides {
            story_id: story.id.clone(),
            prompts,
        },
        other => {
            return Err(ToolError::validation(format!(
                "prompt kind '{other}' is image or video"
            )))
        }
    };
    Ok(ToolOutcome::write(
        format!("Wrote {kind} prompts"),
        json!({"storyId": story.id, "kind": kind}),
        vec![command],
    ))
}

fn import_canvas(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    use crate::domain::NodeKind;
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let name = args.opt_str("name").unwrap_or(&story.name).to_string();
    let mut canvas = crate::domain::CanvasDocument::empty(crate::domain::new_id(), name.clone());
    let mut premise_at = 0.0;
    let premise = if story.brief.idea.trim().is_empty() {
        None
    } else {
        Some(card(
            &mut canvas,
            0.0,
            &mut premise_at,
            NodeKind::Text,
            "Premise".into(),
            Some(story.brief.idea.clone()),
            None,
        ))
    };
    let mut element_at = 0.0;
    for element in &story.elements {
        let text = card(
            &mut canvas,
            1.0,
            &mut element_at,
            NodeKind::Text,
            element.name.clone(),
            Some(element.description.clone()),
            None,
        );
        if let Some(asset_id) = current_assets(&element.main).first().cloned() {
            let image = card(
                &mut canvas,
                2.0,
                &mut element_at,
                NodeKind::Image,
                element.name.clone(),
                None,
                Some(asset_id),
            );
            connect(&mut canvas, &text, &image);
        }
        if let Some(turnaround) = element
            .turnaround
            .as_ref()
            .and_then(|slot| current_assets(slot).first().cloned())
        {
            let image = card(
                &mut canvas,
                2.0,
                &mut element_at,
                NodeKind::Image,
                format!("{} turn-around", element.name),
                None,
                Some(turnaround),
            );
            connect(&mut canvas, &text, &image);
        }
    }
    let mut chapter_at = 0.0;
    for (chapter_index, chapter) in story.chapters.iter().enumerate() {
        let chapter_card = card(
            &mut canvas,
            3.0,
            &mut chapter_at,
            NodeKind::Text,
            format!("{} {}", chapter_index + 1, chapter.title),
            Some(chapter.synopsis.clone()),
            None,
        );
        if let Some(premise) = &premise {
            connect(&mut canvas, premise, &chapter_card);
        }
        let mut act_at = chapter_at;
        for act in &chapter.acts {
            let act_card = card(
                &mut canvas,
                4.0,
                &mut act_at,
                NodeKind::Text,
                act.title.clone(),
                Some(act.summary.clone()),
                None,
            );
            connect(&mut canvas, &chapter_card, &act_card);
            if act.transition.is_none() {
                let mut shot_at = act_at;
                for keyframe in &act.keyframes {
                    let shot_card = card(
                        &mut canvas,
                        5.0,
                        &mut shot_at,
                        NodeKind::Text,
                        keyframe.title.clone(),
                        Some(keyframe.content.clone()),
                        None,
                    );
                    connect(&mut canvas, &act_card, &shot_card);
                    if let Some(asset_id) = current_assets(&keyframe.art).first().cloned() {
                        let image = card(
                            &mut canvas,
                            6.0,
                            &mut shot_at,
                            NodeKind::Image,
                            keyframe.title.clone(),
                            None,
                            Some(asset_id),
                        );
                        connect(&mut canvas, &shot_card, &image);
                    }
                    if let Some(asset_id) = current_assets(&keyframe.video).first().cloned() {
                        let video = card(
                            &mut canvas,
                            7.0,
                            &mut shot_at,
                            NodeKind::Video,
                            keyframe.title.clone(),
                            None,
                            Some(asset_id),
                        );
                        connect(&mut canvas, &shot_card, &video);
                    }
                }
            }
            if let Some(asset_id) = current_assets(&act.video).first().cloned() {
                let video = card(
                    &mut canvas,
                    7.0,
                    &mut act_at,
                    NodeKind::Video,
                    act.title.clone(),
                    None,
                    Some(asset_id),
                );
                connect(&mut canvas, &act_card, &video);
            }
        }
        chapter_at = chapter_at.max(act_at);
    }
    let canvas_id = canvas.id.clone();
    Ok(ToolOutcome::write(
        format!("Imported the story into canvas {name}"),
        json!({"canvasId": canvas_id, "nodes": canvas.nodes.len(), "edges": canvas.edges.len()}),
        vec![DocumentCommand::AddCanvas {
            canvas,
            index: None,
        }],
    ))
}

fn card(
    canvas: &mut crate::domain::CanvasDocument,
    column: f64,
    at: &mut f64,
    kind: crate::domain::NodeKind,
    title: String,
    content: Option<String>,
    asset_id: Option<String>,
) -> String {
    let mut node = make_node(kind, title, column * 400.0, *at);
    node.data.content = content;
    node.data.asset_id = asset_id;
    let id = node.id.clone();
    canvas.nodes.push(node);
    *at += 260.0;
    id
}

fn connect(canvas: &mut crate::domain::CanvasDocument, from: &str, to: &str) {
    let source = crate::domain::EdgeEndpoint {
        node_id: from.to_string(),
        port_id: "out".into(),
    };
    let target = crate::domain::EdgeEndpoint {
        node_id: to.to_string(),
        port_id: "prompt".into(),
    };
    if crate::domain::validate::validate_edge_candidate(canvas, &source, &target).is_err() {
        return;
    }
    canvas.edges.push(crate::domain::WorkflowEdge {
        id: crate::domain::new_id(),
        source,
        target,
        created_at: now_iso(),
    });
}

fn assemble(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let timeline_id = args.opt_str("timelineId").map(str::to_string);
    let timeline_name = args.opt_str("timelineName").unwrap_or("Story").to_string();
    let with_subtitles = args.opt_bool("withSubtitles", false);
    let settings = timeline_settings(story);
    let frame_width = settings.width;
    let frame_height = settings.height;
    let now = now_iso();
    let video_track = crate::domain::new_id();
    let mut tracks: Vec<TimelineTrack> = vec![TimelineTrack {
        id: video_track.clone(),
        kind: TrackKind::Video,
        name: "V1".into(),
        muted: false,
        hidden: false,
        locked: false,
        created_at: now.clone(),
    }];
    let mut clips: Vec<TimelineClip> = Vec::new();
    let mut edit_clips: Vec<StoryEditClip> = Vec::new();
    let mut digest_units: Vec<(String, Option<String>, i64, i64, String)> = Vec::new();
    let mut starts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut shots: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
    let mut cursor = 0_i64;

    for chapter in &story.chapters {
        for act in &chapter.acts {
            starts.entry(act.id.clone()).or_insert(cursor);
            let units = assembly_units(act, &story.shot_granularity, moka, cursor);
            for unit in units {
                if let Some(keyframe_id) = &unit.keyframe_id {
                    shots.insert(
                        format!("{}:{}", act.id, keyframe_id),
                        (unit.start_ms, unit.duration_ms),
                    );
                }
                digest_units.push((
                    act.id.clone(),
                    unit.keyframe_id.clone(),
                    unit.start_ms,
                    unit.duration_ms,
                    unit.asset_id.clone(),
                ));
                let clip_id = crate::domain::new_id();
                edit_clips.push(StoryEditClip {
                    act_id: act.id.clone(),
                    keyframe_id: unit.keyframe_id.clone(),
                    clip_id: clip_id.clone(),
                });
                clips.push(TimelineClip {
                    id: clip_id,
                    track_id: video_track.clone(),
                    kind: TrackKind::Video,
                    label: act.title.clone(),
                    start_ms: unit.start_ms,
                    duration_ms: unit.duration_ms.max(100),
                    in_point_ms: unit.in_point_ms,
                    out_point_ms: unit.out_point_ms,
                    speed: 1.0,
                    volume: 1.0,
                    fade_in_ms: 0,
                    fade_out_ms: 0,
                    muted: false,
                    opacity: 1.0,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    asset_id: Some(unit.asset_id),
                    adjust: None,
                    filter: None,
                    text: None,
                });
                cursor = cursor.max(unit.start_ms + unit.duration_ms);
            }
        }
    }
    if clips.is_empty() {
        return Err(ToolError::new(
            "STEP_GAPS",
            "there is nothing with a picture or a shot to assemble",
        ));
    }

    let voice_rows = story.chapters.iter().any(|chapter| {
        chapter.acts.iter().any(|act| {
            act.voice
                .as_ref()
                .is_some_and(|slot| !slot.takes.is_empty())
                || act.keyframes.iter().any(|keyframe| {
                    keyframe.voices.as_ref().is_some_and(|voices| {
                        voices.iter().any(|voice| !voice.slot.takes.is_empty())
                    })
                })
        })
    });
    let music_rows = story.chapters.iter().any(|chapter| {
        chapter.acts.iter().any(|act| {
            act.music
                .as_ref()
                .is_some_and(|slot| !slot.takes.is_empty())
        })
    });
    let voice_track = voice_rows.then(crate::domain::new_id);
    let music_track = music_rows.then(crate::domain::new_id);
    if let Some(track_id) = &voice_track {
        tracks.push(audio_track(track_id, "Voice", &now));
    }
    if let Some(track_id) = &music_track {
        tracks.push(audio_track(track_id, "Music", &now));
    }

    for chapter in &story.chapters {
        for act in &chapter.acts {
            let Some(act_start) = starts.get(&act.id).copied() else {
                continue;
            };
            let per_line = act.keyframes.iter().any(|keyframe| {
                keyframe
                    .voices
                    .as_ref()
                    .is_some_and(|voices| voices.iter().any(|voice| !voice.slot.takes.is_empty()))
            });
            if let Some(track_id) = &voice_track {
                if per_line {
                    for keyframe in &act.keyframes {
                        let window = shots
                            .get(&format!("{}:{}", act.id, keyframe.id))
                            .copied()
                            .unwrap_or((act_start, keyframe.duration_ms));
                        let voices = keyframe.voices.as_deref().unwrap_or_default();
                        for voice in voices {
                            let Some(take) = voice.slot.takes.last() else {
                                continue;
                            };
                            for asset_id in &take.asset_ids {
                                if moka.resources.find(asset_id).is_none() {
                                    continue;
                                }
                                let duration = resource_duration(moka, asset_id)
                                    .unwrap_or(window.1)
                                    .max(100);
                                clips
                                    .push(audio_clip(track_id, asset_id, window.0, duration, &now));
                                edit_clips.push(StoryEditClip {
                                    act_id: act.id.clone(),
                                    keyframe_id: Some(keyframe.id.clone()),
                                    clip_id: clips.last().unwrap().id.clone(),
                                });
                            }
                        }
                    }
                } else if let Some(take) = act.voice.as_ref().and_then(|slot| slot.takes.last()) {
                    for asset_id in &take.asset_ids {
                        if moka.resources.find(asset_id).is_none() {
                            continue;
                        }
                        let duration =
                            resource_duration(moka, asset_id).unwrap_or(act_duration(act));
                        clips.push(audio_clip(track_id, asset_id, act_start, duration, &now));
                        edit_clips.push(StoryEditClip {
                            act_id: act.id.clone(),
                            keyframe_id: Some(String::new()),
                            clip_id: clips.last().unwrap().id.clone(),
                        });
                    }
                }
            }
            if let Some(track_id) = &music_track {
                if let Some(take) = act.music.as_ref().and_then(|slot| slot.takes.last()) {
                    for asset_id in &take.asset_ids {
                        if moka.resources.find(asset_id).is_none() {
                            continue;
                        }
                        let duration =
                            resource_duration(moka, asset_id).unwrap_or(act_duration(act));
                        clips.push(audio_clip(track_id, asset_id, act_start, duration, &now));
                        edit_clips.push(StoryEditClip {
                            act_id: act.id.clone(),
                            keyframe_id: Some(String::new()),
                            clip_id: clips.last().unwrap().id.clone(),
                        });
                    }
                }
            }
        }
    }

    if with_subtitles {
        let text_track = crate::domain::new_id();
        tracks.push(TimelineTrack {
            id: text_track.clone(),
            kind: TrackKind::Text,
            name: "Subtitles".into(),
            muted: false,
            hidden: false,
            locked: false,
            created_at: now.clone(),
        });
        for chapter in &story.chapters {
            for act in &chapter.acts {
                let Some(act_start) = starts.get(&act.id).copied() else {
                    continue;
                };
                for keyframe in &act.keyframes {
                    let lines: Vec<_> = keyframe
                        .dialogue
                        .iter()
                        .filter(|line| !line.text.trim().is_empty())
                        .collect();
                    if lines.is_empty() {
                        continue;
                    }
                    let (start, total) = shots
                        .get(&format!("{}:{}", act.id, keyframe.id))
                        .copied()
                        .unwrap_or((act_start, keyframe.duration_ms));
                    let share = (total / lines.len() as i64).max(1);
                    for (index, line) in lines.iter().enumerate() {
                        let clip_id = crate::domain::new_id();
                        clips.push(text_clip(
                            &text_track,
                            &line.text,
                            start + index as i64 * share,
                            share,
                            &now,
                        ));
                        edit_clips.push(StoryEditClip {
                            act_id: act.id.clone(),
                            keyframe_id: Some(String::new()),
                            clip_id,
                        });
                    }
                }
            }
        }
    }

    // A timeline already on file keeps the rows it was given: this telling's
    // own audio and subtitle rows are reused rather than laid beside empty
    // copies of themselves on every assembly.
    let existing_timeline = match timeline_id.as_deref() {
        Some(id) => Some(super::timeline_of(moka, id)?),
        None => None,
    };
    let mut added_tracks = tracks.clone();
    if let Some(existing) = existing_timeline.as_ref() {
        let mut remap: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        if let Some(track) = existing
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Video)
        {
            remap.insert(video_track.clone(), track.id.clone());
        }
        let audio: Vec<&TimelineTrack> = existing
            .tracks
            .iter()
            .filter(|track| track.kind == TrackKind::Audio)
            .collect();
        if let (Some(new), Some(track)) = (voice_track.as_ref(), audio.first()) {
            remap.insert(new.clone(), track.id.clone());
        }
        if let (Some(new), Some(track)) = (music_track.as_ref(), audio.get(1)) {
            remap.insert(new.clone(), track.id.clone());
        }
        if let Some(track) = existing
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Text)
        {
            if let Some(new) = tracks
                .iter()
                .find(|track| track.kind == TrackKind::Text)
                .map(|track| track.id.clone())
            {
                remap.insert(new, track.id.clone());
            }
        }
        for clip in &mut clips {
            if let Some(track_id) = remap.get(&clip.track_id) {
                clip.track_id = track_id.clone();
            }
        }
        added_tracks.retain(|track| !remap.contains_key(&track.id));
    }

    let mut commands = Vec::new();
    let timeline_id = match timeline_id {
        Some(id) => {
            let existing = super::timeline_of(moka, &id)?;
            let mine: Vec<String> = story
                .edit
                .clip_by_act
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|entry| existing.clips.iter().any(|clip| clip.id == entry.clip_id))
                .map(|entry| entry.clip_id.clone())
                .collect();
            if !mine.is_empty() {
                commands.push(DocumentCommand::RemoveClips {
                    timeline_id: id.clone(),
                    clip_ids: mine,
                });
            }
            let known_tracks: std::collections::HashSet<&str> = existing
                .tracks
                .iter()
                .map(|track| track.id.as_str())
                .collect();
            for track in tracks
                .iter()
                .filter(|track| !known_tracks.contains(track.id.as_str()))
            {
                commands.push(DocumentCommand::AddTrack {
                    timeline_id: id.clone(),
                    track: track.clone(),
                    index: None,
                });
            }
            commands.push(DocumentCommand::AddClips {
                timeline_id: id.clone(),
                clips,
                seams: None,
            });
            id
        }
        None => {
            let timeline = TimelineDocument {
                id: crate::domain::new_id(),
                name: timeline_name,
                schema_version: crate::domain::timeline::TIMELINE_SCHEMA_VERSION,
                settings,
                tracks,
                clips,
                transitions: Vec::new(),
                created_at: now.clone(),
                updated_at: now,
            };
            let id = timeline.id.clone();
            commands.push(DocumentCommand::AddTimeline {
                timeline,
                index: None,
            });
            id
        }
    };

    let mut digest_rows = vec![
        "assembly:v2".to_string(),
        format!("timeline:{timeline_id}"),
        format!("frame:{frame_width}x{frame_height}@30"),
        format!("subtitles:{}", if with_subtitles { "on" } else { "off" }),
    ];
    for (act_id, keyframe_id, start, duration, asset_id) in &digest_units {
        digest_rows.push(format!(
            "unit:{act_id}:{}:{start}:{duration}:{asset_id}",
            keyframe_id.as_deref().unwrap_or_default()
        ));
    }
    for chapter in &story.chapters {
        for act in &chapter.acts {
            let per_line = act.keyframes.iter().any(|keyframe| {
                keyframe
                    .voices
                    .as_ref()
                    .is_some_and(|voices| voices.iter().any(|voice| !voice.slot.takes.is_empty()))
            });
            if per_line {
                for keyframe in &act.keyframes {
                    for voice in keyframe.voices.as_deref().unwrap_or_default() {
                        if let Some(asset_id) = voice
                            .slot
                            .takes
                            .last()
                            .and_then(|take| take.asset_ids.first())
                        {
                            digest_rows.push(format!(
                                "voice:{}:{}:{}:{asset_id}",
                                act.id, keyframe.id, voice.line_id
                            ));
                        }
                    }
                }
            } else if let Some(asset_id) = act
                .voice
                .as_ref()
                .and_then(|slot| slot.takes.last())
                .and_then(|take| take.asset_ids.first())
            {
                digest_rows.push(format!("voice:{}:::{asset_id}", act.id));
            }
            if let Some(asset_id) = act
                .music
                .as_ref()
                .and_then(|slot| slot.takes.last())
                .and_then(|take| take.asset_ids.first())
            {
                digest_rows.push(format!("music:{}::{asset_id}", act.id));
            }
            if with_subtitles {
                for keyframe in &act.keyframes {
                    for line in &keyframe.dialogue {
                        if line.text.trim().is_empty() {
                            continue;
                        }
                        digest_rows.push(format!(
                            "caption:{}:{}:{}:{}",
                            act.id,
                            keyframe.id,
                            line.id.as_deref().unwrap_or_default(),
                            line.text
                        ));
                    }
                }
            }
        }
    }
    let digest = assembly_digest(&digest_rows);

    let edit = StoryEdit {
        timeline_id: Some(timeline_id.clone()),
        clip_by_act: Some(edit_clips),
        ..StoryEdit::default()
    };
    commands.push(DocumentCommand::SetStoryEdit {
        story_id: story.id.clone(),
        patch: crate::domain::story::StoryEditPatch {
            timeline_id: Some(Some(timeline_id.clone())),
            clip_by_act: Some(Some(edit.clip_by_act.clone().unwrap_or_default())),
            assembled_digest: Some(Some(digest.clone())),
        },
    });
    Ok(ToolOutcome::write(
        format!(
            "Assembled {} clips onto timeline {timeline_id}",
            edit.clip_by_act.as_ref().map(Vec::len).unwrap_or(0)
        ),
        json!({
            "timelineId": timeline_id,
            "clips": edit.clip_by_act.as_ref().map(Vec::len).unwrap_or(0),
            "withSubtitles": with_subtitles,
            "digest": digest,
        }),
        commands,
    ))
}

struct AssemblyUnit {
    keyframe_id: Option<String>,
    start_ms: i64,
    duration_ms: i64,
    in_point_ms: i64,
    out_point_ms: i64,
    asset_id: String,
}

fn assembly_units(
    act: &crate::domain::story::StoryAct,
    fallback: &crate::domain::story::StoryShotGranularity,
    moka: &MokaFile,
    start: i64,
) -> Vec<AssemblyUnit> {
    use crate::domain::story::StoryShotGranularity;
    let (keyframes, take, planned_ms) = if act.transition.is_some() {
        (
            None,
            act.video.takes.last(),
            act.transition
                .as_ref()
                .map(|transition| transition.duration_ms)
                .unwrap_or(4_000),
        )
    } else if act.shot_granularity.unwrap_or(*fallback) == StoryShotGranularity::Keyframe {
        (Some(()), None, 0)
    } else {
        (None, act.video.takes.last(), act_duration(act))
    };
    let mut units = Vec::new();
    let mut cursor = start;
    if keyframes.is_some() {
        for keyframe in &act.keyframes {
            let Some(take) = keyframe.video.takes.last() else {
                continue;
            };
            let Some(asset_id) = take.asset_ids.first() else {
                continue;
            };
            let duration = resource_duration(moka, asset_id).unwrap_or(keyframe.duration_ms);
            units.push(AssemblyUnit {
                keyframe_id: Some(keyframe.id.clone()),
                start_ms: cursor,
                duration_ms: duration.max(100),
                in_point_ms: 0,
                out_point_ms: duration.max(100),
                asset_id: asset_id.clone(),
            });
            cursor += duration.max(100);
        }
        return units;
    }
    let Some(take) = take else {
        return units;
    };
    if take.asset_ids.is_empty() {
        return units;
    }
    let share = planned_ms / take.asset_ids.len() as i64;
    let mut full = 0_i64;
    let mut parts = Vec::new();
    for asset_id in &take.asset_ids {
        if moka.resources.find(asset_id).is_none() {
            continue;
        }
        let duration = resource_duration(moka, asset_id).unwrap_or(share).max(1);
        parts.push((asset_id.clone(), duration));
        full += duration;
    }
    let window_in = take.in_ms.unwrap_or(0).clamp(0, full);
    let window_out = take.out_ms.unwrap_or(full).clamp(window_in, full);
    let mut piece_at = 0_i64;
    for (asset_id, duration) in parts {
        let piece_start = piece_at;
        piece_at += duration;
        let in_point = window_in.max(piece_start);
        let out_point = window_out.min(piece_start + duration);
        if out_point <= in_point {
            continue;
        }
        units.push(AssemblyUnit {
            keyframe_id: None,
            start_ms: cursor,
            duration_ms: out_point - in_point,
            in_point_ms: in_point - piece_start,
            out_point_ms: out_point - piece_start,
            asset_id,
        });
        cursor += out_point - in_point;
    }
    units
}

fn act_duration(act: &crate::domain::story::StoryAct) -> i64 {
    act.keyframes
        .iter()
        .map(|keyframe| keyframe.duration_ms)
        .sum::<i64>()
        .max(4_000)
}

fn resource_duration(moka: &MokaFile, asset_id: &str) -> Option<i64> {
    moka.resources
        .find(asset_id)
        .and_then(|entry| entry.probe.as_ref())
        .and_then(|probe| probe.duration_ms)
}

fn audio_track(id: &str, name: &str, now: &str) -> TimelineTrack {
    TimelineTrack {
        id: id.to_string(),
        kind: TrackKind::Audio,
        name: name.to_string(),
        muted: false,
        hidden: false,
        locked: false,
        created_at: now.to_string(),
    }
}

fn audio_clip(
    track_id: &str,
    asset_id: &str,
    start_ms: i64,
    duration_ms: i64,
    now: &str,
) -> TimelineClip {
    TimelineClip {
        id: crate::domain::new_id(),
        track_id: track_id.to_string(),
        kind: TrackKind::Audio,
        label: String::new(),
        start_ms,
        duration_ms,
        in_point_ms: 0,
        out_point_ms: duration_ms,
        speed: 1.0,
        volume: 1.0,
        fade_in_ms: 0,
        fade_out_ms: 0,
        muted: false,
        opacity: 1.0,
        created_at: now.to_string(),
        updated_at: now.to_string(),
        asset_id: Some(asset_id.to_string()),
        adjust: None,
        filter: None,
        text: None,
    }
}

fn text_clip(
    track_id: &str,
    content: &str,
    start_ms: i64,
    duration_ms: i64,
    now: &str,
) -> TimelineClip {
    let label = if content.chars().count() > 24 {
        format!("{}…", content.chars().take(24).collect::<String>())
    } else {
        content.to_string()
    };
    TimelineClip {
        id: crate::domain::new_id(),
        track_id: track_id.to_string(),
        kind: TrackKind::Text,
        label,
        start_ms,
        duration_ms,
        in_point_ms: 0,
        out_point_ms: duration_ms,
        speed: 1.0,
        volume: 1.0,
        fade_in_ms: 0,
        fade_out_ms: 0,
        muted: false,
        opacity: 1.0,
        created_at: now.to_string(),
        updated_at: now.to_string(),
        asset_id: None,
        adjust: None,
        filter: None,
        text: Some(crate::domain::TextClipData {
            content: content.to_string(),
            style: crate::domain::TextClipStyle {
                font_family: "Inter, ui-sans-serif, system-ui, sans-serif".into(),
                font_size: 48,
                color: "#ffffff".into(),
                bold: false,
                italic: false,
                align: crate::domain::TextAlign::Center,
                position: crate::domain::TextPosition::Bottom,
                background: None,
                stroke_width: 0,
                stroke_color: "#000000".into(),
            },
        }),
    }
}

fn assembly_digest(rows: &[String]) -> String {
    let mut hash = 0x811c_9dc5_u32;
    for unit in rows.join("\n").encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

fn timeline_settings(story: &StoryDocument) -> TimelineSettings {
    let (width, height) = match story.brief.aspect.as_str() {
        "9:16" => (1080, 1920),
        "1:1" => (1080, 1080),
        "4:3" => (1440, 1080),
        "21:9" => (2560, 1080),
        _ => (1920, 1080),
    };
    TimelineSettings {
        fps: 30,
        width,
        height,
        background: "#000000".into(),
    }
}

/// Starts a batch of story generations. The manager validates targets and
/// assets against the document; this tool only shapes the request.
pub async fn effect(
    state: &ApiState,
    session: &ProjectSession,
    name: &str,
    input: &Value,
    moka: &MokaFile,
) -> Result<ToolOutcome, ToolError> {
    match name {
        "story.split_manuscript" => return split_manuscript(state, session, moka, input).await,
        "story.focus" => return focus_room(state, moka, input).await,
        "story.list_jobs" => return list_jobs(session, input).await,
        "story.read_job" => return read_job(session, input).await,
        _ => {}
    }
    let args = Args::new("story.start_job", input)?;
    let story_id = args.req_str("storyId")?.to_string();
    super::story_of(moka, &story_id)?;
    let kind: crate::story::StoryJobKind = serde_json::from_value(json!(args.req_str("kind")?))
        .map_err(|_| ToolError::validation("unknown story job kind"))?;
    let items = args.req_array("items")?;
    if items.len() > 40 {
        return Err(ToolError::validation(
            "a story batch carries at most 40 items",
        ));
    }
    let mut parsed = Vec::with_capacity(items.len());
    for item in items {
        let target: crate::story::StoryTarget = serde_json::from_value(
            item.get("target")
                .cloned()
                .ok_or_else(|| ToolError::validation("every item needs target"))?,
        )
        .map_err(|error| ToolError::validation(format!("target is not valid: {error}")))?;
        let capability: crate::domain::Capability = serde_json::from_value(
            item.get("capability")
                .cloned()
                .ok_or_else(|| ToolError::validation("every item needs capability"))?,
        )
        .map_err(|error| ToolError::validation(format!("capability is not valid: {error}")))?;
        let prompt = item
            .get("prompt")
            .and_then(Value::as_str)
            .filter(|prompt| !prompt.trim().is_empty())
            .ok_or_else(|| ToolError::validation("every item needs a prompt"))?;
        let inputs: Vec<crate::generate::GenerateInput> = item
            .get("inputs")
            .and_then(Value::as_array)
            .map(|inputs| {
                inputs
                    .iter()
                    .filter_map(|input| serde_json::from_value(input.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        let mut queued = crate::story::StoryJobItem::queued(
            item.get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(crate::domain::new_id),
            target,
            capability,
            prompt.to_string(),
            item.get("system")
                .and_then(Value::as_str)
                .map(str::to_string),
            inputs,
            item.get("params").cloned().unwrap_or_else(|| json!({})),
        );
        // The name a drawing is filed under, and the set it belongs to, are
        // the client's own words about the piece rather than its request; a
        // planner that fills them must not have them dropped on the way in.
        queued.name = item.get("name").and_then(Value::as_str).map(str::to_string);
        queued.copies = item
            .get("copies")
            .and_then(Value::as_u64)
            .map(|value| value as usize);
        queued.set_id = item
            .get("setId")
            .and_then(Value::as_str)
            .map(str::to_string);
        parsed.push(queued);
    }
    // A place may be asked of several models at once: the pieces take turns,
    // and the ones that land on the same model start as that model's own
    // batch. The room spreads its asks the same way in its model bar, so a
    // CLI caller naming a pool gets the same rotation rather than a second
    // meaning for the same setting.
    let model = args.opt_str("model").unwrap_or("").to_string();
    let mut names: Vec<String> = Vec::new();
    for name in args.opt_strings("models") {
        let name = name.trim().to_string();
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    if names.is_empty() {
        names.push(model.trim().to_string());
    }
    let parallel = args
        .opt_i64("parallel")
        .map(|value| value.max(1) as usize)
        .unwrap_or(crate::story::DEFAULT_PARALLEL_ITEMS);
    // The same checks the room's HTTP route makes: a batch is refused before a
    // provider is paid, not after eleven of its twelve pieces have come home.
    if let Err(issues) = crate::story::validate_start(
        moka,
        &story_id,
        kind,
        &parsed,
        parallel,
        &moka.resources,
        state.story_jobs.limits(),
    ) {
        return Err(
            ToolError::validation("the requested story job is not valid")
                .details(json!({"issues": issues})),
        );
    }
    let active = session
        .0
        .list_story_jobs()
        .await?
        .iter()
        .filter(|job| !job.status.is_terminal())
        .count();
    // Every model of the pool drives a batch of its own, so a pool is held to
    // the same ceiling as the batches it becomes rather than counted once.
    let waves = names.len().max(1);
    if active + waves > state.story_jobs.limits().max_active_jobs_per_project {
        return Err(ToolError::new(
            "STORY_JOB_BUSY",
            "this project already has a job in progress",
        ));
    }
    // A named model is resolved as it stands; none means the deployment's
    // default for this capability. Passing the raw choice through would record
    // a model id the record cannot use and leave the failure to the run.
    let mut resolved = Vec::with_capacity(names.len());
    for name in &names {
        let config = if name.is_empty() {
            state.models.resolve_default(kind.capability()).await
        } else {
            state.models.resolve(name, kind.capability()).await
        }
        .map_err(ToolError::from)?;
        resolved.push((name.clone(), config.config_id));
    }
    // The pieces take turns in the order the models were given; a model left
    // with no piece is not started as an empty batch.
    let mut groups: Vec<Vec<crate::story::StoryJobItem>> =
        (0..resolved.len()).map(|_| Vec::new()).collect();
    let item_count = parsed.len();
    let turns = groups.len();
    for (index, item) in parsed.into_iter().enumerate() {
        groups[index % turns].push(item);
    }
    let mut started = Vec::new();
    for ((name, model_id), group) in resolved.into_iter().zip(groups) {
        if group.is_empty() {
            continue;
        }
        let job = state
            .story_jobs
            .start(&session.0, story_id.clone(), kind, model_id, parallel, group)
            .await
            .map_err(|error| {
                ToolError::internal(format!(
                    "the batch for {name} could not be started after {} others were: {error}",
                    started.len()
                ))
            })?;
        started.push(job);
    }
    let Some(first) = started.first() else {
        return Err(ToolError::validation("a story batch needs at least one item"));
    };
    let jobs: Vec<Value> = started
        .iter()
        .map(|job| {
            json!({
                "jobId": job.id,
                "model": if job.model.is_empty() { "default" } else { job.model.as_str() },
                "items": job.items.len(),
            })
        })
        .collect();
    let summary = if started.len() == 1 {
        format!("Started a story job with {item_count} items")
    } else {
        format!(
            "Started {} story jobs with {item_count} items",
            started.len()
        )
    };
    Ok(ToolOutcome {
        summary,
        data: json!({"jobId": first.id, "storyId": first.story_id, "jobs": jobs}),
        task: Some(TaskRef {
            kind: "storyJob".into(),
            id: first.id.clone(),
        }),
        ..ToolOutcome::default()
    })
}

async fn split_manuscript(
    state: &ApiState,
    session: &ProjectSession,
    moka: &MokaFile,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    let args = Args::new("story.split_manuscript", input)?;
    args.confirmed()?;
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let source_id = args
        .opt_str("sourceAssetId")
        .map(str::to_string)
        .or_else(|| story.brief.source_asset_id.clone())
        .ok_or_else(|| ToolError::new("STEP_GAPS", "the story has no manuscript on file"))?;
    let entry = moka
        .resources
        .texts
        .iter()
        .find(|entry| entry.id == source_id)
        .ok_or_else(|| ToolError::new("ASSET_NOT_FOUND", "the manuscript is not on the shelf"))?;
    let inside = entry.path.starts_with("assets/")
        && !entry.path.split(['/', '\\']).any(|part| part == "..");
    if !inside {
        return Err(ToolError::validation(
            "the manuscript is outside the project's own files",
        ));
    }
    let root = session.0.project_root().await?;
    let text = tokio::fs::read_to_string(root.join(&entry.path))
        .await
        .map_err(|error| {
            ToolError::validation(format!("the manuscript cannot be read: {error}"))
        })?;
    let chars: Vec<char> = text.chars().collect();
    let budget = args.opt_i64("budget").unwrap_or(12_000).max(1_000) as usize;
    let minutes = (story.brief.chapter_ms.max(60_000) / 60_000).max(1);
    let total = format_timestamp(story.brief.total_duration_ms);
    let named = args.opt_str("model").unwrap_or("").trim();
    let resolved = if named.is_empty() {
        state
            .models
            .resolve_default(crate::domain::Capability::Text)
            .await
    } else {
        state
            .models
            .resolve(named, crate::domain::Capability::Text)
            .await
    }
    .map_err(ToolError::from)?;
    let system = crate::prompts::render(crate::prompts::Prompt::StorySplitSystem, &json!({}))
        .map_err(|error| ToolError::new("PROMPT_TEMPLATE_FAILED", error.to_string()))?;
    let mut cut: Vec<CutChapter> = Vec::new();
    let mut cursor = 0_usize;
    let mut part = 0;
    while cursor < chars.len() {
        part += 1;
        if part > 1_000 {
            return Err(ToolError::new(
                "STEP_GAPS",
                "the manuscript needs too many parts",
            ));
        }
        let end = window_end(&chars, cursor, budget);
        let window: String = chars[cursor..end].iter().collect();
        let final_part = end >= chars.len();
        let mut reading: Option<WindowReading> = None;
        let mut reason = String::new();
        for attempt in 1..=3 {
            let prompt = if attempt == 1 {
                crate::prompts::render(
                    crate::prompts::Prompt::StorySplit,
                    &json!({
                        "text": window,
                        "part": part,
                        "minutes": minutes,
                        "total": total,
                        "last": final_part,
                    }),
                )
            } else {
                crate::prompts::render(
                    crate::prompts::Prompt::StorySplitRepair,
                    &json!({
                        "text": window,
                        "part": part,
                        "minutes": minutes,
                        "total": total,
                        "last": final_part,
                        "missing": [reason.clone()],
                    }),
                )
            }
            .map_err(|error| ToolError::new("PROMPT_TEMPLATE_FAILED", error.to_string()))?;
            let request = GenerateRequest {
                capability: crate::domain::Capability::Text,
                model: resolved.config_id.clone(),
                prompt,
                system: Some(system.clone()),
                ..GenerateRequest::default()
            };
            let result = state
                .gateway
                .text(&session.0, request, &DeltaSink::default(), &Cancel::new())
                .await
                .map_err(ToolError::from)?;
            let Some(answer) = result.text.as_deref() else {
                reason = "the split answer had no text".to_string();
                continue;
            };
            let pointers = match split_pointers(answer) {
                Ok(pointers) => pointers,
                Err(error) => {
                    reason = error;
                    continue;
                }
            };
            let (boundaries, missed) = locate_boundaries(&window, &pointers, cursor == 0);
            if !missed.is_empty() && attempt < 3 {
                reason = missed[0].clone();
                continue;
            }
            let found = cut_window(&window, &boundaries, final_part);
            let progressed = if final_part {
                !found.chapters.is_empty()
            } else {
                found.tail_start.is_some_and(|tail| tail > cursor)
            };
            if !progressed {
                reason = missed
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "no chapter boundary could be placed".to_string());
                continue;
            }
            reading = Some(found);
            break;
        }
        let Some(reading) = reading else {
            return Err(ToolError::new(
                "STEP_GAPS",
                format!("part {part} could not be cut: {reason}"),
            ));
        };
        for chapter in reading.chapters {
            if cut.len() >= crate::domain::story::MAX_CHAPTERS_PER_STORY {
                if let Some(last) = cut.last_mut() {
                    last.body = format!("{}\n\n{}", last.body, chapter.body);
                }
            } else {
                cut.push(chapter);
            }
        }
        if final_part {
            break;
        }
        let Some(tail) = reading.tail_start else {
            return Err(ToolError::new(
                "STEP_GAPS",
                "the split left no place to continue",
            ));
        };
        if tail <= cursor {
            return Err(ToolError::new(
                "STEP_GAPS",
                "the split did not move forward",
            ));
        }
        cursor = tail;
    }
    if cut.is_empty() {
        return Err(ToolError::new(
            "STEP_GAPS",
            "the manuscript produced no chapters",
        ));
    }
    let lengths: Vec<usize> = cut
        .iter()
        .map(|chapter| chapter.body.chars().count().max(1))
        .collect();
    let sum: usize = lengths.iter().sum();
    let mut spent = 0_i64;
    let mut chapters = Vec::with_capacity(cut.len());
    for (index, chapter) in cut.iter().enumerate() {
        let last = index + 1 == cut.len();
        let duration = if last {
            (story.brief.total_duration_ms - spent).max(1)
        } else {
            ((story.brief.total_duration_ms as i128 * lengths[index] as i128) / sum as i128).max(1)
                as i64
        };
        spent += duration;
        chapters.push(StoryChapter {
            id: crate::domain::new_id(),
            title: chapter.title.clone(),
            synopsis: chapter.body.clone(),
            target_duration_ms: duration,
            acts: Vec::new(),
            revision: 1,
            board_revision: None,
            board_outline: None,
            outline_locked: false,
        });
    }
    let mut commands = vec![DocumentCommand::SetStoryChapters {
        story_id: story.id.clone(),
        chapters,
    }];
    commands.push(DocumentCommand::UpdateStoryBrief {
        story_id: story.id.clone(),
        patch: StoryBriefPatch {
            source_split: Some(Some(true)),
            ..StoryBriefPatch::default()
        },
    });
    let opened = session
        .0
        .current()
        .await?
        .ok_or_else(|| ToolError::new("PROJECT_NOT_OPEN", "no project is open"))?;
    let saved = session
        .0
        .apply_agent_commands(opened.moka.metadata.revision, commands)
        .await
        .map_err(ToolError::from)?;
    Ok(ToolOutcome::write(
        format!("Cut the manuscript into {} chapters", cut.len()),
        json!({
            "storyId": story.id,
            "chapters": cut.len(),
            "revision": saved.0.revision,
        }),
        Vec::new(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitEntry {
    #[serde(default)]
    number: Option<i64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    discard: Option<bool>,
}

struct SplitPointer {
    title: String,
    start: Option<String>,
    end: Option<String>,
    before: Option<String>,
    discard: bool,
}

fn split_pointers(answer: &str) -> Result<Vec<SplitPointer>, String> {
    let value = extract_json(answer)?;
    let raw = if let Some(chapters) = value.get("chapters").and_then(Value::as_array) {
        chapters.clone()
    } else if let Some(list) = value.as_array() {
        list.clone()
    } else {
        vec![value]
    };
    let mut pointers = Vec::new();
    for entry in raw {
        let Ok(entry) = serde_json::from_value::<SplitEntry>(entry) else {
            continue;
        };
        let start = entry
            .start
            .map(|word| word.trim().to_string())
            .filter(|word| !word.is_empty());
        let end = entry
            .end
            .map(|word| word.trim().to_string())
            .filter(|word| !word.is_empty());
        let before = entry
            .before
            .map(|word| word.trim().to_string())
            .filter(|word| !word.is_empty());
        if start.is_none() && before.is_none() && !pointers.is_empty() {
            continue;
        }
        let discard = entry.discard == Some(true) || entry.number == Some(0);
        pointers.push(SplitPointer {
            title: entry.title.unwrap_or_default(),
            start,
            end,
            before,
            discard,
        });
    }
    if pointers.is_empty() {
        Err("the answer named no chapter boundary".to_string())
    } else {
        Ok(pointers)
    }
}

fn extract_json(answer: &str) -> Result<Value, String> {
    let start = answer
        .char_indices()
        .find(|(_, ch)| *ch == '{' || *ch == '[')
        .map(|(at, _)| at)
        .ok_or_else(|| "the answer held no json".to_string())?;
    let slice = &answer[start..];
    let end = if slice.starts_with('{') { '}' } else { ']' };
    let tail = slice
        .char_indices()
        .rev()
        .find(|(_, ch)| *ch == end)
        .map(|(at, _)| at + 1)
        .ok_or_else(|| "the answer's json was not closed".to_string())?;
    serde_json::from_str(&slice[..tail])
        .map_err(|error| format!("the answer was not json: {error}"))
}

struct CutChapter {
    title: String,
    body: String,
}

struct Boundary {
    at: usize,
    title: String,
    discard: bool,
    end: Option<usize>,
}

struct WindowReading {
    chapters: Vec<CutChapter>,
    tail_start: Option<usize>,
}

fn locate_boundaries(
    window: &str,
    pointers: &[SplitPointer],
    first_part: bool,
) -> (Vec<Boundary>, Vec<String>) {
    let chars: Vec<char> = window.chars().collect();
    let compact = compact_chars(&chars);
    let mut boundaries = Vec::new();
    let mut missed = Vec::new();
    let mut from = 0;
    let mut first = true;
    for pointer in pointers {
        if pointer.discard {
            if first_part && first {
                boundaries.push(Boundary {
                    at: 0,
                    title: pointer.title.clone(),
                    discard: true,
                    end: None,
                });
                first = false;
            }
            continue;
        }
        if first && pointer.start.is_none() && pointer.before.is_none() {
            boundaries.push(Boundary {
                at: 0,
                title: pointer.title.clone(),
                discard: false,
                end: pointer
                    .end
                    .as_deref()
                    .and_then(|quote| find_quote(&chars, &compact, quote, 0)),
            });
            first = false;
            continue;
        }
        if !first_part && first {
            boundaries.push(Boundary {
                at: 0,
                title: pointer.title.clone(),
                discard: false,
                end: pointer
                    .end
                    .as_deref()
                    .and_then(|quote| find_quote(&chars, &compact, quote, 0)),
            });
            first = false;
            continue;
        }
        first = false;
        let mut at = pointer
            .start
            .as_deref()
            .and_then(|quote| find_quote(&chars, &compact, quote, from));
        if at.is_none() {
            if let Some(before) = pointer.before.as_deref() {
                if let Some(held) = find_quote(&chars, &compact, before, from) {
                    let mut next = held + before.chars().count();
                    while next < chars.len() && chars[next].is_whitespace() {
                        next += 1;
                    }
                    at = Some(next);
                }
            }
        }
        let Some(at) = at else {
            missed.push(
                pointer
                    .start
                    .clone()
                    .or(pointer.before.clone())
                    .unwrap_or_else(|| pointer.title.clone()),
            );
            continue;
        };
        if (at <= from && !boundaries.is_empty()) || at >= chars.len() {
            missed.push(
                pointer
                    .start
                    .clone()
                    .or(pointer.before.clone())
                    .unwrap_or_else(|| pointer.title.clone()),
            );
            continue;
        }
        boundaries.push(Boundary {
            at,
            title: pointer.title.clone(),
            discard: false,
            end: pointer
                .end
                .as_deref()
                .and_then(|quote| find_quote(&chars, &compact, quote, at)),
        });
        from = at;
    }
    (boundaries, missed)
}

fn cut_window(window: &str, boundaries: &[Boundary], final_part: bool) -> WindowReading {
    let chars: Vec<char> = window.chars().collect();
    let mut chapters = Vec::new();
    let mut tail_end = None;
    for (index, boundary) in boundaries.iter().enumerate() {
        if boundary.discard {
            continue;
        }
        let next = boundaries.get(index + 1);
        let start = boundary.at;
        if next.is_none() && !final_part {
            let Some(end) = boundary.end else { continue };
            if end <= start {
                continue;
            }
            if let Some(chapter) = cut_chapter(&chars, start, end, boundary, chapters.len() + 1) {
                chapters.push(chapter);
                tail_end = Some(end);
            }
            continue;
        }
        let end = next.map(|next| next.at).unwrap_or(chars.len());
        if end <= start {
            continue;
        }
        if let Some(chapter) = cut_chapter(&chars, start, end, boundary, chapters.len() + 1) {
            chapters.push(chapter);
        }
    }
    let last = boundaries.last();
    WindowReading {
        chapters,
        tail_start: if final_part || last.is_none() {
            None
        } else {
            Some(tail_end.unwrap_or_else(|| last.map(|held| held.at).unwrap_or(0)))
        },
    }
}

fn cut_chapter(
    chars: &[char],
    start: usize,
    end: usize,
    boundary: &Boundary,
    number: usize,
) -> Option<CutChapter> {
    let body: String = chars[start..end].iter().collect();
    let line_end = body.find('\n');
    let first_line = line_end.map(|at| &body[..at]).unwrap_or(&body).trim();
    let title = if boundary.title.trim().is_empty() {
        heading_at(&body)
            .map(|heading| heading.chars().take(120).collect())
            .unwrap_or_else(|| format!("Chapter {number}"))
    } else {
        boundary.title.chars().take(120).collect()
    };
    let mut body = if first_line == title.trim() && is_source_heading(first_line) {
        line_end
            .map(|at| body[at + 1..].to_string())
            .unwrap_or_default()
    } else {
        body
    };
    body = body.trim().to_string();
    (!body.is_empty()).then_some(CutChapter { title, body })
}

fn heading_at(window: &str) -> Option<String> {
    let line = window.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    if is_source_heading(line) || line.chars().count() <= 60 {
        Some(line.to_string())
    } else {
        None
    }
}

fn is_source_heading(line: &str) -> bool {
    let line = line.trim();
    (line.starts_with('第') && line.contains('章'))
        || (line.starts_with('第') && line.contains('集'))
        || (line.starts_with('第') && line.contains('回'))
        || line.to_ascii_lowercase().starts_with("chapter ")
}

struct CompactChars {
    text: Vec<char>,
    map: Vec<usize>,
}

fn compact_chars(chars: &[char]) -> CompactChars {
    let mut text = Vec::new();
    let mut map = Vec::new();
    for (at, ch) in chars.iter().enumerate() {
        if ch.is_whitespace() {
            continue;
        }
        text.push(*ch);
        map.push(at);
    }
    CompactChars { text, map }
}

fn bare_quote(quote: &str) -> String {
    quote
        .trim()
        .trim_matches(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '\'' | '"'
                        | '“'
                        | '”'
                        | '‘'
                        | '’'
                        | '「'
                        | '」'
                        | '『'
                        | '』'
                        | '《'
                        | '》'
                        | '【'
                        | '】'
                        | '('
                        | ')'
                        | '（'
                        | '）'
                        | '.'
                        | '…'
                )
        })
        .to_string()
}

fn find_quote(chars: &[char], compact: &CompactChars, quote: &str, from: usize) -> Option<usize> {
    let bare = bare_quote(quote);
    let target: Vec<char> = bare.chars().collect();
    if target.len() < 2 {
        return None;
    }
    if target.len() <= chars.len() {
        for at in from..=chars.len() - target.len() {
            if chars[at..at + target.len()] == target[..] {
                return Some(at);
            }
        }
    }
    let squeezed: Vec<char> = target
        .into_iter()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    if squeezed.is_empty() {
        return None;
    }
    for at in 0..=compact.text.len().saturating_sub(squeezed.len()) {
        let source_at = compact.map[at];
        if source_at < from {
            continue;
        }
        if compact.text[at..at + squeezed.len()] == squeezed[..] {
            return Some(source_at);
        }
    }
    None
}

fn window_end(chars: &[char], from: usize, budget: usize) -> usize {
    if from >= chars.len() {
        return chars.len();
    }
    let wanted = (from + budget.max(1)).min(chars.len());
    if wanted >= chars.len() {
        return chars.len();
    }
    let floor = from + (wanted - from) / 2;
    if let Some(at) = (floor..wanted)
        .rev()
        .find(|at| chars.get(*at) == Some(&'\n') && chars.get(at + 1) == Some(&'\n'))
    {
        return (at + 2).min(chars.len());
    }
    if let Some(at) = (floor..wanted)
        .rev()
        .find(|at| chars.get(*at) == Some(&'\n'))
    {
        return (at + 1).min(chars.len());
    }
    wanted
}

fn format_timestamp(ms: i64) -> String {
    let total = (ms.max(0) as f64 / 1000.0).round() as i64;
    let seconds = total % 60;
    let minutes = (total / 60) % 60;
    let hours = total / 3600;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

async fn focus_room(
    state: &ApiState,
    moka: &MokaFile,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    let args = Args::new("story.focus", input)?;
    let story_id = args.req_str("storyId")?.to_string();
    let story = super::story_of(moka, &story_id)?;
    let chapter_id = args.opt_str("chapterId").map(str::to_string);
    if let Some(chapter_id) = chapter_id.as_deref() {
        if !story
            .chapters
            .iter()
            .any(|chapter| chapter.id == chapter_id)
        {
            return Err(ToolError::new(
                "CHAPTER_NOT_FOUND",
                format!("chapter {chapter_id} does not exist"),
            ));
        }
    }
    let step = args
        .opt_str("step")
        .map(str::to_string)
        .unwrap_or_else(|| "storyboard".to_string());
    let focus = json!({
        "room": "story",
        "storyId": story_id,
        "step": step,
        "chapterId": chapter_id,
        "actId": args.opt_str("actId"),
        "keyframeId": args.opt_str("keyframeId"),
        "elementId": args.opt_str("elementId"),
    });
    *state.focus.lock().await = Some(focus.clone());
    Ok(ToolOutcome::read(
        "Asked the story room to move there",
        json!({"focus": focus}),
    ))
}

async fn list_jobs(session: &ProjectSession, input: &Value) -> Result<ToolOutcome, ToolError> {
    let args = Args::new("story.list_jobs", input)?;
    let story_id = args.opt_str("storyId").map(str::to_string);
    let include_answers = args.opt_bool("answers", false);
    let mut jobs = session.0.list_story_jobs().await?;
    if let Some(story_id) = story_id {
        jobs.retain(|job| job.story_id == story_id);
    }
    jobs.sort_by(|one, other| other.created_at.cmp(&one.created_at));
    let listed: Vec<Value> = jobs
        .iter()
        .map(|job| {
            let mut value = json!({
                "id": job.id,
                "storyId": job.story_id,
                "kind": job.kind,
                "status": job.status,
                "model": job.model,
                "parallel": job.parallel,
                "readAt": job.read_at,
                "createdAt": job.created_at,
                "updatedAt": job.updated_at,
                "itemCount": job.items.len(),
                "succeeded": job.items.iter().filter(|item| item.status == crate::story::StoryJobStatus::Succeeded).count(),
                "failed": job.items.iter().filter(|item| item.status == crate::story::StoryJobStatus::Failed).count(),
            });
            if include_answers {
                value["items"] = json!(job.items);
            }
            value
        })
        .collect();
    Ok(ToolOutcome::read(
        format!("{} story jobs", listed.len()),
        json!({"jobs": listed}),
    ))
}

async fn read_job(session: &ProjectSession, input: &Value) -> Result<ToolOutcome, ToolError> {
    let args = Args::new("story.read_job", input)?;
    let id = args.req_str("jobId")?;
    let mut job = session.0.get_story_job(id).await?;
    let marked = job.status.is_terminal() && job.read_at.is_none();
    if marked {
        job.read_at = Some(now_iso());
        job = session.0.update_story_job(job).await?;
    }
    Ok(ToolOutcome::write(
        if marked {
            format!("Marked story job {id} read")
        } else {
            format!("Story job {id} was already read or is still running")
        },
        json!({"jobId": job.id, "status": job.status, "readAt": job.read_at, "marked": marked}),
        Vec::new(),
    ))
}

fn _slot_target_family(_: &StorySlotTarget) {}

#[cfg(test)]
mod split_tests {
    use super::*;

    #[test]
    fn a_fenced_split_answer_names_its_boundaries() {
        let pointers = split_pointers(
            "```json\n{\"chapters\":[{\"number\":1,\"title\":\"One\",\"start\":\"chapter one\",\"end\":\"chapter two\"},{\"number\":2,\"title\":\"Two\",\"start\":\"chapter two\"}]}\n```",
        )
        .expect("the answer is read");
        assert_eq!(pointers.len(), 2);
        assert_eq!(pointers[0].title, "One");
        assert_eq!(pointers[0].end.as_deref(), Some("chapter two"));
    }

    #[test]
    fn a_manuscript_is_cut_at_the_places_its_answer_quoted() {
        let window = "第一章 开始\n甲。\n第二章 后来\n乙。\n";
        let pointers = vec![
            SplitPointer {
                title: "第一章 开始".into(),
                start: Some("第一章 开始".into()),
                end: Some("第二章 后来".into()),
                before: None,
                discard: false,
            },
            SplitPointer {
                title: "第二章 后来".into(),
                start: Some("第二章 后来".into()),
                end: None,
                before: None,
                discard: false,
            },
        ];
        let (boundaries, missed) = locate_boundaries(window, &pointers, true);
        assert!(missed.is_empty(), "{missed:?}");
        let reading = cut_window(window, &boundaries, true);
        assert_eq!(reading.chapters.len(), 2);
        assert_eq!(reading.chapters[0].title, "第一章 开始");
        assert!(reading.chapters[0].body.contains("甲。"));
        assert!(reading.chapters[1].body.contains("乙。"));
    }
}
