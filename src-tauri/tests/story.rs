//! The Rust half of the story command matrix, mirrored from
//! `src/shared/domain/story.test.ts`: the same cases, the same fixture shape,
//! the same codes.
//!
//! Two languages read and write one document, so the cases here are the ones
//! the TypeScript suite pins: if the two ever disagree about what a command
//! does, one of these suites says so.

use moka_canvas::domain::commands::apply_commands;
use moka_canvas::domain::story::{
    self, StoryAct, StoryActSound, StoryBrief, StoryChapter, StoryDialogueLine, StoryDocument,
    StoryEdit, StoryEditClip, StoryEditPatch, StoryElement, StoryElementKind, StoryElementPatch,
    StoryElementView, StoryKeyframe, StoryKeyframePatch, StoryShotGranularity, StoryShotSize,
    StorySlot, StorySlotTarget, StoryTake, MAX_ACTS_PER_CHAPTER, MAX_CHAPTERS_PER_STORY,
    MAX_ELEMENTS_PER_STORY, MAX_KEYFRAMES_PER_ACT, MAX_TAKES_PER_SLOT, STORY_NAME_MAX,
};
use moka_canvas::domain::validate::validate_moka_file;
use moka_canvas::domain::{
    CanvasDocument, DocumentCommand, MokaFile, ProjectMetadata, ResourceEntry, ResourceRegistry,
    TimelineDocument, TimelineSettings, MOKA_FILE_VERSION,
};
use moka_canvas::project::codec::{decode_moka_file, encode_moka_file, MOKA_MAGIC};

const NOW: &str = "2026-01-01T00:00:00.000Z";

const STORY: &str = "story-1";
const CHAPTER_FIRST: &str = "chapter-first";
const CHAPTER_SECOND: &str = "chapter-second";
const ACT: &str = "act-1";
const FRAME_FIRST: &str = "frame-1";
const FRAME_SECOND: &str = "frame-2";
const LINE_FIRST: &str = "line-1";
const HERO: &str = "element-hero";
const PARTNER: &str = "element-partner";
const SCENE: &str = "element-scene";
const PROP: &str = "element-prop";
const SOURCE: &str = "asset-story-source";
const HERO_MAIN: &str = "asset-hero-main";
const HERO_SHEET: &str = "asset-hero-sheet";
const FRAME_ART: &str = "asset-frame-art";
const ACT_VIDEO: &str = "asset-act-video";
const TIMELINE: &str = "timeline-1";

fn apply(moka: &MokaFile, commands: Vec<DocumentCommand>) -> (MokaFile, Vec<DocumentCommand>) {
    apply_commands(moka, &commands).expect("the commands apply")
}

fn code_of(moka: &MokaFile, command: DocumentCommand) -> &'static str {
    match apply_commands(moka, &[command]) {
        Ok(_) => "NO_ERROR",
        Err(error) => error.code,
    }
}

/// The round trip every command must survive: apply, undo with the inverse,
/// and the document is the one the step started from.
fn round_trip(moka: &MokaFile, commands: Vec<DocumentCommand>) -> MokaFile {
    let (next, inverse) = apply(moka, commands);
    let (undone, _) = apply(&next, inverse);
    assert_eq!(undone, *moka, "the inverse must put the document back");
    next
}

fn story_of(moka: &MokaFile) -> &StoryDocument {
    &moka.stories.as_ref().expect("the fixture tells a story")[0]
}

fn take(asset_id: &str) -> StoryTake {
    StoryTake {
        asset_ids: vec![asset_id.into()],
        job_id: None,
        item_id: None,
        note: None,
        created_at: NOW.into(),
    }
}

fn empty_slot() -> StorySlot {
    StorySlot { takes: Vec::new() }
}

fn resource(id: &str, name: &str, path: &str, mime: &str, bytes: i64) -> ResourceEntry {
    ResourceEntry {
        id: id.into(),
        name: name.into(),
        path: path.into(),
        mime: Some(mime.into()),
        bytes: Some(bytes),
        sha256: None,
        created_at: NOW.into(),
        updated_at: NOW.into(),
        probe: None,
        provenance: None,
        tags: None,
        note: None,
        favorite: None,
        origin: None,
        keyword: None,
    }
}

