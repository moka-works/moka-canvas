import { describe, expect, it } from "vitest";
import { applyCommands, CommandError } from "./commands";
import {
  MAX_ACTS_PER_CHAPTER,
  MAX_CHAPTERS_PER_STORY,
  MAX_ELEMENTS_PER_STORY,
  MAX_KEYFRAMES_PER_ACT,
  MAX_TAKES_PER_SLOT,
  REFERENCE_IMAGES_DEFAULT,
  REFERENCE_IMAGES_MAX,
  STORY_NAME_MAX,
} from "./constants";
import { decodeMokaFile, encodeMokaFile } from "./codec";
import { i18n } from "../i18n";
import {
  buildEmptyStory,
  buildStoryMokaFile,
  storyIds,
  timelineIds,
} from "./fixtures";
import {
  createChapter,
  createKeyframe,
  createStory,
  defaultChapterCount,
  emptyStorySlot,
  nextStoryName,
} from "./factories";
import {
  actPlannedMs,
  actsRegenerationCost,
  chapterRegenerationCost,
  chapterWaves,
  chunkWaves,
  currentTake,
  elementComplete,
  elementOf,
  formatDuration,
  ideaReady,
  firstLineOf,
  keyframeCount,
  lineCountFor,
  mergeActs,
  mergeChapters,
  mergeChaptersAt,
  mergeElements,
  slotWithoutTake,
  stepComplete,
  stepGaps,
  stepReachable,
  storyMentions,
  STORY_STEPS,
  storyProgress,
  stripStoryMentions,
  targetKey,
  timelineSizeForAspect,
  voiceFor,
  voiceNamed,
  withTake,
  type ActDraft,
  type StoryChapterDraft,
  type StoryElementDraft,
} from "./story";
import {
  collectAssetReferences,
  unreferencedAssets,
  validateMokaFile,
  validateStory,
} from "./validate";
import type {
  DocumentCommand,
  MokaFile,
  StoryAct,
  StoryChapter,
  StoryDocument,
  StoryElement,
  StoryKeyframe,
  StorySlot,
  StoryVoiceProfile,
} from "./types";

const NOW = "2026-01-01T00:00:00.000Z";

function apply(moka: MokaFile, ...commands: DocumentCommand[]) {
  return applyCommands(moka, commands);
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as CommandError).code;
  }
  return "NO_ERROR";
}

/** Every command must survive this: apply, undo, and be where it started. */
function expectRoundTrip(
  moka: MokaFile,
  ...commands: DocumentCommand[]
): MokaFile {
  const { next, inverse } = apply(moka, ...commands);
  const undone = apply(next, ...inverse).next;
  expect(undone).toEqual(moka);
  return next;
}

function storyOfFile(moka: MokaFile): StoryDocument {
  return moka.stories![0];
}

function take(assetId: string): StorySlot["takes"][number] {
  return { assetIds: [assetId], createdAt: NOW };
}

// -----------------------------------------------------------------------------
// Where each step has got to
// -----------------------------------------------------------------------------

describe("storyProgress", () => {
  const ids = storyIds();

  it("counts the premise as the one thing step one settles", () => {
    const empty = createStory("新的故事");
    expect(storyProgress(empty).idea).toEqual({
      step: "idea",
      state: "empty",
      done: 0,
      total: 1,
    });
    const told = createStory("新的故事", { idea: "一个人等一班停运的车。" });
    expect(storyProgress(told).idea.state).toBe("ready");
    expect(storyProgress(told).idea.done).toBe(1);

    // Settled is the reader's word: a step that is complete is not yet a step
    // that was confirmed.
    told.confirmedSteps = ["idea"];
    expect(storyProgress(told).idea.state).toBe("confirmed");
  });

  it("calls an outline working until every chapter is written, then ready until the reader settles it", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.chapters = [createChapter("一", "他等车。"), createChapter("二")];
    expect(storyProgress(story).outline).toMatchObject({
      state: "working",
      done: 1,
      total: 2,
    });

    story.chapters = [
      createChapter("一", "他等车。"),
      createChapter("二", "车没有来。"),
    ];
    expect(storyProgress(story).outline.state).toBe("ready");

    story.confirmedSteps = ["idea", "outline"];
    expect(storyProgress(story).outline.state).toBe("confirmed");

    // A chapter re-written afterwards leaves the outline settled: only the
    // count of what is finished moves.
    story.chapters = [createChapter("一", "他等车。"), createChapter("二")];
    expect(storyProgress(story).outline).toMatchObject({
      state: "confirmed",
      done: 1,
      total: 2,
    });
  });

  it("counts an element only when its words and its drawings are both there", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.elements = [
      {
        ...element(ids.hero, "character"),
        description: "四十岁上下。",
        main: { takes: [take(ids.heroMain)] },
        turnaround: { takes: [take(ids.heroSheet)] },
      },
      {
        ...element(ids.prop, "prop"),
        description: "一张车票。",
        main: { takes: [] },
      },
    ];
    expect(storyProgress(story).elements).toMatchObject({
      state: "working",
      done: 1,
      total: 2,
    });

    story.elements = story.elements.map((held) => ({
      ...held,
      main: { takes: [take(ids.sceneMain)] },
    }));
    expect(storyProgress(story).elements.state).toBe("ready");
  });

  it("counts a character as drawn only when both of its drawings are there", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.elements = [
      {
        ...element(ids.hero, "character"),
        description: "四十岁上下。",
        main: { takes: [take(ids.heroMain)] },
        turnaround: { takes: [] },
      },
    ];
    expect(storyProgress(story).elements.state).toBe("working");
    story.elements[0].turnaround = { takes: [take(ids.heroSheet)] };
    expect(storyProgress(story).elements.state).toBe("ready");
  });

  it("counts an act as finished only when it is boarded, drawn and filmed", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    const act = createActFor(ids.chapterFirst);
    const frame = createKeyframe(0);
    frame.art = { takes: [take(ids.frameArt)] };
    act.keyframes = [frame];
    story.chapters = [{ ...createChapter("一"), acts: [act] }];
    expect(storyProgress(story).storyboard).toMatchObject({
      state: "working",
      done: 0,
      total: 1,
    });

    // Drawn through, and still no clip: the step is not finished yet.
    act.video = { takes: [take(ids.actVideo)] };
    expect(storyProgress(story).storyboard).toMatchObject({
      state: "ready",
      done: 1,
    });
  });

  it("reads a shot-at-a-time telling as filmed only when every shot has a clip", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.shotGranularity = "keyframe";
    const act = createActFor(ids.chapterFirst);
    const first = createKeyframe(0);
    const second = createKeyframe(1);
    first.art = { takes: [take(ids.frameArt)] };
    second.art = { takes: [take(ids.sceneMain)] };
    first.video = { takes: [take(ids.actVideo)] };
    act.keyframes = [first, second];
    story.chapters = [{ ...createChapter("一"), acts: [act] }];
    expect(storyProgress(story).storyboard.done).toBe(0);

    second.video = { takes: [take(ids.actVideo)] };
    expect(storyProgress(story).storyboard.done).toBe(1);
  });

  it("reads the assembly as empty until a timeline is named, and done once it is", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    expect(storyProgress(story).edit.state).toBe("empty");
    story.edit = { timelineId: "timeline-1" };
    expect(storyProgress(story).edit.state).toBe("ready");
    expect(storyProgress(story).edit.done).toBe(1);

    // The assembly is the whole of the step: an old document that once had to
    // confirm it reads the same as one that never did.
    story.confirmedSteps = ["edit"];
    expect(storyProgress(story).edit.state).toBe("ready");
  });
});

