//! Planning a story batch from the document as it stands.
//!
//! The room's own planners live beside the buttons that press them, which is
//! where a prompt belongs. An agent outside the room has no buttons, so this is
//! the same arithmetic in one place it can reach: which places still need work,
//! what each ask says, which pictures travel with it, and which model answers.
//! Nothing is written here and nothing is asked: the result is a batch a caller
//! starts with `story.start_job`.

use serde_json::{json, Value};

use crate::api::ApiState;
use crate::domain::story::{
    StoryAct, StoryAspect, StoryChapter, StoryDocument, StoryElement, StoryKeyframe,
    StoryPictureReference, StorySlot, StoryVoiceProfile, MAX_IMAGES_PER_ASK, MAX_KEYFRAME_MS,
};
use crate::domain::MokaFile;
use crate::prompts::{self, Prompt};

use super::super::error::ToolError;
use super::{Args, ToolOutcome};

/// The app's own ceiling for one clip, when no model's window is known.
const APP_VIDEO_SECONDS: u32 = 600;
/// What one story batch may carry; the server refuses more.
const MAX_ITEMS_PER_JOB: usize = 40;

struct Planned {
    model: Option<String>,
    value: Value,
}

pub async fn command(
    state: &ApiState,
    moka: &MokaFile,
    input: &Value,
) -> Result<ToolOutcome, ToolError> {
    let args = Args::new("story.plan_job", input)?;
    let story = super::story_of(moka, args.req_str("storyId")?)?;
    let kind = args.req_str("kind")?.to_string();
    let chapter_id = args.opt_str("chapterId").map(str::to_string);
    let act_id = args.opt_str("actId").map(str::to_string);
    let keyframe_ids = args.opt_strings("keyframeIds");
    let element_ids = args.opt_strings("elementIds");
    let views = args.opt_strings("views");
    let model = args.opt_str("model").unwrap_or_default().to_string();
    let video_model = args.opt_str("videoModel").unwrap_or_default().to_string();
    let include_existing = args.opt_bool("includeExisting", false);
    let count = args
        .opt_i64("count")
        .unwrap_or(1)
        .clamp(1, MAX_IMAGES_PER_ASK as i64) as usize;

    let mut warnings = Vec::new();
    let mut planned = match kind.as_str() {
        "outline" => plan_outline(story)?,
        "elements" => plan_elements(story)?,
        "storyboard" => {
            plan_storyboard(
                state,
                story,
                require_chapter(&chapter_id, "storyboard")?,
                &video_model,
                &model,
            )
            .await?
        }
        "actPlan" => plan_act_plan(
            story,
            require_chapter(&chapter_id, "actPlan")?,
            act_id.as_deref(),
            &model,
        )?,
        "elementArt" => plan_element_art(
            story,
            &chapter_id,
            &element_ids,
            &views,
            include_existing,
            count,
            &model,
            &mut warnings,
        )?,
        "keyframeArt" => plan_keyframe_art(
            story,
            require_chapter(&chapter_id, "keyframeArt")?,
            act_id.as_deref(),
            &keyframe_ids,
            include_existing,
            count,
            &model,
            &mut warnings,
        )?,
        "actVideo" => {
            plan_act_videos(
                state,
                story,
                require_chapter(&chapter_id, "actVideo")?,
                act_id.as_deref(),
                include_existing,
                &model,
                &mut warnings,
            )
            .await?
        }
        "keyframeVideo" => {
            plan_keyframe_videos(
                state,
                story,
                require_chapter(&chapter_id, "keyframeVideo")?,
                act_id.as_deref(),
                &keyframe_ids,
                include_existing,
                &model,
                &mut warnings,
            )
            .await?
        }
        "lineVoice" => plan_line_voices(
            story,
            require_chapter(&chapter_id, "lineVoice")?,
            act_id.as_deref(),
            include_existing,
            &model,
            &mut warnings,
        ),
        "music" => plan_music(
            story,
            require_chapter(&chapter_id, "music")?,
            act_id.as_deref(),
            include_existing,
            &model,
            &mut warnings,
        ),
        other => {
            return Err(ToolError::validation(format!(
                "unknown story plan kind '{other}'"
            )))
        }
    };

    let total = planned.len();
    let flat: Vec<Value> = planned.iter().map(|item| item.value.clone()).collect();
    let waves = group_waves(&mut planned);
    Ok(ToolOutcome::read(
        format!("planned {total} {kind} items"),
        json!({
            "storyId": story.id,
            "kind": kind,
            "chapterId": chapter_id,
            "items": flat,
            "waves": waves,
            "warnings": warnings,
        }),
    ))
}

// -----------------------------------------------------------------------------
// The words a telling is asked for
// -----------------------------------------------------------------------------

fn plan_outline(story: &StoryDocument) -> Result<Vec<Planned>, ToolError> {
    let prompt = join_prompts(&[
        facts_prompt(story)?,
        render(
            Prompt::StoryOutline,
            json!({
                "idea": story.brief.idea,
                "chapters": story.chapters.len().max(1),
            }),
        )?,
    ]);
    Ok(vec![Planned {
        model: None,
        value: job_item(
            "outline",
            json!({"kind": "outline"}),
            "text",
            prompt,
            Some(system_prompt()?),
            Vec::new(),
            json!({}),
            None,
            None,
            None,
        ),
    }])
}

fn plan_elements(story: &StoryDocument) -> Result<Vec<Planned>, ToolError> {
    let chapters: Vec<Value> = story
        .chapters
        .iter()
        .enumerate()
        .map(|(at, chapter)| {
            json!({
                "number": at + 1,
                "title": chapter.title,
                "text": chapter.synopsis,
            })
        })
        .collect();
    let prompt = join_prompts(&[
        facts_prompt(story)?,
        render(
            Prompt::StoryElements,
            json!({
                "chapters": chapters,
                "elements": elements_list(story),
            }),
        )?,
    ]);
    Ok(vec![Planned {
        model: None,
        value: job_item(
            "elements",
            json!({"kind": "elements"}),
            "text",
            prompt,
            Some(system_prompt()?),
            Vec::new(),
            json!({}),
            None,
            None,
            None,
        ),
    }])
}

