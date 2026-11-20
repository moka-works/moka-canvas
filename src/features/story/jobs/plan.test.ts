import { beforeEach, describe, expect, it } from "vitest";

import type { ModelsView } from "../../../api/models";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type {
  StoryDocument,
  StoryFilmRole,
  StoryKeyframe,
} from "../../../shared/domain/types";
import { storyMergeElementsPrompt } from "../../../shared/prompts";
import { useModelStore } from "../../settings/modelStore";
import { useStoryModels } from "../stores/storyModels";
import {
  chunkElementMerges,
  clampSeconds,
  imageSizeForAspect,
  itemsForTargets,
  jobKey,
  keyframeCast,
  planActMusic,
  planActVideos,
  planActVideoWaves,
  planActVoice,
  planChapterRewrite,
  planElementArt,
  planElementArtWaves,
  planElementMergeWaves,
  planElements,
  planKeyframeArt,
  planKeyframeArtWaves,
  planKeyframeVideos,
  planLineVoiceAsks,
  planOutline,
  planOutlineRevision,
  planStoryboard,
  settledRoleFrames,
  voiceParamsFor,
  type ElementRepeat,
} from "./plan";

const ids = storyIds();

function story(): StoryDocument {
  const held = buildStoryMokaFile().stories?.[0];
  if (held === undefined) throw new Error("the fixture holds a story");
  return held;
}

/**
 * The settings as the room reads them, with the machine's own video length —
 * the number a canvas node asks with when nobody says, and the one the story
 * room must not mistake for a length its board is cut to.
 */
function settingsWithVideoSeconds(seconds: number): ModelsView {
  return {
    version: 1,
    revision: 1,
    models: [],
    defaults: {
      text: null,
      image: null,
      speech: null,
      music: null,
      video: null,
      asr: null,
    },
    preferences: {
      systemPrompt: "",
      reasoningEffort: "auto",
      image: { size: "1024x1024", quality: "auto", background: "", count: 1 },
      video: {
        seconds,
        resolution: "",
        generateAudio: false,
        watermark: false,
        mode: "auto",
        ratio: "",
      },
      speech: {
        voice: "",
        format: "",
        speed: 1,
        instructions: "",
        sampleRate: 22_050,
        volume: 50,
        rate: 1,
        pitch: 1,
      },
      music: { format: "mp3", watermark: false },
      story: { splitChars: 12_000 },
    },
    secretStorage: "unset",
  };
}

/**
 * The settings with a video model that films at most this long, chosen as the
 * deployment's default: the window a telling longer than it is filmed in
 * pieces of.
 */
function settingsWithVideoCeiling(maxSeconds: number): ModelsView {
  const view = settingsWithVideoSeconds(6);
  return {
    ...view,
    models: [
      {
        id: "filmer",
        category: "video",
        protocol: "bailianVideo",
        url: "https://provider.test/video-synthesis",
        model: "filmer",
        displayName: "Filmer",
        maxVideoSeconds: maxSeconds,
        enabled: true,
        apiKey: { set: false, masked: null },
      },
    ],
    defaults: { ...view.defaults, video: "filmer" },
  };
}

/** The settings with two video models, the slower one the deployment's own. */
function settingsWithTwoVideoModels(): ModelsView {
  const view = settingsWithVideoSeconds(6);
  const model = (id: string, maxSeconds: number) => ({
    id,
    category: "video" as const,
    protocol: "bailianVideo",
    url: "https://provider.test/video-synthesis",
    model: id,
    displayName: id,
    maxVideoSeconds: maxSeconds,
    enabled: true,
    apiKey: { set: false, masked: null },
  });
  return {
    ...view,
    models: [model("slow", 15), model("quick", 5)],
    defaults: { ...view.defaults, video: "slow" },
  };
}

/** The fixture with both shots of its first act set to run this long. */
function plannedShot(ms: number): StoryDocument {
  const held = drawnStory();
  return {
    ...held,
    chapters: held.chapters.map((chapter) => ({
      ...chapter,
      acts: chapter.acts.map((heldAct) => ({
        ...heldAct,
        keyframes: heldAct.keyframes.map((keyframe) => ({
          ...keyframe,
          durationMs: ms,
        })),
      })),
    })),
  };
}

/** A story whose first act has both of its shots drawn. */
function drawnStory(): StoryDocument {
  const held = story();
  const act = held.chapters[0].acts[0];
  const second = act.keyframes[1];
  return {
    ...held,
    chapters: held.chapters.map((chapter) => ({
      ...chapter,
      acts: chapter.acts.map((heldAct) =>
        heldAct.id !== act.id
          ? heldAct
          : {
              ...heldAct,
              keyframes: heldAct.keyframes.map((keyframe) =>
                keyframe.id !== second.id
                  ? keyframe
                  : {
                      ...keyframe,
                      art: {
                        takes: [
                          {
                            assetIds: ["asset-frame-second"],
                            createdAt: "2026-01-01T00:00:00Z",
                          },
                        ],
                        confirmed: false,
                      },
                    },
              ),
            },
      ),
    })),
  };
}

/**
 * The drawn board with a shoot role given to the shots this names, and — when
 * one is handed over — one more drawn shot after the fixture's own, two
 * seconds long, for a board long enough to have a middle.
 */
function roled(
  roles: Record<string, StoryFilmRole>,
  extra?: { id: string; assetId: string; content: string },
): StoryDocument {
  const held = drawnStory();
  const act = held.chapters[0].acts[0];
  const frames = [...act.keyframes];
  if (extra !== undefined) {
    frames.push({
      ...frames[frames.length - 1],
      id: extra.id,
      title: "#3",
      content: extra.content,
      durationMs: 2_000,
      art: {
        takes: [
          { assetIds: [extra.assetId], createdAt: "2026-01-01T00:00:00Z" },
        ],
      },
    });
  }
  const next = {
    ...act,
    keyframes: frames.map((frame) =>
      roles[frame.id] === undefined
        ? frame
        : { ...frame, filmRole: roles[frame.id] },
    ),
  };
  return {
    ...held,
    chapters: held.chapters.map((chapter) => ({
      ...chapter,
      acts: chapter.acts.map((each) => (each.id === act.id ? next : each)),
    })),
  };
}

/** The fixture with one shot's words replaced — its mentions with them. */
function withContent(
  content: string,
  keyframeId: string = ids.frameFirst,
): StoryDocument {
  const held = story();
  return {
    ...held,
    chapters: held.chapters.map((chapter) => ({
      ...chapter,
      acts: chapter.acts.map((act) => ({
        ...act,
        keyframes: act.keyframes.map((keyframe) =>
          keyframe.id === keyframeId ? { ...keyframe, content } : keyframe,
        ),
      })),
    })),
  };
}

beforeEach(() => {
  useModelStore.setState({ view: null });
  useStoryModels.setState({ choices: {} });
});

describe("the two numbers a plan turns on", () => {
  it("asks a picture for the size closest to the frame", () => {
    expect(imageSizeForAspect("16:9")).toBe("1536x1024");
    expect(imageSizeForAspect("21:9")).toBe("1536x1024");
    expect(imageSizeForAspect("4:3")).toBe("1536x1024");
    expect(imageSizeForAspect("9:16")).toBe("1024x1536");
    expect(imageSizeForAspect("1:1")).toBe("1024x1024");
  });

  it("asks a clip for what it is meant to run, up to the ceiling", () => {
    expect(clampSeconds(4_400)).toBe(4);
    expect(clampSeconds(0)).toBe(1);
    expect(clampSeconds(120_000, 8)).toBe(8);
  });

  it("names a piece after the place it is for", () => {
    expect(
      jobKey({
        kind: "keyframeArt",
        chapterId: "chapter-1",
        actId: "act-1",
        keyframeId: "frame-1",
      }),
    ).toBe("keyframe:chapter-1:act-1:frame-1");
    expect(jobKey({ kind: "elements" })).toBe("elements");
    expect(
      jobKey({
        kind: "elementArt",
        elementId: "element-hero",
        view: "main",
      }),
    ).toBe("element:main:element-hero");
  });
});