describe("what a step is still waiting for", () => {
  const ids = storyIds();

  it("says what step one is missing, and nothing once the premise is written", () => {
    const story = createStory("新的故事");
    expect(stepGaps(story, "idea")).toEqual([{ kind: "ideaMissing" }]);
    story.brief.idea = "一个人等一班停运的车。";
    expect(stepGaps(story, "idea")).toEqual([]);
    expect(stepComplete(story, "idea")).toBe(true);
  });

  it("names the chapters of an outline that are not written yet", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    expect(stepGaps(story, "outline")).toEqual([{ kind: "noChapters" }]);
    story.chapters = [
      createChapter("一", "他等车。"),
      createChapter("二"),
      createChapter("", "没有标题。"),
    ];
    expect(stepGaps(story, "outline")).toEqual([
      { kind: "chaptersUnwritten", numbers: [2, 3] },
    ]);
  });

  it("lists the elements that have no words, and those that have no drawing", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    expect(stepGaps(story, "elements")).toEqual([{ kind: "noElements" }]);
    story.elements = [
      { ...element(ids.hero, "character"), name: "林", description: "" },
      {
        ...element(ids.prop, "prop"),
        name: "旧车票",
        description: "一张车票。",
        main: { takes: [] },
      },
    ];
    expect(stepGaps(story, "elements")).toEqual([
      { kind: "elementsUndescribed", names: ["林"] },
      { kind: "elementsUndrawn", names: ["旧车票"] },
    ]);
  });

  it("counts the acts with nothing in them, the frames missing and the clips missing", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    expect(stepGaps(story, "storyboard")).toEqual([{ kind: "noActs" }]);
    const bare = createActFor(ids.chapterFirst);
    const shot = createActFor(ids.chapterSecond);
    shot.keyframes = [createKeyframe(0)];
    shot.video = { takes: [take(ids.actVideo)] };
    story.chapters = [
      { ...createChapter("一"), acts: [bare] },
      { ...createChapter("二"), acts: [shot] },
    ];
    expect(stepGaps(story, "storyboard")).toEqual([
      { kind: "actsWithoutShots", count: 1 },
      { kind: "framesMissing", count: 1 },
      { kind: "clipsMissing", count: 1 },
    ]);
  });

  it("asks for the timeline, and for nothing after it", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    expect(stepGaps(story, "edit")).toEqual([{ kind: "noTimeline" }]);
    story.edit = { timelineId: "timeline-1" };
    expect(stepGaps(story, "edit")).toEqual([]);
  });
});

describe("which step a reader can walk to", () => {
  const ids = storyIds();

  it("lets step two open on a premise the reader has settled, and no sooner", () => {
    const story = createStory("新的故事");
    expect(stepReachable(storyProgress(story), "outline")).toBe(false);
    story.brief.idea = "一个人等一班停运的车。";
    // Written, and not yet settled: a door opens on the reader's word.
    expect(stepReachable(storyProgress(story), "outline")).toBe(false);
    story.confirmedSteps = ["idea"];
    expect(stepReachable(storyProgress(story), "outline")).toBe(true);
  });

  it("opens the elements on an outline that has been settled", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.confirmedSteps = ["idea"];
    story.chapters = [createChapter("一", "他等车。")];
    expect(stepReachable(storyProgress(story), "elements")).toBe(false);

    // Settled, and not one board between them: the boards are what step four
    // is for, and step three is where they are drawn from.
    story.confirmedSteps = ["idea", "outline"];
    expect(storyProgress(story).outline.state).toBe("confirmed");
    expect(stepReachable(storyProgress(story), "elements")).toBe(true);
  });

  it("opens the board on elements that have been settled", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.chapters = [createChapter("一", "他等车。")];
    story.confirmedSteps = ["idea", "outline"];
    story.elements = [
      {
        ...element(ids.hero, "character"),
        main: { takes: [take(ids.heroMain)] },
        turnaround: { takes: [take(ids.heroSheet)] },
      },
    ];
    // Drawn through, and not yet settled.
    expect(stepReachable(storyProgress(story), "storyboard")).toBe(false);
    story.confirmedSteps = ["idea", "outline", "elements"];
    expect(stepReachable(storyProgress(story), "storyboard")).toBe(true);
  });

  it("opens the cutting room on a board that has been settled", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    const act = createActFor(ids.chapterFirst);
    act.video = { takes: [take(ids.actVideo)] };
    story.chapters = [{ ...createChapter("一"), acts: [act] }];
    story.confirmedSteps = ["idea", "outline", "elements"];
    expect(stepReachable(storyProgress(story), "edit")).toBe(false);
    story.confirmedSteps = ["idea", "outline", "elements", "storyboard"];
    expect(stepReachable(storyProgress(story), "edit")).toBe(true);
  });

  it("always offers the first step, and keeps the other four in order", () => {
    const bare = storyProgress(createStory("新的故事"));
    expect(stepReachable(bare, "idea")).toBe(true);
    for (const step of STORY_STEPS) {
      expect(stepReachable(bare, step)).toBe(step === "idea");
    }
  });
});

describe("counting a story's parts", () => {
  it("adds up an act's shots, and an episode's", () => {
    const chapter = createChapter("一");
    const act = createActFor(chapter.id);
    const first = createKeyframe(0);
    first.durationMs = 2_000;
    const second = createKeyframe(1);
    second.durationMs = 3_000;
    act.keyframes = [first, second];
    chapter.acts = [act];
    expect(actPlannedMs(act)).toBe(5_000);
    expect(keyframeCount(chapter)).toBe(2);
  });
});