async fn plan_storyboard(
    state: &ApiState,
    story: &StoryDocument,
    chapter_id: &str,
    video_model: &str,
    model: &str,
) -> Result<Vec<Planned>, ToolError> {
    let chapter = chapter_of(story, chapter_id)?;
    let number = story
        .chapters
        .iter()
        .position(|held| held.id == chapter.id)
        .unwrap_or(0)
        + 1;
    let ceiling = video_ceiling(state, video_model).await;
    let max_shot_seconds = u32::min(MAX_KEYFRAME_MS as u32 / 1000, ceiling);
    let planned = chapter_plan(chapter);
    let prompt = join_prompts(&[
        facts_prompt(story)?,
        render(
            Prompt::StoryStoryboard,
            json!({
                "number": number,
                "chapter": {"title": chapter.title, "text": chapter.synopsis},
                "targetDurationMs": chapter.target_duration_ms,
                "seconds": (chapter.target_duration_ms as f64 / 1000.0).round() as i64,
                "maxVideoSeconds": ceiling,
                "maxShotSeconds": max_shot_seconds,
                "elements": elements_list(story),
                "planned": planned,
                "shotSizes": SHOT_SIZES,
                "cameraMoves": CAMERA_MOVES,
                "angles": CAMERA_ANGLES,
            }),
        )?,
    ]);
    Ok(vec![Planned {
        model: none_if_empty(model),
        value: job_item(
            &format!("storyboard:{}", chapter.id),
            json!({"kind": "storyboard", "chapterId": chapter.id}),
            "text",
            prompt,
            Some(system_prompt()?),
            Vec::new(),
            json!({}),
            None,
            None,
            None,
        ),
    }])
}

fn plan_act_plan(
    story: &StoryDocument,
    chapter_id: &str,
    act_id: Option<&str>,
    model: &str,
) -> Result<Vec<Planned>, ToolError> {
    let chapter = chapter_of(story, chapter_id)?;
    let regular: Vec<&StoryAct> = chapter
        .acts
        .iter()
        .filter(|act| act.transition.is_none())
        .collect();
    let single = act_id.and_then(|id| regular.iter().copied().find(|act| act.id == id));
    if act_id.is_some() && single.is_none() {
        return Err(ToolError::new(
            "ACT_NOT_FOUND",
            format!("act {} does not exist", act_id.unwrap_or_default()),
        ));
    }
    let standing = match single {
        Some(act) => format!(
            "Write the plan for this one act only:\n- {} — “{}” — {}",
            act.id, act.title, act.summary
        ),
        None if regular.is_empty() => "The chapter has no acts yet: write them.".to_string(),
        None => {
            let mut lines = vec![
                "The chapter is already planned as the acts below. Keep each actId and the order; rewrite what the chapter needs.".to_string(),
            ];
            for act in &regular {
                lines.push(format!(
                    "- {} — “{}” — {}{}",
                    act.id,
                    act.title,
                    act.summary,
                    act.plan
                        .as_deref()
                        .map(|plan| format!(" — {plan}"))
                        .unwrap_or_default()
                ));
            }
            lines.join("\n")
        }
    };
    let number = story
        .chapters
        .iter()
        .position(|held| held.id == chapter.id)
        .unwrap_or(0)
        + 1;
    let prompt = join_prompts(&[
        facts_prompt(story)?,
        render(
            Prompt::StoryActPlan,
            json!({
                "number": number,
                "chapter": {"title": chapter.title, "text": chapter.synopsis},
                "seconds": (chapter.target_duration_ms as f64 / 1000.0).round() as i64,
                "standing": standing,
                "elements": elements_list(story),
            }),
        )?,
    ]);
    let id = match single {
        Some(act) => format!("actPlan:{}:{}", chapter.id, act.id),
        None => format!("actPlan:{}", chapter.id),
    };
    let target = match single {
        Some(act) => json!({"kind": "actPlan", "chapterId": chapter.id, "actId": act.id}),
        None => json!({"kind": "actPlan", "chapterId": chapter.id}),
    };
    Ok(vec![Planned {
        model: none_if_empty(model),
        value: job_item(
            &id,
            target,
            "text",
            prompt,
            Some(system_prompt()?),
            Vec::new(),
            json!({}),
            None,
            None,
            None,
        ),
    }])
}