fn timeline() -> TimelineDocument {
    TimelineDocument {
        id: TIMELINE.into(),
        name: "Timeline 1".into(),
        schema_version: 1,
        settings: TimelineSettings {
            fps: 30,
            width: 1920,
            height: 1080,
            background: "#000000".into(),
        },
        tracks: Vec::new(),
        clips: Vec::new(),
        transitions: Vec::new(),
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

fn frame(index: usize) -> StoryKeyframe {
    StoryKeyframe {
        id: format!("frame-{index}"),
        title: format!("#{}", index + 1),
        shot_size: StoryShotSize::Medium,
        camera_move: story::StoryCameraMove::Static,
        angle: story::StoryCameraAngle::EyeLevel,
        film_role: story::StoryFilmRole::Reference,
        content: "画面".into(),
        dialogue: Vec::new(),
        duration_ms: 1_000,
        art: empty_slot(),
        video: empty_slot(),
        voices: None,
    }
}

fn act(id: &str) -> StoryAct {
    StoryAct {
        id: id.into(),
        title: "第 1 幕".into(),
        summary: "内容".into(),
        character_ids: Vec::new(),
        scene_id: None,
        prop_ids: Vec::new(),
        sound: StoryActSound {
            music: String::new(),
            sfx: String::new(),
            ambience: None,
        },
        keyframes: Vec::new(),
        video: empty_slot(),
        voice: None,
        music: None,
    }
}

fn element(id: &str, kind: StoryElementKind) -> StoryElement {
    StoryElement {
        id: id.into(),
        kind,
        name: id.into(),
        description: String::new(),
        chapter_ids: Vec::new(),
        main: empty_slot(),
        turnaround: if kind == StoryElementKind::Character {
            Some(empty_slot())
        } else {
            None
        },
        voice: None,
    }
}

/// The project the TypeScript fixture builds, shape for shape: one telling
/// walked as far as the fourth step, an assembly that names a real timeline,
/// and a shelf holding every drawing it points at.
fn story_document() -> MokaFile {
    let mut moka = MokaFile {
        version: MOKA_FILE_VERSION.to_string(),
        metadata: ProjectMetadata {
            id: "project-1".into(),
            name: "Fixture".into(),
            description: None,
            cover_path: None,
            revision: 1,
            created_at: NOW.into(),
            updated_at: NOW.into(),
        },
        resources: ResourceRegistry::default(),
        folders: None,
        timelines: Some(vec![timeline()]),
        stories: None,
        canvas: vec![CanvasDocument::empty("canvas-1".into(), "Canvas 1".into())],
    };
    for id in [HERO_MAIN, HERO_SHEET, FRAME_ART] {
        moka.resources.images.push(resource(
            id,
            &format!("{id}.png"),
            &format!("assets/images/{id}.png"),
            "image/png",
            120_000,
        ));
    }
    moka.resources.videos.push(resource(
        ACT_VIDEO,
        "act-video.mp4",
        "assets/videos/act-video.mp4",
        "video/mp4",
        240_000,
    ));
    moka.resources.texts.push(resource(
        SOURCE,
        "novel.txt",
        "assets/texts/novel.txt",
        "text/plain",
        40_000,
    ));

    let first = StoryKeyframe {
        id: FRAME_FIRST.into(),
        title: "#1".into(),
        shot_size: StoryShotSize::Wide,
        camera_move: story::StoryCameraMove::PushIn,
        angle: story::StoryCameraAngle::EyeLevel,
        film_role: story::StoryFilmRole::Reference,
        content: "雨中的站台，一个人立在灯下。".into(),
        dialogue: vec![StoryDialogueLine {
            id: Some(LINE_FIRST.into()),
            character_id: Some(HERO.into()),
            speaker: "林".into(),
            text: "车已经停运了。".into(),
            tone: Some("平静".into()),
        }],
        duration_ms: 2_000,
        art: StorySlot {
            takes: vec![StoryTake {
                asset_ids: vec![FRAME_ART.into()],
                job_id: Some("job-1".into()),
                item_id: Some(format!("keyframe:{CHAPTER_FIRST}:{ACT}:{FRAME_FIRST}")),
                note: Some("按关键帧生成".into()),
                created_at: NOW.into(),
            }],
        },
        video: empty_slot(),
        voices: None,
    };
    let second = StoryKeyframe {
        id: FRAME_SECOND.into(),
        title: "#2".into(),
        content: "另一人转过身来。".into(),
        shot_size: StoryShotSize::Close,
        camera_move: story::StoryCameraMove::Static,
        angle: story::StoryCameraAngle::OverTheShoulder,
        film_role: story::StoryFilmRole::Reference,
        dialogue: Vec::new(),
        duration_ms: 3_000,
        art: empty_slot(),
        video: empty_slot(),
        voices: None,
    };

    moka.stories = Some(vec![StoryDocument {
        id: STORY.into(),
        name: "雨夜列车".into(),
        schema_version: 1,
        brief: StoryBrief {
            idea: "末班列车上，两个陌生人交换了各自要说的话。".into(),
            source_asset_id: Some(SOURCE.into()),
            source_name: Some("novel.txt".into()),
            source_split: Some(true),
            total_duration_ms: 120_000,
            aspect: story::StoryAspect::Widescreen,
            genre: "对白剧情".into(),
            style: "现代都市风".into(),
        },
        chapters: vec![
            StoryChapter {
                id: CHAPTER_FIRST.into(),
                title: "第一章 站台".into(),
                synopsis: "他在站台上等一班已经停运的列车。".into(),
                target_duration_ms: 60_000,
                acts: vec![StoryAct {
                    id: ACT.into(),
                    title: "第 1 幕 空站台".into(),
                    summary: "站台上的灯一盏一盏亮起来。".into(),
                    character_ids: vec![HERO.into(), PARTNER.into()],
                    scene_id: Some(SCENE.into()),
                    prop_ids: vec![PROP.into()],
                    sound: StoryActSound {
                        music: "低音提琴，缓慢".into(),
                        sfx: "雨声".into(),
                        ambience: Some("空站台".into()),
                    },
                    keyframes: vec![first, second],
                    video: StorySlot {
                        takes: vec![StoryTake {
                            asset_ids: vec![ACT_VIDEO.into()],
                            job_id: Some("job-2".into()),
                            item_id: Some(format!("actVideo:{CHAPTER_FIRST}:{ACT}")),
                            note: Some("按幕生成，5.0s".into()),
                            created_at: NOW.into(),
                        }],
                    },
                    voice: None,
                    music: None,
                }],
            },
            StoryChapter {
                id: CHAPTER_SECOND.into(),
                title: "第二章 车厢".into(),
                synopsis: "车厢比站台更暗。".into(),
                target_duration_ms: 60_000,
                acts: Vec::new(),
            },
        ],
        elements: vec![
            StoryElement {
                id: HERO.into(),
                kind: StoryElementKind::Character,
                name: "林".into(),
                description: "四十岁上下，深色大衣，说话很慢。".into(),
                chapter_ids: vec![CHAPTER_FIRST.into()],
                main: StorySlot {
                    takes: vec![take(HERO_MAIN)],
                },
                turnaround: Some(StorySlot {
                    takes: vec![take(HERO_SHEET)],
                }),
                voice: None,
            },
            element(PARTNER, StoryElementKind::Character),
            element(SCENE, StoryElementKind::Scene),
            element(PROP, StoryElementKind::Prop),
        ],
        shot_granularity: StoryShotGranularity::Act,
        max_reference_images: story::REFERENCE_IMAGES_DEFAULT,
        confirmed_steps: vec![
            story::StoryStep::Idea,
            story::StoryStep::Outline,
            story::StoryStep::Elements,
        ],
        edit: StoryEdit {
            timeline_id: Some(TIMELINE.into()),
            clip_by_act: Some(vec![StoryEditClip {
                act_id: ACT.into(),
                keyframe_id: None,
                clip_id: "clip-video".into(),
            }]),
            assembled_digest: None,
        },
        narrator: None,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }]);
    moka
}

// -----------------------------------------------------------------------------
// The commands
// -----------------------------------------------------------------------------

#[test]
fn adds_a_story_at_the_place_it_asks_for() {
    let mut moka = story_document();
    moka.stories = None;
    let next = round_trip(
        &moka,
        vec![DocumentCommand::AddStory {
            story: create_story("雨夜列车"),
            index: Some(0),
        }],
    );
    assert_eq!(next.stories.as_ref().unwrap()[0].name, "雨夜列车");
}

#[test]
fn refuses_a_story_past_the_limit_a_nameless_one_and_a_duplicate_id() {
    let mut full = story_document();
    full.stories = Some(
        (0..20)
            .map(|n| create_story(&format!("故事 {n}")))
            .collect::<Vec<_>>(),
    );
    assert_eq!(
        code_of(
            &full,
            DocumentCommand::AddStory {
                story: create_story("多出来的"),
                index: None,
            }
        ),
        "STORY_LIMIT_REACHED"
    );

    let moka = story_document();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddStory {
                story: create_story(""),
                index: None,
            }
        ),
        "STORY_NAME_INVALID"
    );
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddStory {
                story: create_story(&"x".repeat(STORY_NAME_MAX + 1)),
                index: None,
            }
        ),
        "STORY_NAME_INVALID"
    );
    let mut twin = create_story("同名");
    twin.id = STORY.into();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::AddStory {
                story: twin,
                index: None,
            }
        ),
        "STORY_ID_EXISTS"
    );
}

#[test]
fn takes_a_story_out_whole_and_leaves_the_timeline_standing() {
    let moka = story_document();
    let (next, inverse) = apply(
        &moka,
        vec![DocumentCommand::RemoveStory {
            story_id: STORY.into(),
        }],
    );
    assert!(next.stories.is_none());
    // The timeline the story assembled stays where a reader can still watch it.
    assert_eq!(next.timelines.as_ref().unwrap().len(), 1);
    let (undone, _) = apply(&next, inverse);
    assert_eq!(undone, moka);
}

