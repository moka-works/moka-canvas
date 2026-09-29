// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import type {
  StoryJobItem,
  StoryJobRecord,
  StoryTarget,
} from "../../../api/story";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { StoryDocument } from "../../../shared/domain/types";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { applyJobResults } from "./apply";

const ids = storyIds();

/** The room's project, open, with the fixture story in it. */
function open(): void {
  useProjectStore.getState().hydrate({
    moka: buildStoryMokaFile(),
    root: "/tmp/moka-story-apply-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
}

function story(): StoryDocument {
  const held = useProjectStore
    .getState()
    .moka?.stories?.find((each) => each.id === ids.story);
  if (held === undefined) throw new Error("the fixture story is open");
  return held;
}

function item(overrides: Partial<StoryJobItem> = {}): StoryJobItem {
  return {
    id: "keyframe:chapter-1:act-1:frame-1",
    target: { kind: "keyframeArt", chapterId: "", actId: "", keyframeId: "" },
    capability: "image",
    prompt: "雨中的站台",
    inputs: [],
    params: {},
    status: "succeeded",
    ...overrides,
  };
}

function record(
  kind: StoryJobRecord["kind"],
  items: StoryJobItem[],
): StoryJobRecord {
  return {
    id: `job-${kind}`,
    projectId: "project-1",
    storyId: ids.story,
    kind,
    status: "succeeded",
    model: "a-model",
    items,
    cancelRequested: false,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  };
}

function keyframeItem(
  keyframeId: string,
  assetId: string,
  extra: Partial<StoryJobItem> = {},
): StoryJobItem {
  return item({
    id: `keyframe:${ids.chapterFirst}:${ids.act}:${keyframeId}`,
    target: {
      kind: "keyframeArt",
      chapterId: ids.chapterFirst,
      actId: ids.act,
      keyframeId,
    },
    assetIds: [assetId],
    ...extra,
  });
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  open();
});

/** One piece of an act's clip, as the room asks for it when an act is long. */
function actPiece(
  id: string,
  assetId: string,
  extra: Partial<StoryJobItem> = {},
): StoryJobItem {
  return item({
    id,
    target: { kind: "actVideo", chapterId: ids.chapterFirst, actId: ids.act },
    capability: "video",
    assetIds: [assetId],
    ...extra,
  });
}

describe("writing a batch's answers into the story", () => {
  it("files a drawing at the place its piece was for", () => {
    const report = applyJobResults(
      record("keyframeArt", [keyframeItem(ids.frameSecond, "asset-new-frame")]),
    );

    expect(report.applied).toBe(1);
    expect(report.skipped).toBe(0);
    const frame = story().chapters[0].acts[0].keyframes.find(
      (each) => each.id === ids.frameSecond,
    );
    expect(frame?.art.takes.map((take) => take.assetIds[0])).toEqual([
      "asset-new-frame",
    ]);
    // The ask that drew it is written on the take, so a redraw can tell its own
    // work from a reader's.
    expect(frame?.art.takes[0].jobId).toBe("job-keyframeArt");
    expect(frame?.art.takes[0].itemId).toBe(
      `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`,
    );
  });

  it("adds a drawing to the place rather than replacing what is there", () => {
    const report = applyJobResults(
      record("keyframeArt", [
        keyframeItem(ids.frameFirst, "asset-another-frame"),
      ]),
    );

    expect(report.applied).toBe(1);
    const frame = story().chapters[0].acts[0].keyframes.find(
      (each) => each.id === ids.frameFirst,
    );
    expect(frame?.art.takes.map((take) => take.assetIds[0])).toEqual([
      ids.frameArt,
      "asset-another-frame",
    ]);
  });

  it("keeps an act's pieces as the one clip they make, in the order they play", () => {
    const base = `actVideo:${ids.chapterFirst}:${ids.act}`;
    // Three pieces is what a board with a pair, a first frame and a run of
    // references asks for; the order they play in is the order they are kept.
    const pieces = [
      actPiece(`${base}:1`, "asset-act-1"),
      actPiece(`${base}:2`, "asset-act-2"),
      actPiece(`${base}:3`, "asset-act-3"),
    ];
    const report = applyJobResults(record("actVideo", pieces));

    expect(report.applied).toBe(3);
    expect(report.skipped).toBe(0);
    const act = story().chapters[0].acts[0];
    const clip = act.video.takes[act.video.takes.length - 1];
    expect(clip?.assetIds).toEqual([
      "asset-act-1",
      "asset-act-2",
      "asset-act-3",
    ]);
    // The piece that opens the act is the ask written on the clip.
    expect(clip?.itemId).toBe(`${base}:1`);

    // Read again, the same pieces are not another clip.
    const again = applyJobResults(record("actVideo", pieces));
    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(3);
    expect(story().chapters[0].acts[0].video.takes).toHaveLength(
      act.video.takes.length,
    );
  });

  it("writes no clip for an act whose pieces did not all come back", () => {
    // A sequence with a piece missing is not a shorter act but a broken one:
    // the film would run to something the board never planned.
    const base = `actVideo:${ids.chapterFirst}:${ids.act}`;
    const before = story().chapters[0].acts[0].video.takes.length;
    const report = applyJobResults(
      record("actVideo", [
        actPiece(`${base}:1`, "asset-act-1"),
        actPiece(`${base}:2`, "asset-act-2", {
          status: "failed",
          error: "the provider refused it",
        }),
      ]),
    );

    expect(report.applied).toBe(0);
    expect(report.skipped).toBe(2);
    expect(story().chapters[0].acts[0].video.takes).toHaveLength(before);
  });

  it("writes the chapters an outline answered with, keeping the boards", () => {
    const report = applyJobResults(
      record("outline", [
        item({
          id: "outline",
          target: { kind: "outline" },
          capability: "text",
          text: '```json\n{ "chapters": [ { "title": "第一章 站台", "synopsis": "新的梗概。" }, { "title": "第二章 车厢", "synopsis": "车厢比站台更暗。" } ] }\n```',
        }),
      ]),
    );

    expect(report.applied).toBe(1);
    // The first chapter kept its board and only took the new words.
    expect(story().chapters[0].title).toBe("第一章 站台");
    expect(story().chapters[0].synopsis).toBe("新的梗概。");
    expect(story().chapters[0].acts).toHaveLength(1);
  });

  it("reads a part of a manuscript that answered with one chapter", () => {
    const report = applyJobResults(
      record("outline", [
        item({
          id: "outline:1",
          target: { kind: "outline" },
          capability: "text",
          text: '{ "title": "第一章 站台", "synopsis": "他在站台上等列车。" }',
        }),
      ]),
    );

    expect(report.applied).toBe(1);
    expect(story().chapters[0].synopsis).toBe("他在站台上等列车。");
  });

  it("writes the elements an answer found, keeping the drawings of those it knew", () => {
    const report = applyJobResults(
      record("elements", [
        item({
          id: "elements",
          target: { kind: "elements" },
          capability: "text",
          text: JSON.stringify({
            characters: [
              {
                name: "林",
                description: "四十岁上下，灰呢大衣。",
                chapters: [1],
              },
            ],
            scenes: [],
            props: [],
          }),
        }),
      ]),
    );

    expect(report.applied).toBe(1);
    expect(report.notes).toEqual([]);
    const hero = story().elements.find((each) => each.id === ids.hero);
    expect(hero?.description).toBe("四十岁上下，灰呢大衣。");
    expect(hero?.main.takes.map((take) => take.assetIds[0])).toEqual([
      ids.heroMain,
    ]);
  });

  it("reads a group the model named its own way, and says what it could not", () => {
    // The ask describes the groups as places and things while its shape names
    // them scenes and props, so an answer may come back under either's words.
    const report = applyJobResults(
      record("elements", [
        item({
          id: "elements",
          target: { kind: "elements" },
          capability: "text",
          text: JSON.stringify({
            characters: [
              {
                name: "林",
                description: "四十岁上下，深色大衣。",
                chapters: [1],
              },
            ],
            places: [
              { name: "荒站台", description: "雨里没有灯。", chapters: [1] },
            ],
            things: [{ name: "宫灯", description: "纸罩上落着灰。" }],
            moods: [{ name: "湿冷", description: "雨水的气味。" }],
          }),
        }),
      ]),
    );

    const byName = new Map(
      story().elements.map((each) => [each.name, each.kind]),
    );
    expect(byName.get("荒站台")).toBe("scene");
    expect(byName.get("宫灯")).toBe("prop");
    // What no group was read from is said at the moment the answer is read in:
    // it is the one loss the document cannot show by being wrong.
    expect(report.notes.join()).toContain("moods");
  });

  it("writes a board onto the episode its piece was for", () => {
    const report = applyJobResults(
      record("storyboard", [
        item({
          id: `storyboard:${ids.chapterSecond}`,
          target: { kind: "storyboard", chapterId: ids.chapterSecond },
          capability: "text",
          text: JSON.stringify({
            acts: [
              {
                title: "第 1 幕 车厢",
                summary: "车厢比站台更暗。",
                characters: ["周"],
                scene: "末班车车厢",
                props: [],
                sound: { music: "", sfx: "车轮声" },
                keyframes: [
                  {
                    shotSize: "close",
                    cameraMove: "pushIn",
                    angle: "eyeLevel",
                    content: "周抬起头。",
                    durationMs: 2000,
                    dialogue: [],
                  },
                ],
              },
            ],
          }),
        }),
      ]),
    );

    expect(report.applied).toBe(1);
    const chapter = story().chapters.find(
      (each) => each.id === ids.chapterSecond,
    );
    expect(chapter?.acts).toHaveLength(1);
    expect(chapter?.acts[0].characterIds).toEqual([ids.partner]);
    expect(chapter?.acts[0].sound.sfx).toBe("车轮声");
    expect(chapter?.acts[0].keyframes[0].content).toBe("周抬起头。");
  });

  it("files a clip where its act is, writing nothing down on the reader's behalf", () => {
    const report = applyJobResults(
      record("actVideo", [
        item({
          id: `actVideo:${ids.chapterFirst}:${ids.act}`,
          target: {
            kind: "actVideo",
            chapterId: ids.chapterFirst,
            actId: ids.act,
          },
          capability: "video",
          assetIds: ["asset-new-act"],
        }),
      ]),
    );

    expect(report.applied).toBe(1);
    const act = story().chapters[0].acts[0];
    expect(act.video.takes.map((take) => take.assetIds[0])).toEqual([
      ids.actVideo,
      "asset-new-act",
    ]);
    // Nothing about the filing is the reader's word: a batch writes its
    // answers down and nothing else.
    expect(act.video.takes).toHaveLength(2);
  });

  it("files a voice and a score in the two places an act keeps them", () => {
    const report = applyJobResults(
      record("voice", [
        item({
          id: `actVoice:${ids.chapterFirst}:${ids.act}`,
          target: {
            kind: "voice",
            chapterId: ids.chapterFirst,
            actId: ids.act,
          },
          capability: "speech",
          assetIds: ["asset-new-voice"],
        }),
      ]),
    );
    applyJobResults(
      record("music", [
        item({
          id: `actMusic:${ids.chapterFirst}:${ids.act}`,
          target: {
            kind: "music",
            chapterId: ids.chapterFirst,
            actId: ids.act,
          },
          capability: "music",
          assetIds: ["asset-new-music"],
        }),
      ]),
    );

    expect(report.applied).toBe(1);
    const act = story().chapters[0].acts[0];
    // Both slots were absent before the answers; an answer makes the place
    // rather than being dropped for want of one.
    expect(act.voice?.takes.map((take) => take.assetIds[0])).toEqual([
      "asset-new-voice",
    ]);
    expect(act.music?.takes.map((take) => take.assetIds[0])).toEqual([
      "asset-new-music",
    ]);
    // Both places hold what came back and nothing else.
    expect(act.voice?.takes).toHaveLength(1);
    expect(act.music?.takes).toHaveLength(1);
  });
});

describe("what applying an answer twice does", () => {
  it("writes nothing the second time, and pushes nothing onto the history", () => {
    const held = record("keyframeArt", [
      keyframeItem(ids.frameSecond, "asset-new-frame"),
    ]);
    applyJobResults(held);
    const afterFirst = useHistoryStore.getState().undoStack.length;

    const again = applyJobResults(held);

    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(1);
    expect(useHistoryStore.getState().undoStack.length).toBe(afterFirst);
  });

  it("writes nothing for a batch whose pieces are all already written", () => {
    // The fixture already keeps this drawing at this place.
    const report = applyJobResults(
      record("keyframeArt", [keyframeItem(ids.frameFirst, ids.frameArt)]),
    );
    expect(report.applied).toBe(0);
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it("writes nothing for a telling whose chapters are already the story's", () => {
    // The same answer, read into the story a second time: the record is kept
    // and may be read again by a room opened tomorrow, so what it wrote the
    // first time is what it must notice the second.
    const held = record("outline", [
      item({
        id: "outline",
        target: { kind: "outline" },
        capability: "text",
        text: JSON.stringify({
          chapters: [
            { title: "第一章 站台", synopsis: "他在站台上等到天亮。" },
            { title: "第二章 车厢", synopsis: "车厢里没有别人。" },
          ],
        }),
      }),
    ]);
    const first = applyJobResults(held);
    const afterFirst = useHistoryStore.getState().undoStack.length;
    expect(first.applied).toBe(1);

    const again = applyJobResults(held);

    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(1);
    expect(useHistoryStore.getState().undoStack.length).toBe(afterFirst);
  });
});

describe("what applying does not write", () => {
  it("leaves the pieces that did not succeed alone", () => {
    const report = applyJobResults(
      record("keyframeArt", [
        keyframeItem(ids.frameFirst, "asset-one"),
        keyframeItem(ids.frameSecond, "asset-two", { status: "failed" }),
        item({
          id: "keyframe:three",
          target: {
            kind: "keyframeArt",
            chapterId: ids.chapterFirst,
            actId: ids.act,
            keyframeId: "frame-gone",
          },
          capability: "image",
          assetIds: ["asset-three"],
        }),
      ]),
    );

    expect(report.applied).toBe(1);
    expect(report.skipped).toBe(2);
    // The place that is no longer there is said out loud rather than dropped.
    expect(report.notes.join(" ")).toContain("frame-gone");
    const act = story().chapters[0].acts[0];
    expect(
      act.keyframes.find((each) => each.id === ids.frameSecond)?.art.takes,
    ).toEqual([]);
  });

  it("says a story it can no longer find is gone", () => {
    const report = applyJobResults({
      ...record("keyframeArt", [keyframeItem(ids.frameSecond, "asset-x")]),
      storyId: "story-gone",
    });
    expect(report.applied).toBe(0);
    expect(report.notes.join(" ")).toContain("gone");
  });

  it("keeps an answer it could not read, and says which piece it was", () => {
    const report = applyJobResults(
      record("outline", [
        item({
          id: "outline",
          target: { kind: "outline" },
          capability: "text",
          text: "I could not write this as json.",
        }),
      ]),
    );

    expect(report.applied).toBe(0);
    expect(report.notes.join(" ")).toContain("outline");
  });

  it("says so when the document refused the whole batch", () => {
    // A conflict waiting to be resolved is a document that will take nothing:
    // the answer is not in it, and the room is told apart from a batch that
    // simply had nothing new to write.
    useProjectStore.setState({ saveStatus: "conflicted" });
    const report = applyJobResults(
      record("keyframeArt", [keyframeItem(ids.frameSecond, "asset-late")]),
    );

    expect(report.refused).toBe(true);
    expect(report.applied).toBe(0);
    expect(
      story().chapters[0].acts[0].keyframes.find(
        (each) => each.id === ids.frameSecond,
      )?.art.takes,
    ).toEqual([]);
  });
});

describe("a manuscript written in parts", () => {
  /** One part of a manuscript, answered with the one chapter it is. */
  function part(number: number, title: string, synopsis: string): StoryJobItem {
    return item({
      id: `outline:${number}`,
      target: { kind: "outline" },
      capability: "text",
      text: JSON.stringify({ title, synopsis }),
    });
  }

  it("writes the parts as one table, in the order they were asked for", () => {
    const report = applyJobResults(
      record("outline", [
        part(1, "第一章 站台", "他在站台上等车。"),
        part(2, "第二章 车厢", "车厢里只有两个人。"),
        part(3, "第三章 天亮", "天亮了。"),
      ]),
    );

    expect(report.applied).toBe(3);
    expect(story().chapters.map((chapter) => chapter.title)).toEqual([
      "第一章 站台",
      "第二章 车厢",
      "第三章 天亮",
    ]);
    // One batch is one step back, however many parts it answered with.
    const entry = useHistoryStore.getState().takeUndo();
    expect(entry?.forwardCommands).toHaveLength(1);
  });

  it("leaves the places nobody answered for as they stood", () => {
    const held = record("outline", [
      part(2, "第二章 车厢", "车厢里只有两个人。"),
      item({
        id: "outline:3",
        target: { kind: "outline" },
        capability: "text",
        status: "failed",
      }),
    ]);
    const report = applyJobResults(held);

    expect(report.applied).toBe(1);
    expect(report.skipped).toBe(1);
    // The second part landed in the second place, and the first chapter — the
    // one the fixture already told — is still the first chapter.
    expect(story().chapters[0].title).toBe("第一章 站台");
    expect(story().chapters[1].title).toBe("第二章 车厢");
  });

  it("adds the chapters a telling has not reached yet rather than leaving holes", () => {
    const report = applyJobResults(
      record("outline", [
        part(4, "第四章 雨", "雨一直下到天亮。"),
        part(5, "第五章 天亮", "天亮了。"),
      ]),
    );

    expect(report.applied).toBe(2);
    const chapters = story().chapters;
    expect(chapters).toHaveLength(4);
    expect(chapters.every((chapter) => chapter.title !== "")).toBe(true);
    expect(chapters[2].title).toBe("第四章 雨");
    expect(chapters[3].title).toBe("第五章 天亮");
  });
});

describe("undoing a batch", () => {
  it("takes back the whole batch as one step", () => {
    applyJobResults(
      record("keyframeArt", [
        keyframeItem(ids.frameFirst, "asset-one"),
        keyframeItem(ids.frameSecond, "asset-two"),
      ]),
    );

    const entry = useHistoryStore.getState().takeUndo();
    expect(entry?.forwardCommands).toHaveLength(2);
    expect(entry?.label).toContain("File");
  });
});

/** The place a target names, for the tests that read one out of a record. */
export type { StoryTarget };