// -----------------------------------------------------------------------------
// The pictures of a cast and of a board
// -----------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn plan_element_art(
    story: &StoryDocument,
    chapter_id: &Option<String>,
    element_ids: &[String],
    views: &[String],
    include_existing: bool,
    count: usize,
    model: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<Planned>, ToolError> {
    let selected: Vec<&StoryElement> = if !element_ids.is_empty() {
        element_ids
            .iter()
            .filter_map(|id| story.elements.iter().find(|element| &element.id == id))
            .collect()
    } else if let Some(chapter_id) = chapter_id {
        let chapter = chapter_of(story, chapter_id)?;
        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
        for act in &chapter.acts {
            used.extend(act.character_ids.iter().cloned());
            used.extend(act.scene_id.iter().cloned());
            used.extend(act.prop_ids.iter().cloned());
            for keyframe in &act.keyframes {
                for name in mention_names(&keyframe.content) {
                    if let Some(element) =
                        story.elements.iter().find(|element| element.name == name)
                    {
                        used.insert(element.id.clone());
                    }
                }
            }
        }
        story
            .elements
            .iter()
            .filter(|element| {
                element.chapter_ids.iter().any(|id| id == chapter_id) || used.contains(&element.id)
            })
            .collect()
    } else {
        story.elements.iter().collect()
    };
    if selected.is_empty() {
        warnings.push("no elements are on file for this chapter".to_string());
        return Ok(Vec::new());
    }
    let wanted_views: Vec<String> = if views.is_empty() {
        vec!["main".to_string(), "turnaround".to_string()]
    } else {
        views.to_vec()
    };
    let set_id = format!("set_{}", crate::domain::new_id());
    let mut planned = Vec::new();
    for element in selected {
        let variants: Vec<Option<String>> = element
            .variants
            .as_ref()
            .map(|forms| {
                std::iter::once(None)
                    .chain(forms.iter().map(|form| Some(form.id.clone())))
                    .collect()
            })
            .unwrap_or_else(|| vec![None]);
        for variant_id in variants {
            let Some(look) = element_look(element, variant_id.as_deref()) else {
                continue;
            };
            for view in &wanted_views {
                if view == "turnaround" && element.kind.as_str() != "character" {
                    continue;
                }
                let existing = if view == "turnaround" {
                    look.turnaround.and_then(current_asset)
                } else {
                    current_asset(look.main)
                };
                if existing.is_some() && !include_existing {
                    continue;
                }
                if view == "turnaround" && current_asset(look.main).is_none() {
                    warnings.push(format!(
                        "{} has no main picture yet; draw it before its turn-around",
                        look.name
                    ));
                    continue;
                }
                let aspect = look.ratio.unwrap_or(story.brief.aspect);
                let target = match variant_id.as_deref() {
                    Some(variant_id) => json!({
                        "kind": "elementArt",
                        "elementId": element.id,
                        "view": view,
                        "variantId": variant_id,
                    }),
                    None => json!({
                        "kind": "elementArt",
                        "elementId": element.id,
                        "view": view,
                    }),
                };
                let id = match variant_id.as_deref() {
                    Some(variant_id) => {
                        format!("element:{}:{}:{}", view, element.id, variant_id)
                    }
                    None => format!("element:{}:{}", view, element.id),
                };
                let prompt = if let Some(prompt) = image_prompt_override(story, &id) {
                    prompt.to_string()
                } else if view == "turnaround" {
                    render(
                        Prompt::StoryElementTurnaround,
                        json!({
                            "name": look.name,
                            "description": look.description,
                            "style": story.brief.style,
                        }),
                    )?
                } else {
                    let reference = picture_reference_asset(story, look.reference);
                    render(
                        Prompt::StoryElementMain,
                        json!({
                            "kind": element.kind.as_str(),
                            "name": look.name,
                            "description": look.description,
                            "hasReference": reference.is_some(),
                            "aspect": aspect.as_str(),
                            "style": story.brief.style,
                        }),
                    )?
                };
                let inputs = if view == "turnaround" {
                    current_asset(look.main)
                        .map(|asset_id| vec![json!({"role": "reference", "assetId": asset_id})])
                        .unwrap_or_default()
                } else {
                    picture_reference_asset(story, look.reference)
                        .map(|asset_id| vec![json!({"role": "reference", "assetId": asset_id})])
                        .unwrap_or_default()
                };
                let name = if view == "turnaround" {
                    format!("{} turn-around", look.name)
                } else {
                    look.name.to_string()
                };
                let item_model =
                    none_if_empty(model).or_else(|| look.image_model.map(str::to_string));
                planned.extend(copy_items(
                    id,
                    target,
                    name,
                    prompt,
                    inputs,
                    json!({"size": image_size(aspect.as_str(), view == "turnaround")}),
                    item_model,
                    count,
                    Some(&set_id),
                ));
            }
        }
    }
    Ok(planned)
}

