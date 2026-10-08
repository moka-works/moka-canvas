import { beforeEach, describe, expect, it } from "vitest";

import type { ModelsView } from "../../../api/models";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type {
  StoryDocument,
  StoryFilmRole,
} from "../../../shared/domain/types";
import { useModelStore } from "../../settings/modelStore";
import {
  clampSeconds,
  imageSizeForAspect,
  itemsForTargets,
  jobKey,
  keyframeCast,
  planActMusic,
  planActVideos,
  planActVoice,
  planElementArt,
  planElements,
  planKeyframeArt,
  planKeyframeVideos,
  planLineVoiceAsks,
  planOutline,
  planStoryboard,
  settledRoleFrames,
  voiceParamsFor,
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
      story: { splitChars: 12_000, readChars: 8_000 },
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
    const words = planOutline(story(), { mode: "expand", chapters: 2 });
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
    const items = planOutline(story(), { mode: "expand", chapters: 2 });

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

  it("asks for each part of a manuscript on its own, numbered in order", () => {
    const items = planOutline(story(), {
      mode: "split",
      chapters: 2,
      chunks: [
        { title: "第一章", text: "他在站台上等一班已经停运的列车。" },
        { title: "第二章", text: "车厢比站台更暗。" },
      ],
    });

    // The number on the piece is the place in the telling its answer belongs,
    // so the parts are in the order the manuscript was read in.
    expect(items.map((item) => item.id)).toEqual(["outline:1", "outline:2"]);
    expect(items[0].prompt).toContain("Part 1 of 2");
    expect(items[1].prompt).toContain("Part 2 of 2");
    expect(items[1].prompt).toContain("车厢比站台更暗。");
    // A chapter is asked for under the name the manuscript gave it.
    expect(items[0].prompt).toContain("第一章");
    expect(items[1].prompt).toContain("第二章");
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
      chapterIds: [ids.chapterSecond],
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
});

describe("planning the drawings", () => {
  it("asks for a character's main picture in the frame of the film", () => {
    const items = planElementArt(story(), [
      { elementId: ids.hero, view: "main" },
    ]);

    expect(items[0].id).toBe(`element:main:${ids.hero}`);
    expect(items[0].capability).toBe("image");
    expect(items[0].params).toEqual({ size: "1536x1024" });
    expect(items[0].inputs).toEqual([]);
    expect(items[0].prompt).toContain("林");
    expect(items[0].prompt).toContain("现代都市风");
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
      { role: "reference", assetId: ids.heroMain },
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
    // numbered as a reference and no picture travels with the ask.
    const items = planKeyframeArt(withContent("`旧车票`攥在手里。"), [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(items[0].inputs).toEqual([]);
    expect(items[0].prompt).not.toContain("旧车票 —");
    expect(items[0].prompt).toContain("旧车票攥在手里。");
  });

  it("carries no picture for a frame whose words name none", () => {
    const items = planKeyframeArt(withContent("雨下个不停。"), [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(items[0].inputs).toEqual([]);
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
      ids.heroMain,
      ids.partnerMain,
    ]);
    expect(cast.beyond.map(({ element }) => element.name)).toEqual([
      "末班车车厢",
    ]);
    expect(cast.undrawn).toEqual([]);

    const [item] = planKeyframeArt(limited, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);
    expect(item.inputs?.map((input) => input.assetId)).toEqual([
      ids.heroMain,
      ids.partnerMain,
    ]);
    expect(item.prompt).not.toContain("末班车车厢 —");
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
    // The pictures are references, and the prompt asks for a shot drawn from
    // them rather than one moving between frames.
    expect(items[0].prompt).toContain(
      "It covers: 雨中的站台，林立在灯下。; 周转过身来。",
    );
    expect(items[0].prompt).toContain("references the shots are drawn from");
    expect(items[0].prompt).not.toContain("frames it moves between");
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
    expect(items[1].prompt).toContain("This part opens on: 周转过身来。");
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
    expect(items[0].prompt).toContain("It opens on: 雨中的站台，林立在灯下。");
    expect(items[0].prompt).toContain("It ends on: 周转过身来。");
    expect(items[0].prompt).not.toContain("passes through");
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
    expect(items[0].prompt).toContain("It covers:");
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