describe("what a story is told and cut to", () => {
  it("turns a frame into the size a film is exported at", () => {
    expect(timelineSizeForAspect("16:9")).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(timelineSizeForAspect("9:16")).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(timelineSizeForAspect("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(timelineSizeForAspect("4:3")).toEqual({ width: 1440, height: 1080 });
    expect(timelineSizeForAspect("21:9")).toEqual({
      width: 2560,
      height: 1080,
    });
  });

  it("reads a running time the way a reader says it", () => {
    expect(formatDuration(30_000)).toBe("00:30");
    expect(formatDuration(180_000)).toBe("03:00");
    expect(formatDuration(8 * 60 * 60 * 1000)).toBe("8:00:00");
  });
});

describe("whether the premise is one", () => {
  const story = () => {
    const held = createStory("一个故事");
    return held;
  };

  it("wants words or a manuscript before anything can be written from it", () => {
    expect(ideaReady(story())).toBe(false);
    expect(
      ideaReady({ ...story(), brief: { ...story().brief, idea: "太短" } }),
    ).toBe(false);
    expect(
      ideaReady({
        ...story(),
        brief: { ...story().brief, idea: "末班列车上，两个陌生人交换了话。" },
      }),
    ).toBe(true);
    expect(
      ideaReady({
        ...story(),
        brief: { ...story().brief, sourceAssetId: "asset-novel" },
      }),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Merging an answer into what is there
// -----------------------------------------------------------------------------

describe("mergeChapters", () => {
  it("keeps the board of a chapter that stands where it stood", () => {
    const existing: StoryChapter[] = [
      { ...createChapter("一", "旧梗概"), acts: [createActFor("chapter-1")] },
    ];
    const proposed: StoryChapterDraft[] = [
      { title: "一", synopsis: "新梗概", targetDurationMs: 30_000 },
    ];
    const merged = mergeChapters(existing, proposed);
    expect(merged[0].id).toBe(existing[0].id);
    expect(merged[0].synopsis).toBe("新梗概");
    expect(merged[0].targetDurationMs).toBe(30_000);
    expect(merged[0].acts).toHaveLength(1);
  });

  it("gives a chapter with no chapter in its place one of its own, and lets the chapters no longer told go", () => {
    const existing: StoryChapter[] = [createChapter("一"), createChapter("二")];
    const merged = mergeChapters(existing, [
      { title: "一", synopsis: "" },
      { title: "多出来的一章", synopsis: "" },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(existing[0].id);
    expect(merged[1].id).not.toBe(existing[0].id);
    expect(merged[1].acts).toEqual([]);

    // The second chapter is gone from the telling, and so is its board.
    const shortened = mergeChapters(existing, [{ title: "一", synopsis: "" }]);
    expect(shortened).toHaveLength(1);
  });
});

describe("mergeElements", () => {
  const hero: StoryElement = {
    ...element("element-hero", "character"),
    name: "林",
    description: "旧描述",
    main: { takes: [take("asset-hero-main")] },
    turnaround: { takes: [take("asset-hero-sheet")] },
  };

  it("matches a character by kind and name however the airs around the name move", () => {
    const identified: StoryElementDraft[] = [
      { kind: "character", name: "  林 ", description: "新描述" },
    ];
    const merged = mergeElements([hero], identified, [createChapter("一")]);
    expect(merged[0].id).toBe(hero.id);
    expect(merged[0].description).toBe("新描述");
    expect(merged[0].main.takes).toHaveLength(1);
    expect(merged[0].main.takes[0].assetIds[0]).toBe("asset-hero-main");
    expect(merged[0].turnaround?.takes).toHaveLength(1);
  });

  it("drops a character the reading no longer finds, and gives a new one no drawings", () => {
    const merged = mergeElements(
      [hero],
      [{ kind: "prop", name: "旧车票", description: "一张车票" }],
      [],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).not.toBe(hero.id);
    expect(merged[0].main.takes).toEqual([]);
    expect(merged[0].turnaround).toBeUndefined();
  });

  it("keeps what a part of the telling did not name, since it never saw it", () => {
    const merged = mergeElements(
      [hero],
      [{ kind: "character", name: "周", description: "年轻。" }],
      [],
      { partial: true },
    );
    expect(merged.map((each) => each.name)).toEqual(["周", "林"]);
    // The cast it did name is still matched and rewritten, drawings and all.
    const again = mergeElements(
      [hero],
      [{ kind: "character", name: "林", description: "换了衣服。" }],
      [],
      { partial: true },
    );
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(hero.id);
    expect(again[0].description).toBe("换了衣服。");
    expect(again[0].main.takes).toHaveLength(1);
  });

  it("adds the chapters a later part noticed to the ones already on file", () => {
    const chapters = [createChapter("一"), createChapter("二")];
    const heard = { ...hero, chapterIds: [chapters[0].id] };
    const merged = mergeElements(
      [heard],
      [
        {
          kind: "character",
          name: "林",
          description: "换了衣服。",
          chapterIndexes: [1],
        },
      ],
      chapters,
      { partial: true },
    );
    // A part that read the second chapter cannot unsay what the part before it
    // found in the first: what it noticed is added, in telling order.
    expect(merged).toHaveLength(1);
    expect(merged[0].chapterIds).toEqual([chapters[0].id, chapters[1].id]);
  });

  it("keeps one name from standing in the cast twice", () => {
    const merged = mergeElements(
      [],
      [
        { kind: "character", name: "林", description: "短。" },
        { kind: "character", name: "林", description: "更长的一段描述。" },
      ],
      [],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].chapterIds).toEqual([]);
  });

  it("resolves the chapters a draft was noticed in, and drops a number that names none", () => {
    const chapters = [createChapter("一"), createChapter("二")];
    const merged = mergeElements(
      [],
      [
        {
          kind: "character",
          name: "林",
          description: "",
          chapterIndexes: [1, 9],
        },
        { kind: "prop", name: "票", description: "", chapterIndexes: [] },
      ],
      chapters,
    );
    expect(merged[0].chapterIds).toEqual([chapters[1].id]);
    expect(merged[1].chapterIds).toEqual([]);
  });
});

describe("mergeActs", () => {
  it("keeps the frames and the clip of an act that stands where it stood", () => {
    const held = createActFor("chapter-1");
    const frame = createKeyframe(0);
    frame.art = { takes: [take("asset-frame-art")] };
    frame.video = { takes: [take("asset-frame-video")] };
    held.keyframes = [frame];
    held.video = { takes: [take("asset-act-video")] };

    const draft: ActDraft = {
      title: "新标题",
      summary: "新内容",
      characters: ["element-hero"],
      props: [],
      sound: { music: "低音", sfx: "雨" },
      keyframes: [
        {
          shotSize: "close",
          cameraMove: "static",
          angle: "low",
          content: "新画面",
          dialogue: [
            { speaker: "林", text: "走吧", characterId: "element-hero" },
          ],
          durationMs: 1_500,
        },
      ],
    };
    const merged = mergeActs([held], [draft]);
    expect(merged[0].id).toBe(held.id);
    expect(merged[0].title).toBe("新标题");
    expect(merged[0].video.takes).toHaveLength(1);
    expect(merged[0].video.takes).toHaveLength(1);
    expect(merged[0].keyframes[0].id).toBe(frame.id);
    expect(merged[0].keyframes[0].art.takes).toHaveLength(1);
    expect(merged[0].keyframes[0].video.takes).toHaveLength(1);
    expect(merged[0].keyframes[0].content).toBe("新画面");
    expect(merged[0].keyframes[0].dialogue[0].characterId).toBe("element-hero");
  });

  it("gives a line written over one that stood there a name of its own, and keeps the first one's", () => {
    const held = createActFor("chapter-1");
    const frame = createKeyframe(0);
    frame.dialogue = [
      { id: "line-first", speaker: "林", text: "走吧" },
      { id: "line-second", speaker: "周", text: "再等等。" },
    ];
    held.keyframes = [frame];

    const merged = mergeActs(
      [held],
      [
        {
          title: "新标题",
          summary: "新内容",
          characters: ["element-hero"],
          props: [],
          sound: { music: "", sfx: "" },
          keyframes: [
            {
              shotSize: "close",
              cameraMove: "static",
              angle: "low",
              content: "新画面",
              durationMs: 1_500,
              dialogue: [
                // The same line, rewritten: the name is kept, and the words it
                // was read in are what will say it is out of date.
                { speaker: "林", text: "走吧，天亮了。" },
                // The one that stood second is now third, and the new line in
                // its place is the one that arrives unnamed: a line is paired
                // with the one that stood in its place, as a shot is.
                { speaker: "林", text: "听见了。" },
                { speaker: "周", text: "再等等。" },
              ],
            },
          ],
        },
      ],
    );

    const lines = merged[0].keyframes[0].dialogue;
    expect(lines[0]?.id).toBe("line-first");
    expect(lines[0]?.text).toBe("走吧，天亮了。");
    expect(new Set(lines.map((line) => line.id)).size).toBe(3);
  });

  it("lets an act that is no longer boarded go, with its frames", () => {
    const merged = mergeActs([createActFor("chapter-1")], []);
    expect(merged).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Slots
// -----------------------------------------------------------------------------

describe("withTake", () => {
  it("does not keep the same drawing twice", () => {
    const once = withTake(emptyStorySlot(), take("asset-a"), 12);
    const twice = withTake(once, take("asset-a"), 12);
    expect(twice.takes).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it("keeps the newest takes and lets the oldest go", () => {
    let slot = emptyStorySlot();
    for (let n = 0; n < MAX_TAKES_PER_SLOT + 2; n += 1) {
      slot = withTake(slot, take(`asset-${n}`), MAX_TAKES_PER_SLOT);
    }
    expect(slot.takes).toHaveLength(MAX_TAKES_PER_SLOT);
    expect(slot.takes[0].assetIds[0]).toBe("asset-2");
    expect(currentTake(slot)?.assetIds[0]).toBe(
      `asset-${MAX_TAKES_PER_SLOT + 1}`,
    );
  });
});

describe("slotWithoutTake", () => {
  it("drops the named drawing and leaves the rest in the order they were", () => {
    const held: StorySlot = {
      takes: [take("asset-a"), take("asset-b"), take("asset-c")],
    };
    const dropped = slotWithoutTake(held, "asset-b");
    expect(dropped.takes.map((one) => one.assetIds[0])).toEqual([
      "asset-a",
      "asset-c",
    ]);
    // The place the drawing was kept for still holds it: what leaves is the
    // old take alone.
    expect(currentTake(dropped)?.assetIds[0]).toBe("asset-c");
  });

  it("does not drop the drawing the place is keeping", () => {
    const held: StorySlot = { takes: [take("asset-a"), take("asset-b")] };
    expect(slotWithoutTake(held, "asset-b")).toBe(held);
  });

  it("leaves the place alone when it never held that drawing", () => {
    const held: StorySlot = { takes: [take("asset-a")] };
    expect(slotWithoutTake(held, "asset-gone")).toBe(held);
  });
});

describe("the name a place is known by", () => {
  it("is written from the target alone, in one spelling per kind of place", () => {
    expect(targetKey({ kind: "element", elementId: "e1", view: "main" })).toBe(
      "element:main:e1",
    );
    expect(
      targetKey({
        kind: "keyframe",
        chapterId: "c",
        actId: "a",
        keyframeId: "k",
      }),
    ).toBe("keyframe:c:a:k");
    expect(targetKey({ kind: "actVideo", chapterId: "c", actId: "a" })).toBe(
      "actVideo:c:a",
    );
    expect(
      targetKey({
        kind: "keyframeVideo",
        chapterId: "c",
        actId: "a",
        keyframeId: "k",
      }),
    ).toBe("keyframeVideo:c:a:k");
    expect(targetKey({ kind: "actVoice", chapterId: "c", actId: "a" })).toBe(
      "actVoice:c:a",
    );
    expect(targetKey({ kind: "actMusic", chapterId: "c", actId: "a" })).toBe(
      "actMusic:c:a",
    );
  });
});

describe("the sound of an act", () => {
  it("writes a voice into a slot that was not there, and takes it back", () => {
    const moka = buildStoryMokaFile();
    const story = storyOfFile(moka);
    expect(story.chapters[0].acts[0].voice).toBeUndefined();

    const target = {
      kind: "actVoice" as const,
      chapterId: story.chapters[0].id,
      actId: story.chapters[0].acts[0].id,
    };
    const next = expectRoundTrip(moka, {
      type: "setStorySlot",
      storyId: story.id,
      target,
      slot: { takes: [take("asset-act-voice")] },
    });
    expect(
      storyOfFile(next).chapters[0].acts[0].voice?.takes[0]?.assetIds[0],
    ).toBe("asset-act-voice");

    // And the score is a place of its own, not the same one written twice.
    const scored = expectRoundTrip(moka, {
      type: "setStorySlot",
      storyId: story.id,
      target: { ...target, kind: "actMusic" },
      slot: { takes: [take("asset-act-music")] },
    });
    const act = storyOfFile(scored).chapters[0].acts[0];
    expect(act.music?.takes).toHaveLength(1);
    expect(act.voice).toBeUndefined();
  });

  it("is what the document says: absent until it is made, and absent after", () => {
    const moka = buildStoryMokaFile();
    // A telling nobody has voiced writes no slot at all, so the file says
    // "not asked for yet" rather than "asked for and empty".
    const bare = decodeMokaFile(encodeMokaFile(moka));
    expect(storyOfFile(bare).chapters[0].acts[0].voice).toBeUndefined();

    const story = storyOfFile(moka);
    story.chapters[0].acts[0].voice = {
      takes: [take("asset-act-voice")],
    };
    story.chapters[0].acts[0].music = { takes: [] };
    const read = decodeMokaFile(encodeMokaFile(moka));
    expect(storyOfFile(read).chapters[0].acts[0].voice?.takes).toHaveLength(1);
    expect(storyOfFile(read).chapters[0].acts[0].music?.takes).toEqual([]);
  });

  it("is kept by the document as something in use, so a package carries it", () => {
    const moka = buildStoryMokaFile();
    const story = storyOfFile(moka);
    const act = story.chapters[0].acts[0];
    act.voice = { takes: [take("asset-act-voice")] };
    act.music = { takes: [take("asset-act-music")] };

    const refs = collectAssetReferences(moka);
    expect(refs.get("asset-act-voice")).toEqual([act.id]);
    expect(refs.get("asset-act-music")).toEqual([act.id]);
  });
});

describe("reading a story's cast", () => {
  it("finds the element an id names, and nothing for one the story let go", () => {
    const story = storyOfFile(buildStoryMokaFile());
    const ids = storyIds();
    expect(elementOf(story, ids.hero)?.name).toBe("林");
    expect(elementOf(story, "gone")).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// The commands
// -----------------------------------------------------------------------------

function createActFor(chapterId: string): StoryAct {
  return {
    id: `act-${chapterId}`,
    title: "第 1 幕",
    summary: "内容",
    characterIds: [],
    propIds: [],
    sound: { music: "", sfx: "" },
    keyframes: [],
    video: emptyStorySlot(),
  };
}

function element(id: string, kind: StoryElement["kind"]): StoryElement {
  return {
    id,
    kind,
    name: id,
    description: "",
    chapterIds: [],
    main: emptyStorySlot(),
    ...(kind === "character" ? { turnaround: emptyStorySlot() } : {}),
  };
}

describe("the names a shot's words mention", () => {
  it("reads every backticked name with where it is written", () => {
    expect(storyMentions("`林`看着`周`，`林`笑了。")).toEqual([
      { start: 0, end: 3, name: "林" },
      { start: 5, end: 8, name: "周" },
      { start: 9, end: 12, name: "林" },
    ]);
  });

  it("leaves a backtick with no partner as the character it is", () => {
    // A content cut short or a reader mid-typing: nothing is swallowed.
    expect(storyMentions("雨下个不停`")).toEqual([]);
    expect(storyMentions("`没有关上的名字")).toEqual([]);
    expect(storyMentions("``")).toEqual([]);
    expect(storyMentions("雨中的站台，一个人立在灯下。")).toEqual([]);
  });

  it("sends the words without the marks that made them mentions", () => {
    expect(stripStoryMentions("`林`看着`周`，`林`笑了。")).toBe(
      "林看着周，林笑了。",
    );
    expect(stripStoryMentions("雨下个不停`")).toBe("雨下个不停`");
    expect(stripStoryMentions("雨中的站台。")).toBe("雨中的站台。");
  });

  it("gives a new telling the default reference limit", () => {
    expect(createStory("新的故事").maxReferenceImages).toBe(
      REFERENCE_IMAGES_DEFAULT,
    );
  });
});

describe("story lifecycle commands", () => {
  it("adds a story at the place it asks for, and puts it back there on undo", () => {
    const moka = buildEmptyStory();
    const added = expectRoundTrip(moka, {
      type: "addStory",
      story: createStory("雨夜列车", { idea: "一句话" }),
      index: 0,
    });
    expect(added.stories).toHaveLength(2);
    expect(added.stories![0].name).toBe("雨夜列车");
  });

  it("refuses a story past the limit, a name nobody could read, and a duplicate id", () => {
    const moka = buildEmptyStory();
    const full = { ...moka, stories: [] as StoryDocument[] };
    for (let n = 0; n < 20; n += 1) {
      full.stories = [...full.stories!, createStory(`故事 ${n}`)];
    }
    expect(
      codeOf(() =>
        apply(full, { type: "addStory", story: createStory("多出来的") }),
      ),
    ).toBe("STORY_LIMIT_REACHED");

    expect(
      codeOf(() => apply(moka, { type: "addStory", story: createStory("") })),
    ).toBe("STORY_NAME_INVALID");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addStory",
          story: createStory("x".repeat(STORY_NAME_MAX + 1)),
        }),
      ),
    ).toBe("STORY_NAME_INVALID");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addStory",
          story: { ...createStory("同名"), id: moka.stories![0].id },
        }),
      ),
    ).toBe("STORY_ID_EXISTS");
  });

  it("takes a story out whole, and puts everything back with it", () => {
    const moka = buildStoryMokaFile();
    const { next, inverse } = apply(moka, {
      type: "removeStory",
      storyId: storyIds().story,
    });
    expect(next.stories).toBeUndefined();
    // The timeline the story assembled stays where a reader can still watch it.
    expect(next.timelines).toHaveLength(1);
    expect(apply(next, ...inverse).next).toEqual(moka);
  });

  it("renames a story", () => {
    const moka = buildStoryMokaFile();
    const renamed = expectRoundTrip(moka, {
      type: "renameStory",
      storyId: storyIds().story,
      name: "站台与车厢",
    });
    expect(storyOfFile(renamed).name).toBe("站台与车厢");
  });

  it("settles a step, keeps the steps in telling order, and unsettles one on undo", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const settled = expectRoundTrip(moka, {
      type: "confirmStoryStep",
      storyId: ids.story,
      step: "storyboard",
      confirmed: true,
    });
    expect(storyOfFile(settled).confirmedSteps).toEqual([
      "idea",
      "outline",
      "elements",
      "storyboard",
    ]);

    // A step settled out of order is written into its place in the telling.
    const outOfOrder = expectRoundTrip(
      { ...moka, stories: [{ ...storyOfFile(moka), confirmedSteps: [] }] },
      {
        type: "confirmStoryStep",
        storyId: ids.story,
        step: "edit",
        confirmed: true,
      },
      {
        type: "confirmStoryStep",
        storyId: ids.story,
        step: "idea",
        confirmed: true,
      },
    );
    expect(storyOfFile(outOfOrder).confirmedSteps).toEqual(["idea", "edit"]);

    // Settling a step it is already standing on changes nothing to put back.
    const again = apply(settled, {
      type: "confirmStoryStep",
      storyId: ids.story,
      step: "storyboard",
      confirmed: true,
    });
    expect(storyOfFile(again.next).confirmedSteps).toEqual(
      storyOfFile(settled).confirmedSteps,
    );
  });

  it("refuses a step that is not one of the telling's own", () => {
    const moka = buildStoryMokaFile();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "confirmStoryStep",
          storyId: storyIds().story,
          step: "polish" as never,
          confirmed: true,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("moves only the fields a brief patch names", () => {
    const moka = buildStoryMokaFile();
    const next = expectRoundTrip(moka, {
      type: "updateStoryBrief",
      storyId: storyIds().story,
      patch: { totalDurationMs: 300_000, genre: "悬疑" },
    });
    const brief = storyOfFile(next).brief;
    expect(brief.totalDurationMs).toBe(300_000);
    expect(brief.genre).toBe("悬疑");
    expect(brief.style).toBe("现代都市风");
    expect(brief.idea).toBe(storyOfFile(moka).brief.idea);
  });

  it("refuses a running time and a frame nobody offered", () => {
    const moka = buildStoryMokaFile();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryBrief",
          storyId: storyIds().story,
          patch: { totalDurationMs: 1 },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryBrief",
          storyId: storyIds().story,
          patch: { aspect: "5:4" as never },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("changes the granularity, and leaves the clips already made alone", () => {
    const moka = buildStoryMokaFile();
    const next = expectRoundTrip(moka, {
      type: "updateStoryGranularity",
      storyId: storyIds().story,
      shotGranularity: "keyframe",
    });
    const story = storyOfFile(next);
    expect(story.shotGranularity).toBe("keyframe");
    expect(story.chapters[0].acts[0].video.takes).toHaveLength(1);
  });

  it("refuses a granularity that is neither of the two", () => {
    const moka = buildStoryMokaFile();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryGranularity",
          storyId: storyIds().story,
          shotGranularity: "scene" as never,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("moves the reference limit, and leaves the frames already drawn alone", () => {
    const moka = buildStoryMokaFile();
    const next = expectRoundTrip(moka, {
      type: "updateStoryReferenceLimit",
      storyId: storyIds().story,
      maxReferenceImages: 5,
    });
    const story = storyOfFile(next);
    expect(story.maxReferenceImages).toBe(5);
    expect(story.chapters[0].acts[0].keyframes[0].art.takes).toHaveLength(1);
  });

  it("refuses a reference limit no ask could carry", () => {
    const moka = buildStoryMokaFile();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryReferenceLimit",
          storyId: storyIds().story,
          maxReferenceImages: REFERENCE_IMAGES_MAX + 1,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("the outline command", () => {
  it("keeps a chapter's board when the chapter keeps its id, and drops one that leaves", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const kept = createChapter("第一章 站台", "重写的梗概");
    const rewritten: StoryChapter[] = [
      { ...kept, id: ids.chapterFirst },
      { ...createChapter("第三章 终点"), id: "chapter-third" },
    ];
    const next = expectRoundTrip(moka, {
      type: "setStoryChapters",
      storyId: ids.story,
      chapters: rewritten,
    });
    const chapters = storyOfFile(next).chapters;
    expect(chapters.map((chapter) => chapter.id)).toEqual([
      ids.chapterFirst,
      "chapter-third",
    ]);
    // The board shot from the first chapter is still on it.
    expect(chapters[0].acts).toHaveLength(1);
    expect(chapters[1].acts).toEqual([]);
  });

  it("refuses more chapters than a story holds", () => {
    const moka = buildStoryMokaFile();
    const chapters = Array.from(
      { length: MAX_CHAPTERS_PER_STORY + 1 },
      (_, n) => createChapter(`第 ${n} 章`),
    );
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryChapters",
          storyId: storyIds().story,
          chapters,
        }),
      ),
    ).toBe("STORY_CHAPTER_LIMIT");
  });
});

describe("the elements commands", () => {
  it("keeps an element's drawings and answers when it keeps its id", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const before = storyOfFile(moka).elements.find((e) => e.id === ids.hero)!;
    const next = expectRoundTrip(moka, {
      type: "setStoryElements",
      storyId: ids.story,
      elements: [{ ...before, description: "重写的描述" }],
    });
    const hero = storyOfFile(next).elements[0];
    expect(hero.description).toBe("重写的描述");
    expect(hero.main.takes).toHaveLength(1);
    expect(hero.turnaround?.takes).toHaveLength(1);
  });

  it("refuses more elements than a story holds", () => {
    const moka = buildStoryMokaFile();
    const elements = Array.from(
      { length: MAX_ELEMENTS_PER_STORY + 1 },
      (_, n) => element(`element-${n}`, "prop"),
    );
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryElements",
          storyId: storyIds().story,
          elements,
        }),
      ),
    ).toBe("STORY_ELEMENT_LIMIT");
  });

  it("moves only the fields an element patch names", () => {
    const moka = buildStoryMokaFile();
    const next = expectRoundTrip(moka, {
      type: "updateStoryElement",
      storyId: storyIds().story,
      elementId: storyIds().hero,
      patch: { description: "换了件衣服。" },
    });
    const hero = storyOfFile(next).elements.find(
      (e) => e.id === storyIds().hero,
    )!;
    expect(hero.description).toBe("换了件衣服。");
    expect(hero.name).toBe("林");
  });

  it("names the chapters an element was seen in, and refuses one the story has not", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryElement",
      storyId: ids.story,
      elementId: ids.hero,
      patch: { chapterIds: [ids.chapterSecond] },
    });
    const hero = storyOfFile(next).elements.find((e) => e.id === ids.hero)!;
    expect(hero.chapterIds).toEqual([ids.chapterSecond]);

    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryElement",
          storyId: ids.story,
          elementId: ids.hero,
          patch: { chapterIds: ["chapter-gone"] },
        }),
      ),
    ).toBe("STORY_TARGET_INVALID");
  });
});

describe("the board commands", () => {
  it("keeps an act's frames, clip and answers when it keeps its id, and lets one that leaves go", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const act = storyOfFile(moka).chapters[0].acts[0];
    const next = expectRoundTrip(moka, {
      type: "setStoryActs",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      acts: [
        { ...act, title: "第 1 幕 站台的灯", summary: "重写的内容" },
        createActFor(ids.chapterFirst),
      ],
    });
    const acts = storyOfFile(next).chapters[0].acts;
    expect(acts).toHaveLength(2);
    expect(acts[0].title).toBe("第 1 幕 站台的灯");
    expect(acts[0].video.takes).toHaveLength(1);
    expect(acts[0].keyframes[0].art.takes).toHaveLength(1);
    expect(acts[1].video.takes).toEqual([]);
  });

  it("refuses more acts than an episode holds, and more shots than an act holds", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const acts = Array.from({ length: MAX_ACTS_PER_CHAPTER + 1 }, () =>
      createActFor(ids.chapterFirst),
    );
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryActs",
          storyId: ids.story,
          chapterId: ids.chapterFirst,
          acts,
        }),
      ),
    ).toBe("STORY_ACT_LIMIT");

    const crowded = createActFor(ids.chapterFirst);
    crowded.keyframes = Array.from(
      { length: MAX_KEYFRAMES_PER_ACT + 1 },
      (_, n) => createKeyframe(n),
    );
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryActs",
          storyId: ids.story,
          chapterId: ids.chapterFirst,
          acts: [crowded],
        }),
      ),
    ).toBe("STORY_KEYFRAME_LIMIT");
  });

  it("keeps a reference to an element that is no longer there, once, and says nothing", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const act = storyOfFile(moka).chapters[0].acts[0];
    const next = apply(moka, {
      type: "setStoryActs",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      acts: [{ ...act, characterIds: [ids.hero, "gone", ids.hero] }],
    }).next;
    expect(storyOfFile(next).chapters[0].acts[0].characterIds).toEqual([
      ids.hero,
      "gone",
    ]);
  });

  it("moves only the fields an act patch names, replacing a sound whole", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryAct",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      actId: ids.act,
      patch: { sound: { music: "大提琴", sfx: "" } },
    });
    const act = storyOfFile(next).chapters[0].acts[0];
    expect(act.sound).toEqual({ music: "大提琴", sfx: "" });
    expect(act.title).toBe("第 1 幕 空站台");
  });

  it("moves only the fields a shot patch names, and keeps a shot to its length", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryKeyframe",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      actId: ids.act,
      keyframeId: ids.frameSecond,
      patch: {
        shotSize: "extremeWide",
        durationMs: 1_200,
        dialogue: [{ id: "line-second", speaker: "周", text: "车还会来。" }],
      },
    });
    const frame = storyOfFile(next).chapters[0].acts[0].keyframes[1];
    expect(frame.shotSize).toBe("extremeWide");
    expect(frame.durationMs).toBe(1_200);
    expect(frame.dialogue).toEqual([
      { id: "line-second", speaker: "周", text: "车还会来。" },
    ]);
    expect(frame.content).toBe("`周`转过身来。");

    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryKeyframe",
          storyId: ids.story,
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId: ids.frameSecond,
          patch: { durationMs: 10 },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("refuses a line with no name of its own, or two sharing one", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const writing = (dialogue: StoryKeyframe["dialogue"]) => () =>
      apply(moka, {
        type: "updateStoryKeyframe",
        storyId: ids.story,
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
        patch: { dialogue },
      });
    // A line is what the things kept for it are filed under: a patch naming
    // none, or naming one twice, is refused rather than written.
    expect(
      codeOf(writing([{ id: "", speaker: "周", text: "车还会来。" }])),
    ).toBe("VALIDATION_FAILED");
    expect(
      codeOf(
        writing([
          { id: "same", speaker: "周", text: "车还会来。" },
          { id: "same", speaker: "周", text: "车不会来了。" },
        ]),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("moves a shot's role in filming, and puts the plain use back on undo", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryKeyframe",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      actId: ids.act,
      keyframeId: ids.frameFirst,
      patch: { filmRole: "firstLastFrame" },
    });
    const frames = storyOfFile(next).chapters[0].acts[0].keyframes;
    expect(frames[0].filmRole).toBe("firstLastFrame");
    // The shot beside it was never named, and no word is carried for it: the
    // plain use is what a frame with nothing said about it means.
    expect(frames[1].filmRole).toBeUndefined();
  });
});