#[allow(clippy::too_many_arguments)]
fn plan_keyframe_art(
    story: &StoryDocument,
    chapter_id: &str,
    act_id: Option<&str>,
    keyframe_ids: &[String],
    include_existing: bool,
    count: usize,
    model: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<Planned>, ToolError> {
    let chapter = chapter_of(story, chapter_id)?;
    let set_id = format!("set_{}", crate::domain::new_id());
    let mut planned = Vec::new();
    for act in &chapter.acts {
        if act_id.is_some_and(|id| act.id != id) {
            continue;
        }
        for keyframe in &act.keyframes {
            if !keyframe_ids.is_empty() && !keyframe_ids.iter().any(|id| id == &keyframe.id) {
                continue;
            }
            if keyframe.art_not_needed {
                continue;
            }
            if current_asset(&keyframe.art).is_some() && !include_existing {
                continue;
            }
            let (cast, inputs) = keyframe_cast(story, act, keyframe, warnings);
            let target = json!({
                "kind": "keyframeArt",
                "chapterId": chapter.id,
                "actId": act.id,
                "keyframeId": keyframe.id,
            });
            let id = format!("keyframe:{}:{}:{}", chapter.id, act.id, keyframe.id);
            let prompt = if let Some(prompt) = image_prompt_override(story, &id) {
                prompt.to_string()
            } else {
                render(
                    Prompt::StoryKeyframe,
                    json!({
                        "aspect": story.brief.aspect.as_str(),
                        "style": story.brief.style,
                        "chapter": {"title": chapter.title},
                        "summary": act.summary,
                        "content": keyframe.content,
                        "shotSize": keyframe.shot_size.as_str(),
                        "angle": keyframe.angle.as_str(),
                        "cast": cast,
                    }),
                )?
            };
            let item_model = none_if_empty(model).or_else(|| {
                keyframe
                    .image_model
                    .clone()
                    .filter(|value| !value.trim().is_empty())
            });
            planned.extend(copy_items(
                id,
                target,
                keyframe.title.clone(),
                prompt,
                inputs,
                json!({"size": image_size(story.brief.aspect.as_str(), false)}),
                item_model,
                count,
                Some(&set_id),
            ));
        }
    }
    Ok(planned)
}

// -----------------------------------------------------------------------------
// The clips of a board
// -----------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn plan_act_videos(
    state: &ApiState,
    story: &StoryDocument,
    chapter_id: &str,
    act_id: Option<&str>,
    include_existing: bool,
    model: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<Planned>, ToolError> {
    let chapter = chapter_of(story, chapter_id)?;
    let mut planned = Vec::new();
    for act in &chapter.acts {
        if act_id.is_some_and(|id| act.id != id) {
            continue;
        }
        if act.transition.is_some() {
            warnings.push(format!(
                "{} is a bridge between acts; film its neighbours first",
                act.title
            ));
            continue;
        }
        if current_asset(&act.video).is_some() && !include_existing {
            continue;
        }
        if act.keyframes.is_empty() {
            warnings.push(format!("{} has no shots to film", act.title));
            continue;
        }
        let ceiling_model = none_if_empty(model).or_else(|| act.video_model.clone());
        let ceiling = video_ceiling(state, ceiling_model.as_deref().unwrap_or_default()).await;
        let pieces = act_pieces(act, ceiling, &act.title, warnings);
        if pieces.is_empty() {
            continue;
        }
        let total = pieces.len();
        let item_model = none_if_empty(model).or_else(|| {
            act.video_model
                .clone()
                .filter(|value| !value.trim().is_empty())
        });
        for (at, piece) in pieces.into_iter().enumerate() {
            let mut context = json!({
                "aspect": story.brief.aspect.as_str(),
                "style": story.brief.style,
                "title": act.title,
                "summary": act.summary,
                "seconds": piece.seconds,
                "shots": piece.shots,
                "hasDialogue": piece.has_dialogue,
                "words": piece.words,
                "references": piece.references,
            });
            if total > 1 {
                context["part"] = json!(at + 1);
                context["total"] = json!(total);
            }
            let base = format!("actVideo:{}:{}", chapter.id, act.id);
            let id = if total > 1 {
                format!("{base}:{}", at + 1)
            } else {
                base
            };
            let prompt = match video_prompt_override(story, &id) {
                Some(prompt) => prompt.to_string(),
                None => render(Prompt::StoryActVideo, context)?,
            };
            planned.push(Planned {
                model: item_model.clone(),
                value: job_item(
                    &id,
                    json!({"kind": "actVideo", "chapterId": chapter.id, "actId": act.id}),
                    "video",
                    prompt,
                    None,
                    piece.inputs,
                    json!({
                        "seconds": piece.seconds,
                        "ratio": story.brief.aspect.as_str(),
                        "mode": if piece.references { "reference" } else { "auto" },
                    }),
                    Some(act.title.clone()),
                    None,
                    None,
                ),
            });
        }
    }
    Ok(planned)
}

#[allow(clippy::too_many_arguments)]
async fn plan_keyframe_videos(
    state: &ApiState,
    story: &StoryDocument,
    chapter_id: &str,
    act_id: Option<&str>,
    keyframe_ids: &[String],
    include_existing: bool,
    model: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<Planned>, ToolError> {
    let chapter = chapter_of(story, chapter_id)?;
    let mut planned = Vec::new();
    for act in &chapter.acts {
        if act_id.is_some_and(|id| act.id != id) {
            continue;
        }
        let ceiling_model = none_if_empty(model).or_else(|| act.video_model.clone());
        let ceiling = video_ceiling(state, ceiling_model.as_deref().unwrap_or_default()).await;
        let item_model = none_if_empty(model).or_else(|| {
            act.video_model
                .clone()
                .filter(|value| !value.trim().is_empty())
        });
        for (at, keyframe) in act.keyframes.iter().enumerate() {
            if !keyframe_ids.is_empty() && !keyframe_ids.iter().any(|id| id == &keyframe.id) {
                continue;
            }
            if current_asset(&keyframe.video).is_some() && !include_existing {
                continue;
            }
            let Some(frame) = current_asset(&keyframe.art) else {
                warnings.push(format!(
                    "{} has no picture yet; draw it before filming it",
                    keyframe.title
                ));
                continue;
            };
            let last_frame = act
                .keyframes
                .get(at + 1)
                .and_then(|next| current_asset(&next.art))
                .filter(|next| next != &frame);
            let seconds = clamp_seconds(keyframe.duration_ms, ceiling);
            let mut inputs = vec![json!({"role": "firstFrame", "assetId": frame})];
            if let Some(last_frame) = last_frame {
                inputs.push(json!({"role": "lastFrame", "assetId": last_frame}));
            }
            let id = format!("keyframeVideo:{}:{}:{}", chapter.id, act.id, keyframe.id);
            let prompt = match video_prompt_override(story, &id) {
                Some(prompt) => prompt.to_string(),
                None => render(
                    Prompt::StoryKeyframeVideo,
                    json!({
                        "aspect": story.brief.aspect.as_str(),
                        "style": story.brief.style,
                        "title": keyframe.title,
                        "content": strip_mentions(&keyframe.content),
                        "motion": keyframe.motion.as_deref().map(strip_mentions).unwrap_or_default(),
                        "move": keyframe.camera_move.as_str(),
                        "seconds": seconds,
                        "dialogue": spoken_lines(&keyframe.dialogue),
                    }),
                )?,
            };
            planned.push(Planned {
                model: item_model.clone(),
                value: job_item(
                    &id,
                    json!({
                        "kind": "keyframeVideo",
                        "chapterId": chapter.id,
                        "actId": act.id,
                        "keyframeId": keyframe.id,
                    }),
                    "video",
                    prompt,
                    None,
                    inputs,
                    json!({
                        "seconds": seconds,
                        "ratio": story.brief.aspect.as_str(),
                    }),
                    Some(keyframe.title.clone()),
                    None,
                    None,
                ),
            });
        }
    }
    Ok(planned)
}

struct Piece {
    seconds: u32,
    shots: Vec<Value>,
    inputs: Vec<Value>,
    has_dialogue: bool,
    words: bool,
    references: bool,
}

fn act_pieces(act: &StoryAct, ceiling: u32, title: &str, warnings: &mut Vec<String>) -> Vec<Piece> {
    let mut pieces = Vec::new();
    let mut current: Vec<&StoryKeyframe> = Vec::new();
    let mut current_ms = 0_i64;
    let ceiling_ms = ceiling as i64 * 1000;
    for keyframe in &act.keyframes {
        if current_asset(&keyframe.art).is_none() && !keyframe.art_not_needed {
            warnings.push(format!(
                "{} shot “{}” has no picture yet; draw it before filming the act",
                title, keyframe.title
            ));
            return Vec::new();
        }
        if !current.is_empty() && current_ms + keyframe.duration_ms > ceiling_ms {
            pieces.push(piece_of(&current, ceiling));
            current.clear();
            current_ms = 0;
        }
        current.push(keyframe);
        current_ms += keyframe.duration_ms;
    }
    if !current.is_empty() {
        pieces.push(piece_of(&current, ceiling));
    }
    pieces
}

fn piece_of(shots: &[&StoryKeyframe], ceiling: u32) -> Piece {
    let ms: i64 = shots.iter().map(|keyframe| keyframe.duration_ms).sum();
    let pictured: Vec<String> = shots
        .iter()
        .filter_map(|keyframe| current_asset(&keyframe.art))
        .collect();
    let words = pictured.is_empty();
    let references = pictured.len() > 1;
    let mut at = 0_f64;
    let prompt_shots: Vec<Value> = shots
        .iter()
        .map(|keyframe| {
            let start = at;
            at += keyframe.duration_ms as f64 / 1000.0;
            let tenths = (start * 10.0).round() as i64;
            let at = if tenths % 10 == 0 {
                json!(tenths / 10)
            } else {
                json!(tenths as f64 / 10.0)
            };
            json!({
                "at": at,
                "content": strip_mentions(&keyframe.content),
                "motion": keyframe.motion.as_deref().map(strip_mentions).unwrap_or_default(),
                "move": keyframe.camera_move.as_str(),
                "dialogue": spoken_lines(&keyframe.dialogue),
            })
        })
        .collect();
    let has_dialogue = shots
        .iter()
        .any(|keyframe| !spoken_lines(&keyframe.dialogue).is_empty());
    let inputs = if words {
        Vec::new()
    } else if references {
        pictured
            .into_iter()
            .map(|asset_id| json!({"role": "reference", "assetId": asset_id}))
            .collect()
    } else {
        vec![json!({"role": "firstFrame", "assetId": pictured[0]})]
    };
    Piece {
        seconds: clamp_seconds(ms, ceiling),
        shots: prompt_shots,
        inputs,
        has_dialogue,
        words,
        references,
    }
}

// -----------------------------------------------------------------------------
// The sound of an act
// -----------------------------------------------------------------------------

fn plan_line_voices(
    story: &StoryDocument,
    chapter_id: &str,
    act_id: Option<&str>,
    include_existing: bool,
    model: &str,
    warnings: &mut Vec<String>,
) -> Vec<Planned> {
    let Ok(chapter) = chapter_of(story, chapter_id) else {
        return Vec::new();
    };
    let mut planned = Vec::new();
    for act in &chapter.acts {
        if act_id.is_some_and(|id| act.id != id) {
            continue;
        }
        for keyframe in &act.keyframes {
            for line in &keyframe.dialogue {
                if line.text.trim().is_empty() {
                    continue;
                }
                if line_voice_exists(keyframe, line.id.as_deref()) && !include_existing {
                    continue;
                }
                let line_id = line.id.clone().unwrap_or_else(crate::domain::new_id);
                let voice = resolve_voice(story, line.character_id.as_deref(), &line.speaker);
                let item_model = none_if_empty(model).or_else(|| none_if_empty(&voice.model));
                let mut params = json!({});
                if let Some(reference) = &voice.reference_asset_id {
                    params["referenceAssetId"] = json!(reference);
                } else if !voice.voice.trim().is_empty() {
                    params["voice"] = json!(voice.voice);
                }
                if let Some(rate) = voice.rate {
                    params["rate"] = json!(rate);
                }
                if let Some(pitch) = voice.pitch {
                    params["pitch"] = json!(pitch);
                }
                let instructions = [
                    act.summary.trim().to_string(),
                    line.tone
                        .as_deref()
                        .map(str::trim)
                        .filter(|tone| !tone.is_empty())
                        .map(|tone| format!("（{tone}）"))
                        .unwrap_or_default(),
                    voice.instructions.clone().unwrap_or_default(),
                ]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
                if !instructions.is_empty() {
                    params["instructions"] = json!(instructions);
                }
                let inputs = voice
                    .reference_asset_id
                    .as_ref()
                    .map(|asset_id| vec![json!({"role": "reference", "assetId": asset_id})])
                    .unwrap_or_default();
                if line.id.is_none() {
                    warnings.push(format!(
                        "line “{}” has no id yet; its take will be filed under a new one",
                        line.text.trim()
                    ));
                }
                planned.push(Planned {
                    model: item_model,
                    value: job_item(
                        &format!(
                            "lineVoice:{}:{}:{}:{}",
                            chapter.id, act.id, keyframe.id, line_id
                        ),
                        json!({
                            "kind": "lineVoice",
                            "chapterId": chapter.id,
                            "actId": act.id,
                            "keyframeId": keyframe.id,
                            "lineId": line_id,
                        }),
                        "speech",
                        line.text.clone(),
                        None,
                        inputs,
                        params,
                        Some(format!("{} line", keyframe.title)),
                        None,
                        None,
                    ),
                });
            }
        }
    }
    planned
}

fn plan_music(
    story: &StoryDocument,
    chapter_id: &str,
    act_id: Option<&str>,
    include_existing: bool,
    model: &str,
    _warnings: &mut Vec<String>,
) -> Vec<Planned> {
    let Ok(chapter) = chapter_of(story, chapter_id) else {
        return Vec::new();
    };
    let mut planned = Vec::new();
    for act in &chapter.acts {
        if act_id.is_some_and(|id| act.id != id) {
            continue;
        }
        let has_music = act
            .music
            .as_ref()
            .is_some_and(|slot| current_asset(slot).is_some());
        if has_music && !include_existing {
            continue;
        }
        let music = act.sound.music.trim();
        let sfx = act.sound.sfx.trim();
        let ambience = act.sound.ambience.as_deref().unwrap_or("").trim();
        if music.is_empty() && sfx.is_empty() && ambience.is_empty() {
            continue;
        }
        let seconds = clamp_seconds(act_ms(act), APP_VIDEO_SECONDS);
        let prompt = match render(
            Prompt::StoryActMusic,
            json!({
                "aspect": story.brief.aspect.as_str(),
                "style": story.brief.style,
                "genre": story.brief.genre,
                "title": act.title,
                "summary": act.summary,
                "music": music,
                "sfx": sfx,
                "ambience": ambience,
                "seconds": seconds,
            }),
        ) {
            Ok(prompt) => prompt,
            Err(_) => continue,
        };
        planned.push(Planned {
            model: none_if_empty(model),
            value: job_item(
                &format!("actMusic:{}:{}", chapter.id, act.id),
                json!({"kind": "music", "chapterId": chapter.id, "actId": act.id}),
                "music",
                prompt,
                None,
                Vec::new(),
                json!({"instrumental": true}),
                Some(act.title.clone()),
                None,
                None,
            ),
        });
    }
    planned
}

// -----------------------------------------------------------------------------
// Shared reading of a board
// -----------------------------------------------------------------------------

fn require_chapter<'a>(chapter_id: &'a Option<String>, kind: &str) -> Result<&'a str, ToolError> {
    chapter_id
        .as_deref()
        .ok_or_else(|| ToolError::validation(format!("{kind} needs chapterId")))
}