describe("planning the words", () => {
  it("asks under the room's standing instruction, which drawings never carry", () => {
    // A written answer is shaped by it — one json block and nothing around it —
    // and a picture has no room for a shape that is about words.
    const words = planOutline(story(), { chapters: 2 });
    expect(words[0].system).toContain("Answer with one json shape");
    expect(planElements(story())[0].system).toContain("json shape");
    expect(planStoryboard(story(), [ids.chapterFirst])[0].system).toContain(
      "json shape",
    );

    const pictures = planElementArt(story(), [
      { elementId: ids.hero, view: "main" },
    ]);
    expect(pictures[0].system).toBeUndefined();
  });

  it("asks for the telling as chapters, from the premise as typed", () => {
    const items = planOutline(story(), { chapters: 2 });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("outline");
    expect(items[0].capability).toBe("text");
    expect(items[0].target).toEqual({ kind: "outline" });
    expect(items[0].prompt).toContain(
      "末班列车上，两个陌生人交换了各自要说的话。",
    );
    expect(items[0].prompt).toContain("Write this telling as 2 chapters.");
    expect(items[0].prompt).toContain("16:9");
    expect(items[0].prompt).toContain("对白剧情");
    expect(items[0].prompt).toContain("2:00");
    expect(items[0].prompt).not.toContain("{{");
  });

  it("asks for one chapter again in the place it stands, with its neighbours", () => {
    const held = story();
    const item = planChapterRewrite(held, 0);

    expect(item?.id).toBe("outline:rewrite:1");
    expect(item?.target).toEqual({ kind: "outline" });
    expect(item?.prompt).toContain("This is chapter 1.");
    expect(item?.prompt).toContain(
      "末班列车上，两个陌生人交换了各自要说的话。",
    );
    // The chapter after it travels as the reading the table already holds.
    expect(item?.prompt).toContain("The chapter after it: 2. 第二章 车厢");
    expect(item?.prompt).toContain("车厢比站台更暗。");
    expect(item?.prompt).not.toContain("{{");
  });

  it("asks what the telling is made of, chapter by chapter", () => {
    const items = planElements(story());

    expect(items[0].id).toBe("elements");
    expect(items[0].target).toEqual({ kind: "elements" });
    expect(items[0].prompt).toContain(
      "1. 第一章 站台 — 他在站台上等一班已经停运的列车。",
    );
    expect(items[0].prompt).toContain("2. 第二章 车厢 — 车厢比站台更暗。");
    // Reading the whole telling is one ask, and it is not numbered as a part.
    expect(items[0].prompt).not.toContain("This is part");
  });

  it("reads a long telling a part at a time, and says which part it is", () => {
    const items = planElements(story(), {
      pieces: [
        {
          chapterId: ids.chapterSecond,
          number: 2,
          title: "第二章 车厢",
          text: "车厢比站台更暗。",
        },
      ],
      part: 2,
      total: 3,
    });

    // The piece is numbered the way a manuscript's parts are, so the answer
    // comes home to the part that asked for it.
    expect(items[0].id).toBe("elements:2");
    expect(items[0].prompt).toContain("This is part 2 of 3 of the telling");
    // Only the chapters this part is for are listed, and under the numbers the
    // telling gives them: that number is how the answer says where each thing
    // was noticed, and it is read against the whole table rather than the part.
    expect(items[0].prompt).toContain("2. 第二章 车厢 — 车厢比站台更暗。");
    expect(items[0].prompt).not.toContain("第一章 站台");
  });

  it("merges the parts' words about one name in one ask", () => {
    const waves = planElementMergeWaves(story(), [
      {
        kind: "character",
        name: "林",
        descriptions: ["第一批的描述。", "后一批的描述。"],
      },
    ]);

    expect(waves).toHaveLength(1);
    const item = waves[0].items[0];
    expect(item.id).toBe("elements:merge:1");
    expect(item.target).toEqual({ kind: "elements" });
    expect(item.capability).toBe("text");
    expect(item.prompt).toContain('- character "林"');
    expect(item.prompt).toContain("第一批的描述。");
    expect(item.prompt).toContain("后一批的描述。");
    // One merge is not numbered as a part of several.
    expect(item.prompt).not.toContain("This is merge");
  });

  it("carries whole names into the next ask when one does not fit", () => {
    const held = story();
    const groups: ElementRepeat[] = ["甲", "乙", "丙"].map((name) => ({
      kind: "character",
      name,
      descriptions: ["一".repeat(80), "二".repeat(80)],
    }));
    const measure = (which: typeof groups) =>
      storyMergeElementsPrompt({
        groups: which,
        genre: held.brief.genre,
        style: held.brief.style,
        part: 1,
        total: groups.length,
      }).length;
    const budget = measure(groups.slice(0, 2));

    const waves = chunkElementMerges(held, groups, budget);

    // Two names fit, the third opens the next ask; no ask holds half a name.
    expect(waves.map((wave) => wave.map((group) => group.name))).toEqual([
      ["甲", "乙"],
      ["丙"],
    ]);
    for (const wave of waves) {
      for (const group of wave) {
        expect(group.descriptions).toHaveLength(2);
      }
      expect(measure(wave)).toBeLessThanOrEqual(budget);
    }
  });

  it("shortens one name's words rather than cutting the name in two", () => {
    const held = story();
    const group = {
      kind: "character" as const,
      name: "林",
      descriptions: ["甲".repeat(200), "乙".repeat(200)],
    };
    const bare = storyMergeElementsPrompt({
      groups: [{ ...group, descriptions: [] }],
      genre: held.brief.genre,
      style: held.brief.style,
      part: 1,
      total: 1,
    }).length;
    const budget = bare + 60;

    const waves = chunkElementMerges(held, [group], budget);

    // The element is one ask by itself: what does not fit is cut from its
    // descriptions, never from the set of names.
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(1);
    expect(waves[0][0].name).toBe("林");
    expect(waves[0][0].descriptions.join("").length).toBeLessThan(
      group.descriptions.join("").length,
    );
    expect(
      storyMergeElementsPrompt({
        groups: waves[0],
        genre: held.brief.genre,
        style: held.brief.style,
        part: 1,
        total: 1,
      }).length,
    ).toBeLessThanOrEqual(budget);
  });

  it("asks nothing when the parts repeated no name", () => {
    expect(planElementMergeWaves(story(), [])).toEqual([]);
  });

  it("asks for a board with the names the story holds", () => {
    const items = planStoryboard(story(), [ids.chapterFirst]);

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`storyboard:${ids.chapterFirst}`);
    expect(items[0].capability).toBe("text");
    expect(items[0].prompt).toContain("Chapter 1 of the telling: 第一章 站台");
    expect(items[0].prompt).toContain("- 林 (character)");
    expect(items[0].prompt).toContain("- 末班车车厢 (scene)");
    // The list the framing is chosen from is the list the parser reads.
    expect(items[0].prompt).toContain("mediumClose");
    expect(items[0].prompt).toContain("pushIn");
    expect(items[0].prompt).toContain("eyeLevel");
  });

  it("asks for no board of a chapter the story does not have", () => {
    expect(planStoryboard(story(), ["chapter-gone"])).toEqual([]);
  });

  it("plans a revision only while the outline is ahead of the board", () => {
    const held = story();
    const chapter = held.chapters[0]!;
    expect(chapter.acts.length).toBeGreaterThan(0);
    expect(planOutlineRevision(held, chapter.id)).toBeUndefined();

    chapter.revision = 2;
    chapter.boardRevision = 1;
    chapter.boardOutline = {
      title: chapter.title,
      synopsis: "The words the board was written from.",
    };
    chapter.synopsis = "The words the outline now holds.";
    const item = planOutlineRevision(held, chapter.id);
    expect(item).toBeDefined();
    expect(item!.id).toBe(`outlineRevision:${chapter.id}:2`);
    expect(item!.target).toEqual({
      kind: "outlineRevision",
      chapterId: chapter.id,
    });
    expect(item!.capability).toBe("text");
    expect(item!.prompt).toContain("The words the board was written from.");
    expect(item!.prompt).toContain("The words the outline now holds.");
    for (const act of chapter.acts) {
      expect(item!.prompt).toContain(act.id);
      for (const frame of act.keyframes) {
        expect(item!.prompt).toContain(frame.id);
      }
    }
  });
});

