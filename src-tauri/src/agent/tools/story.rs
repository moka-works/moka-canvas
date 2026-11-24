//! The story room's tools.
//!
//! A story is a document of steps: an idea, an outline, a cast, a board, an
//! edit. The tools follow that shape — read a step, change one thing, confirm
//! when the reader says so — and a batch generation is a task, never a tool
//! that waits. Verification tools compute readiness from the content itself;
//! there is no second, tool-local definition of what a step still needs.

use serde_json::{json, Value};

use crate::api::{ApiState, ProjectSession};
use crate::domain::story::{
    StoryAct, StoryActPatch, StoryBriefPatch, StoryChapter, StoryDocument, StoryEdit,
    StoryEditClip, StoryElement, StoryElementPatch, StoryKeyframe, StoryKeyframePatch, StorySlot,
    StorySlotTarget, StoryTake, StoryVoiceProfile, REFERENCE_IMAGES_MAX, STORY_SCHEMA_VERSION,
};
use crate::domain::{
    now_iso, DocumentCommand, MokaFile, TimelineClip, TimelineDocument, TimelineSettings,
    TimelineTrack, TrackKind,
};
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
        "story.replace_acts" | "story.add_act" | "story.remove_act" | "story.move_act" => {
            acts(moka, &args, name)
        }
        "story.update_act" => update_act(moka, &args),
        "story.replace_keyframes" | "story.add_keyframe" | "story.remove_keyframe" => {
            keyframes(moka, &args, name)
        }
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
            let act = act_from(
                &json!({
                    "title": args.opt_str("title").unwrap_or("Act"),
                    "summary": args.opt_str("summary").unwrap_or_default(),
                }),
                None,
            )?;
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
    Ok(ToolOutcome::write(
        format!("Confirmed {key}"),
        json!({"confirmedSteps": story.confirmed_steps, "step": key}),
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

fn assemble(moka: &MokaFile, args: &Args<'_>) -> Result<ToolOutcome, ToolError> {
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let timeline_id = args.opt_str("timelineId").map(str::to_string);
    let timeline_name = args.opt_str("timelineName").unwrap_or("Story").to_string();
    let settings = timeline_settings(story);
    let mut clips: Vec<TimelineClip> = Vec::new();
    let mut edit_clips: Vec<StoryEditClip> = Vec::new();
    let mut cursor = 0_i64;
    let now = now_iso();
    let track_id = crate::domain::new_id();
    for chapter in &story.chapters {
        for act in &chapter.acts {
            let current = act
                .video
                .takes
                .last()
                .and_then(|take| take.asset_ids.first())
                .cloned();
            let shots: Vec<(Option<String>, Option<String>, i64)> = if act.keyframes.is_empty() {
                vec![(None, current, 4_000)]
            } else {
                act.keyframes
                    .iter()
                    .map(|keyframe| {
                        (
                            Some(keyframe.id.clone()),
                            keyframe
                                .video
                                .takes
                                .last()
                                .and_then(|take| take.asset_ids.first())
                                .cloned()
                                .or_else(|| {
                                    keyframe
                                        .art
                                        .takes
                                        .last()
                                        .and_then(|take| take.asset_ids.first())
                                        .cloned()
                                }),
                            keyframe.duration_ms,
                        )
                    })
                    .collect()
            };
            for (keyframe_id, asset_id, duration) in shots {
                let Some(asset_id) = asset_id else { continue };
                let clip_id = crate::domain::new_id();
                edit_clips.push(StoryEditClip {
                    act_id: act.id.clone(),
                    keyframe_id,
                    clip_id: clip_id.clone(),
                });
                clips.push(TimelineClip {
                    id: clip_id,
                    track_id: track_id.clone(),
                    kind: TrackKind::Video,
                    label: act.title.clone(),
                    start_ms: cursor,
                    duration_ms: duration.max(100),
                    in_point_ms: 0,
                    out_point_ms: duration.max(100),
                    speed: 1.0,
                    volume: 1.0,
                    fade_in_ms: 0,
                    fade_out_ms: 0,
                    muted: false,
                    opacity: 1.0,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    asset_id: Some(asset_id),
                    adjust: None,
                    filter: None,
                    text: None,
                });
                cursor += duration.max(100);
            }
        }
    }
    if clips.is_empty() {
        return Err(ToolError::new(
            "STEP_GAPS",
            "there is nothing with a picture or a shot to assemble",
        ));
    }
    let mut commands = Vec::new();
    let timeline_id = match timeline_id {
        Some(id) => {
            super::timeline_of(moka, &id)?;
            id
        }
        None => {
            let timeline = TimelineDocument {
                id: crate::domain::new_id(),
                name: timeline_name,
                schema_version: crate::domain::timeline::TIMELINE_SCHEMA_VERSION,
                settings,
                tracks: vec![TimelineTrack {
                    id: track_id,
                    kind: TrackKind::Video,
                    name: "V1".into(),
                    muted: false,
                    hidden: false,
                    locked: false,
                    created_at: now.clone(),
                }],
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
            assembled_digest: None,
        },
    });
    Ok(ToolOutcome::write(
        format!(
            "Assembled {} clips into a timeline",
            edit.clip_by_act.as_ref().map(Vec::len).unwrap_or(0)
        ),
        json!({"timelineId": timeline_id}),
        commands,
    ))
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
    _name: &str,
    input: &Value,
    moka: &MokaFile,
) -> Result<ToolOutcome, ToolError> {
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
    let model = args.opt_str("model").unwrap_or("").to_string();
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
    if active >= state.story_jobs.limits().max_active_jobs_per_project {
        return Err(ToolError::new(
            "STORY_JOB_BUSY",
            "this project already has a job in progress",
        ));
    }
    // A named model is resolved as it stands; none means the deployment's
    // default for this capability. Passing the raw choice through would record
    // a model id the record cannot use and leave the failure to the run.
    let named = model.trim();
    let resolved = if named.is_empty() {
        state.models.resolve_default(kind.capability()).await
    } else {
        state.models.resolve(named, kind.capability()).await
    }
    .map_err(ToolError::from)?;
    let job = state
        .story_jobs
        .start(
            &session.0,
            story_id,
            kind,
            resolved.config_id,
            parallel,
            parsed,
        )
        .await?;
    Ok(ToolOutcome {
        summary: format!("Started a story job with {} items", items.len()),
        data: json!({"jobId": job.id, "storyId": job.story_id}),
        task: Some(TaskRef {
            kind: "storyJob".into(),
            id: job.id,
        }),
        ..ToolOutcome::default()
    })
}

fn _slot_target_family(_: &StorySlotTarget) {}