fn chapter_of<'a>(story: &'a StoryDocument, id: &str) -> Result<&'a StoryChapter, ToolError> {
    story
        .chapters
        .iter()
        .find(|chapter| chapter.id == id)
        .ok_or_else(|| ToolError::new("CHAPTER_NOT_FOUND", format!("chapter {id} does not exist")))
}

fn chapter_plan(chapter: &StoryChapter) -> Option<Vec<Value>> {
    let regular: Vec<&StoryAct> = chapter
        .acts
        .iter()
        .filter(|act| act.transition.is_none())
        .collect();
    if !regular.iter().any(|act| {
        act.plan
            .as_deref()
            .is_some_and(|plan| !plan.trim().is_empty())
    }) {
        return None;
    }
    Some(
        regular
            .iter()
            .map(|act| {
                json!({
                    "id": act.id,
                    "title": act.title,
                    "summary": act.summary,
                    "plan": act.plan.clone().unwrap_or_else(|| act.summary.clone()),
                })
            })
            .collect(),
    )
}

fn act_ms(act: &StoryAct) -> i64 {
    act.keyframes
        .iter()
        .map(|keyframe| keyframe.duration_ms)
        .sum::<i64>()
        .max(1)
}

fn current_asset(slot: &StorySlot) -> Option<String> {
    slot.takes
        .last()
        .and_then(|take| take.asset_ids.first().cloned())
}

