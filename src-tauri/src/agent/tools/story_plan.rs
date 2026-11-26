//! Planning a story batch from the document as it stands.
//!
//! The room's own planners live beside the buttons that press them, which is
//! where a prompt belongs. An agent outside the room has no buttons, so this is
//! the same arithmetic in one place it can reach: which places still need work,
//! what each ask says, which pictures travel with it, and which model answers.
//! Nothing is written here and nothing is asked: the result is a batch a caller
//! starts with `story.start_job`.

use serde_json::{json, Value};

use std::collections::{BTreeMap, BTreeSet};

use crate::api::ApiState;
use crate::domain::story::{
    StoryAct, StoryAspect, StoryChapter, StoryDocument, StoryElement, StoryFilmRole, StoryKeyframe,
    StoryPictureReference, StoryShotGranularity, StorySlot, StoryVoiceProfile, MAX_IMAGES_PER_ASK,
    MAX_KEYFRAME_MS,
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
    let budget = args.opt_i64("budget");
    let count = args
        .opt_i64("count")
        .unwrap_or(1)
        .clamp(1, MAX_IMAGES_PER_ASK as i64) as usize;
    let instruction = args.opt_str("instruction").map(str::to_string);
    let mask_asset = args.opt_str("maskAssetId").map(str::to_string);
    let variant_id = args.opt_str("variantId").map(str::to_string);

    let mut warnings = Vec::new();
    let mut planned = match kind.as_str() {
        "outline" => match chapter_id.as_deref() {
            Some(chapter_id) => plan_chapter_outline(story, chapter_id, &model)?,
            None => plan_outline(story, &model)?,
        },
        "elements" => plan_elements(state, story, budget, &model).await?,
        "mergeElements" => plan_merge_elements(story, args.raw("groups").cloned(), &model)?,
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
        "continuity" => {
            plan_continuity(story, require_chapter(&chapter_id, "continuity")?, &model)?
        }
        "outlineRevision" => plan_outline_revision(
            story,
            require_chapter(&chapter_id, "outlineRevision")?,
            &model,
        )?,
        "pictureEdit" => plan_picture_edit(
            story,
            chapter_id.as_deref(),
            act_id.as_deref(),
            &keyframe_ids,
            &element_ids,
            &views,
            variant_id.as_deref(),
            instruction.as_deref(),
            mask_asset.as_deref(),
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
        "voice" => plan_act_voice(
            story,
            require_chapter(&chapter_id, "voice")?,
            act_id.as_deref(),
            include_existing,
            &model,
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
    let job_kind = match kind.as_str() {
        "mergeElements" => "elements",
        _ => kind.as_str(),
    };
    Ok(ToolOutcome::read(
        format!("planned {total} {kind} items"),
        json!({
            "storyId": story.id,
            "kind": job_kind,
            "plan": kind,
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

fn plan_outline(story: &StoryDocument, model: &str) -> Result<Vec<Planned>, ToolError> {
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
        model: none_if_empty(model),
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

/// How much of a telling one reading ask carries when nothing else says.
const DEFAULT_READING_BUDGET: usize = 500_000;
const MIN_READING_BUDGET: i64 = 1_000;
const MAX_READING_BUDGET: i64 = 1_000_000;

struct ReadingPiece {
    number: usize,
    title: String,
    text: String,
}

async fn plan_elements(
    state: &ApiState,
    story: &StoryDocument,
    budget: Option<i64>,
    model: &str,
) -> Result<Vec<Planned>, ToolError> {
    // A telling longer than one ask may carry is read a part at a time, the
    // way the room reads it: the parts keep the telling's own chapter numbers,
    // and the merge that puts repeated names together comes after them.
    let budget = match budget {
        Some(value) if (MIN_READING_BUDGET..=MAX_READING_BUDGET).contains(&value) => value as usize,
        Some(_) => {
            return Err(ToolError::validation(
                "budget must be between 1000 and 1000000 characters",
            ))
        }
        None => state
            .models
            .snapshot()
            .await
            .map(|view| view.preferences.story.split_chars as usize)
            .unwrap_or(DEFAULT_READING_BUDGET)
            .clamp(MIN_READING_BUDGET as usize, MAX_READING_BUDGET as usize),
    };
    let parts = chapter_reading_parts(story, budget);
    let total = parts.len().max(1);
    let (people, places) = element_inventory(story);
    let mut planned = Vec::new();
    for (at, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let numbers: BTreeSet<usize> = part.iter().map(|piece| piece.number).collect();
        let chapters: Vec<Value> = part
            .iter()
            .map(|piece| {
                json!({
                    "number": piece.number,
                    "title": piece.title,
                    "text": piece.text,
                })
            })
            .collect();
        let mut context = json!({"chapters": chapters});
        let id = if total == 1 {
            "elements".to_string()
        } else {
            context["part"] = json!(at + 1);
            context["total"] = json!(total);
            format!("elements:{}", at + 1)
        };
        let prompt = join_prompts(&[
            facts_prompt(story)?,
            inventory_prompt(&people, &places, &numbers),
            render(Prompt::StoryElements, context)?,
        ]);
        planned.push(Planned {
            model: none_if_empty(model),
            value: job_item(
                &id,
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
        });
    }
    Ok(planned)
}

/// The chapters of a telling packed into the asks that read them.
///
/// The same arithmetic as the room's own packer: a piece costs its words and
/// its title, neighbouring chapters share an ask until it is full, and a
/// chapter longer than one ask is cut back to a paragraph boundary and carried
/// into the next one. A batch less than half full is closed rather than
/// carried forward.
fn chapter_reading_parts(story: &StoryDocument, budget: usize) -> Vec<Vec<ReadingPiece>> {
    let limit = budget.max(1);
    let floor = (limit / 2).max(1);
    let mut waves: Vec<Vec<ReadingPiece>> = Vec::new();
    let mut wave: Vec<ReadingPiece> = Vec::new();
    let mut used = 0usize;
    for (index, chapter) in story.chapters.iter().enumerate() {
        let title = chapter.title.clone();
        let title_cost = title.chars().count();
        let mut rest: String = chapter.synopsis.trim().to_string();
        if rest.is_empty() {
            wave.push(ReadingPiece {
                number: index + 1,
                title,
                text: String::new(),
            });
            used += title_cost;
            if used >= limit {
                flush_wave(&mut waves, &mut wave, &mut used);
            }
            continue;
        }
        while !rest.is_empty() {
            let remaining = limit.saturating_sub(used);
            if remaining < floor {
                flush_wave(&mut waves, &mut wave, &mut used);
                continue;
            }
            let room = remaining.saturating_sub(title_cost);
            if room == 0 {
                if !wave.is_empty() {
                    flush_wave(&mut waves, &mut wave, &mut used);
                    continue;
                }
                let length = rest.chars().count();
                wave.push(ReadingPiece {
                    number: index + 1,
                    title: title.clone(),
                    text: rest.clone(),
                });
                used += length + title_cost;
                rest.clear();
                flush_wave(&mut waves, &mut wave, &mut used);
                break;
            }
            let length = rest.chars().count();
            if length <= room {
                wave.push(ReadingPiece {
                    number: index + 1,
                    title: title.clone(),
                    text: rest.clone(),
                });
                used += length + title_cost;
                rest.clear();
                if used >= limit {
                    flush_wave(&mut waves, &mut wave, &mut used);
                }
                break;
            }
            let take = length.min(paragraph_cut_at(&rest, room)).max(1);
            let cut: String = rest.chars().take(take).collect();
            rest = rest.chars().skip(take).collect();
            wave.push(ReadingPiece {
                number: index + 1,
                title: title.clone(),
                text: cut,
            });
            used += take + title_cost;
            flush_wave(&mut waves, &mut wave, &mut used);
        }
    }
    flush_wave(&mut waves, &mut wave, &mut used);
    waves
}

fn flush_wave(waves: &mut Vec<Vec<ReadingPiece>>, wave: &mut Vec<ReadingPiece>, used: &mut usize) {
    if wave.is_empty() {
        return;
    }
    waves.push(std::mem::take(wave));
    *used = 0;
}

/// Where to cut a text so the cut lands between paragraphs where it can.
fn paragraph_cut_at(text: &str, limit: usize) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let length = chars.len();
    if limit >= length {
        return length;
    }
    let wanted = limit.max(1);
    if wanted >= 2 {
        let upto = wanted.saturating_sub(2).min(length.saturating_sub(2));
        for at in (0..=upto).rev() {
            if chars[at] == '\n' && chars[at + 1] == '\n' {
                return at + 2;
            }
        }
    }
    let upto = wanted.saturating_sub(1);
    for at in (0..=upto).rev() {
        if chars[at] == '\n' {
            return at + 1;
        }
    }
    wanted
}

pub(super) type PeopleIndex = BTreeMap<String, BTreeSet<usize>>;
pub(super) type PlaceIndex = BTreeMap<String, (usize, BTreeSet<usize>)>;

/// Who and what the telling's own notes say it is made of.
///
/// The cast lists and scene headings a script already carries are read back
/// as an index: people by the chapters that name them, places by the scenes
/// they stand in. It is the telling's own words, not a reading of the plot.
pub(super) fn element_inventory(story: &StoryDocument) -> (PeopleIndex, PlaceIndex) {
    let mut people: PeopleIndex = BTreeMap::new();
    let mut places: PlaceIndex = BTreeMap::new();
    for (index, chapter) in story.chapters.iter().enumerate() {
        let number = index + 1;
        for name in chapter_cast(&chapter.synopsis) {
            people.entry(name).or_default().insert(number);
        }
        for place in chapter_places(&chapter.synopsis) {
            let entry = places.entry(place).or_insert_with(|| (0, BTreeSet::new()));
            entry.0 += 1;
            entry.1.insert(number);
        }
    }
    (people, places)
}

/// The prompt's own checklist, limited to the chapters this part reads.
fn inventory_prompt(people: &PeopleIndex, places: &PlaceIndex, numbers: &BTreeSet<usize>) -> String {
    let mut lines = Vec::new();
    let mut named: Vec<(&String, &BTreeSet<usize>)> = people
        .iter()
        .filter(|(_, chapters)| chapters.iter().any(|number| numbers.contains(number)))
        .collect();
    named.sort_by(|one, other| {
        let one_first = one.1.iter().next().copied().unwrap_or(0);
        let other_first = other.1.iter().next().copied().unwrap_or(0);
        one_first.cmp(&other_first).then_with(|| one.0.cmp(other.0))
    });
    if !named.is_empty() {
        lines.push("The telling's own cast lists name these people, by chapter:".to_string());
        for (name, chapters) in named {
            lines.push(format!("- {name} [{}]", chapter_list(chapters)));
        }
    }
    let mut recurring: Vec<(&String, &(usize, BTreeSet<usize>))> = places
        .iter()
        .filter(|(_, (scenes, chapters))| {
            *scenes >= 2 && chapters.iter().any(|number| numbers.contains(number))
        })
        .collect();
    recurring.sort_by(|one, other| other.1 .0.cmp(&one.1 .0).then(one.0.cmp(other.0)));
    if !recurring.is_empty() {
        lines.push(
            "These places recur in two or more scenes (place — scenes — chapters):".to_string(),
        );
        for (name, (scenes, chapters)) in recurring {
            lines.push(format!("- {name} — {scenes} scenes — [{}]", chapter_list(chapters)));
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    lines.push(
        "Every person named above and every place that recurs must have an entry; do not leave one out because part of its appearance is small, and keep the chapter numbers the telling gives.".to_string(),
    );
    lines.join("\n")
}

fn chapter_list(chapters: &BTreeSet<usize>) -> String {
    chapters
        .iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// The people a script's own `主要人物` line names.
fn chapter_cast(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed
            .strip_prefix("**主要人物**：")
            .or_else(|| trimmed.strip_prefix("**主要人物**:"))
        else {
            continue;
        };
        for piece in rest.split(['、', ',', '，']) {
            let name = piece
                .split(['（', '('])
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !name.is_empty() && name != "—" {
                names.push(name);
            }
        }
    }
    names
}

const SCENE_TIME_WORDS: [&str; 14] = [
    "清晨", "上午", "中午", "下午", "黄昏", "夜", "凌晨", "黎明前", "白天", "傍晚", "深夜", "清早",
    "正午", "午夜",
];

/// The places a script's own scene headings stand in, one per heading.
fn chapter_places(text: &str) -> Vec<String> {
    let mut places = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("## ") else {
            continue;
        };
        let Some(dot) = rest.find(". ") else {
            continue;
        };
        let label = rest[dot + 2..]
            .split(['（', '('])
            .next()
            .unwrap_or("")
            .trim();
        if label.is_empty() {
            continue;
        }
        let mut parts: Vec<&str> = label.split('·').collect();
        while let Some(last) = parts.last() {
            if SCENE_TIME_WORDS.contains(&last.trim()) {
                parts.pop();
            } else {
                break;
            }
        }
        let place = parts.join("·").trim().to_string();
        if !place.is_empty() {
            places.push(place);
        }
    }
    places
}

fn chapter_index(story: &StoryDocument, chapter_id: &str) -> Result<usize, ToolError> {
    story
        .chapters
        .iter()
        .position(|chapter| chapter.id == chapter_id)
        .ok_or_else(|| {
            ToolError::new(
                "CHAPTER_NOT_FOUND",
                format!("chapter {chapter_id} does not exist"),
            )
        })
}

fn chapter_revision(chapter: &StoryChapter) -> u32 {
    chapter.revision.max(1)
}

fn chapter_board_revision(chapter: &StoryChapter) -> u32 {
    chapter.board_revision.unwrap_or(chapter_revision(chapter))
}

fn chapter_outline_ahead(chapter: &StoryChapter) -> bool {
    chapter_board_revision(chapter) < chapter_revision(chapter)
}

/// FNV-1a over UTF-16 code units, the same reading the room writes into a
/// continuity ask's id.
fn fnv1a(text: &str) -> String {
    let mut hash = 0x811c_9dc5_u32;
    for unit in text.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

fn continuity_fingerprint(chapter: &StoryChapter) -> String {
    let mut rows = Vec::new();
    for act in &chapter.acts {
        if act.transition.is_some() {
            continue;
        }
        rows.push(format!(
            "act:{}:{}:{}:{}:{}",
            act.id,
            act.title,
            act.scene_id.as_deref().unwrap_or_default(),
            act.character_ids.join(","),
            act.prop_ids.join(","),
        ));
        for keyframe in &act.keyframes {
            rows.push(format!(
                "shot:{}:{}:{}:{}:{}:{}:{}",
                keyframe.id,
                keyframe.shot_size.as_str(),
                keyframe.camera_move.as_str(),
                keyframe.angle.as_str(),
                keyframe.duration_ms,
                keyframe.content,
                keyframe.motion.as_deref().unwrap_or_default(),
            ));
            for line in &keyframe.dialogue {
                rows.push(format!(
                    "line:{}:{}:{}",
                    line.id.as_deref().unwrap_or_default(),
                    line.speaker,
                    line.text
                ));
            }
        }
    }
    fnv1a(&rows.join("\n"))
}

fn continuity_board(story: &StoryDocument, chapter: &StoryChapter) -> String {
    chapter
        .acts
        .iter()
        .filter(|act| act.transition.is_none())
        .enumerate()
        .map(|(at, act)| {
            let cast = act
                .character_ids
                .iter()
                .filter_map(|id| story.elements.iter().find(|element| &element.id == id))
                .map(|element| element.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let place = act
                .scene_id
                .as_deref()
                .and_then(|id| story.elements.iter().find(|element| element.id == id))
                .map(|element| element.name.as_str())
                .unwrap_or("—");
            let shots = act
                .keyframes
                .iter()
                .enumerate()
                .map(|(shot_at, keyframe)| {
                    let lines = keyframe
                        .dialogue
                        .iter()
                        .map(|line| format!("    line ({}): {}", line.speaker, line.text))
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!(
                        "  Shot {} — id: {} — {}/{}/{}, {} ms\n    content: {}{}{}",
                        shot_at + 1,
                        keyframe.id,
                        keyframe.shot_size.as_str(),
                        keyframe.camera_move.as_str(),
                        keyframe.angle.as_str(),
                        keyframe.duration_ms,
                        keyframe.content,
                        keyframe
                            .motion
                            .as_deref()
                            .filter(|motion| !motion.is_empty())
                            .map(|motion| format!("\n    motion: {motion}"))
                            .unwrap_or_default(),
                        if lines.is_empty() {
                            String::new()
                        } else {
                            format!("\n{lines}")
                        },
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "Act {} — id: {} — “{}”\n  place: {}; cast: {}\n{}",
                at + 1,
                act.id,
                act.title,
                place,
                if cast.is_empty() { "—" } else { &cast },
                shots
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn plan_chapter_outline(
    story: &StoryDocument,
    chapter_id: &str,
    model: &str,
) -> Result<Vec<Planned>, ToolError> {
    let index = chapter_index(story, chapter_id)?;
    let chapter = &story.chapters[index];
    let around = |at: usize| {
        story.chapters.get(at).map(|held| {
            json!({
                "number": at + 1,
                "title": held.title,
                "text": held.synopsis.chars().take(1200).collect::<String>(),
            })
        })
    };
    let mut context = json!({
        "idea": story.brief.idea,
        "chapters": story.chapters.len(),
        "number": index + 1,
        "current": {
            "title": chapter.title,
            "text": chapter.synopsis.chars().take(1200).collect::<String>(),
        },
    });
    if index > 0 {
        context["previous"] = around(index - 1).unwrap_or(Value::Null);
    }
    if index + 1 < story.chapters.len() {
        context["next"] = around(index + 1).unwrap_or(Value::Null);
    }
    Ok(vec![Planned {
        model: none_if_empty(model),
        value: job_item(
            &format!("outline:rewrite:{}", index + 1),
            json!({"kind": "outline"}),
            "text",
            render(Prompt::StoryChapter, context)?,
            Some(system_prompt()?),
            Vec::new(),
            json!({}),
            None,
            None,
            None,
        ),
    }])
}

fn plan_continuity(
    story: &StoryDocument,
    chapter_id: &str,
    model: &str,
) -> Result<Vec<Planned>, ToolError> {
    let index = chapter_index(story, chapter_id)?;
    let chapter = &story.chapters[index];
    if chapter
        .acts
        .iter()
        .all(|act| act.transition.is_some() || act.keyframes.is_empty())
    {
        return Ok(Vec::new());
    }
    let mut context = json!({
        "number": index + 1,
        "chapter": {"title": chapter.title, "text": chapter.synopsis},
        "board": continuity_board(story, chapter),
        "shotSizes": ["extremeClose", "close", "mediumClose", "medium", "mediumFull", "full", "wide", "extremeWide"],
        "cameraMoves": ["static", "handheld", "pushIn", "pullOut", "panLeft", "panRight", "tiltUp", "tiltDown", "trackLeft", "trackRight", "arc", "craneUp", "zoomIn", "zoomOut"],
        "angles": ["eyeLevel", "high", "low", "overhead", "dutch", "overTheShoulder", "pointOfView"],
    });
    context["__facts"] = json!(facts_prompt(story)?);
    let prompt = join_prompts(&[
        facts_prompt(story)?,
        render(Prompt::StoryContinuity, context)?,
    ]);
    let stamp = format!(
        "{}:{}",
        chapter_revision(chapter),
        continuity_fingerprint(chapter)
    );
    Ok(vec![Planned {
        model: none_if_empty(model),
        value: job_item(
            &format!("continuity:{chapter_id}:{stamp}"),
            json!({"kind": "continuity", "chapterId": chapter_id}),
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

fn revision_made(
    story: &StoryDocument,
    chapter_id: &str,
    act_id: &str,
    keyframe: &StoryKeyframe,
) -> String {
    let mut made = Vec::new();
    if current_asset(&keyframe.art).is_some() {
        made.push("frame drawn");
    }
    if current_asset(&keyframe.video).is_some() {
        made.push("shot filmed");
    }
    if keyframe.voices.as_ref().is_some_and(|voices| {
        voices
            .iter()
            .any(|voice| current_asset(&voice.slot).is_some())
    }) {
        made.push("line read aloud");
    }
    let shot_id = format!("keyframeVideo:{}:{}:{}", chapter_id, act_id, keyframe.id);
    if video_prompt_override(story, &shot_id).is_some() {
        made.push("hand-written video prompt");
    }
    if made.is_empty() {
        "nothing yet".to_string()
    } else {
        made.join(", ")
    }
}

fn revision_acts(story: &StoryDocument, chapter: &StoryChapter) -> Value {
    json!(chapter
        .acts
        .iter()
        .filter(|act| act.transition.is_none())
        .map(|act| json!({
            "id": act.id,
            "title": act.title,
            "summary": act.summary,
            "frames": act.keyframes.iter().map(|keyframe| {
                let mut frame = json!({
                    "id": keyframe.id,
                    "title": keyframe.title,
                    "shotSize": keyframe.shot_size.as_str(),
                    "cameraMove": keyframe.camera_move.as_str(),
                    "angle": keyframe.angle.as_str(),
                    "durationMs": keyframe.duration_ms,
                    "content": keyframe.content,
                    "dialogue": keyframe.dialogue,
                    "made": revision_made(story, &chapter.id, &act.id, keyframe),
                });
                if let Some(motion) = keyframe
                    .motion
                    .as_deref()
                    .filter(|motion| !motion.trim().is_empty())
                {
                    frame["motion"] = json!(motion);
                }
                frame
            }).collect::<Vec<_>>(),
        }))
        .collect::<Vec<_>>())
}

fn plan_outline_revision(
    story: &StoryDocument,
    chapter_id: &str,
    model: &str,
) -> Result<Vec<Planned>, ToolError> {
    let index = chapter_index(story, chapter_id)?;
    let chapter = &story.chapters[index];
    if !chapter_outline_ahead(chapter) {
        return Ok(Vec::new());
    }
    let Some(before) = chapter.board_outline.as_ref() else {
        return Ok(Vec::new());
    };
    let prompt = join_prompts(&[
        facts_prompt(story)?,
        render(
            Prompt::StoryRevision,
            json!({
                "number": index + 1,
                "before": {"title": before.title, "text": before.synopsis},
                "after": {"title": chapter.title, "text": chapter.synopsis},
                "seconds": (chapter.target_duration_ms / 1000).max(1),
                "elements": elements_list(story),
                "acts": revision_acts(story, chapter),
                "shotSizes": ["extremeClose", "close", "mediumClose", "medium", "mediumFull", "full", "wide", "extremeWide"],
                "cameraMoves": ["static", "handheld", "pushIn", "pullOut", "panLeft", "panRight", "tiltUp", "tiltDown", "trackLeft", "trackRight", "arc", "craneUp", "zoomIn", "zoomOut"],
                "angles": ["eyeLevel", "high", "low", "overhead", "dutch", "overTheShoulder", "pointOfView"],
            }),
        )?,
    ]);
    Ok(vec![Planned {
        model: none_if_empty(model),
        value: job_item(
            &format!("outlineRevision:{chapter_id}:{}", chapter_revision(chapter)),
            json!({"kind": "outlineRevision", "chapterId": chapter_id}),
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

fn plan_merge_elements(
    _story: &StoryDocument,
    groups: Option<Value>,
    model: &str,
) -> Result<Vec<Planned>, ToolError> {
    let groups = groups
        .and_then(|value| value.as_array().cloned())
        .filter(|groups| !groups.is_empty())
        .ok_or_else(|| ToolError::validation("mergeElements needs a non-empty groups list"))?;
    Ok(vec![Planned {
        model: none_if_empty(model),
        value: job_item(
            "elements:merge",
            json!({"kind": "elements"}),
            "text",
            render(Prompt::StoryMergeElements, json!({"groups": groups}))?,
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
fn plan_picture_edit(
    story: &StoryDocument,
    chapter_id: Option<&str>,
    act_id: Option<&str>,
    keyframe_ids: &[String],
    element_ids: &[String],
    views: &[String],
    variant_id: Option<&str>,
    instruction: Option<&str>,
    mask_asset: Option<&str>,
    model: &str,
) -> Result<Vec<Planned>, ToolError> {
    let instruction = instruction
        .map(str::trim)
        .filter(|instruction| !instruction.is_empty())
        .ok_or_else(|| ToolError::validation("pictureEdit needs an instruction"))?;
    let look = format!(
        "The film's look: {}. No text, no lettering, no watermark, no frame around the picture.",
        story.brief.style
    );
    let masked = |lines: &mut Vec<String>| {
        if mask_asset.is_some() {
            lines.push("The second picture is a black-and-white mask: white marks the region to change and black the region to keep.".to_string());
        }
    };
    if !element_ids.is_empty() {
        let element_id = &element_ids[0];
        let element = story
            .elements
            .iter()
            .find(|element| &element.id == element_id)
            .ok_or_else(|| {
                ToolError::new(
                    "ELEMENT_NOT_FOUND",
                    format!("element {element_id} does not exist"),
                )
            })?;
        let look_of = element_look(element, variant_id).ok_or_else(|| {
            ToolError::validation(format!("element {element_id} has no such form"))
        })?;
        let view = views.first().map(String::as_str).unwrap_or("main");
        let slot = if view == "turnaround" {
            look_of.turnaround
        } else {
            Some(look_of.main)
        };
        let Some(source) = slot.and_then(current_asset) else {
            return Err(ToolError::new(
                "STEP_GAPS",
                format!("{} has no picture to edit", look_of.name),
            ));
        };
        let target = match variant_id {
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
        let id = match variant_id {
            Some(variant_id) => format!("element:{}:{}:{}", view, element.id, variant_id),
            None => format!("element:{}:{}", view, element.id),
        };
        let noun = match element.kind.as_str() {
            "character" => "character",
            "scene" => "place",
            _ => "thing",
        };
        let name = match variant_id.and_then(|id| {
            element
                .variants
                .as_ref()
                .and_then(|forms| forms.iter().find(|form| form.id == id))
        }) {
            Some(form) => format!("{} ({})", element.name, form.name),
            None => element.name.clone(),
        };
        let mut lines = vec![
            format!("Edit the reference picture of the {noun} \u{201c}{name}\u{201d} from the attached picture. Keep everything else unchanged \u{2014} the same face, hair, clothes, body and look; change only what the instruction says."),
            look,
        ];
        masked(&mut lines);
        let aspect = look_of.ratio.unwrap_or(story.brief.aspect);
        let mut inputs = vec![json!({"role": "reference", "assetId": source})];
        if let Some(mask) = mask_asset {
            inputs.push(json!({"role": "mask", "assetId": mask}));
        }
        return Ok(vec![Planned {
            model: none_if_empty(model).or_else(|| look_of.image_model.map(str::to_string)),
            value: job_item(
                &id,
                target,
                "image",
                format!("{instruction}\n{}", lines.join("\n")),
                None,
                inputs,
                json!({"size": image_size(aspect.as_str(), view == "turnaround")}),
                None,
                None,
                None,
            ),
        }]);
    }
    let chapter_id = chapter_id
        .ok_or_else(|| ToolError::validation("pictureEdit needs a chapterId or an elementId"))?;
    let chapter = chapter_of(story, chapter_id)?;
    let keyframe = chapter
        .acts
        .iter()
        .filter(|act| act_id.is_none_or(|id| act.id == id))
        .flat_map(|act| act.keyframes.iter().map(move |keyframe| (act, keyframe)))
        .find(|(_, keyframe)| {
            keyframe_ids.is_empty() || keyframe_ids.iter().any(|id| id == &keyframe.id)
        })
        .ok_or_else(|| ToolError::new("KEYFRAME_NOT_FOUND", "no such shot to edit"))?;
    let Some(source) = current_asset(&keyframe.1.art) else {
        return Err(ToolError::new(
            "STEP_GAPS",
            "that shot has no picture to edit",
        ));
    };
    let mut lines = vec![
        "Edit this shot's frame from the attached picture. Keep the composition, the framing and the people, the place and the things exactly as they are; change only what the instruction says.".to_string(),
        format!("This shot: {}. {look}", keyframe.1.content),
    ];
    masked(&mut lines);
    let mut inputs = vec![json!({"role": "reference", "assetId": source})];
    if let Some(mask) = mask_asset {
        inputs.push(json!({"role": "mask", "assetId": mask}));
    }
    let id = format!(
        "keyframe:{}:{}:{}",
        chapter.id, keyframe.0.id, keyframe.1.id
    );
    Ok(vec![Planned {
        model: none_if_empty(model).or_else(|| keyframe.1.image_model.clone()),
        value: job_item(
            &id,
            json!({
                "kind": "keyframeArt",
                "chapterId": chapter.id,
                "actId": keyframe.0.id,
                "keyframeId": keyframe.1.id,
            }),
            "image",
            format!("{instruction}\n{}", lines.join("\n")),
            None,
            inputs,
            json!({"size": image_size(story.brief.aspect.as_str(), false)}),
            Some(keyframe.1.title.clone()),
            None,
            None,
        ),
    }])
}

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
            let (mut cast, mut inputs) = keyframe_cast(story, act, keyframe, warnings);
            // A frame that travels with pictures is composed inside its place:
            // the place leads them even when the shot's own list left it out,
            // so a close-up keeps the room's light and walls behind the face.
            // The place the shot's list names wins over the act's own. A frame
            // with no pictures at all stays reference-free.
            let place_id = keyframe
                .references
                .as_ref()
                .and_then(|references| {
                    references.iter().find_map(|reference| {
                        let id = reference.element_id.as_deref()?;
                        story
                            .elements
                            .iter()
                            .find(|element| element.id == id && element.kind.as_str() == "scene")
                            .map(|element| element.id.clone())
                    })
                })
                .or_else(|| act.scene_id.clone());
            let mut has_place = false;
            if !cast.is_empty() {
                if let Some(scene_id) = place_id.as_deref() {
                    if let Some(element) = story.elements.iter().find(|held| held.id == scene_id) {
                        let variant = keyframe.variant_choices.get(&element.id).cloned();
                        if let Some(look) = element_look(element, variant.as_deref()) {
                            if let Some(asset_id) = current_asset(look.main) {
                                let held = inputs.iter().position(|input| {
                                    input.get("assetId").and_then(|value| value.as_str())
                                        == Some(asset_id.as_str())
                                });
                                match held {
                                    Some(0) => has_place = true,
                                    Some(position) => {
                                        let picture = cast.remove(position);
                                        let input = inputs.remove(position);
                                        cast.insert(0, picture);
                                        inputs.insert(0, input);
                                        has_place = true;
                                    }
                                    None => {
                                        cast.insert(
                                            0,
                                            json!({
                                                "name": look.name,
                                                "description": look.description,
                                            }),
                                        );
                                        inputs.insert(
                                            0,
                                            json!({"role": "reference", "assetId": asset_id}),
                                        );
                                        let limit = story.max_reference_images as usize;
                                        cast.truncate(limit);
                                        inputs.truncate(limit);
                                        has_place = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
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
                        "place": has_place,
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
    for (index, act) in chapter.acts.iter().enumerate() {
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
        if let Some(transition) = &act.transition {
            if current_asset(&act.video).is_some() && !include_existing {
                continue;
            }
            let Some(from) = neighbour_video(story, chapter, index, Edge::End) else {
                warnings.push(format!(
                    "{} is a bridge whose previous act has no clip yet",
                    act.title
                ));
                continue;
            };
            let Some(to) = neighbour_video(story, chapter, index + 1, Edge::Start) else {
                warnings.push(format!(
                    "{} is a bridge whose next act has no clip yet",
                    act.title
                ));
                continue;
            };
            let seconds = clamp_seconds(transition.duration_ms, ceiling);
            let base = format!("actVideo:{}:{}", chapter.id, act.id);
            let prompt = match video_prompt_override(story, &base) {
                Some(prompt) => prompt.to_string(),
                None => render(
                    Prompt::StoryTransitionVideo,
                    json!({
                        "seconds": seconds,
                        "aspect": story.brief.aspect.as_str(),
                        "style": story.brief.style,
                        "from": strip_mentions(&from.content),
                        "to": strip_mentions(&to.content),
                        "move": transition.prompt,
                    }),
                )?,
            };
            planned.push(Planned {
                model: item_model,
                value: job_item(
                    &base,
                    json!({"kind": "actVideo", "chapterId": chapter.id, "actId": act.id}),
                    "video",
                    prompt,
                    None,
                    vec![
                        json!({"role": "firstFrame", "assetId": from.asset_id, "frame": "last"}),
                        json!({"role": "lastFrame", "assetId": to.asset_id, "frame": "first"}),
                    ],
                    json!({
                        "seconds": seconds,
                        "ratio": story.brief.aspect.as_str(),
                        "mode": "auto",
                    }),
                    Some(act.title.clone()),
                    None,
                    None,
                ),
            });
            continue;
        }
        if current_asset(&act.video).is_some() && !include_existing {
            continue;
        }
        if act.keyframes.is_empty() {
            warnings.push(format!("{} has no shots to film", act.title));
            continue;
        }
        let pieces = act_pieces(act, ceiling, &act.title, warnings);
        if pieces.is_empty() {
            continue;
        }
        let total = pieces.len();
        let also_tail = previous_act_tail(chapter, index);
        let item_model = none_if_empty(model).or_else(|| {
            act.video_model
                .clone()
                .filter(|value| !value.trim().is_empty())
        });
        for (at, mut piece) in pieces.into_iter().enumerate() {
            let mode = match piece.kind {
                PieceKind::Words => "words",
                PieceKind::Reference => "references",
                PieceKind::Frame | PieceKind::Pair => "frames",
            };
            let continues = at == 0
                && act.continue_from_previous
                && !matches!(piece.kind, PieceKind::Words | PieceKind::Reference)
                && !piece.inputs.is_empty()
                && also_tail.is_some();
            if at == 0 && act.continue_from_previous && !continues {
                warnings.push(format!(
                    "{} cannot open on the act before it; its clip begins on its own frames",
                    act.title
                ));
            }
            if continues {
                if let Some(tail) = &also_tail {
                    piece.inputs[0] = json!({
                        "role": "firstFrame",
                        "assetId": tail,
                        "frame": "last",
                    });
                }
            }
            let mut context = json!({
                "aspect": story.brief.aspect.as_str(),
                "style": story.brief.style,
                "title": act.title,
                "summary": act.summary,
                "seconds": piece.seconds,
                "shots": piece.prompt_shots(),
                "hasDialogue": piece.has_dialogue(),
                "words": piece.kind == PieceKind::Words,
                "references": piece.kind == PieceKind::Reference,
                "mode": mode,
            });
            if total > 1 {
                context["part"] = json!(at + 1);
                context["total"] = json!(total);
            }
            if continues {
                context["continues"] = json!(true);
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
                    piece.inputs.clone(),
                    json!({
                        "seconds": piece.seconds,
                        "ratio": story.brief.aspect.as_str(),
                        "mode": if piece.kind == PieceKind::Reference { "reference" } else { "auto" },
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Edge {
    Start,
    End,
}

struct NeighbourVideo {
    asset_id: String,
    content: String,
}

fn neighbour_video(
    story: &StoryDocument,
    chapter: &StoryChapter,
    index: usize,
    edge: Edge,
) -> Option<NeighbourVideo> {
    let act = chapter.acts.get(index)?;
    if act.transition.is_some() {
        return None;
    }
    let per_shot =
        act.shot_granularity.unwrap_or(story.shot_granularity) == StoryShotGranularity::Keyframe;
    if per_shot {
        let mut frames: Vec<&StoryKeyframe> = act.keyframes.iter().collect();
        if edge == Edge::End {
            frames.reverse();
        }
        for frame in frames {
            let Some(take) = frame.video.takes.last() else {
                continue;
            };
            let asset_id = match edge {
                Edge::Start => take.asset_ids.first(),
                Edge::End => take.asset_ids.last(),
            };
            if let Some(asset_id) = asset_id {
                return Some(NeighbourVideo {
                    asset_id: asset_id.clone(),
                    content: frame.content.clone(),
                });
            }
        }
        return None;
    }
    let take = act.video.takes.last()?;
    let asset_id = match edge {
        Edge::Start => take.asset_ids.first(),
        Edge::End => take.asset_ids.last(),
    }?;
    let mut frames: Vec<&StoryKeyframe> = act.keyframes.iter().collect();
    if edge == Edge::End {
        frames.reverse();
    }
    let content = frames
        .iter()
        .find(|frame| !frame.content.trim().is_empty())
        .map(|frame| frame.content.clone())
        .unwrap_or_else(|| act.summary.clone());
    Some(NeighbourVideo {
        asset_id: asset_id.clone(),
        content,
    })
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum PieceKind {
    Words,
    Frame,
    Pair,
    Reference,
}

struct Piece<'a> {
    keyframes: Vec<&'a StoryKeyframe>,
    seconds: u32,
    kind: PieceKind,
    inputs: Vec<Value>,
}

impl Piece<'_> {
    fn has_dialogue(&self) -> bool {
        self.keyframes
            .iter()
            .any(|keyframe| !spoken_lines(&keyframe.dialogue).is_empty())
    }

    fn prompt_shots(&self) -> Vec<Value> {
        let mut held = 0_i64;
        self.keyframes
            .iter()
            .map(|keyframe| {
                let start = (held as f64 / 100.0).round() / 10.0;
                held += keyframe.duration_ms;
                let start = start.min(self.seconds as f64);
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
            .collect()
    }
}

fn has_picture(keyframe: &StoryKeyframe) -> bool {
    current_asset(&keyframe.art).is_some()
}

fn next_pictured(shots: &[&StoryKeyframe], from: usize) -> Option<usize> {
    (from..shots.len()).find(|at| has_picture(shots[*at]))
}

fn opens_own_piece(shots: &[&StoryKeyframe], at: usize) -> bool {
    if !has_picture(shots[at]) {
        return false;
    }
    match shots[at].film_role {
        StoryFilmRole::FirstFrame => true,
        StoryFilmRole::FirstLastFrame => next_pictured(shots, at + 1).is_some(),
        StoryFilmRole::Reference => false,
    }
}

fn piece_of<'a>(kind: PieceKind, shots: Vec<&'a StoryKeyframe>, seconds: u32) -> Piece<'a> {
    let pictured: Vec<String> = shots
        .iter()
        .filter_map(|keyframe| current_asset(&keyframe.art))
        .collect();
    let inputs = match kind {
        PieceKind::Words => Vec::new(),
        PieceKind::Reference => pictured
            .iter()
            .map(|asset_id| json!({"role": "reference", "assetId": asset_id}))
            .collect(),
        PieceKind::Frame => pictured
            .first()
            .map(|asset_id| vec![json!({"role": "firstFrame", "assetId": asset_id})])
            .unwrap_or_default(),
        PieceKind::Pair => {
            let mut inputs = pictured
                .first()
                .map(|asset_id| vec![json!({"role": "firstFrame", "assetId": asset_id})])
                .unwrap_or_default();
            if pictured.len() > 1 {
                if let Some(last) = pictured.last() {
                    inputs.push(json!({"role": "lastFrame", "assetId": last}));
                }
            }
            inputs
        }
    };
    Piece {
        keyframes: shots,
        seconds,
        kind,
        inputs,
    }
}

fn act_pieces<'a>(
    act: &'a StoryAct,
    ceiling: u32,
    title: &str,
    warnings: &mut Vec<String>,
) -> Vec<Piece<'a>> {
    for keyframe in &act.keyframes {
        if current_asset(&keyframe.art).is_none() && !keyframe.art_not_needed {
            warnings.push(format!(
                "{} shot “{}” has no picture yet; draw it before filming the act",
                title, keyframe.title
            ));
            return Vec::new();
        }
    }
    let shots: Vec<&StoryKeyframe> = act
        .keyframes
        .iter()
        .filter(|keyframe| current_asset(&keyframe.art).is_some() || keyframe.art_not_needed)
        .collect();
    let mut pieces = Vec::new();
    let mut at = 0_usize;
    while at < shots.len() {
        if !has_picture(shots[at]) {
            let next = next_pictured(&shots, at);
            if next.is_none() || opens_own_piece(&shots, next.unwrap()) {
                let mut end = at;
                let mut ms = 0_i64;
                while end < shots.len() && !has_picture(shots[end]) {
                    ms += shots[end].duration_ms;
                    end += 1;
                }
                pieces.push(piece_of(
                    PieceKind::Words,
                    shots[at..end].to_vec(),
                    clamp_seconds(ms, ceiling),
                ));
                at = end;
                continue;
            }
        }
        let role = shots[at].film_role;
        let tail = if role == StoryFilmRole::FirstLastFrame {
            next_pictured(&shots, at + 1)
        } else {
            None
        };
        if let Some(tail) = tail {
            let closing = next_pictured(&shots, tail + 1).is_none();
            let inner = shots[at..=tail].to_vec();
            let ms: i64 = inner.iter().map(|keyframe| keyframe.duration_ms).sum();
            let seconds = clamp_seconds(
                ms - if closing { 0 } else { shots[tail].duration_ms },
                ceiling,
            );
            pieces.push(piece_of(PieceKind::Pair, inner, seconds));
            at = if closing { tail + 1 } else { tail };
            continue;
        }
        if role == StoryFilmRole::FirstFrame {
            let mut end = at + 1;
            while end < shots.len() && !has_picture(shots[end]) {
                end += 1;
            }
            let inner = shots[at..end].to_vec();
            let ms: i64 = inner.iter().map(|keyframe| keyframe.duration_ms).sum();
            pieces.push(piece_of(
                PieceKind::Frame,
                inner,
                clamp_seconds(ms, ceiling),
            ));
            at = end;
            continue;
        }
        let mut run = Vec::new();
        let mut run_ms = 0_i64;
        while at < shots.len() {
            let held = shots[at];
            if !run.is_empty() && has_picture(held) && opens_own_piece(&shots, at) {
                break;
            }
            if run_ms > 0 && run_ms + held.duration_ms > ceiling as i64 * 1000 {
                break;
            }
            run.push(held);
            run_ms += held.duration_ms;
            at += 1;
        }
        let kind = if run.iter().any(|keyframe| has_picture(keyframe)) {
            PieceKind::Reference
        } else {
            PieceKind::Words
        };
        pieces.push(piece_of(kind, run, clamp_seconds(run_ms, ceiling)));
    }
    pieces
}

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
                // The reference travels as the item's input picture; a speech
                // service takes no reference in its params, and a batch that
                // named one there would be refused before it was sent.
                let mut params = json!({});
                if voice.reference_asset_id.is_none() && !voice.voice.trim().is_empty() {
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

fn plan_act_voice(
    story: &StoryDocument,
    chapter_id: &str,
    act_id: Option<&str>,
    include_existing: bool,
    model: &str,
) -> Vec<Planned> {
    let Ok(chapter) = chapter_of(story, chapter_id) else {
        return Vec::new();
    };
    let voice = story.narrator.clone().unwrap_or_default();
    let mut planned = Vec::new();
    for act in &chapter.acts {
        if act_id.is_some_and(|id| act.id != id) {
            continue;
        }
        if act
            .voice
            .as_ref()
            .is_some_and(|slot| current_asset(slot).is_some())
            && !include_existing
        {
            continue;
        }
        let words: Vec<&str> = act
            .keyframes
            .iter()
            .flat_map(|keyframe| keyframe.dialogue.iter())
            .map(|line| line.text.trim())
            .filter(|line| !line.is_empty())
            .collect();
        if words.is_empty() {
            continue;
        }
        let item_model = none_if_empty(model).or_else(|| none_if_empty(&voice.model));
        let mut params = json!({});
        if voice.reference_asset_id.is_none() && !voice.voice.trim().is_empty() {
            params["voice"] = json!(voice.voice);
        }
        if let Some(rate) = voice.rate {
            params["rate"] = json!(rate);
        }
        if let Some(pitch) = voice.pitch {
            params["pitch"] = json!(pitch);
        }
        let instructions = [
            act.summary.trim(),
            voice.instructions.as_deref().unwrap_or(""),
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
        planned.push(Planned {
            model: item_model,
            value: job_item(
                &format!("actVoice:{}:{}", chapter.id, act.id),
                json!({"kind": "voice", "chapterId": chapter.id, "actId": act.id}),
                "speech",
                words.join("\n"),
                None,
                inputs,
                params,
                Some(act.title.clone()),
                None,
                None,
            ),
        });
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

/// The last file of the act before this one, when it has a clip to take it from.
fn previous_act_tail(chapter: &StoryChapter, index: usize) -> Option<String> {
    let previous = chapter.acts.get(index.checked_sub(1)?)?;
    if previous.transition.is_some() {
        return None;
    }
    previous
        .video
        .takes
        .last()
        .and_then(|take| take.asset_ids.last().cloned())
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
    // The place is the base a frame is composed on: it leads the pictures,
    // people follow, and things come last. The order is fixed here because the
    // numbered references in the prompt are read against it.
    let rank = |element_id: &str| -> u8 {
        story
            .elements
            .iter()
            .find(|element| element.id == element_id)
            .map(|element| match element.kind.as_str() {
                "scene" => 0,
                "character" => 1,
                "prop" => 2,
                _ => 3,
            })
            .unwrap_or(3)
    };
    wants.sort_by_key(|(element_id, _, _)| rank(element_id));
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

/// A clip's seconds: the plan taken down to a whole second, never past the
/// ceiling. Down rather than nearest, because a worker's ceiling is often a
/// fraction more than its frame grid renders (H3 declares fifteen seconds and
/// films 345 frames at 24 fps, 14.375 s): 14.8 s rounded up would ask for the
/// ceiling and be refused, while a clip a fraction short still plays.
fn clamp_seconds(ms: i64, ceiling: u32) -> u32 {
    let whole = ms.max(0) / 1000;
    (whole.clamp(1, ceiling.max(1) as i64)) as u32
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

#[cfg(test)]
mod inventory_tests {
    use super::{chapter_cast, chapter_places, paragraph_cut_at};

    #[test]
    fn a_cast_line_is_read_without_its_note() {
        let text = "**主要人物**：黎知盈、宋见明（助理代传话）、唐母\n";
        assert_eq!(chapter_cast(text), vec!["黎知盈", "宋见明", "唐母"]);
    }

    #[test]
    fn scene_headings_keep_the_place_and_drop_the_hour() {
        let text = "## 1. 旧灯塔·潮位室·凌晨（0:00–0:20）\n## 2. 旧海堤·决口·黎明前（0:20–1:20）\n";
        assert_eq!(
            chapter_places(text),
            vec!["旧灯塔·潮位室", "旧海堤·决口"]
        );
    }

    #[test]
    fn a_cut_prefers_a_paragraph_boundary() {
        let text = "甲".repeat(10) + "\n\n" + &"乙".repeat(10);
        assert_eq!(paragraph_cut_at(&text, 15), 12);
    }

    #[test]
    fn a_cut_falls_back_to_a_line_boundary() {
        let text = "甲".repeat(10) + "\n" + &"乙".repeat(10);
        assert_eq!(paragraph_cut_at(&text, 15), 11);
    }
}