#[test]
fn renames_a_story() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::RenameStory {
            story_id: STORY.into(),
            name: "站台与车厢".into(),
        }],
    );
    assert_eq!(story_of(&next).name, "站台与车厢");
}

#[test]
fn moves_only_the_fields_a_brief_patch_names() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryBrief {
            story_id: STORY.into(),
            patch: story::StoryBriefPatch {
                total_duration_ms: Some(300_000),
                genre: Some("悬疑".into()),
                ..Default::default()
            },
        }],
    );
    let brief = &story_of(&next).brief;
    assert_eq!(brief.total_duration_ms, 300_000);
    assert_eq!(brief.genre, "悬疑");
    assert_eq!(brief.style, "现代都市风");
    assert_eq!(brief.idea, story_of(&moka).brief.idea);
}

#[test]
fn refuses_a_running_time_nobody_offered() {
    let moka = story_document();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::UpdateStoryBrief {
                story_id: STORY.into(),
                patch: story::StoryBriefPatch {
                    total_duration_ms: Some(1),
                    ..Default::default()
                },
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn changes_the_granularity_and_keeps_the_clips_already_made() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryGranularity {
            story_id: STORY.into(),
            shot_granularity: StoryShotGranularity::Keyframe,
        }],
    );
    let story = story_of(&next);
    assert_eq!(story.shot_granularity, StoryShotGranularity::Keyframe);
    assert_eq!(story.chapters[0].acts[0].video.takes.len(), 1);
}

#[test]
fn moves_the_reference_limit_and_keeps_the_frames_already_drawn() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryReferenceLimit {
            story_id: STORY.into(),
            max_reference_images: 5,
        }],
    );
    let story = story_of(&next);
    assert_eq!(story.max_reference_images, 5);
    assert_eq!(story.chapters[0].acts[0].keyframes[0].art.takes.len(), 1);
}

#[test]
fn refuses_a_reference_limit_no_ask_could_carry() {
    let moka = story_document();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::UpdateStoryReferenceLimit {
                story_id: STORY.into(),
                max_reference_images: story::REFERENCE_IMAGES_MAX + 1,
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn keeps_a_chapters_board_when_the_chapter_keeps_its_id() {
    let moka = story_document();
    let rewritten = vec![
        StoryChapter {
            id: CHAPTER_FIRST.into(),
            title: "第一章 站台".into(),
            synopsis: "重写的梗概".into(),
            target_duration_ms: 60_000,
            acts: Vec::new(),
        },
        StoryChapter {
            id: "chapter-third".into(),
            title: "第三章 终点".into(),
            synopsis: "".into(),
            target_duration_ms: 60_000,
            acts: Vec::new(),
        },
    ];
    let next = round_trip(
        &moka,
        vec![DocumentCommand::SetStoryChapters {
            story_id: STORY.into(),
            chapters: rewritten,
        }],
    );
    let chapters = &story_of(&next).chapters;
    assert_eq!(chapters.len(), 2);
    // The board shot from the first chapter is still on it.
    assert_eq!(chapters[0].acts.len(), 1);
    assert_eq!(chapters[1].acts.len(), 0);
}

#[test]
fn refuses_more_chapters_than_a_story_holds() {
    let moka = story_document();
    let chapters: Vec<StoryChapter> = (0..MAX_CHAPTERS_PER_STORY + 1)
        .map(|n| StoryChapter {
            id: format!("chapter-{n}"),
            title: format!("第 {n} 章"),
            synopsis: String::new(),
            target_duration_ms: 60_000,
            acts: Vec::new(),
        })
        .collect();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::SetStoryChapters {
                story_id: STORY.into(),
                chapters,
            }
        ),
        "STORY_CHAPTER_LIMIT"
    );
}

#[test]
fn keeps_an_elements_drawings_when_it_keeps_its_id() {
    let moka = story_document();
    let before = story_of(&moka)
        .elements
        .iter()
        .find(|element| element.id == HERO)
        .unwrap()
        .clone();
    let mut rewritten = before.clone();
    rewritten.description = "重写的描述".into();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::SetStoryElements {
            story_id: STORY.into(),
            elements: vec![rewritten],
        }],
    );
    let hero = &story_of(&next).elements[0];
    assert_eq!(hero.description, "重写的描述");
    assert_eq!(hero.main.takes.len(), 1);
    assert_eq!(hero.turnaround.as_ref().unwrap().takes.len(), 1);
}

#[test]
fn refuses_more_elements_than_a_story_holds() {
    let moka = story_document();
    let elements: Vec<StoryElement> = (0..MAX_ELEMENTS_PER_STORY + 1)
        .map(|n| element(&format!("element-{n}"), StoryElementKind::Prop))
        .collect();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::SetStoryElements {
                story_id: STORY.into(),
                elements,
            }
        ),
        "STORY_ELEMENT_LIMIT"
    );
}

#[test]
fn moves_only_the_fields_an_element_patch_names() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryElement {
            story_id: STORY.into(),
            element_id: HERO.into(),
            patch: StoryElementPatch {
                name: Some("林先生".into()),
                ..Default::default()
            },
        }],
    );
    let hero = story_of(&next)
        .elements
        .iter()
        .find(|element| element.id == HERO)
        .unwrap();
    assert_eq!(hero.name, "林先生");
    assert_eq!(hero.description, "四十岁上下，深色大衣，说话很慢。");
}

#[test]
fn names_the_chapters_an_element_was_seen_in_and_refuses_a_chapter_it_has_not() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryElement {
            story_id: STORY.into(),
            element_id: HERO.into(),
            patch: StoryElementPatch {
                chapter_ids: Some(vec![CHAPTER_FIRST.into()]),
                ..Default::default()
            },
        }],
    );
    let hero = story_of(&next)
        .elements
        .iter()
        .find(|element| element.id == HERO)
        .unwrap();
    assert_eq!(hero.chapter_ids, vec![CHAPTER_FIRST.to_string()]);

    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::UpdateStoryElement {
                story_id: STORY.into(),
                element_id: HERO.into(),
                patch: StoryElementPatch {
                    chapter_ids: Some(vec!["chapter-gone".into()]),
                    ..Default::default()
                },
            }
        ),
        "STORY_TARGET_INVALID"
    );
}

fn voice(model: &str, tone: &str) -> story::StoryVoiceProfile {
    story::StoryVoiceProfile {
        model: model.into(),
        voice: tone.into(),
        rate: None,
        pitch: None,
        instructions: None,
        reference_asset_id: None,
    }
}