fn line_voice_exists(keyframe: &StoryKeyframe, line_id: Option<&str>) -> bool {
    let Some(line_id) = line_id else {
        return false;
    };
    keyframe.voices.as_ref().is_some_and(|voices| {
        voices
            .iter()
            .any(|voice| voice.line_id == line_id && current_asset(&voice.slot).is_some())
    })
}

struct ElementLook<'a> {
    name: &'a str,
    description: &'a str,
    main: &'a StorySlot,
    turnaround: Option<&'a StorySlot>,
    reference: Option<&'a StoryPictureReference>,
    image_model: Option<&'a str>,
    ratio: Option<StoryAspect>,
}

fn element_look<'a>(
    element: &'a StoryElement,
    variant_id: Option<&str>,
) -> Option<ElementLook<'a>> {
    match variant_id {
        Some(variant_id) => {
            let form = element
                .variants
                .as_ref()?
                .iter()
                .find(|form| form.id == variant_id)?;
            Some(ElementLook {
                name: &form.name,
                description: &form.description,
                main: &form.main,
                turnaround: form.turnaround.as_ref(),
                reference: form.reference.as_ref(),
                image_model: form.image_model.as_deref(),
                ratio: form.ratio.or(element.ratio),
            })
        }
        None => Some(ElementLook {
            name: &element.name,
            description: &element.description,
            main: &element.main,
            turnaround: element.turnaround.as_ref(),
            reference: element.reference.as_ref(),
            image_model: element.image_model.as_deref(),
            ratio: element.ratio,
        }),
    }
}

fn picture_reference_asset(
    story: &StoryDocument,
    reference: Option<&StoryPictureReference>,
) -> Option<String> {
    match reference? {
        StoryPictureReference::Asset { asset_id } => Some(asset_id.clone()),
        StoryPictureReference::Element {
            element_id,
            variant_id,
        } => {
            let element = story
                .elements
                .iter()
                .find(|element| &element.id == element_id)?;
            current_asset(element_look(element, variant_id.as_deref())?.main)
        }
    }
}

struct CastLook {
    name: String,
    description: String,
    asset_id: String,
}