describe("planning the drawings", () => {
  it("gathers the drawings by the picture model each card names", () => {
    const held = story();
    held.elements.find((element) => element.id === ids.hero)!.imageModel =
      "paint-2";

    const waves = planElementArtWaves(held, [
      { elementId: ids.hero, view: "main" },
      { elementId: ids.prop, view: "main" },
    ]);

    expect(waves.map((wave) => wave.model)).toEqual(["paint-2", null]);
    expect(waves[0]?.items.map((item) => item.id)).toEqual([
      `element:main:${ids.hero}`,
    ]);
    expect(waves[1]?.items.map((item) => item.id)).toEqual([
      `element:main:${ids.prop}`,
    ]);
  });

  it("gives each drawing its own turn of the step's list", () => {
    useStoryModels.getState().choose("image", ["paint-1", "paint-2"]);

    const waves = planKeyframeArtWaves(story(), [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
    ]);

    // Each frame takes the next model in turn; the frames that landed on one
    // model then travel together as one ask.
    expect(waves.map((wave) => wave.model)).toEqual(["paint-1", "paint-2"]);
    expect(waves.map((wave) => wave.items.map((item) => item.id))).toEqual([
      [`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`],
      [`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`],
    ]);
  });

  it("gathers a board's frames by the picture model each row names", () => {
    const held = story();
    held.chapters[0]!.acts[0]!.keyframes[0]!.imageModel = "paint-2";

    const waves = planKeyframeArtWaves(held, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
    ]);

    expect(waves.map((wave) => wave.model)).toEqual(["paint-2", null]);
    expect(waves[0]?.items.map((item) => item.id)).toEqual([
      `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    ]);
    expect(waves[1]?.items.map((item) => item.id)).toEqual([
      `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`,
    ]);
  });

  it("draws a character upright whatever frame the film is cut to", () => {
    const items = planElementArt(story(), [
      { elementId: ids.hero, view: "main" },
    ]);

    expect(items[0].id).toBe(`element:main:${ids.hero}`);
    expect(items[0].capability).toBe("image");
    expect(items[0].params).toEqual({ size: "1024x1536" });
    expect(items[0].inputs).toEqual([]);
    expect(items[0].prompt).toContain("林");
    expect(items[0].prompt).toContain("现代都市风");
  });

  it("draws a place in the film's frame and a thing square by default", () => {
    const scene = planElementArt(story(), [
      { elementId: ids.scene, view: "main" },
    ]);
    expect(scene[0].params).toEqual({ size: "1536x1024" });

    const prop = planElementArt(story(), [
      { elementId: ids.prop, view: "main" },
    ]);
    expect(prop[0].params).toEqual({ size: "1024x1024" });
  });

  it("draws a main picture from the reference its card names", () => {
    const held = story();
    held.elements.find((element) => element.id === ids.hero)!.reference = {
      kind: "asset",
      assetId: "asset-reference",
    };
    const items = planElementArt(held, [{ elementId: ids.hero, view: "main" }]);
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: "asset-reference" },
    ]);
    expect(items[0].prompt).toContain("attached picture");
  });

  it("draws a form from its own words and its element's default form", () => {
    const held = story();
    const hero = held.elements.find((element) => element.id === ids.hero)!;
    hero.variants = [
      {
        id: "variant-old",
        name: "老年",
        description: "二十年以后，头发白了。",
        main: { takes: [] },
        turnaround: { takes: [] },
        reference: { kind: "element", elementId: ids.hero },
      },
    ];
    const items = planElementArt(held, [
      { elementId: ids.hero, view: "main", variantId: "variant-old" },
    ]);
    expect(items[0].id).toBe(`element:main:${ids.hero}:variant-old`);
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.heroMain },
    ]);
    expect(items[0].prompt).toContain("老年");
    expect(items[0].prompt).toContain("头发白了");
  });

  it("draws a thing in the frame its card names", () => {
    const held = story();
    held.elements.find((element) => element.id === ids.prop)!.ratio = "9:16";

    const prop = planElementArt(held, [{ elementId: ids.prop, view: "main" }]);
    expect(prop[0].params).toEqual({ size: "1024x1536" });
  });

  it("keeps the turn-around a square sheet of four views", () => {
    const items = planElementArt(story(), [
      { elementId: ids.hero, view: "turnaround" },
    ]);
    expect(items[0].params).toEqual({ size: "1024x1024" });
    // The sheet is filed under the character's own name and a fixed suffix,
    // not a generic label carrying a batch's random tag.
    expect(items[0].name).toBe("林 turn-around");
  });

  it("draws a turn-around from the picture the character already has", () => {
    const items = planElementArt(story(), [
      { elementId: ids.hero, view: "turnaround" },
    ]);

    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.heroMain },
    ]);
    expect(items[0].prompt).toContain("four views");
  });

  it("plans no turn-around for a character nobody has drawn", () => {
    const items = planElementArt(story(), [
      { elementId: ids.prop, view: "turnaround" },
    ]);
    expect(items).toEqual([]);
  });

  it("draws a frame with the pictures its own words name, in the order they are named", () => {
    // The mentions decide: a place named before a character is the place's
    // picture first and the character's second, whatever the act's cast lists.
    const items = planKeyframeArt(
      withContent("`末班车车厢`里，`林`立在灯下。"),
      [
        {
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId: ids.frameFirst,
        },
      ],
    );

    expect(items[0].id).toBe(
      `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    );
    expect(items[0].capability).toBe("image");
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.sceneMain },
      { role: "reference", assetId: ids.heroSheet },
    ]);
    expect(items[0].prompt).toContain("1. 末班车车厢 —");
    expect(items[0].prompt).toContain("2. 林 —");
    // The backticks the mentions are written with travel nowhere: the model
    // reads the sentence the telling means.
    expect(items[0].prompt).toContain("This shot: 末班车车厢里，林立在灯下。");
    expect(items[0].prompt).not.toContain("`");
  });

  it("leaves a name nobody has drawn to the words", () => {
    // The prop has no drawing of its own, so the mention is prose: it is not
    // numbered as a reference. The speaker of the shot's line still travels,
    // since a frame without their face gives the line to a stranger.
    const items = planKeyframeArt(withContent("`旧车票`攥在手里。"), [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.heroSheet },
    ]);
    expect(items[0].prompt).not.toContain("旧车票 —");
    expect(items[0].prompt).toContain("旧车票攥在手里。");
  });

  it("draws a frame whose words name none from the act's cast", () => {
    const held = withContent("雨下个不停。");
    held.chapters[0]!.acts[0]!.keyframes[0]!.references = undefined;
    const items = planKeyframeArt(held, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.heroSheet },
      { role: "reference", assetId: ids.partnerMain },
      { role: "reference", assetId: ids.sceneMain },
    ]);
    expect(items[0].prompt).toContain("1. 林 —");
    expect(items[0].prompt).toContain("2. 周 —");
    expect(items[0].prompt).toContain("3. 末班车车厢 —");
    // The prop has no drawing, so it has no numbered reference to stand on.
    expect(items[0].prompt).not.toContain("旧车票 —");
  });

  it("carries the first of the act's pictures its limit allows", () => {
    const held = withContent("雨下个不停。");
    held.chapters[0]!.acts[0]!.keyframes[0]!.references = undefined;
    const limited: StoryDocument = { ...held, maxReferenceImages: 1 };
    const [item] = planKeyframeArt(limited, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.inputs?.map((input) => input.assetId)).toEqual([ids.heroSheet]);
  });

  it("draws a shot that names nothing from the list it still keeps", () => {
    // The reader took one of the act's pictures off the shot: what is left is
    // the shot's own list and stands in for the words it never wrote.
    const held = withContent("雨下个不停。");
    held.chapters[0]!.acts[0]!.keyframes[0]!.references = [
      { elementId: ids.scene, name: "" },
    ];
    const [item] = planKeyframeArt(held, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.inputs?.map((input) => input.assetId)).toEqual([ids.sceneMain]);
  });

  it("leaves an emptied reference list with no pictures to stand in", () => {
    // The reader took every reference out of the shot: the act's cast is not
    // put back in its place.
    const held = withContent("雨下个不停。");
    held.chapters[0]!.acts[0]!.keyframes[0]!.references = [];
    const items = planKeyframeArt(held, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(items[0].inputs).toEqual([]);
  });

  it("does not add the act's cast to a shot whose words name a picture", () => {
    const held = withContent("`林`立在灯下。");
    held.chapters[0]!.acts[0]!.keyframes[0]!.references = undefined;
    const [item] = planKeyframeArt(held, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.inputs?.map((input) => input.assetId)).toEqual([ids.heroSheet]);
  });

  it("numbers exactly the pictures that travel", () => {
    // What must not happen is a numbered reference with no picture behind it.
    const items = planKeyframeArt(story(), [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
    ]);
    const numbered = (
      items[0].prompt.split("in the order they are given:")[1] ?? ""
    )
      .split("\n")
      .filter((line) => /^\d+\./.test(line.trim()));
    expect(numbered.length).toBe(items[0].inputs?.length);
    expect(numbered[0]).toContain("周");
  });

  it("carries the first pictures the story's limit allows, in the order they are named", () => {
    // Three drawn elements are mentioned and the story allows two: the first
    // two travel and the third is left to the words.
    const words = "`林`看着`周`，`末班车车厢`里很暗。";
    const held = withContent(words);
    const limited: StoryDocument = { ...held, maxReferenceImages: 2 };
    const cast = keyframeCast(limited, words);
    expect(cast.carried.map(({ assetId }) => assetId)).toEqual([
      ids.heroSheet,
      ids.partnerMain,
    ]);
    expect(cast.beyond.map(({ name }) => name)).toEqual(["末班车车厢"]);
    expect(cast.undrawn).toEqual([]);

    const [item] = planKeyframeArt(limited, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.inputs?.map((input) => input.assetId)).toEqual([
      ids.heroSheet,
      ids.partnerMain,
    ]);
    expect(item.prompt).not.toContain("末班车车厢 —");
  });

  it("carries a story element reference the words name from the drawing it keeps now", () => {
    const held = story();
    const scene = held.elements.find((element) => element.id === ids.scene)!;
    scene.variants = [
      {
        id: "variant-night",
        name: "夜晚",
        description: "灯都灭了。",
        main: {
          takes: [
            {
              assetIds: ["asset-scene-night"],
              createdAt: "2026-02-01T00:00:00Z",
            },
          ],
        },
      },
    ];
    const references = [
      {
        elementId: ids.scene,
        variantId: "variant-night",
        name: "车厢背面",
      },
    ];
    const cast = keyframeCast(held, "`车厢背面`在雨里。", references);
    expect(cast.carried.map(({ assetId }) => assetId)).toEqual([
      "asset-scene-night",
    ]);
    expect(cast.carried[0]?.name).toBe("车厢背面");
    expect(cast.carried[0]?.variant?.id).toBe("variant-night");
  });

  it("carries a shot's references where the words name them", () => {
    const references = [
      { elementId: ids.hero, name: "林" },
      { assetId: "asset-extra", name: "霓虹" },
    ];
    const cast = keyframeCast(
      story(),
      "`林`看着站台，`霓虹`在雨里亮着。",
      references,
    );
    expect(cast.carried.map(({ assetId }) => assetId)).toEqual([
      ids.heroSheet,
      "asset-extra",
    ]);
    expect(cast.carried[1]?.description).toBe(
      "A picture this shot is drawn with.",
    );

    // The story's limit is one budget for both: the mention goes first and
    // the extra is left beside it rather than silently sent instead.
    const limited = { ...story(), maxReferenceImages: 1 };
    const held = keyframeCast(
      limited,
      "`林`看着站台，`霓虹`在雨里亮着。",
      references,
    );
    expect(held.carried.map(({ assetId }) => assetId)).toEqual([ids.heroSheet]);
    expect(held.beyond.map(({ assetId }) => assetId)).toEqual(["asset-extra"]);

    const withReferences = withContent("`林`看着站台，`霓虹`在雨里亮着。");
    withReferences.chapters[0]!.acts[0]!.keyframes[0]!.references = references;
    const [item] = planKeyframeArt(withReferences, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.inputs?.map((input) => input.assetId)).toEqual([
      ids.heroSheet,
      "asset-extra",
    ]);
    expect(item.prompt).toContain("霓虹 —");
  });

  it("leaves a shot's reference out of the ask when its words never name it", () => {
    const references = [
      { elementId: ids.hero, name: "林" },
      { assetId: "asset-extra", name: "霓虹" },
    ];
    const cast = keyframeCast(story(), "`林`看着站台。", references);
    expect(cast.carried.map(({ assetId }) => assetId)).toEqual([ids.heroSheet]);
    expect(cast.beyond).toEqual([]);

    const withReferences = withContent("`林`看着站台。");
    withReferences.chapters[0]!.acts[0]!.keyframes[0]!.references = references;
    const [item] = planKeyframeArt(withReferences, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.inputs?.map((input) => input.assetId)).toEqual([ids.heroSheet]);
    expect(item.prompt).not.toContain("霓虹");
  });

  it("carries the act's place and a shot's speaker when its words name other pictures", () => {
    const held = withContent("`周`转过身来。");
    const frame = held.chapters[0]!.acts[0]!.keyframes[0]!;
    frame.references = [
      { elementId: ids.partner, name: "周" },
      { elementId: ids.hero, name: "林" },
      { elementId: ids.scene, name: "" },
    ];
    const [item] = planKeyframeArt(held, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    // The words name 周; the act's place and the one who speaks are carried
    // behind them, so the frame has a background and the line a face.
    expect(item.inputs?.map((input) => input.assetId)).toEqual([
      ids.partnerMain,
      ids.sceneMain,
      ids.heroSheet,
    ]);
  });

  it("does not force a place into a close-up", () => {
    const held = withContent("`周`转过身来。");
    const frame = held.chapters[0]!.acts[0]!.keyframes[0]!;
    frame.shotSize = "close";
    frame.references = [
      { elementId: ids.partner, name: "周" },
      { elementId: ids.hero, name: "林" },
      { elementId: ids.scene, name: "" },
    ];
    const [item] = planKeyframeArt(held, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.inputs?.map((input) => input.assetId)).toEqual([
      ids.partnerMain,
      ids.heroSheet,
    ]);
  });

  it("carries the form a shot chose rather than the element's default", () => {
    const held = story();
    const hero = held.elements.find((element) => element.id === ids.hero)!;
    hero.variants = [
      {
        id: "variant-old",
        name: "老年",
        description: "二十年以后，头发白了。",
        main: {
          takes: [
            { assetIds: ["asset-hero-old"], createdAt: "2026-02-01T00:00:00Z" },
          ],
        },
        turnaround: { takes: [] },
      },
    ];
    const words = "`林`立在灯下。";
    const cast = keyframeCast(held, words, [], {
      [ids.hero]: "variant-old",
    });
    expect(cast.carried[0]?.assetId).toBe("asset-hero-old");
    expect(cast.carried[0]?.variant?.id).toBe("variant-old");
    expect(cast.carried[0]?.description).toContain("头发白了");

    const frame = withContent(words);
    frame.elements.find((element) => element.id === ids.hero)!.variants =
      hero.variants;
    const storyFrame = frame.chapters[0]!.acts[0]!.keyframes[0]!;
    storyFrame.variantChoices = { [ids.hero]: "variant-old" };
    const [item] = planKeyframeArt(frame, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.inputs?.map((input) => input.assetId)).toEqual([
      "asset-hero-old",
    ]);
  });

  it("names a mentioned name that matches nothing as undrawn", () => {
    const cast = keyframeCast(story(), "`陌生人`走过来。");
    expect(cast.carried).toEqual([]);
    expect(cast.undrawn).toEqual(["陌生人"]);
  });

  it("plans nothing for a frame that was taken away", () => {
    expect(
      planKeyframeArt(story(), [
        {
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId: "frame-gone",
        },
      ]),
    ).toEqual([]);
  });
});