#[test]
fn reads_a_voices_recording_out_of_a_stored_voice_and_writes_none_that_none_names() {
    // A voice stored before recordings existed does not hold the field at
    // all, and reads back as promising no recording.
    let before: story::StoryVoiceProfile =
        serde_json::from_str(r#"{"model":"voice-model","voice":"longxiaochun"}"#).unwrap();
    assert_eq!(before.reference_asset_id, None);

    // One stored with a recording reads it out, under the name the wire uses.
    let copied: story::StoryVoiceProfile =
        serde_json::from_str(r#"{"model":"","voice":"","referenceAssetId":"asset-recording"}"#)
            .unwrap();
    assert_eq!(
        copied.reference_asset_id.as_deref(),
        Some("asset-recording")
    );

    // And a voice that names none is written without the field: what was not
    // said is not written, the way a slot with no takes holds none.
    assert!(
        !serde_json::to_string(&voice("voice-model", "longxiaochun"))
            .unwrap()
            .contains("referenceAssetId")
    );
}

#[test]
fn gives_a_character_a_voice_takes_it_away_and_keeps_the_round_trip() {
    let moka = story_document();
    let held = story::StoryVoiceProfile {
        model: "voice-model".into(),
        voice: "longxiaochun".into(),
        rate: Some(1.2),
        pitch: None,
        instructions: Some("低沉、慢".into()),
        reference_asset_id: None,
    };
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryElement {
            story_id: STORY.into(),
            element_id: HERO.into(),
            patch: StoryElementPatch {
                voice: Some(Some(held.clone())),
                ..Default::default()
            },
        }],
    );
    let hero = story_of(&next)
        .elements
        .iter()
        .find(|element| element.id == HERO)
        .unwrap();
    assert_eq!(hero.voice, Some(held));
    // The characters beside them were never named, and no voice is written for
    // them: a voice holding nothing is not a voice.
    assert!(story_of(&next).elements[1].voice.is_none());

    // Taken off the element rather than left holding nothing.
    let cleared = round_trip(
        &next,
        vec![DocumentCommand::UpdateStoryElement {
            story_id: STORY.into(),
            element_id: HERO.into(),
            patch: StoryElementPatch {
                voice: Some(None),
                ..Default::default()
            },
        }],
    );
    assert!(story_of(&cleared).elements[0].voice.is_none());

    // A pitch no provider would take is refused.
    let mut beyond = voice("", "");
    beyond.pitch = Some(3.0);
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::UpdateStoryElement {
                story_id: STORY.into(),
                element_id: HERO.into(),
                patch: StoryElementPatch {
                    voice: Some(Some(beyond)),
                    ..Default::default()
                },
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn keeps_a_characters_voice_through_a_cast_listed_again_without_it() {
    let moka = story_document();
    let voiced = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryElement {
            story_id: STORY.into(),
            element_id: HERO.into(),
            patch: StoryElementPatch {
                voice: Some(Some(voice("", "longxiaochun"))),
                ..Default::default()
            },
        }],
    );
    // A reading brings words, not a voice: the voice is one of the reader's
    // answers about a character, so a listing that says nothing of it leaves
    // it standing.
    let mut listed = story_of(&voiced).elements[0].clone();
    listed.voice = None;
    listed.description = "重写的描述".into();
    let next = round_trip(
        &voiced,
        vec![DocumentCommand::SetStoryElements {
            story_id: STORY.into(),
            elements: vec![listed],
        }],
    );
    let hero = &story_of(&next).elements[0];
    assert_eq!(hero.description, "重写的描述");
    assert_eq!(hero.voice.as_ref().unwrap().voice, "longxiaochun");
}

#[test]
fn writes_the_narrators_voice_and_takes_it_away_again() {
    let moka = story_document();
    assert!(story_of(&moka).narrator.is_none());
    assert!(!serde_json::to_string(story_of(&moka))
        .unwrap()
        .contains("narrator"));

    let told = voice("", "旁白的音色");
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryNarrator {
            story_id: STORY.into(),
            narrator: Some(told.clone()),
        }],
    );
    assert_eq!(story_of(&next).narrator, Some(told));

    let cleared = round_trip(
        &next,
        vec![DocumentCommand::UpdateStoryNarrator {
            story_id: STORY.into(),
            narrator: None,
        }],
    );
    assert!(story_of(&cleared).narrator.is_none());

    let mut beyond = voice("", "");
    beyond.rate = Some(4.0);
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::UpdateStoryNarrator {
                story_id: STORY.into(),
                narrator: Some(beyond),
            }
        ),
        "VALIDATION_FAILED"
    );
}

/// A telling written before voices existed is still a telling: the document is
/// read, and nothing is written back for the voices it never carried.
#[test]
fn reads_a_document_written_before_voices_existed() {
    let moka = story_document();
    let mut raw: serde_json::Value = serde_json::to_value(story_of(&moka)).unwrap();
    raw.as_object_mut().unwrap().remove("narrator");
    for element in raw["elements"].as_array_mut().unwrap() {
        element.as_object_mut().unwrap().remove("voice");
    }
    let story: StoryDocument = serde_json::from_value(raw).unwrap();
    assert!(story.narrator.is_none());
    assert!(story.elements[0].voice.is_none());
    assert!(!serde_json::to_string(&story.elements[0])
        .unwrap()
        .contains("voice"));
}

#[test]
fn keeps_an_acts_frames_and_clip_when_it_keeps_its_id() {
    let moka = story_document();
    let held = story_of(&moka).chapters[0].acts[0].clone();
    let mut rewritten = held.clone();
    rewritten.title = "第 1 幕 站台的灯".into();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::SetStoryActs {
            story_id: STORY.into(),
            chapter_id: CHAPTER_FIRST.into(),
            acts: vec![rewritten, act("act-second")],
        }],
    );
    let acts = &story_of(&next).chapters[0].acts;
    assert_eq!(acts.len(), 2);
    assert_eq!(acts[0].title, "第 1 幕 站台的灯");
    assert_eq!(acts[0].video.takes.len(), 1);
    assert_eq!(acts[0].keyframes[0].art.takes.len(), 1);
    assert!(acts[1].video.takes.is_empty());
}

#[test]
fn refuses_more_acts_than_an_episode_holds_and_more_shots_than_an_act_holds() {
    let moka = story_document();
    let acts: Vec<StoryAct> = (0..MAX_ACTS_PER_CHAPTER + 1)
        .map(|n| act(&format!("act-{n}")))
        .collect();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::SetStoryActs {
                story_id: STORY.into(),
                chapter_id: CHAPTER_FIRST.into(),
                acts,
            }
        ),
        "STORY_ACT_LIMIT"
    );

    let mut crowded = act(ACT);
    crowded.keyframes = (0..MAX_KEYFRAMES_PER_ACT + 1).map(frame).collect();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::SetStoryActs {
                story_id: STORY.into(),
                chapter_id: CHAPTER_FIRST.into(),
                acts: vec![crowded],
            }
        ),
        "STORY_KEYFRAME_LIMIT"
    );
}

#[test]
fn keeps_a_reference_to_an_element_that_is_no_longer_there_once() {
    let moka = story_document();
    let mut rewritten = story_of(&moka).chapters[0].acts[0].clone();
    rewritten.character_ids = vec![HERO.into(), "gone".into(), HERO.into()];
    let next = apply(
        &moka,
        vec![DocumentCommand::SetStoryActs {
            story_id: STORY.into(),
            chapter_id: CHAPTER_FIRST.into(),
            acts: vec![rewritten],
        }],
    )
    .0;
    assert_eq!(
        story_of(&next).chapters[0].acts[0].character_ids,
        vec![HERO.to_string(), "gone".to_string()]
    );
}