fn keyframe_cast(
    story: &StoryDocument,
    act: &StoryAct,
    keyframe: &StoryKeyframe,
    warnings: &mut Vec<String>,
) -> (Vec<Value>, Vec<Value>) {
    let mut wants: Vec<(String, Option<String>, String)> = Vec::new();
    let mut direct: Vec<CastLook> = Vec::new();
    if let Some(references) = &keyframe.references {
        for reference in references {
            if let Some(element_id) = &reference.element_id {
                push_want(
                    &mut wants,
                    element_id,
                    reference.variant_id.clone(),
                    reference.name.clone(),
                );
            } else if let Some(asset_id) = &reference.asset_id {
                direct.push(CastLook {
                    name: if reference.name.trim().is_empty() {
                        "Reference".to_string()
                    } else {
                        reference.name.clone()
                    },
                    description: "A picture this shot is drawn with.".to_string(),
                    asset_id: asset_id.clone(),
                });
            }
        }
    } else {
        let mentions = mention_names(&keyframe.content);
        if !mentions.is_empty() {
            for name in mentions {
                let Some(element) = story.elements.iter().find(|element| element.name == name)
                else {
                    warnings.push(format!(
                        "shot “{}” names “{}”, which is not in the cast",
                        keyframe.title, name
                    ));
                    continue;
                };
                let variant = keyframe.variant_choices.get(&element.id).cloned();
                push_want(&mut wants, &element.id, variant, name);
            }
        } else {
            for element_id in act
                .character_ids
                .iter()
                .chain(act.scene_id.iter())
                .chain(act.prop_ids.iter())
            {
                push_want(&mut wants, element_id, None, String::new());
            }
        }
    }
    // A place and a speaker are kept whether the words name them or not, but
    // only where the shot's own list already holds them: an emptied list is a
    // reader saying this shot carries no pictures at all.
    let mut required: Vec<(String, String)> = Vec::new();
    if act.scene_id.is_some()
        && keyframe.shot_size.as_str() != "close"
        && keyframe.shot_size.as_str() != "extremeClose"
    {
        required.push((
            act.scene_id.clone().unwrap_or_default(),
            story
                .elements
                .iter()
                .find(|element| Some(&element.id) == act.scene_id.as_ref())
                .map(|element| element.name.clone())
                .unwrap_or_default(),
        ));
    }
    for line in &keyframe.dialogue {
        if let Some(character_id) = &line.character_id {
            required.push((character_id.clone(), line.speaker.clone()));
        }
    }
    for (element_id, name) in required {
        if wants.iter().any(|(held, _, _)| held == &element_id) {
            let entry = wants
                .iter_mut()
                .find(|(held, _, _)| held == &element_id)
                .expect("the entry was just found");
            if entry.2.trim().is_empty() {
                entry.2 = name;
            }
        }
    }
    let mut cast = direct;
    for (element_id, variant_id, name) in wants {
        let Some(element) = story
            .elements
            .iter()
            .find(|element| element.id == element_id)
        else {
            continue;
        };
        let Some(look) = element_look(element, variant_id.as_deref()) else {
            continue;
        };
        let Some(asset_id) = current_asset(look.main) else {
            warnings.push(format!(
                "{} has no main picture yet; draw it before this frame",
                look.name
            ));
            continue;
        };
        cast.push(CastLook {
            name: if name.trim().is_empty() {
                look.name.to_string()
            } else {
                name
            },
            description: look.description.to_string(),
            asset_id,
        });
    }
    let mut seen = std::collections::HashSet::new();
    cast.retain(|entry| seen.insert(entry.asset_id.clone()));
    let limit = story.max_reference_images as usize;
    if cast.len() > limit {
        warnings.push(format!(
            "the shot names {} pictures; only the first {limit} travel",
            cast.len()
        ));
        cast.truncate(limit);
    }
    let cast_json = cast
        .iter()
        .map(|entry| json!({"name": entry.name, "description": entry.description}))
        .collect();
    let inputs = cast
        .iter()
        .map(|entry| json!({"role": "reference", "assetId": entry.asset_id}))
        .collect();
    (cast_json, inputs)
}

fn push_want(
    wants: &mut Vec<(String, Option<String>, String)>,
    element_id: &str,
    variant_id: Option<String>,
    name: String,
) {
    if wants
        .iter()
        .any(|(held, held_variant, _)| held == element_id && held_variant == &variant_id)
    {
        return;
    }
    wants.push((element_id.to_string(), variant_id, name));
}

fn resolve_voice(
    story: &StoryDocument,
    character_id: Option<&str>,
    speaker: &str,
) -> StoryVoiceProfile {
    let mut voice = StoryVoiceProfile::default();
    if let Some(narrator) = &story.narrator {
        merge_voice(&mut voice, narrator);
    }
    let character = character_id
        .and_then(|id| story.elements.iter().find(|element| element.id == id))
        .or_else(|| {
            story.elements.iter().find(|element| {
                element.kind.as_str() == "character" && element.name == speaker.trim()
            })
        });
    if let Some(character) = character {
        if let Some(own) = &character.voice {
            merge_voice(&mut voice, own);
        }
    }
    voice
}

fn merge_voice(into: &mut StoryVoiceProfile, from: &StoryVoiceProfile) {
    if !from.model.trim().is_empty() {
        into.model = from.model.clone();
    }
    if !from.voice.trim().is_empty() {
        into.voice = from.voice.clone();
    }
    if from.rate.is_some() {
        into.rate = from.rate;
    }
    if from.pitch.is_some() {
        into.pitch = from.pitch;
    }
    if from.instructions.is_some() {
        into.instructions = from.instructions.clone();
    }
    if from.reference_asset_id.is_some() {
        into.reference_asset_id = from.reference_asset_id.clone();
    }
}

// -----------------------------------------------------------------------------
// Words and pieces
// -----------------------------------------------------------------------------

fn facts_prompt(story: &StoryDocument) -> Result<String, ToolError> {
    render(
        Prompt::StoryFacts,
        json!({
            "aspect": story.brief.aspect.as_str(),
            "genre": story.brief.genre,
            "style": story.brief.style,
            "total": format_duration(story.brief.total_duration_ms),
        }),
    )
}

fn system_prompt() -> Result<String, ToolError> {
    render(Prompt::StorySystem, json!({}))
}

fn render(prompt: Prompt, context: Value) -> Result<String, ToolError> {
    prompts::render(prompt, &context)
        .map_err(|error| ToolError::new("PROMPT_TEMPLATE_FAILED", error.to_string()))
}

/// The words a reader wrote for one picture, keyed by the ask's own id.
fn image_prompt_override<'a>(story: &'a StoryDocument, id: &str) -> Option<&'a str> {
    story
        .image_prompt_overrides
        .as_ref()
        .and_then(|overrides| overrides.get(id))
        .map(|override_| override_.prompt.as_str())
}