describe("the voice a character speaks in", () => {
  it("resolves the voice layer by layer, field by field", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    // The hero has a model of their own and no tone; the telling's narrator
    // has a tone. The two fill what the other leaves empty.
    const story: StoryDocument = {
      ...storyOfFile(moka),
      narrator: { model: "", voice: "旁白的音色" },
      elements: storyOfFile(moka).elements.map((element) =>
        element.id === ids.hero
          ? { ...element, voice: { model: "voice-model", voice: "" } }
          : element,
      ),
    };

    expect(voiceFor(story, ids.hero)).toEqual({
      model: "voice-model",
      voice: "旁白的音色",
    });
    // The partner says nothing about a voice, so the narrator speaks for them,
    // and a line that belongs to nobody leans on it too.
    expect(voiceFor(story, ids.partner)).toEqual({
      model: "",
      voice: "旁白的音色",
    });
    expect(voiceFor(story, undefined)).toEqual({
      model: "",
      voice: "旁白的音色",
    });
    // What no layer names is the deployment's default; the machine's own pick
    // is the last layer the room knows about before it.
    expect(voiceFor(story, ids.partner, { model: "machine-pick" })).toEqual({
      model: "machine-pick",
      voice: "旁白的音色",
    });
    // A line whose character is no longer in the story reads in the narrator's
    // voice rather than in nobody's.
    expect(voiceFor(story, "gone")).toEqual({
      model: "",
      voice: "旁白的音色",
    });
  });

  it("counts a recording alone as a voice said, and carries it down the chain", () => {
    const ids = storyIds();
    // A recording with nothing else named is still a voice: the reader heard
    // it rather than named it.
    expect(
      voiceNamed({
        model: "",
        voice: "",
        referenceAssetId: "asset-hero-voice",
      }),
    ).toBe(true);
    expect(voiceNamed({ model: "", voice: "" })).toBe(false);

    // The narrator is heard from a recording; a character that names none
    // follows it the way it follows a tone.
    const held = storyOfFile(buildStoryMokaFile());
    const story: StoryDocument = {
      ...held,
      narrator: { model: "", voice: "", rate: 1.2 },
    };
    const followed: StoryDocument = {
      ...story,
      narrator: {
        ...story.narrator!,
        referenceAssetId: "asset-narrator-voice",
      },
    };
    expect(voiceFor(followed, ids.partner)).toEqual({
      model: "",
      voice: "",
      rate: 1.2,
      referenceAssetId: "asset-narrator-voice",
    });

    // The hero's own recording stands over the narrator's, and what the hero
    // leaves empty — the pace, here — still falls through to it.
    const hero: StoryDocument = {
      ...followed,
      elements: followed.elements.map((element) =>
        element.id === ids.hero
          ? {
              ...element,
              voice: {
                model: "",
                voice: "",
                referenceAssetId: "asset-hero-voice",
              },
            }
          : element,
      ),
    };
    expect(voiceFor(hero, ids.hero)).toEqual({
      model: "",
      voice: "",
      rate: 1.2,
      referenceAssetId: "asset-hero-voice",
    });
  });

  it("leaves the step's own measure where it was: a voice is optional", () => {
    const hero = storyOfFile(buildStoryMokaFile()).elements[0]!;
    const before = elementComplete(hero);
    expect(
      elementComplete({ ...hero, voice: { model: "", voice: "longxiaochun" } }),
    ).toBe(before);
  });

  it("counts the lines a character is given, and hands over their first", () => {
    const story = storyOfFile(buildStoryMokaFile());
    const ids = storyIds();
    expect(lineCountFor(story, ids.hero)).toBe(1);
    expect(lineCountFor(story, ids.partner)).toBe(0);
    expect(firstLineOf(story, ids.hero)).toEqual({
      id: ids.lineFirst,
      characterId: ids.hero,
      speaker: "林",
      text: "车已经停运了。",
      tone: "平静",
    });
    expect(firstLineOf(story, ids.partner)).toBeUndefined();
  });

  it("gives a character a voice, takes it away, and survives the round trip", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryElement",
      storyId: ids.story,
      elementId: ids.hero,
      patch: {
        voice: {
          model: "voice-model",
          voice: "longxiaochun",
          rate: 1.2,
          instructions: "低沉、慢",
        },
      },
    });
    const hero = storyOfFile(next).elements.find(
      (element) => element.id === ids.hero,
    );
    expect(hero?.voice).toEqual({
      model: "voice-model",
      voice: "longxiaochun",
      rate: 1.2,
      instructions: "低沉、慢",
    });
    // The other characters keep theirs: a voice is written on one card.
    expect(storyOfFile(next).elements[1]?.voice).toBeUndefined();

    // And it is taken off the element rather than left holding an empty voice.
    const cleared = expectRoundTrip(next, {
      type: "updateStoryElement",
      storyId: ids.story,
      elementId: ids.hero,
      patch: { voice: null },
    });
    expect(
      storyOfFile(cleared).elements.find((element) => element.id === ids.hero)
        ?.voice,
    ).toBeUndefined();
  });

  it("refuses a voice outside the bounds the providers accept", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const writing = (voice: StoryVoiceProfile) => () =>
      apply(moka, {
        type: "updateStoryElement",
        storyId: ids.story,
        elementId: ids.hero,
        patch: { voice },
      });
    expect(codeOf(writing({ model: "", voice: "", rate: 3 }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(codeOf(writing({ model: "", voice: "", pitch: 0.1 }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(codeOf(writing({ model: "m".repeat(200), voice: "" }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("writes the narrator's voice and takes it away again", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryNarrator",
      storyId: ids.story,
      narrator: { model: "", voice: "旁白的音色" },
    });
    expect(storyOfFile(next).narrator).toEqual({
      model: "",
      voice: "旁白的音色",
    });

    const cleared = expectRoundTrip(next, {
      type: "updateStoryNarrator",
      storyId: ids.story,
      narrator: null,
    });
    expect(storyOfFile(cleared).narrator).toBeUndefined();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryNarrator",
          storyId: ids.story,
          narrator: { model: "", voice: "", pitch: 9 },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("keeps a voice through a cast listed again without it", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const voiced = expectRoundTrip(moka, {
      type: "updateStoryElement",
      storyId: ids.story,
      elementId: ids.hero,
      patch: { voice: { model: "", voice: "longxiaochun" } },
    });
    // A reading brings words. The voice is one of the reader's answers about
    // the character, so a listing that says nothing of it leaves it standing.
    const relisted = expectRoundTrip(voiced, {
      type: "setStoryElements",
      storyId: ids.story,
      elements: storyOfFile(voiced).elements.map((element) => {
        if (element.id !== ids.hero) return element;
        const words: StoryElement = { ...element, description: "新的描述。" };
        delete words.voice;
        return words;
      }),
    });
    const hero = storyOfFile(relisted).elements.find(
      (element) => element.id === ids.hero,
    );
    expect(hero?.description).toBe("新的描述。");
    expect(hero?.voice).toEqual({ model: "", voice: "longxiaochun" });
  });
});

describe("filing a drawing at a place", () => {
  it("adds a take to the place a target names, and puts the old slot back on undo", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const slot: StorySlot = {
      takes: [{ assetIds: ["asset-new"], createdAt: NOW }],
    };
    const next = expectRoundTrip(moka, {
      type: "setStorySlot",
      storyId: ids.story,
      target: {
        kind: "keyframe",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
      slot,
    });
    expect(storyOfFile(next).chapters[0].acts[0].keyframes[1].art).toEqual(
      slot,
    );
  });

  it("trims a slot to what a place keeps, oldest first, and refuses two of one drawing", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const takes = Array.from({ length: MAX_TAKES_PER_SLOT + 3 }, (_, n) =>
      take(`asset-${n}`),
    );
    takes.push(take("asset-0"));
    const next = apply(moka, {
      type: "setStorySlot",
      storyId: ids.story,
      target: { kind: "element", elementId: ids.prop, view: "main" },
      slot: { takes },
    }).next;
    const prop = storyOfFile(next).elements.find((e) => e.id === ids.prop)!;
    expect(prop.main.takes).toHaveLength(MAX_TAKES_PER_SLOT);
    expect(prop.main.takes[0].assetIds[0]).toBe("asset-3");
  });

  it("refuses a place the story no longer holds", () => {
    const moka = buildStoryMokaFile();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStorySlot",
          storyId: storyIds().story,
          target: { kind: "element", elementId: "gone", view: "main" },
          slot: { takes: [] },
        }),
      ),
    ).toBe("STORY_TARGET_INVALID");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStorySlot",
          storyId: storyIds().story,
          target: {
            kind: "element",
            elementId: storyIds().scene,
            view: "turnaround",
          },
          slot: { takes: [] },
        }),
      ),
    ).toBe("STORY_TARGET_INVALID");
  });

  it("files an act's clip at the act, and a shot's clip at the shot", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const withAct = apply(moka, {
      type: "setStorySlot",
      storyId: ids.story,
      target: { kind: "actVideo", chapterId: ids.chapterFirst, actId: ids.act },
      slot: { takes: [take("asset-second-take")] },
    }).next;
    expect(storyOfFile(withAct).chapters[0].acts[0].video.takes).toEqual([
      take("asset-second-take"),
    ]);

    const withShot = apply(moka, {
      type: "setStorySlot",
      storyId: ids.story,
      target: {
        kind: "keyframeVideo",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
      slot: { takes: [take("asset-shot")] },
    }).next;
    expect(
      storyOfFile(withShot).chapters[0].acts[0].keyframes[1].video.takes,
    ).toHaveLength(1);
  });
});