#[test]
fn moves_only_the_fields_an_act_patch_names_replacing_a_sound_whole() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryAct {
            story_id: STORY.into(),
            chapter_id: CHAPTER_FIRST.into(),
            act_id: ACT.into(),
            patch: story::StoryActPatch {
                sound: Some(StoryActSound {
                    music: "大提琴".into(),
                    sfx: String::new(),
                    ambience: None,
                }),
                title: Some("第 1 幕 站台的灯".into()),
                ..Default::default()
            },
        }],
    );
    let held = &story_of(&next).chapters[0].acts[0];
    assert_eq!(held.sound.music, "大提琴");
    assert_eq!(held.title, "第 1 幕 站台的灯");
    assert_eq!(held.summary, "站台上的灯一盏一盏亮起来。");
}

#[test]
fn takes_a_scene_away_when_the_patch_carries_a_null_for_it() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryAct {
            story_id: STORY.into(),
            chapter_id: CHAPTER_FIRST.into(),
            act_id: ACT.into(),
            patch: story::StoryActPatch {
                scene_id: Some(None),
                ..Default::default()
            },
        }],
    );
    assert_eq!(story_of(&next).chapters[0].acts[0].scene_id, None);
}

#[test]
fn moves_only_the_fields_a_shot_patch_names_and_keeps_a_shot_to_its_length() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryKeyframe {
            story_id: STORY.into(),
            chapter_id: CHAPTER_FIRST.into(),
            act_id: ACT.into(),
            keyframe_id: FRAME_SECOND.into(),
            patch: StoryKeyframePatch {
                shot_size: Some(StoryShotSize::ExtremeWide),
                duration_ms: Some(1_200),
                dialogue: Some(vec![StoryDialogueLine {
                    id: Some("line-second".into()),
                    character_id: None,
                    speaker: "周".into(),
                    text: "车还会来。".into(),
                    tone: None,
                }]),
                ..Default::default()
            },
        }],
    );
    let held = &story_of(&next).chapters[0].acts[0].keyframes[1];
    assert_eq!(held.shot_size, StoryShotSize::ExtremeWide);
    assert_eq!(held.duration_ms, 1_200);
    assert_eq!(held.dialogue.len(), 1);
    assert_eq!(held.content, "另一人转过身来。");

    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::UpdateStoryKeyframe {
                story_id: STORY.into(),
                chapter_id: CHAPTER_FIRST.into(),
                act_id: ACT.into(),
                keyframe_id: FRAME_SECOND.into(),
                patch: StoryKeyframePatch {
                    duration_ms: Some(10),
                    ..Default::default()
                },
            }
        ),
        "VALIDATION_FAILED"
    );
}

#[test]
fn refuses_a_line_of_dialogue_with_no_name_of_its_own_or_two_sharing_one() {
    let moka = story_document();
    let patched = |dialogue: Vec<StoryDialogueLine>| DocumentCommand::UpdateStoryKeyframe {
        story_id: STORY.into(),
        chapter_id: CHAPTER_FIRST.into(),
        act_id: ACT.into(),
        keyframe_id: FRAME_FIRST.into(),
        patch: StoryKeyframePatch {
            dialogue: Some(dialogue),
            ..Default::default()
        },
    };
    let line = |id: Option<&str>, text: &str| StoryDialogueLine {
        id: id.map(str::to_string),
        character_id: None,
        speaker: "周".into(),
        text: text.into(),
        tone: None,
    };
    assert_eq!(
        code_of(&moka, patched(vec![line(None, "车还会来。")])),
        "VALIDATION_FAILED"
    );
    assert_eq!(
        code_of(
            &moka,
            patched(vec![
                line(Some("same"), "车还会来。"),
                line(Some("same"), "车不会来了。"),
            ])
        ),
        "VALIDATION_FAILED"
    );
}

/// A telling written before lines had names is still a telling: the document
/// is read, and the names it does not carry are left off rather than written
/// back as something else.
#[test]
fn reads_a_document_whose_lines_have_no_names() {
    let moka = story_document();
    let mut raw: serde_json::Value = serde_json::to_value(story_of(&moka)).unwrap();
    for frame in raw["chapters"][0]["acts"][0]["keyframes"]
        .as_array_mut()
        .unwrap()
    {
        for line in frame["dialogue"].as_array_mut().unwrap() {
            line.as_object_mut().unwrap().remove("id");
        }
    }
    let story: StoryDocument = serde_json::from_value(raw).unwrap();
    let lines = &story.chapters[0].acts[0].keyframes[0].dialogue;
    assert_eq!(lines[0].id, None);
    assert_eq!(lines[0].speaker, "林");
    // And a line with no name is not written back holding an empty one.
    let written =
        serde_json::to_string(&story.chapters[0].acts[0].keyframes[0].dialogue[0]).unwrap();
    assert!(!written.contains("\"id\""));
}

