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
    StoryActPatch, StoryBriefPatch, StoryDocument, StoryEdit, StoryEditClip, StoryElement,
    StoryElementPatch, StoryKeyframePatch, StorySlot, StorySlotTarget, StoryTake,
    StoryVoiceProfile, REFERENCE_IMAGES_MAX, STORY_SCHEMA_VERSION,
};
use crate::domain::{
    now_iso, DocumentCommand, MokaFile, TimelineClip, TimelineDocument, TimelineSettings,
    TimelineTrack, TrackKind,
};

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
            let mut data = json!({
                "story": {
                    "id": story.id,
                    "name": story.name,
                    "shotGranularity": story.shot_granularity,
                    "maxReferenceImages": story.max_reference_images,
                    "confirmedSteps": story.confirmed_steps,
                },
            });
            if wants("brief") {
                data["brief"] = json!(story.brief);
            }
            if wants("chapters") {
                data["chapters"] = json!(story
                    .chapters
                    .iter()
                    .map(|chapter| json!({
                        "id": chapter.id,
                        "title": chapter.title,
                        "synopsis": shorten(&chapter.synopsis, 2_000),
                        "targetDurationMs": chapter.target_duration_ms,
                        "actCount": chapter.acts.len(),
                    }))
                    .collect::<Vec<_>>());
            }
            if wants("elements") {
                data["elements"] = json!(story.elements);
            }
            if wants("storyboard") {
                data["acts"] = json!(story
                    .chapters
                    .iter()
                    .flat_map(|chapter| chapter.acts.iter().map(move |act| json!({
                        "id": act.id,
                        "chapterId": chapter.id,
                        "title": act.title,
                        "summary": shorten(&act.summary, 2_000),
                        "keyframeCount": act.keyframes.len(),
                        "videoTakes": act.video.takes.len(),
                        "voiceTakes": act.voice.as_ref().map(|voice| voice.takes.len()).unwrap_or(0),
                        "musicTakes": act.music.as_ref().map(|music| music.takes.len()).unwrap_or(0),
                    })))
                    .collect::<Vec<_>>());
                data["keyframes"] = json!(story
                    .chapters
                    .iter()
                    .flat_map(|chapter| {
                        chapter.acts.iter().flat_map(move |act| {
                            act.keyframes.iter().map(move |keyframe| json!({
                                "id": keyframe.id,
                                "actId": act.id,
                                "title": keyframe.title,
                                "shotSize": keyframe.shot_size,
                                "cameraMove": keyframe.camera_move,
                                "angle": keyframe.angle,
                                "durationMs": keyframe.duration_ms,
                                "content": shorten(&keyframe.content, 2_000),
                                "dialogue": keyframe.dialogue,
                                "artTakes": keyframe.art.takes.len(),
                                "videoTakes": keyframe.video.takes.len(),
                                "currentArt": keyframe.art.takes.last().and_then(|take| take.asset_ids.first()),
                            }))
                        })
                    })
                    .collect::<Vec<_>>());
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
        "story.assemble" => assemble(moka, &args),
        other => Err(ToolError::new(
            "TOOL_NOT_FOUND",
            format!("tool {other} is not a story command"),
        )),
    }
}

fn shorten(text: &str, limit: usize) -> String {
    let mut value: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        value.push('…');
    }
    value
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
    StorySlot { takes: Vec::new() }
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
            voice: None,
            music: None,
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
            dialogue: Vec::new(),
            duration_ms: 4_000,
            art: empty_slot(),
            video: empty_slot(),
            voices: None,
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
    Ok(keyframe)
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
    let patch: StoryKeyframePatch = serde_json::from_value(
        args.raw("patch")
            .cloned()
            .ok_or_else(|| ToolError::validation("story.update_keyframe needs a patch"))?,
    )
    .map_err(|error| ToolError::validation(format!("patch is not valid: {error}")))?;
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
        voice: None,
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
        StorySlotTarget::Element { element_id, view } => story
            .elements
            .iter()
            .find(|element| element.id == *element_id)
            .map(|element| match view {
                crate::domain::story::StoryElementView::Main => &element.main,
                crate::domain::story::StoryElementView::Turnaround => {
                    element.turnaround.as_ref().unwrap_or(&element.main)
                }
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
            let previous_last = slot.takes.last().cloned();
            slot.takes.push(take.clone());
            if slot.takes.len() > crate::domain::story::MAX_TAKES_PER_SLOT {
                slot.takes.remove(0);
                warnings.push("the oldest take was dropped to stay within 12".to_string());
            }
            if !args.opt_bool("makeCurrent", true) {
                if let Some(previous) = previous_last {
                    slot.takes.pop();
                    slot.takes.push(previous);
                    let _ = take;
                }
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
    let mut gaps = Vec::new();
    let has_idea = !story.brief.idea.trim().is_empty();
    let has_outline = !story.chapters.is_empty()
        && story
            .chapters
            .iter()
            .all(|chapter| !chapter.title.trim().is_empty());
    let has_elements = !story.elements.is_empty();
    let mut board_ok = !story.chapters.is_empty();
    for chapter in &story.chapters {
        if chapter.acts.is_empty() {
            board_ok = false;
            gaps.push(json!({"step": "storyboard", "chapterId": chapter.id, "kind": "missingActs", "message": format!("{} has no acts", chapter.title)}));
        }
        for act in &chapter.acts {
            if act.keyframes.is_empty() {
                board_ok = false;
                gaps.push(json!({"step": "storyboard", "chapterId": chapter.id, "actId": act.id, "kind": "missingKeyframes", "message": format!("{} has no shots", act.title)}));
            }
        }
    }
    let edit_ok = story.edit.timeline_id.is_some();
    let ready = json!({
        "idea": has_idea,
        "outline": has_outline,
        "elements": has_elements,
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
    Ok(ToolOutcome::write(
        format!("Confirmed {key}"),
        json!({"confirmedSteps": story.confirmed_steps, "step": key}),
        vec![DocumentCommand::ConfirmStoryStep {
            story_id: story.id.clone(),
            step,
            confirmed: true,
        }],
    ))
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
        parsed.push(crate::story::StoryJobItem::queued(
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
        ));
    }
    let model = args.opt_str("model").unwrap_or("").to_string();
    let job = state
        .story_jobs
        .start(&session.0, story_id, kind, model, parsed)
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