describe("taking a field away", () => {
  it("takes an act's scene away when the patch carries a null for it", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryAct",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      actId: ids.act,
      patch: { sceneId: null },
    });
    expect(storyOfFile(next).chapters[0].acts[0].sceneId).toBeUndefined();
    expect(storyOfFile(moka).chapters[0].acts[0].sceneId).toBe(ids.scene);
  });

  it("takes the manuscript away when the brief patch carries a null for it", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryBrief",
      storyId: ids.story,
      patch: { sourceAssetId: null, sourceName: null, sourceSplit: null },
    });
    const brief = storyOfFile(next).brief;
    expect(brief.sourceAssetId).toBeUndefined();
    expect(brief.sourceName).toBeUndefined();
    expect(brief.sourceSplit).toBeUndefined();
    // The premise itself is untouched: only the keys the patch named moved.
    expect(brief.idea).toBe(storyOfFile(moka).brief.idea);
  });

  it("clears an assembly and puts it back whole", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const cleared = expectRoundTrip(moka, {
      type: "setStoryEdit",
      storyId: ids.story,
      patch: { timelineId: null, clipByAct: null },
    });
    expect(storyOfFile(cleared).edit).toEqual({});

    // And the other way: an assembly put on a story that had none, undone.
    const { next, inverse } = apply(cleared, {
      type: "setStoryEdit",
      storyId: ids.story,
      patch: { timelineId: timelineIds().timeline },
    });
    expect(storyOfFile(next).edit.timelineId).toBe(timelineIds().timeline);
    expect(
      storyOfFile(apply(next, ...inverse).next).edit.timelineId,
    ).toBeUndefined();
  });
});