/// A shot's role in filming is a word a document carries only when it says
/// something other than the plain one: a board that has never heard of roles is
/// one whose shots are all written back the same way, without the word.
#[test]
fn keeps_a_shots_role_in_filming_on_the_side_of_the_plain_word() {
    let moka = story_document();
    let plain = serde_json::to_string(story_of(&moka)).unwrap();
    assert!(!plain.contains("filmRole"), "the plain word is not written");
    assert_eq!(
        story_of(&moka).chapters[0].acts[0].keyframes[0].film_role,
        story::StoryFilmRole::Reference
    );

    let next = round_trip(
        &moka,
        vec![DocumentCommand::UpdateStoryKeyframe {
            story_id: STORY.into(),
            chapter_id: CHAPTER_FIRST.into(),
            act_id: ACT.into(),
            keyframe_id: FRAME_FIRST.into(),
            patch: StoryKeyframePatch {
                film_role: Some(story::StoryFilmRole::FirstLastFrame),
                ..Default::default()
            },
        }],
    );
    let keyframes = &story_of(&next).chapters[0].acts[0].keyframes;
    assert_eq!(keyframes[0].film_role, story::StoryFilmRole::FirstLastFrame);
    // The shot beside it was never named, so it is a reference.
    assert_eq!(keyframes[1].film_role, story::StoryFilmRole::Reference);

    let written = serde_json::to_string(&keyframes[0]).unwrap();
    assert!(written.contains(r#""filmRole":"firstLastFrame""#));
    assert!(!serde_json::to_string(&keyframes[1])
        .unwrap()
        .contains("filmRole"));
}

#[test]
fn files_a_drawing_at_the_place_a_target_names() {
    let moka = story_document();
    let slot = StorySlot {
        takes: vec![take("asset-new")],
    };
    let next = round_trip(
        &moka,
        vec![DocumentCommand::SetStorySlot {
            story_id: STORY.into(),
            target: StorySlotTarget::Keyframe {
                chapter_id: CHAPTER_FIRST.into(),
                act_id: ACT.into(),
                keyframe_id: FRAME_SECOND.into(),
            },
            slot: slot.clone(),
            read: None,
        }],
    );
    assert_eq!(story_of(&next).chapters[0].acts[0].keyframes[1].art, slot);
}

#[test]
fn files_a_voice_and_a_score_where_an_act_keeps_them() {
    let moka = story_document();
    // Both places are absent on a telling nobody has voiced, and the first
    // take ever made for an act is what makes one.
    let act = &story_of(&moka).chapters[0].acts[0];
    assert!(act.voice.is_none());
    assert!(act.music.is_none());

    let next = round_trip(
        &moka,
        vec![DocumentCommand::SetStorySlot {
            story_id: STORY.into(),
            target: StorySlotTarget::ActVoice {
                chapter_id: CHAPTER_FIRST.into(),
                act_id: ACT.into(),
            },
            slot: StorySlot {
                takes: vec![take("asset-act-voice")],
            },
            read: None,
        }],
    );
    let act = &story_of(&next).chapters[0].acts[0];
    assert_eq!(
        act.voice.as_ref().unwrap().takes[0].asset_ids,
        vec!["asset-act-voice"]
    );
    // The score is a place of its own, not the voice written twice.
    assert!(act.music.is_none());

    let scored = round_trip(
        &moka,
        vec![DocumentCommand::SetStorySlot {
            story_id: STORY.into(),
            target: StorySlotTarget::ActMusic {
                chapter_id: CHAPTER_FIRST.into(),
                act_id: ACT.into(),
            },
            slot: StorySlot {
                takes: vec![take("asset-act-music")],
            },
            read: None,
        }],
    );
    let act = &story_of(&scored).chapters[0].acts[0];
    assert_eq!(
        act.music.as_ref().unwrap().takes[0].asset_ids,
        vec!["asset-act-music"]
    );
    assert!(act.voice.is_none());
}

#[test]
fn trims_a_slot_to_what_a_place_keeps_oldest_first_and_drops_two_of_one_drawing() {
    let moka = story_document();
    let mut takes: Vec<StoryTake> = (0..MAX_TAKES_PER_SLOT + 3)
        .map(|n| take(&format!("asset-{n}")))
        .collect();
    takes.push(take("asset-0"));
    let next = apply(
        &moka,
        vec![DocumentCommand::SetStorySlot {
            story_id: STORY.into(),
            target: StorySlotTarget::Element {
                element_id: PROP.into(),
                view: StoryElementView::Main,
            },
            slot: StorySlot { takes },
            read: None,
        }],
    )
    .0;
    let prop = story_of(&next)
        .elements
        .iter()
        .find(|element| element.id == PROP)
        .unwrap();
    assert_eq!(prop.main.takes.len(), MAX_TAKES_PER_SLOT);
    assert_eq!(prop.main.takes[0].asset_ids, vec!["asset-3"]);
}

#[test]
fn refuses_a_place_the_story_no_longer_holds() {
    let moka = story_document();
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::SetStorySlot {
                story_id: STORY.into(),
                target: StorySlotTarget::Element {
                    element_id: "gone".into(),
                    view: StoryElementView::Main,
                },
                slot: empty_slot(),
                read: None,
            }
        ),
        "STORY_TARGET_INVALID"
    );
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::SetStorySlot {
                story_id: STORY.into(),
                target: StorySlotTarget::Element {
                    element_id: SCENE.into(),
                    view: StoryElementView::Turnaround,
                },
                slot: empty_slot(),
                read: None,
            }
        ),
        "STORY_TARGET_INVALID"
    );
}

#[test]
fn remembers_what_a_story_was_assembled_into_and_refuses_a_timeline_nobody_holds() {
    let moka = story_document();
    let next = round_trip(
        &moka,
        vec![DocumentCommand::SetStoryEdit {
            story_id: STORY.into(),
            patch: StoryEditPatch {
                timeline_id: Some(Some(TIMELINE.into())),
                clip_by_act: Some(Some(vec![StoryEditClip {
                    act_id: ACT.into(),
                    keyframe_id: None,
                    clip_id: "clip-cut-a".into(),
                }])),
                assembled_digest: Some(Some("0f3a91cd".into())),
            },
        }],
    );
    let edit = &story_of(&next).edit;
    assert_eq!(edit.timeline_id.as_deref(), Some(TIMELINE));
    assert_eq!(edit.clip_by_act.as_ref().unwrap()[0].clip_id, "clip-cut-a");
    assert_eq!(edit.assembled_digest.as_deref(), Some("0f3a91cd"));

    // A digest is what an assembly writes down; anything else is refused
    // rather than kept as though it meant something.
    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::SetStoryEdit {
                story_id: STORY.into(),
                patch: StoryEditPatch {
                    assembled_digest: Some(Some("NOT-A-DIGEST".into())),
                    ..Default::default()
                },
            }
        ),
        "VALIDATION_FAILED"
    );

    // And it can be taken away again, which is what an undo of the first
    // assembly's own writing looks like.
    let without = round_trip(
        &next,
        vec![DocumentCommand::SetStoryEdit {
            story_id: STORY.into(),
            patch: StoryEditPatch {
                assembled_digest: Some(None),
                ..Default::default()
            },
        }],
    );
    assert_eq!(story_of(&without).edit.assembled_digest, None);

    assert_eq!(
        code_of(
            &moka,
            DocumentCommand::SetStoryEdit {
                story_id: STORY.into(),
                patch: StoryEditPatch {
                    timeline_id: Some(Some("timeline-gone".into())),
                    ..Default::default()
                },
            }
        ),
        "TIMELINE_NOT_FOUND"
    );
}

#[test]
fn settles_a_step_and_takes_it_back_with_the_press_reversed() {
    let moka = story_document();
    // Step five has not been settled, and settling it keeps the telling's own
    // order rather than the order the presses came in.
    let next = round_trip(
        &moka,
        vec![DocumentCommand::ConfirmStoryStep {
            story_id: STORY.into(),
            step: story::StoryStep::Edit,
            confirmed: true,
        }],
    );
    assert_eq!(
        story_of(&next).confirmed_steps,
        vec![
            story::StoryStep::Idea,
            story::StoryStep::Outline,
            story::StoryStep::Elements,
            story::StoryStep::Edit,
        ]
    );

    // Taken back, the step is the reader's again, and one the story never had
    // is settled rather than refused: the press is what opens a step, and a
    // step whose content is not there yet is the interface's own question.
    let next = round_trip(
        &moka,
        vec![DocumentCommand::ConfirmStoryStep {
            story_id: STORY.into(),
            step: story::StoryStep::Outline,
            confirmed: false,
        }],
    );
    assert_eq!(
        story_of(&next).confirmed_steps,
        vec![story::StoryStep::Idea, story::StoryStep::Elements]
    );
}

// -----------------------------------------------------------------------------
// Guardrails
// -----------------------------------------------------------------------------