describe("planning the clips", () => {
  it("films an act from the drawings its shots were given", () => {
    const items = planActVideos(drawnStory(), ids.chapterFirst, [ids.act]);

    expect(items[0].id).toBe(`actVideo:${ids.chapterFirst}:${ids.act}`);
    expect(items[0].capability).toBe("video");
    // The act is five seconds of shots, so five seconds are asked for.
    // The story says how long and how wide; the machine's preferences say the
    // rest, since whether a provider writes sound into its clip is not the
    // telling's opinion.
    expect(items[0].params).toEqual({
      seconds: 5,
      ratio: "16:9",
      mode: "reference",
      generateAudio: false,
      watermark: false,
    });
    // No frame has been given a role, which is every frame a reference: the
    // pictures travel as references and the mode says so, since a machine
    // whose own taste says otherwise does not decide what the board means.
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.frameArt },
      { role: "reference", assetId: "asset-frame-second" },
    ]);
    // The shot's words travel as the telling means them: the backticks that
    // marked their mentions are the room's own and are not sent.
    expect(items[0].prompt).toContain("雨中的站台，林立在灯下。");
    expect(items[0].prompt).toContain("周转过身来。");
    expect(items[0].prompt).not.toContain("`");
    // A line the shot says travels with the clip it is filmed as: the mouth
    // moves with the words, and the dubbing that comes later lines up.
    expect(items[0].prompt).toContain('林 (平静): "车已经停运了。"');
    // Each shot is named by the second it opens, from the holds the board
    // gives it, so a frame added or retimed by hand moves the ones after it.
    expect(items[0].prompt).toContain(
      "At 0s, camera pushIn: 雨中的站台，林立在灯下。",
    );
    expect(items[0].prompt).toContain("At 2s, camera static: 周转过身来。");
    // The line stands with the shot that says it rather than in a paragraph
    // of its own.
    expect(items[0].prompt).toMatch(
      /At 0s, camera pushIn: 雨中的站台，林立在灯下。[^\n]*林 \(平静\): "车已经停运了。"/,
    );
    // The pictures are references, and the prompt asks for a shot drawn from
    // them rather than one moving between frames.
    expect(items[0].prompt).toContain("references the shots are drawn from");
    expect(items[0].prompt).not.toContain("frames it moves between");

    // The material a rewrite reads says how many pictures travel, so the
    // contract can number them rather than guess.
    expect(items[0].promptContext?.ends).toEqual({
      first: false,
      last: false,
      references: true,
      referenceCount: 2,
    });
    // It carries when each shot opens and which shot says which line, so a
    // rewrite can keep the timing and the mouths in step.
    expect(items[0].promptContext?.shots?.map((shot) => shot.start)).toEqual([
      0, 2,
    ]);
    expect(items[0].promptContext?.dialogue).toEqual([
      {
        speaker: "林",
        ref: "S1",
        text: "车已经停运了。",
        tone: "平静",
        shot: 1,
      },
    ]);
  });

  it("moves the times after a frame the reader adds and retimes", () => {
    const base = drawnStory();
    const act = base.chapters[0].acts[0];
    const third: StoryKeyframe = {
      ...act.keyframes[1],
      id: "frame-third",
      title: "#3",
      content: "灯灭了。",
      dialogue: [{ id: "line-third", speaker: "", text: "远处一声闷响。" }],
      durationMs: 4_000,
      art: {
        takes: [
          {
            assetIds: ["asset-frame-third"],
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };
    const board: StoryDocument = {
      ...base,
      chapters: base.chapters.map((chapter) => ({
        ...chapter,
        acts: chapter.acts.map((held) =>
          held.id === act.id
            ? { ...held, keyframes: [...held.keyframes, third] }
            : held,
        ),
      })),
    };

    const [item] = planActVideos(board, ids.chapterFirst, [ids.act]);
    // The added shot's four seconds make the clip nine, and every shot after
    // it opens where its own hold puts it.
    expect(item.params?.seconds).toBe(9);
    expect(item.prompt).toContain(
      "At 0s, camera pushIn: 雨中的站台，林立在灯下。",
    );
    expect(item.prompt).toContain("At 2s, camera static: 周转过身来。");
    // The line the added shot says stands with that shot, at its own second.
    expect(item.prompt).toMatch(
      /At 5s, camera static: 灯灭了。[^\n]*"远处一声闷响。"/,
    );
  });

  it("carries a shot that needs no picture as a moment of the clip", () => {
    const board = story();
    const act = board.chapters[0].acts[0];
    // The second shot is closed without a drawing: its words and seconds are
    // the act's, and only the first shot travels as a picture.
    act.keyframes = act.keyframes.map((keyframe, at) =>
      at === 1
        ? {
            ...keyframe,
            artNotNeeded: true,
            dialogue: [
              { id: "line-second", speaker: "", text: "远处一声汽笛。" },
            ],
          }
        : keyframe,
    );

    const [item] = planActVideos(board, ids.chapterFirst, [ids.act]);
    // The pictureless shot still holds its three seconds: the clip is the five
    // the board planned, and the two moments open where their holds put them.
    expect(item.params?.seconds).toBe(5);
    expect(item.params?.mode).toBe("reference");
    expect(item.inputs).toEqual([{ role: "reference", assetId: ids.frameArt }]);
    expect(item.prompt).toContain(
      "At 0s, camera pushIn: 雨中的站台，林立在灯下。",
    );
    expect(item.prompt).toMatch(
      /At 2s, camera static: 周转过身来。[^\n]*"远处一声汽笛。"/,
    );
    // The material a rewrite reads keeps the moment and the line it says.
    expect(item.promptContext?.shots?.map((shot) => shot.text)).toEqual([
      "雨中的站台，林立在灯下。",
      "周转过身来。",
    ]);
    expect(item.promptContext?.dialogue?.map((line) => line.shot)).toEqual([
      1, 2,
    ]);
  });

  it("films an act of words alone when no shot keeps a picture", () => {
    const board = story();
    const act = board.chapters[0].acts[0];
    act.keyframes = act.keyframes.map((keyframe) => ({
      ...keyframe,
      art: { takes: [] },
      artNotNeeded: true,
    }));

    const [item] = planActVideos(board, ids.chapterFirst, [ids.act]);
    expect(item.params?.seconds).toBe(5);
    expect(item.inputs).toEqual([]);
    expect(item.prompt).toContain("No pictures are given");
    expect(item.prompt).toContain("At 2s, camera static: 周转过身来。");
  });

  it("keeps words that open an act apart from a piece opening on a picture", () => {
    const board = drawnStory();
    const act = board.chapters[0].acts[0];
    act.keyframes = act.keyframes.map((keyframe, at) => {
      if (at === 0)
        return { ...keyframe, art: { takes: [] }, artNotNeeded: true };
      return { ...keyframe, filmRole: "firstFrame" as const };
    });

    const items = planActVideos(board, ids.chapterFirst, [ids.act]);
    // The words cannot stand before a piece pinned on a picture, so they are
    // a clip of their own; the drawn piece opens the act's picture from zero.
    expect(items.map((item) => item.params?.seconds)).toEqual([2, 3]);
    expect(items[0].inputs).toEqual([]);
    expect(items[0].prompt).toContain("No pictures are given");
    expect(items[1].inputs).toEqual([
      { role: "firstFrame", assetId: "asset-frame-second" },
    ]);
    expect(items[1].prompt).toContain("At 0s, camera static: 周转过身来。");
  });

  it("keeps words that filled a clip before a picture made as words alone", () => {
    useModelStore.setState({ view: settingsWithVideoCeiling(5) });
    const board = drawnStory();
    const act = board.chapters[0].acts[0];
    act.keyframes = act.keyframes.map((keyframe, at) =>
      at === 0
        ? {
            ...keyframe,
            durationMs: 4_000,
            art: { takes: [] },
            artNotNeeded: true,
          }
        : { ...keyframe, durationMs: 2_000 },
    );

    const items = planActVideos(board, ids.chapterFirst, [ids.act]);
    // The four seconds of words fill the clip before the picture can join it,
    // so that piece is words alone rather than a run referring to nothing.
    expect(items.map((item) => item.params?.seconds)).toEqual([4, 2]);
    expect(items[0].inputs).toEqual([]);
    expect(items[0].prompt).toContain("No pictures are given");
    expect(items[1].prompt).toContain("At 0s, camera static: 周转过身来。");
  });

  it("asks with the words a reader wrote for the act's clip", () => {
    const held: StoryDocument = {
      ...drawnStory(),
      videoPromptOverrides: {
        [`actVideo:${ids.chapterFirst}:${ids.act}`]: {
          prompt: "A slow push through the rain.",
          auto: "0badcafe",
        },
      },
    };

    const [item] = planActVideos(held, ids.chapterFirst, [ids.act]);
    expect(item.prompt).toBe("A slow push through the rain.");
  });

  it("asks a frame's picture with the words a reader wrote for it", () => {
    const held: StoryDocument = {
      ...drawnStory(),
      imagePromptOverrides: {
        [`keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`]: {
          prompt: "A still frame of the lantern.",
          auto: "0badcafe",
        },
      },
    };

    const [item] = planKeyframeArt(held, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.prompt).toBe("A still frame of the lantern.");
  });

  it("asks an element's picture with the words a reader wrote for it", () => {
    const held: StoryDocument = {
      ...story(),
      imagePromptOverrides: {
        [`element:main:${ids.hero}`]: {
          prompt: "A portrait of the lantern keeper.",
          auto: "0badcafe",
        },
      },
    };

    const [item] = planElementArt(held, [
      { elementId: ids.hero, view: "main" },
    ]);
    expect(item.prompt).toBe("A portrait of the lantern keeper.");
  });

  it("asks a shot with the words a reader wrote for it", () => {
    const held: StoryDocument = {
      ...drawnStory(),
      videoPromptOverrides: {
        [`keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`]: {
          prompt: "Hold on the lantern, then turn.",
          auto: "0badcafe",
        },
      },
    };

    const [item] = planKeyframeVideos(held, ids.chapterFirst, ids.act, [
      ids.frameFirst,
    ]);
    expect(item.prompt).toBe("Hold on the lantern, then turn.");
  });

  it("keeps hand-written words on the piece they were written for", () => {
    const base = roled({ [ids.frameFirst]: "firstFrame" });
    const firstPiece = `actVideo:${ids.chapterFirst}:${ids.act}:1`;
    const held: StoryDocument = {
      ...base,
      videoPromptOverrides: {
        [firstPiece]: { prompt: "Only the opening piece.", auto: "0badcafe" },
      },
    };

    const items = planActVideos(held, ids.chapterFirst, [ids.act]);
    expect(items).toHaveLength(2);
    expect(items[0].prompt).toBe("Only the opening piece.");
    // The piece nobody wrote for keeps the board's own words.
    expect(items[1].prompt).not.toBe("Only the opening piece.");
    expect(items[1].prompt).toContain("Shoot");
  });

  it("plans no act video while none of its shots is drawn", () => {
    const unfilmed: StoryDocument = {
      ...story(),
      chapters: story().chapters.map((chapter) => ({
        ...chapter,
        acts: chapter.acts.map((act) => ({
          ...act,
          keyframes: act.keyframes.map((keyframe) => ({
            ...keyframe,
            art: { takes: [] },
          })),
        })),
      })),
    };
    expect(planActVideos(unfilmed, ids.chapterFirst, [ids.act])).toEqual([]);
  });

  it("films a shot from its own drawing, ending on the next one's", () => {
    const items = planKeyframeVideos(drawnStory(), ids.chapterFirst, ids.act, [
      ids.frameFirst,
    ]);

    expect(items[0].id).toBe(
      `keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    );
    // The shot is drawn for two seconds, which is what it is asked for; the
    // app's own ceiling is six hundred by default and nowhere near.
    expect(items[0].params).toEqual({
      seconds: 2,
      ratio: "16:9",
      generateAudio: false,
      watermark: false,
    });
    expect(items[0].inputs).toEqual([
      { role: "firstFrame", assetId: ids.frameArt },
      { role: "lastFrame", assetId: "asset-frame-second" },
    ]);
    // A shot filmed on its own mouths its own lines.
    expect(items[0].prompt).toContain('林 (平静): "车已经停运了。"');
  });

  it("ends the last shot on itself rather than on a shot that is not there", () => {
    const items = planKeyframeVideos(drawnStory(), ids.chapterFirst, ids.act, [
      ids.frameSecond,
    ]);
    expect(items[0].inputs).toEqual([
      { role: "firstFrame", assetId: "asset-frame-second" },
    ]);
  });

  it("asks for the length the board planned, not the video settings' own", () => {
    // The video settings say what a canvas node asks for when nobody says:
    // six seconds unless the reader changed it. A telling says what each clip
    // is for, shot by shot, and is not cut to that number — an act of two
    // five-second shots is ten seconds wherever the setting stands.
    useModelStore.setState({ view: settingsWithVideoSeconds(6) });

    const items = planActVideos(plannedShot(5_000), ids.chapterFirst, [
      ids.act,
    ]);
    expect(items[0].params).toEqual({
      seconds: 10,
      ratio: "16:9",
      mode: "reference",
      generateAudio: false,
      watermark: false,
    });
    expect(items[0].prompt).toContain("about 10 seconds");
  });

  it("asks a long shot for its own length, and a score for the act it sits under", () => {
    useModelStore.setState({ view: settingsWithVideoSeconds(6) });
    const long = plannedShot(9_000);

    const [shot] = planKeyframeVideos(long, ids.chapterFirst, ids.act, [
      ids.frameFirst,
    ]);
    expect(shot.params?.seconds).toBe(9);

    const [score] = planActMusic(long, ids.chapterFirst, ids.act);
    // An act of two nine-second shots runs eighteen seconds, so the score
    // asked to sit under it is asked for eighteen rather than for six.
    expect(score.prompt).toContain("18 seconds");
  });

  it("films an act longer than one clip may be in pieces, cut where its shots end", () => {
    // The video model films fifteen seconds at a time, and this act is two
    // nine-second shots: one clip would be refused by the provider, so the act
    // travels as two, the second opening on the frame the first closed on and
    // ending on the act's last frame. The names are the act's own with the
    // piece's place, which is how the answers come home to one clip.
    useModelStore.setState({ view: settingsWithVideoCeiling(15) });

    const items = planActVideos(plannedShot(9_000), ids.chapterFirst, [
      ids.act,
    ]);
    expect(items.map((item) => item.id)).toEqual([
      `actVideo:${ids.chapterFirst}:${ids.act}:1`,
      `actVideo:${ids.chapterFirst}:${ids.act}:2`,
    ]);
    expect(items.map((item) => item.params?.seconds)).toEqual([9, 9]);
    expect(items[0].prompt).toContain("part 1 of 2");
    expect(items[1].prompt).toContain("part 2 of 2");
    expect(items[0].prompt).toContain("about 9 seconds");
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.frameArt },
    ]);
    expect(items[1].inputs).toEqual([
      { role: "reference", assetId: "asset-frame-second" },
    ]);
    // Both are the act's: the target is the place the clip lands either way.
    expect(items[0].target).toEqual(items[1].target);
  });

  it("keeps an act that fits in one clip as the one piece it is", () => {
    useModelStore.setState({ view: settingsWithVideoCeiling(15) });

    const items = planActVideos(plannedShot(5_000), ids.chapterFirst, [
      ids.act,
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`actVideo:${ids.chapterFirst}:${ids.act}`);
    expect(items[0].params?.seconds).toBe(10);
  });

  it("films an act by the model it names, cut to that model's window", () => {
    useModelStore.setState({ view: settingsWithTwoVideoModels() });
    const held = plannedShot(8_000);
    held.chapters[0]!.acts[0]!.videoModel = "quick";

    const waves = planActVideoWaves(held, ids.chapterFirst, [ids.act]);
    expect(waves.map((wave) => wave.model)).toEqual(["quick"]);
    // Eight seconds a shot, under a model that films five: each shot is cut
    // to the window this act's own model declares, not the step's.
    expect(waves[0]?.items.map((item) => item.params?.seconds)).toEqual([5, 5]);

    // The act beside it, which names nothing, stays with the step's model and
    // its longer window.
    held.chapters[0]!.acts[0]!.videoModel = undefined;
    const shared = planActVideos(held, ids.chapterFirst, [ids.act]);
    expect(shared.map((item) => item.params?.seconds)).toEqual([8, 8]);
  });

  it("asks for the act's own ceiling when the model declares none", () => {
    // Two shots of four hundred seconds is over thirteen minutes; with no
    // window of its own to go by, the app's own ceiling is what each piece is
    // cut to, and the act travels as two pieces of four hundred.
    useModelStore.setState({ view: settingsWithVideoSeconds(6) });

    const items = planActVideos(plannedShot(400_000), ids.chapterFirst, [
      ids.act,
    ]);
    expect(items.map((item) => item.params?.seconds)).toEqual([400, 400]);

    // A shot longer than that ceiling has no shot end to be cut at, and is
    // asked for the longest one clip may be.
    const [only] = planActVideos(plannedShot(900_000), ids.chapterFirst, [
      ids.act,
    ]);
    expect(only.params?.seconds).toBe(600);
  });

  it("cuts pieces at shot ends even when one shot outruns the model", () => {
    // Nine hundred seconds of one shot cannot be cut anywhere: the shot is
    // asked for the longest the model films, and the piece after it is the
    // other shot, so the act is still asked for in the order the board wrote.
    useModelStore.setState({ view: settingsWithVideoCeiling(15) });

    const items = planActVideos(plannedShot(900_000), ids.chapterFirst, [
      ids.act,
    ]);
    expect(items.map((item) => item.params?.seconds)).toEqual([15, 15]);
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.frameArt },
    ]);
    expect(items[1].inputs).toEqual([
      { role: "reference", assetId: "asset-frame-second" },
    ]);
  });

  it("opens a piece of its own from a frame marked as a first frame", () => {
    useModelStore.setState({ view: settingsWithVideoCeiling(15) });

    const items = planActVideos(
      roled({ [ids.frameSecond]: "firstFrame" }),
      ids.chapterFirst,
      [ids.act],
    );
    expect(items.map((item) => item.id)).toEqual([
      `actVideo:${ids.chapterFirst}:${ids.act}:1`,
      `actVideo:${ids.chapterFirst}:${ids.act}:2`,
    ]);
    // The first shot keeps its reference run, the second is filmed from its
    // own drawn frame: the piece's mode says which of the two it is.
    expect(items.map((item) => item.params?.mode)).toEqual([
      "reference",
      "auto",
    ]);
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.frameArt },
    ]);
    expect(items[1].inputs).toEqual([
      { role: "firstFrame", assetId: "asset-frame-second" },
    ]);
    expect(items[1].prompt).toContain("Shoot part 2 of 2 of this act");
    expect(items[1].prompt).toContain("At 0s, camera static: 周转过身来。");
    expect(items[1].prompt).not.toContain(
      "references the shots are drawn from",
    );
  });

  it("pairs a first-and-last frame with the frame after it, at the act's own end", () => {
    const items = planActVideos(
      roled({ [ids.frameFirst]: "firstLastFrame" }),
      ids.chapterFirst,
      [ids.act],
    );
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`actVideo:${ids.chapterFirst}:${ids.act}`);
    // The pair closes the act, so the second shot's own two seconds ride with
    // it — nothing opens on that frame, and none of the act is asked twice.
    expect(items[0].params?.seconds).toBe(5);
    expect(items[0].params?.mode).toBe("auto");
    expect(items[0].inputs).toEqual([
      { role: "firstFrame", assetId: ids.frameArt },
      { role: "lastFrame", assetId: "asset-frame-second" },
    ]);
    expect(items[0].prompt).toContain(
      "At 0s, camera pushIn: 雨中的站台，林立在灯下。",
    );
    expect(items[0].prompt).toContain("At 2s, camera static: 周转过身来。");
  });

  it("holds a pair's closing moment at the clip's end when the pair outruns the model", () => {
    useModelStore.setState({ view: settingsWithVideoCeiling(15) });
    const board = plannedShot(400_000);
    const act = board.chapters[0].acts[0];
    act.keyframes = act.keyframes.map((keyframe, at) =>
      at === 0 ? { ...keyframe, filmRole: "firstLastFrame" } : keyframe,
    );

    const [item] = planActVideos(board, ids.chapterFirst, [ids.act]);
    expect(item.params?.seconds).toBe(15);
    // A pair cannot be cut anywhere, so it is asked for the longest the model
    // films: the second picture is no longer at eight hundred seconds, it is
    // the closing frame of a fifteen-second clip.
    expect(item.prompt).toContain("about 15 seconds");
    expect(item.prompt).toContain(
      "At 0s, camera pushIn: 雨中的站台，林立在灯下。",
    );
    expect(item.prompt).toContain("At 15s, camera static: 周转过身来。");
  });

  it("closes the act on the pair a settling role makes, with no piece after it", () => {
    const board = roled(
      {
        [ids.frameFirst]: "reference",
        [ids.frameSecond]: "firstLastFrame",
      },
      { id: "frame-third", assetId: "asset-frame-third", content: "灯灭了。" },
    );
    expect([...settledRoleFrames(board.chapters[0].acts[0])]).toEqual([
      "frame-third",
    ]);

    const items = planActVideos(board, ids.chapterFirst, [ids.act]);
    expect(items.map((item) => item.id)).toEqual([
      `actVideo:${ids.chapterFirst}:${ids.act}:1`,
      `actVideo:${ids.chapterFirst}:${ids.act}:2`,
    ]);
    // The first shot is a run of references of its own, and the pair takes the
    // last frame whole: two seconds for the run, five for the pair.
    expect(items.map((item) => item.params?.seconds)).toEqual([2, 5]);
    expect(items.map((item) => item.params?.mode)).toEqual([
      "reference",
      "auto",
    ]);
    expect(items[1].inputs).toEqual([
      { role: "firstFrame", assetId: "asset-frame-second" },
      { role: "lastFrame", assetId: "asset-frame-third" },
    ]);
  });

  it("lets a frame close one piece and open the next when the reader says so", () => {
    const board = roled(
      {
        [ids.frameFirst]: "firstLastFrame",
        [ids.frameSecond]: "firstFrame",
      },
      { id: "frame-third", assetId: "asset-frame-third", content: "灯灭了。" },
    );
    // The pair's tail is not the act's closing frame, so it goes on to open a
    // piece of its own: a frame may serve both pieces, which is the reader's
    // to ask for.
    expect([...settledRoleFrames(board.chapters[0].acts[0])]).toEqual([]);

    const items = planActVideos(board, ids.chapterFirst, [ids.act]);
    // Every shot's own length is asked for exactly once, across the three
    // pieces: the pair opens on the first shot, the third is drawn on its own,
    // and the shot between them is both the pair's tail and a piece's head.
    expect(items.map((item) => item.params?.seconds)).toEqual([2, 3, 2]);
    expect(items.map((item) => item.params?.mode)).toEqual([
      "auto",
      "auto",
      "reference",
    ]);
    expect(items[0].inputs).toEqual([
      { role: "firstFrame", assetId: ids.frameArt },
      { role: "lastFrame", assetId: "asset-frame-second" },
    ]);
    // The second shot is the pair's tail and a first frame at once: the same
    // picture travels in two pieces.
    expect(items[1].inputs).toEqual([
      { role: "firstFrame", assetId: "asset-frame-second" },
    ]);
    expect(items[2].inputs).toEqual([
      { role: "reference", assetId: "asset-frame-third" },
    ]);
  });

  it("treats a first-and-last frame with nothing after it as a reference", () => {
    const items = planActVideos(
      roled({ [ids.frameSecond]: "firstLastFrame" }),
      ids.chapterFirst,
      [ids.act],
    );
    expect(items).toHaveLength(1);
    expect(items[0].params?.mode).toBe("reference");
    expect(items[0].prompt).toContain(
      "At 0s, camera pushIn: 雨中的站台，林立在灯下。",
    );
  });

  it("bridges two acts from the ends of their clips", () => {
    const base = drawnStory();
    const chapter = base.chapters[0];
    const before = chapter.acts[0];
    const after = {
      ...before,
      id: "act-after",
      title: "After",
      video: {
        takes: [
          { assetIds: ["clip-after"], createdAt: "2026-01-01T00:00:00Z" },
        ],
      },
      keyframes: [
        {
          ...before.keyframes[0],
          id: "frame-after",
          art: {
            takes: [
              {
                assetIds: ["art-after"],
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        },
      ],
    };
    const bridge = {
      ...before,
      id: "bridge",
      title: "Bridge",
      keyframes: [],
      video: { takes: [] },
      transition: { prompt: "Through the dark", durationMs: 4_000 },
    };
    const board: StoryDocument = {
      ...base,
      chapters: [
        {
          ...chapter,
          acts: [
            {
              ...before,
              video: {
                takes: [
                  {
                    assetIds: ["clip-before-a", "clip-before-b"],
                    createdAt: "2026-01-01T00:00:00Z",
                  },
                ],
              },
            },
            bridge,
            after,
          ],
        },
      ],
    };

    // The clip before is filmed in pieces, so its end is the last piece's; the
    // clip after opens at its first. Both travel as the pictures taken out of
    // those ends when the request is sent.
    const [ask] = planActVideos(board, chapter.id, [bridge.id]);
    expect(ask.inputs).toEqual([
      { role: "firstFrame", assetId: "clip-before-b", frame: "last" },
      { role: "lastFrame", assetId: "clip-after", frame: "first" },
    ]);
    expect(ask.params?.seconds).toBe(4);

    // A neighbour with no clip has no end to give, so the bridge is not asked
    // for at all rather than being filmed between something else.
    const unfilmed: StoryDocument = {
      ...board,
      chapters: [
        {
          ...chapter,
          acts: chapter.acts.map((act) =>
            act.id === after.id ? { ...act, video: { takes: [] } } : act,
          ),
        },
      ],
    };
    expect(planActVideos(unfilmed, chapter.id, [bridge.id])).toEqual([]);

    // A bridge is asked for in the reader's own words too, when they wrote any.
    const written: StoryDocument = {
      ...board,
      videoPromptOverrides: {
        [`actVideo:${chapter.id}:${bridge.id}`]: {
          prompt: "Dissolve through the dark.",
          auto: "0badcafe",
        },
      },
    };
    const [writtenAsk] = planActVideos(written, chapter.id, [bridge.id]);
    expect(writtenAsk.prompt).toBe("Dissolve through the dark.");
  });
});

describe("asking again for what did not come back", () => {
  it("plans today's ask for a place, from today's document", () => {
    const held = story();
    const edited: StoryDocument = {
      ...held,
      elements: held.elements.map((element) =>
        element.id === ids.hero
          ? { ...element, description: "四十岁上下，灰呢大衣。" }
          : element,
      ),
    };

    const items = itemsForTargets(edited, [
      {
        kind: "keyframeArt",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(
      `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    );
    expect(items[0].prompt).toContain("灰呢大衣");
  });

  it("plans a batch per kind for a mixed list of places", () => {
    const items = itemsForTargets(drawnStory(), [
      { kind: "actVideo", chapterId: ids.chapterFirst, actId: ids.act },
      {
        kind: "keyframeVideo",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);

    expect(items.map((item) => item.id)).toEqual([
      `actVideo:${ids.chapterFirst}:${ids.act}`,
      `keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    ]);
  });

  it("asks again with the words a reader wrote, not the board's own", () => {
    const held: StoryDocument = {
      ...drawnStory(),
      videoPromptOverrides: {
        [`actVideo:${ids.chapterFirst}:${ids.act}`]: {
          prompt: "Keep the station empty this time.",
          auto: "0badcafe",
        },
      },
    };

    const [item] = itemsForTargets(held, [
      { kind: "actVideo", chapterId: ids.chapterFirst, actId: ids.act },
    ]);
    expect(item.prompt).toBe("Keep the station empty this time.");
  });
});

describe("the sound of an act", () => {
  it("reads an act's lines aloud as one ask, in the order the board tells them", () => {
    const held = story();
    const act = held.chapters[0].acts[0];
    // A line in the second shot too, so the order it is read in is a claim
    // the fixture can be wrong about.
    const lined: StoryDocument = {
      ...held,
      chapters: held.chapters.map((chapter) => ({
        ...chapter,
        acts: chapter.acts.map((each) =>
          each.id !== act.id
            ? each
            : {
                ...each,
                keyframes: each.keyframes.map((keyframe) =>
                  keyframe.id !== ids.frameSecond
                    ? keyframe
                    : {
                        ...keyframe,
                        dialogue: [
                          {
                            id: "line-2",
                            speaker: "周",
                            text: "下一班还来。",
                            tone: "",
                          },
                        ],
                      },
                ),
              },
        ),
      })),
    };

    const items = planActVoice(lined, ids.chapterFirst, ids.act);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`actVoice:${ids.chapterFirst}:${ids.act}`);
    expect(items[0].capability).toBe("speech");
    // The words themselves and nothing else: a voice given the speaker's name
    // or the bracketed tone would read those out too.
    expect(items[0].prompt).toContain("车已经停运了。");
    expect(items[0].prompt).toContain("下一班还来。");
    expect(items[0].prompt).not.toContain("林");
    expect(items[0].prompt).not.toContain("平静");
    expect(items[0].prompt.indexOf("车已经停运了")).toBeLessThan(
      items[0].prompt.indexOf("下一班还来"),
    );
  });

  it("asks for nothing when an act says nothing", () => {
    const held = story();
    const silent: StoryDocument = {
      ...held,
      chapters: held.chapters.map((chapter) => ({
        ...chapter,
        acts: chapter.acts.map((act) => ({
          ...act,
          keyframes: act.keyframes.map((keyframe) => ({
            ...keyframe,
            dialogue: [],
          })),
        })),
      })),
    };
    expect(planActVoice(silent, ids.chapterFirst, ids.act)).toEqual([]);
  });

  it("asks for the score in the music capability, with the board's own words", () => {
    const items = planActMusic(story(), ids.chapterFirst, ids.act);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`actMusic:${ids.chapterFirst}:${ids.act}`);
    // The capability is what the answer is filed by: a score asked of a
    // speech model would land on the voice shelf.
    expect(items[0].capability).toBe("music");
    expect(items[0].prompt).toContain("低音提琴，缓慢");
    expect(items[0].prompt).toContain("雨声");
    expect(items[0].prompt).toContain("空站台");
    // A score plays under the lines rather than being sung over them: the
    // service that can write words for a song is told not to. Shape and
    // watermark are the music preferences' to fill, so they are not sent.
    expect(items[0]?.params).toEqual({ instrumental: true });
  });

  it("asks for nothing when the board says nothing about the sound", () => {
    const held = story();
    const act = held.chapters[0].acts[0];
    const hushed: StoryDocument = {
      ...held,
      chapters: held.chapters.map((chapter) => ({
        ...chapter,
        acts: chapter.acts.map((each) =>
          each.id !== act.id
            ? each
            : { ...each, sound: { music: "", sfx: "", ambience: "  " } },
        ),
      })),
    };
    expect(planActMusic(hushed, ids.chapterFirst, ids.act)).toEqual([]);
  });

  it("asks for both again when a retry names the act's sound", () => {
    const held = story();
    const items = itemsForTargets(held, [
      { kind: "voice", chapterId: ids.chapterFirst, actId: ids.act },
      { kind: "music", chapterId: ids.chapterFirst, actId: ids.act },
    ]);
    expect(items.map((item) => item.id)).toEqual([
      `actVoice:${ids.chapterFirst}:${ids.act}`,
      `actMusic:${ids.chapterFirst}:${ids.act}`,
    ]);
  });
});

describe("the record a voice is copied from", () => {
  /** The fixture with the hero's voice copied from a recording. */
  function copied(): StoryDocument {
    const held = story();
    return {
      ...held,
      elements: held.elements.map((element) =>
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
  }

  it("carries the recording with every line the speaker reads", () => {
    const waves = planLineVoiceAsks(copied(), ids.chapterFirst, ids.act);
    expect(waves).toHaveLength(1);
    expect(waves[0].items).toHaveLength(1);
    const item = waves[0].items[0];
    expect(item.target.kind).toBe("lineVoice");
    expect(item.inputs).toEqual([
      { role: "reference", assetId: "asset-hero-voice" },
    ]);

    // A reading aimed at one line carries it the same way: standing in for a
    // speaker who was given a recording is the same ask, not a different one.
    const one = planLineVoiceAsks(copied(), ids.chapterFirst, ids.act, [
      ids.lineFirst,
    ]);
    expect(one[0]?.items[0]?.inputs).toEqual([
      { role: "reference", assetId: "asset-hero-voice" },
    ]);

    // A voice that names no recording travels with no inputs at all.
    const plain = planLineVoiceAsks(story(), ids.chapterFirst, ids.act);
    expect(plain[0]?.items[0]?.inputs).toEqual([]);
  });

  it("sends no voice name beside a recording: the two are one voice said twice", () => {
    const view = settingsWithVideoSeconds(6);
    useModelStore.setState({
      view: {
        ...view,
        preferences: {
          ...view.preferences,
          speech: {
            ...view.preferences.speech,
            voice: "machine-tone",
            speed: 1.2,
          },
        },
      },
    });
    const held = story();

    // Without a recording, the machine's own tone travels as it always has.
    const named = voiceParamsFor(held, { model: "", voice: "" });
    expect(named.voice).toBe("machine-tone");
    expect(named.speed).toBe(1.2);

    // With one, every name stands aside — the machine's and the speaker's
    // alike — while the pace, the pitch, and the direction stay: they are
    // how something is said, not whose voice says it.
    const params = voiceParamsFor(held, {
      model: "",
      voice: "longxiaochun",
      rate: 1.1,
      pitch: 0.9,
      referenceAssetId: "asset-hero-voice",
    });
    expect("voice" in params).toBe(false);
    expect(params.rate).toBe(1.1);
    expect(params.pitch).toBe(0.9);
    expect(typeof params.instructions).toBe("string");
    expect((params.instructions as string).length).toBeGreaterThan(0);
  });
});