/// The same for one clip.
fn video_prompt_override<'a>(story: &'a StoryDocument, id: &str) -> Option<&'a str> {
    story
        .video_prompt_overrides
        .as_ref()
        .and_then(|overrides| overrides.get(id))
        .map(|override_| override_.prompt.as_str())
}

fn join_prompts(parts: &[String]) -> String {
    parts
        .iter()
        .filter(|part| !part.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn elements_list(story: &StoryDocument) -> String {
    story
        .elements
        .iter()
        .map(|element| {
            format!(
                "- {} ({}) — {}",
                element.name,
                element.kind.as_str(),
                element.description
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn spoken_lines(lines: &[crate::domain::story::StoryDialogueLine]) -> String {
    lines
        .iter()
        .filter(|line| !line.text.trim().is_empty())
        .map(|line| {
            let said = format!("\"{}\"", line.text.trim());
            let speaker = line.speaker.trim();
            if speaker.is_empty() {
                said
            } else {
                match line
                    .tone
                    .as_deref()
                    .map(str::trim)
                    .filter(|tone| !tone.is_empty())
                {
                    Some(tone) => format!("{speaker} ({tone}): {said}"),
                    None => format!("{speaker}: {said}"),
                }
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn strip_mentions(content: &str) -> String {
    let chars: Vec<char> = content.chars().collect();
    let mut out = String::new();
    let mut at = 0;
    while at < chars.len() {
        if chars[at] == '`' {
            if let Some(close) = chars[at + 1..].iter().position(|ch| *ch == '`') {
                let end = at + 1 + close;
                let name: String = chars[at + 1..end].iter().collect();
                out.push_str(name.trim());
                at = end + 1;
                continue;
            }
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

fn mention_names(content: &str) -> Vec<String> {
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

fn image_size(aspect: &str, turnaround: bool) -> &'static str {
    if turnaround {
        return "1536x1024";
    }
    match aspect {
        "9:16" => "1024x1536",
        "1:1" => "1024x1024",
        _ => "1536x1024",
    }
}

fn clamp_seconds(ms: i64, ceiling: u32) -> u32 {
    let rounded = ((ms.max(0) as f64) / 1000.0).round() as i64;
    rounded.clamp(1, ceiling.max(1) as i64) as u32
}

async fn video_ceiling(state: &ApiState, model: &str) -> u32 {
    if model.trim().is_empty() {
        return APP_VIDEO_SECONDS;
    }
    let Ok(snapshot) = state.models.snapshot().await else {
        return APP_VIDEO_SECONDS;
    };
    snapshot
        .models
        .iter()
        .find(|held| held.id == model)
        .and_then(|held| held.max_video_seconds)
        .unwrap_or(APP_VIDEO_SECONDS)
        .clamp(1, APP_VIDEO_SECONDS)
}

fn none_if_empty(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

// -----------------------------------------------------------------------------
// A job item and the waves a batch may travel in
// -----------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn job_item(
    id: &str,
    target: Value,
    capability: &str,
    prompt: String,
    system: Option<String>,
    inputs: Vec<Value>,
    params: Value,
    name: Option<String>,
    copies: Option<usize>,
    set_id: Option<String>,
) -> Value {
    let mut value = json!({
        "id": id,
        "target": target,
        "capability": capability,
        "prompt": prompt,
        "inputs": inputs,
        "params": params,
    });
    if let Some(system) = system {
        value["system"] = json!(system);
    }
    if let Some(name) = name {
        value["name"] = json!(name);
    }
    if let Some(copies) = copies {
        value["copies"] = json!(copies);
    }
    if let Some(set_id) = set_id {
        value["setId"] = json!(set_id);
    }
    value
}

#[allow(clippy::too_many_arguments)]
fn copy_items(
    id: String,
    target: Value,
    name: String,
    prompt: String,
    inputs: Vec<Value>,
    params: Value,
    model: Option<String>,
    count: usize,
    set_id: Option<&str>,
) -> Vec<Planned> {
    if count <= 1 {
        return vec![Planned {
            model,
            value: job_item(
                &id,
                target,
                "image",
                prompt,
                None,
                inputs,
                params,
                Some(name),
                None,
                None,
            ),
        }];
    }
    (1..=count)
        .map(|at| Planned {
            model: model.clone(),
            value: job_item(
                &format!("{id}:{at}"),
                target.clone(),
                "image",
                prompt.clone(),
                None,
                inputs.clone(),
                params.clone(),
                Some(format!("{name} {at}")),
                Some(count),
                set_id.map(str::to_string),
            ),
        })
        .collect()
}

fn group_waves(planned: &mut Vec<Planned>) -> Value {
    let mut groups: Vec<(Option<String>, Vec<Value>)> = Vec::new();
    for item in planned.drain(..) {
        if let Some((_, group)) = groups
            .iter_mut()
            .find(|(model, _)| model.as_ref() == item.model.as_ref())
        {
            group.push(item.value);
        } else {
            groups.push((item.model, vec![item.value]));
        }
    }
    let mut waves = Vec::new();
    for (model, items) in groups {
        for chunk in items.chunks(MAX_ITEMS_PER_JOB) {
            waves.push(json!({"model": &model, "items": chunk}));
        }
    }
    json!(waves)
}

const SHOT_SIZES: [&str; 8] = [
    "extremeClose",
    "close",
    "mediumClose",
    "medium",
    "mediumFull",
    "full",
    "wide",
    "extremeWide",
];
const CAMERA_MOVES: [&str; 14] = [
    "static",
    "handheld",
    "pushIn",
    "pullOut",
    "panLeft",
    "panRight",
    "tiltUp",
    "tiltDown",
    "trackLeft",
    "trackRight",
    "arc",
    "craneUp",
    "zoomIn",
    "zoomOut",
];
const CAMERA_ANGLES: [&str; 7] = [
    "eyeLevel",
    "high",
    "low",
    "overhead",
    "dutch",
    "overTheShoulder",
    "pointOfView",
];