#[test]
fn passes_the_fixture_and_reports_what_a_hand_written_file_gets_wrong() {
    let moka = story_document();
    assert_eq!(validate_moka_file(&moka), Vec::new());

    let mut nameless = moka.clone();
    nameless.stories.as_mut().unwrap()[0].name = String::new();
    assert!(validate_moka_file(&nameless)
        .iter()
        .any(|issue| issue.code == "STORY_NAME_INVALID"));

    let mut from_the_future = moka.clone();
    from_the_future.stories.as_mut().unwrap()[0].schema_version = 9;
    assert!(validate_moka_file(&from_the_future)
        .iter()
        .any(|issue| issue.code == "STORY_SCHEMA_NEWER"));

    let mut orphaned = moka.clone();
    orphaned.stories.as_mut().unwrap()[0].edit.timeline_id = Some("timeline-gone".into());
    assert!(validate_moka_file(&orphaned)
        .iter()
        .any(|issue| issue.code == "STORY_TARGET_INVALID"));

    let mut doubled = moka.clone();
    let story = doubled.stories.as_ref().unwrap()[0].clone();
    doubled.stories.as_mut().unwrap().push(story);
    assert!(validate_moka_file(&doubled)
        .iter()
        .any(|issue| issue.code == "STORY_ID_EXISTS"));
}

#[test]
fn reports_a_slot_that_carries_more_takes_than_it_may() {
    let mut moka = story_document();
    let takes: Vec<StoryTake> = (0..MAX_TAKES_PER_SLOT + 1)
        .map(|n| take(&format!("asset-{n}")))
        .collect();
    moka.stories.as_mut().unwrap()[0].elements[0].main = StorySlot { takes };
    assert!(validate_moka_file(&moka)
        .iter()
        .any(|issue| issue.code == "STORY_SLOT_FULL"));
}

#[test]
fn counts_every_drawing_and_the_manuscript_as_in_use() {
    let mut moka = story_document();
    moka.stories.as_mut().unwrap()[0].chapters[0].acts[0].voice = Some(StorySlot {
        takes: vec![take("asset-act-voice")],
    });
    moka.stories.as_mut().unwrap()[0].chapters[0].acts[0].music = Some(StorySlot {
        takes: vec![take("asset-act-music")],
    });
    let refs = moka.asset_references();
    for asset_id in [
        SOURCE,
        HERO_MAIN,
        HERO_SHEET,
        FRAME_ART,
        ACT_VIDEO,
        "asset-act-voice",
        "asset-act-music",
    ] {
        assert!(
            refs.contains_key(asset_id),
            "{asset_id} is pointed at by the story"
        );
    }
}

#[test]
fn counts_a_recording_a_voice_names_as_in_use() {
    let mut moka = story_document();
    let story = &mut moka.stories.as_mut().unwrap()[0];
    story.narrator = Some(story::StoryVoiceProfile {
        reference_asset_id: Some("asset-narrator-voice".into()),
        ..voice("", "")
    });
    story.elements[0].voice = Some(story::StoryVoiceProfile {
        reference_asset_id: Some("asset-hero-voice".into()),
        ..voice("", "")
    });
    let refs = moka.asset_references();
    assert!(
        refs.contains_key("asset-hero-voice"),
        "the character's recording is pointed at by the story"
    );
    assert!(
        refs.contains_key("asset-narrator-voice"),
        "the narrator's recording is pointed at by the story"
    );
}

// -----------------------------------------------------------------------------
// What a document carries
// -----------------------------------------------------------------------------

#[test]
fn reads_the_steps_an_older_document_settled_one_place_at_a_time() {
    // The document as an older build wrote it: no record of settled steps, and
    // the reader's answers standing in the places they used to.
    let document = bson::serialize_to_document(&story_document()).unwrap();
    let mut document = legacy_story(document);
    let bytes = |document: &bson::Document| {
        let mut bytes = MOKA_MAGIC.to_vec();
        bytes.extend(bson::serialize_to_vec(document).unwrap());
        bytes
    };

    // A telling nobody had agreed to anything in reads as one standing on its
    // premise — the manuscript the fixture carries is a premise — and no
    // further.
    let read = decode_moka_file(&bytes(&document)).unwrap();
    assert_eq!(
        story_of(&read).confirmed_steps,
        vec![story::StoryStep::Idea]
    );

    // The answers the old room kept: both chapters written, and the act filmed.
    let bson::Bson::Array(stories) = document.get_mut("stories").unwrap() else {
        panic!("the fixture tells a story");
    };
    let bson::Bson::Document(story) = &mut stories[0] else {
        panic!("a story is a document");
    };
    let bson::Bson::Array(chapters) = story.get_mut("chapters").unwrap() else {
        panic!("a story holds chapters");
    };
    for chapter in chapters.iter_mut() {
        let bson::Bson::Document(chapter) = chapter else {
            panic!("a chapter is a document");
        };
        chapter.insert("synopsisConfirmed", true);
    }
    let bson::Bson::Document(chapter) = &mut chapters[0] else {
        panic!("a chapter is a document");
    };
    let bson::Bson::Array(acts) = chapter.get_mut("acts").unwrap() else {
        panic!("the first chapter is boarded");
    };
    let bson::Bson::Document(act) = &mut acts[0] else {
        panic!("an act is a document");
    };
    act.insert("videoConfirmed", true);

    // The steps those answers stand for, and no others: the cast is not drawn
    // through, so the third step was never settled. The fifth has no answer a
    // document could stand in for it any more, so the assembly the fixture
    // carries is not read as one.
    let read = decode_moka_file(&bytes(&document)).unwrap();
    assert_eq!(
        story_of(&read).confirmed_steps,
        vec![
            story::StoryStep::Idea,
            story::StoryStep::Outline,
            story::StoryStep::Storyboard,
        ]
    );
}

/// The same project as a document an older build wrote: the field that holds
/// the settled steps is not there at all.
fn legacy_story(mut document: bson::Document) -> bson::Document {
    let bson::Bson::Array(stories) = document.get_mut("stories").unwrap() else {
        panic!("the fixture tells a story");
    };
    let bson::Bson::Document(story) = &mut stories[0] else {
        panic!("a story is a document");
    };
    story.remove("confirmedSteps");
    document
}

#[test]
fn a_voiced_act_survives_the_codec_with_its_sound_and_an_unvoiced_one_without() {
    let mut moka = story_document();
    // A telling nobody has voiced writes no slot at all: the file says "not
    // asked for yet" rather than "asked for and empty".
    let bytes = encode_moka_file(&moka, None).unwrap();
    let read = decode_moka_file(&bytes).unwrap();
    assert!(story_of(&read).chapters[0].acts[0].voice.is_none());

    moka.stories.as_mut().unwrap()[0].chapters[0].acts[0].voice = Some(StorySlot {
        takes: vec![take("asset-act-voice")],
    });
    moka.stories.as_mut().unwrap()[0].chapters[0].acts[0].music =
        Some(StorySlot { takes: Vec::new() });
    let bytes = encode_moka_file(&moka, None).unwrap();
    let read = decode_moka_file(&bytes).unwrap();
    let act = &story_of(&read).chapters[0].acts[0];
    assert_eq!(
        act.voice.as_ref().unwrap().takes[0].asset_ids,
        vec!["asset-act-voice"]
    );
    assert_eq!(act.music.as_ref().unwrap().takes.len(), 0);
}

#[test]
fn a_story_survives_the_codec_as_the_document_it_went_in_as() {
    let moka = story_document();
    let bytes = encode_moka_file(&moka, None).unwrap();
    let read = decode_moka_file(&bytes).unwrap();
    assert_eq!(read, moka);
    assert_eq!(read.stories.as_ref().unwrap()[0].brief.style, "现代都市风");
}