describe("what a story was assembled into", () => {
  it("remembers the timeline and its own clips, and refuses one nobody holds", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "setStoryEdit",
      storyId: ids.story,
      patch: {
        clipByAct: [{ actId: ids.act, clipId: "clip-cut-a" }],
      },
    });
    const edit = storyOfFile(next).edit;
    expect(edit.clipByAct).toEqual([{ actId: ids.act, clipId: "clip-cut-a" }]);
    expect(edit.timelineId).toBe(timelineIds().timeline);

    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryEdit",
          storyId: ids.story,
          patch: { timelineId: "timeline-gone" },
        }),
      ),
    ).toBe("TIMELINE_NOT_FOUND");
  });
});

// -----------------------------------------------------------------------------
// Guardrails
// -----------------------------------------------------------------------------

describe("validateStory", () => {
  it("passes the fixture and reports the things a hand-written file gets wrong", () => {
    const story = storyOfFile(buildStoryMokaFile());
    expect(validateStory(story)).toEqual([]);

    expect(
      validateStory({ ...story, name: "" }).map((issue) => issue.code),
    ).toEqual(["STORY_NAME_INVALID"]);
    expect(
      validateStory({ ...story, schemaVersion: 9 }).map((issue) => issue.code),
    ).toContain("STORY_SCHEMA_NEWER");
    expect(
      validateStory({
        ...story,
        brief: { ...story.brief, totalDurationMs: 1 },
      }).map((issue) => issue.code),
    ).toContain("VALIDATION_FAILED");
    const tooShort: StoryDocument = {
      ...story,
      chapters: story.chapters.map((chapter, index) =>
        index === 0
          ? {
              ...chapter,
              acts: [
                {
                  ...chapter.acts[0],
                  keyframes: [
                    { ...chapter.acts[0].keyframes[0], durationMs: 1 },
                  ],
                },
              ],
            }
          : chapter,
      ),
    };
    expect(validateStory(tooShort).map((issue) => issue.code)).toContain(
      "VALIDATION_FAILED",
    );
  });

  it("reports a slot that carries more takes than it may", () => {
    const story = storyOfFile(buildStoryMokaFile());
    const crowded: StoryDocument = {
      ...story,
      elements: story.elements.map((element) => ({
        ...element,
        main: {
          takes: Array.from({ length: MAX_TAKES_PER_SLOT + 1 }, (_, n) =>
            take(`asset-${n}`),
          ),
          confirmed: false,
        },
      })),
    };
    expect(validateStory(crowded).map((issue) => issue.code)).toContain(
      "STORY_SLOT_FULL",
    );
  });

  it("is read by the document validator, along with the timeline a story points at", () => {
    const moka = buildStoryMokaFile();
    expect(validateMokaFile(moka)).toEqual([]);

    const orphaned: MokaFile = {
      ...moka,
      stories: [
        { ...storyOfFile(moka), edit: { timelineId: "timeline-gone" } },
      ],
    };
    expect(validateMokaFile(orphaned).map((issue) => issue.code)).toContain(
      "STORY_TARGET_INVALID",
    );

    const doubled: MokaFile = {
      ...moka,
      stories: [storyOfFile(moka), storyOfFile(moka)],
    };
    expect(validateMokaFile(doubled).map((issue) => issue.code)).toContain(
      "STORY_ID_EXISTS",
    );
  });
});