#[test]
fn a_document_that_tells_no_story_carries_none() {
    let mut moka = story_document();
    moka.stories = None;
    let bytes = encode_moka_file(&moka, None).unwrap();
    let read = decode_moka_file(&bytes).unwrap();
    assert!(read.stories.is_none());
}

#[test]
fn reads_a_word_it_does_not_know_as_the_plainest_thing_it_could_be() {
    // A board written by another build: the words are ones this one has no
    // meaning for, and the telling is still read.
    let raw = r##"{
        "id": "story-1",
        "name": "雨夜列车",
        "schemaVersion": 1,
        "brief": {
            "idea": "一句话",
            "totalDurationMs": 120000,
            "aspect": "5:4",
            "genre": "",
            "style": ""
        },
        "chapters": [{
            "id": "chapter-1",
            "title": "一",
            "synopsis": "",
            "synopsisConfirmed": false,
            "targetDurationMs": 60000,
            "acts": [{
                "id": "act-1",
                "title": "第 1 幕",
                "summary": "",
                "characterIds": [],
                "propIds": [],
                "sound": { "music": "", "sfx": "" },
                "keyframes": [{
                    "id": "frame-1",
                    "title": "#1",
                    "shotSize": "gigantic",
                    "cameraMove": "swooping",
                    "angle": "sideways",
                    "filmRole": "solo",
                    "content": "",
                    "dialogue": [],
                    "durationMs": 1000,
                    "art": { "takes": [], "confirmed": false },
                    "video": { "takes": [], "confirmed": false }
                }],
                "keysConfirmed": false,
                "imagesConfirmed": false,
                "video": { "takes": [], "confirmed": false },
                "videoConfirmed": false
            }]
        }],
        "elements": [{
            "id": "element-1",
            "kind": "souvenir",
            "name": "票",
            "description": "",
            "descriptionConfirmed": false,
            "chapterIds": [],
            "main": { "takes": [], "confirmed": false }
        }],
        "shotGranularity": "everyShot",
        "edit": {},
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    }"##;
    let story: StoryDocument = serde_json::from_str(raw).expect("the telling is read");
    // Written before a step was something the reader settles, and read as a
    // telling none of whose steps have been settled yet.
    assert!(story.confirmed_steps.is_empty());
    assert_eq!(story.shot_granularity, StoryShotGranularity::Act);
    // A document written before the reference limit existed says nothing about
    // it, and the default is what it meant.
    assert_eq!(story.max_reference_images, story::REFERENCE_IMAGES_DEFAULT);
    assert_eq!(story.brief.aspect, story::StoryAspect::Widescreen);
    assert_eq!(story.elements[0].kind, StoryElementKind::Prop);
    let frame = &story.chapters[0].acts[0].keyframes[0];
    assert_eq!(frame.shot_size, StoryShotSize::Medium);
    assert_eq!(frame.camera_move, story::StoryCameraMove::Static);
    assert_eq!(frame.angle, story::StoryCameraAngle::EyeLevel);
    assert_eq!(frame.film_role, story::StoryFilmRole::Reference);
}

#[test]
fn refuses_a_story_written_by_a_newer_build_rather_than_reading_it_wrongly() {
    let mut moka = story_document();
    moka.stories.as_mut().unwrap()[0].schema_version = 9;
    let bytes = encode_moka_file(&moka, None).unwrap();
    assert_eq!(
        decode_moka_file(&bytes).unwrap_err().code(),
        "MOKA_VERSION_UNSUPPORTED"
    );
}

/// The command the story room posts, as it posts it — a take names its files
/// in a list, whether it is one file or several.
///
/// This is the seam the two halves meet at, so the shape is pinned here rather
/// than left to whichever half was written last. The lone `assetId` a document
/// from before the pieces feature carries is still read, and written back out
/// in the list form.
#[test]
fn reads_the_slot_command_the_story_room_posts() {
    let command: DocumentCommand = serde_json::from_str(
        r##"{
            "type": "setStorySlot",
            "storyId": "story-1",
            "target": { "kind": "actVideo", "chapterId": "chapter-first", "actId": "act-1" },
            "slot": {
                "takes": [
                    {
                        "assetIds": ["asset-a", "asset-b"],
                        "jobId": "job-1",
                        "itemId": "actVideo:chapter-first:act-1",
                        "note": "一个长幕分几段拍",
                        "createdAt": "2026-01-01T00:00:00.000Z"
                    },
                    { "assetId": "asset-c", "createdAt": "2026-01-01T00:00:00.000Z" }
                ]
            }
        }"##,
    )
    .expect("the command is read");
    let DocumentCommand::SetStorySlot { slot, .. } = command else {
        panic!("the command is a slot");
    };
    assert_eq!(slot.takes[0].asset_ids, vec!["asset-a", "asset-b"]);
    assert_eq!(slot.takes[0].job_id.as_deref(), Some("job-1"));
    assert_eq!(slot.takes[0].note.as_deref(), Some("一个长幕分几段拍"));
    assert_eq!(slot.takes[1].asset_ids, vec!["asset-c"]);

    let written = serde_json::to_value(&slot.takes[0]).unwrap();
    assert_eq!(
        written["assetIds"],
        serde_json::json!(["asset-a", "asset-b"])
    );
    assert_eq!(written["createdAt"], "2026-01-01T00:00:00.000Z");

    let lone = serde_json::to_value(&slot.takes[1]).unwrap();
    assert_eq!(lone["assetIds"], serde_json::json!(["asset-c"]));
    assert!(lone.get("assetId").is_none());
    // Written and read back as the same take, so what the room files is what
    // the room sees.
    assert_eq!(
        serde_json::from_value::<StoryTake>(lone).unwrap(),
        slot.takes[1]
    );
}

#[test]
fn refuses_a_take_that_names_no_file_at_all() {
    let empty = serde_json::from_str::<StoryTake>(
        r##"{ "assetIds": [], "createdAt": "2026-01-01T00:00:00.000Z" }"##,
    )
    .unwrap_err();
    assert!(empty.to_string().contains("at least one file"), "{empty}");

    let absent = serde_json::from_str::<StoryTake>(
        r##"{ "jobId": "job-1", "createdAt": "2026-01-01T00:00:00.000Z" }"##,
    )
    .unwrap_err();
    assert!(absent.to_string().contains("assetId"), "{absent}");
}

/// A story with a premise and nothing made of it yet, the way the room makes
/// one.
fn create_story(name: &str) -> StoryDocument {
    StoryDocument {
        id: "story-new".into(),
        name: name.into(),
        schema_version: 1,
        brief: StoryBrief {
            idea: "一句话".into(),
            source_asset_id: None,
            source_name: None,
            source_split: None,
            total_duration_ms: 120_000,
            aspect: story::StoryAspect::Widescreen,
            genre: String::new(),
            style: String::new(),
        },
        chapters: Vec::new(),
        elements: Vec::new(),
        shot_granularity: StoryShotGranularity::Act,
        max_reference_images: story::REFERENCE_IMAGES_DEFAULT,
        confirmed_steps: Vec::new(),
        edit: StoryEdit::default(),
        narrator: None,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}