describe("the assets a story holds", () => {
  it("counts every drawing and the manuscript as in use", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const refs = collectAssetReferences(moka);
    for (const assetId of [
      ids.source,
      ids.heroMain,
      ids.heroSheet,
      ids.partnerMain,
      ids.sceneMain,
      ids.frameArt,
      ids.actVideo,
    ]) {
      expect(refs.has(assetId)).toBe(true);
    }
    const unused = unreferencedAssets(moka).map((entry) => entry.id);
    for (const assetId of refs.keys()) expect(unused).not.toContain(assetId);
  });
});

// -----------------------------------------------------------------------------
// What a document carries
// -----------------------------------------------------------------------------

describe("a story through the codec", () => {
  it("comes back as the document it went in as", () => {
    const moka = buildStoryMokaFile();
    const read = decodeMokaFile(encodeMokaFile(moka));
    expect(read).toEqual(moka);
    expect(read.stories![0].brief.style).toBe("现代都市风");
  });

  it("is absent from a document that tells no story, and stays absent", () => {
    const moka = buildEmptyStory();
    delete moka.stories;
    const read = decodeMokaFile(encodeMokaFile(moka));
    expect("stories" in read).toBe(false);
  });

  it("reads a word it does not know as the plainest thing it could be", () => {
    const moka = buildStoryMokaFile();
    // A board written by another build: the words are ones this one has no
    // meaning for, and the project still opens.
    const story = storyOfFile(moka);
    const act = story.chapters[0].acts[0];
    const read = decodeMokaFile(
      encodeMokaFile({
        ...moka,
        stories: [
          {
            ...story,
            shotGranularity: "everyShot" as never,
            chapters: [
              {
                ...story.chapters[0],
                acts: [
                  {
                    ...act,
                    keyframes: [
                      { ...act.keyframes[0], shotSize: "gigantic" as never },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(read.stories![0].shotGranularity).toBe("act");
    expect(read.stories![0].chapters[0].acts[0].keyframes[0].shotSize).toBe(
      "medium",
    );
  });

  it("refuses a story written by a newer build rather than reading it wrongly", () => {
    const moka = buildStoryMokaFile();
    const ahead: MokaFile = {
      ...moka,
      stories: [{ ...storyOfFile(moka), schemaVersion: 9 }],
    };
    expect(() => decodeMokaFile(encodeMokaFile(ahead))).toThrowError(
      /schema version 9 is not supported/,
    );
  });
});

describe("mergeChaptersAt", () => {
  it("writes each answer into the place it was asked for", () => {
    const existing: StoryChapter[] = [
      { ...createChapter("一", "旧梗概"), acts: [createActFor("chapter-1")] },
      createChapter("二", "第二章的梗概"),
    ];
    // A manuscript answers one part at a time: the second part rewrites the
    // second chapter, and the fourth is the next chapter the telling has not
    // been told yet.
    const merged = mergeChaptersAt(existing, [
      { at: 1, draft: { title: "二", synopsis: "新梗概" } },
      { at: 3, draft: { title: "四", synopsis: "第四段" } },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[1]?.id).toBe(existing[1]?.id);
    expect(merged[1]?.synopsis).toBe("新梗概");
    expect(merged[2]?.title).toBe("四");
    // The place nobody answered for is left as it stood, board and all.
    expect(merged[0]?.id).toBe(existing[0]?.id);
    expect(merged[0]?.acts).toHaveLength(1);
  });

  it("drops the chapters a whole-table answer left out", () => {
    const existing = [createChapter("一"), createChapter("二")];
    const merged = mergeChaptersAt(
      existing,
      [{ at: 0, draft: { title: "只有一章", synopsis: "" } }],
      true,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("只有一章");
  });
});

describe("chapterRegenerationCost", () => {
  it("counts the words a re-split writes over and the boards it leaves behind", () => {
    const story = createStory("新的故事");
    story.chapters = [
      {
        ...createChapter("一", "写过的梗概"),
        acts: [createActFor("chapter-1")],
      },
      {
        ...createChapter("二", "也写过的梗概"),
        acts: [createActFor("chapter-2")],
      },
      createChapter("三", ""),
    ];
    expect(chapterRegenerationCost(story, 3)).toEqual({
      chapters: 2,
      acts: 0,
    });
    // A telling divided into fewer chapters than it has leaves the last
    // chapter's board behind, which is what the question is asking about.
    expect(chapterRegenerationCost(story, 1)).toEqual({
      chapters: 2,
      acts: 1,
    });
    expect(chapterRegenerationCost(story)).toEqual({ chapters: 2, acts: 0 });
  });
});

describe("actsRegenerationCost", () => {
  it("counts the acts a new board writes over, and what is already made of them", () => {
    const story = buildStoryMokaFile().stories![0];
    const chapter = story.chapters[0]!;
    const act = chapter.acts[0]!;
    // The fixture's act: two shots, one of them drawn, and a clip of the act.
    expect(actsRegenerationCost(chapter)).toEqual({
      acts: 1,
      drawn: 1,
      filmed: 1,
    });

    act.video = emptyStorySlot();
    act.keyframes[1]!.art = {
      takes: [{ assetIds: ["asset-other-frame"], createdAt: NOW }],
    };
    expect(actsRegenerationCost(chapter)).toEqual({
      acts: 1,
      drawn: 2,
      filmed: 0,
    });
  });

  it("costs nothing to board an episode that has no board yet", () => {
    const story = buildStoryMokaFile().stories![0];
    expect(actsRegenerationCost(story.chapters[1]!)).toEqual({
      acts: 0,
      drawn: 0,
      filmed: 0,
    });
  });
});

describe("chunkWaves", () => {
  it("cuts a list into the asks a telling is made of", () => {
    expect(chunkWaves([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunkWaves([1, 2], 5)).toEqual([[1, 2]]);
    expect(chunkWaves([], 5)).toEqual([]);
    // A width nobody could take pieces in is one piece an ask.
    expect(chunkWaves([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe("chapterWaves", () => {
  it("packs the chapters into the asks one reading is made of", () => {
    // How many chapters a reading may hold says nothing about how long they
    // are: a chapter weighs its title and its synopsis together.
    const chapters = [
      createChapter("一", "字".repeat(60)),
      createChapter("二", "字".repeat(60)),
      createChapter("三", "字".repeat(60)),
    ];
    expect(chapterWaves(chapters, 130).map((wave) => wave.length)).toEqual([
      2, 1,
    ]);
    expect(chapterWaves(chapters, 1_000)).toHaveLength(1);
    expect(chapterWaves([], 1_000)).toEqual([]);
  });

  it("gives a chapter heavier than an ask an ask of its own", () => {
    const long = createChapter("一", "字".repeat(500));
    const short = createChapter("二", "短。");
    expect(chapterWaves([long, short], 100)).toEqual([[long], [short]]);
  });
});

describe("defaultChapterCount", () => {
  it("offers a chapter a minute, and never a telling of no chapters", () => {
    expect(defaultChapterCount(600_000)).toBe(10);
    expect(defaultChapterCount(180_000)).toBe(3);
    expect(defaultChapterCount(20_000)).toBe(1);
    expect(defaultChapterCount(0)).toBe(1);
  });
});

describe("the language the story room speaks", () => {
  it("names a new story in the interface's own language", async () => {
    await i18n.changeLanguage("zh");
    try {
      const moka = buildEmptyStory();
      expect(nextStoryName(moka)).toBe("故事 2");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
