import { beforeEach, describe, expect, it } from "vitest";

import { applyCommands } from "../../shared/domain/commands";
import {
  buildEmptyStory,
  buildStoryMokaFile,
  storyIds,
} from "../../shared/domain/fixtures";
import type {
  CanvasDocument,
  MokaFile,
  StoryDocument,
  WorkflowNode,
} from "../../shared/domain";
import { useModelStore } from "../settings/modelStore";
import { planKeyframeArt, planOutline, planStoryboard } from "./jobs/plan";
import {
  canvasImportCounts,
  hasCanvasImport,
  planStoryCanvas,
} from "./importCanvas";

const ids = storyIds();

function fixture(): { moka: MokaFile; story: StoryDocument } {
  const moka = buildStoryMokaFile();
  const story = moka.stories?.[0];
  if (story === undefined) throw new Error("the fixture holds a story");
  return { moka, story };
}

function board(): {
  moka: MokaFile;
  story: StoryDocument;
  canvas: CanvasDocument;
} {
  const { moka, story } = fixture();
  return { moka, story, canvas: planStoryCanvas(story, moka, "雨夜列车") };
}

/** The card a title names, which the import gives one of. */
function card(canvas: CanvasDocument, title: string): WorkflowNode {
  const found = canvas.nodes.find((node) => node.title === title);
  if (found === undefined) {
    throw new Error(
      `no card “${title}” among ${canvas.nodes.map((node) => node.title).join(", ")}`,
    );
  }
  return found;
}

/** Whether two cards are joined the way the telling joins them. */
function joined(
  canvas: CanvasDocument,
  from: WorkflowNode,
  to: WorkflowNode,
  portId: string,
): boolean {
  return canvas.edges.some(
    (edge) =>
      edge.source.nodeId === from.id &&
      edge.target.nodeId === to.id &&
      edge.target.portId === portId,
  );
}

beforeEach(() => {
  useModelStore.setState({ view: null });
});

describe("the board a telling makes", () => {
  it("holds every piece the steps generated, naming the files already on the shelf", () => {
    const { canvas } = board();
    // The premise and both episodes, the act and its two shots.
    expect(card(canvas, "Premise").data).toMatchObject({
      content: "末班列车上，两个陌生人交换了各自要说的话。",
    });
    expect(card(canvas, "1. 第一章 站台").data).toMatchObject({
      content: "他在站台上等一班已经停运的列车。",
    });
    expect(card(canvas, "1.1 第 1 幕 空站台").data).toMatchObject({
      content: "站台上的灯一盏一盏亮起来。",
    });
    // The words of a shot are what it shows and what is said in it — written
    // without the backticks that mark a mention, which are the room's own.
    expect(card(canvas, "1.1.1").data).toMatchObject({
      content: "雨中的站台，林立在灯下。\n林：车已经停运了。（平静）",
    });
    expect(card(canvas, "2. 第二章 车厢")).toBeDefined();
    // The drawings and the clip are the shelf's own files, read through the
    // takes the story keeps, and never copies of them.
    const shelf = new Set([
      ...fixture().moka.resources.images.map((entry) => entry.id),
      ...fixture().moka.resources.videos.map((entry) => entry.id),
    ]);
    const held = canvas.nodes.flatMap((node) => {
      const assetId = (node.data as { assetId?: string }).assetId;
      return assetId === undefined ? [] : [assetId];
    });
    expect(held).toEqual(
      expect.arrayContaining([
        ids.heroMain,
        ids.heroSheet,
        ids.partnerMain,
        ids.sceneMain,
        ids.frameArt,
        ids.actVideo,
      ]),
    );
    for (const assetId of held) expect(shelf.has(assetId)).toBe(true);
    // A character drawn twice is one card each; an element never drawn is
    // described and nothing more.
    expect(card(canvas, "林")).toBeDefined();
    expect(card(canvas, "林 · main")).toBeDefined();
    expect(card(canvas, "林 · turn-around")).toBeDefined();
    expect(card(canvas, "周")).toBeDefined();
    expect(card(canvas, "1.1.1 · frame")).toBeDefined();
    expect(card(canvas, "1.1 · clip")).toBeDefined();
  });

  it("joins every card to what it was made from", () => {
    const { canvas } = board();
    const premise = card(canvas, "Premise");
    const chapter = card(canvas, "1. 第一章 站台");
    const act = card(canvas, "1.1 第 1 幕 空站台");
    const shot = card(canvas, "1.1.1");
    const frame = card(canvas, "1.1.1 · frame");
    const clip = card(canvas, "1.1 · clip");

    expect(joined(canvas, premise, chapter, "prompt")).toBe(true);
    expect(joined(canvas, chapter, act, "prompt")).toBe(true);
    expect(joined(canvas, act, shot, "prompt")).toBe(true);
    expect(joined(canvas, shot, frame, "prompt")).toBe(true);
    expect(joined(canvas, act, clip, "prompt")).toBe(true);
    // The frame was drawn from the picture its own words named, and the clip
    // starts from the frame — the wires an ask's own references make. A name
    // the words do not mention is not wired, however drawn it is.
    expect(joined(canvas, card(canvas, "林 · main"), frame, "images")).toBe(
      true,
    );
    expect(joined(canvas, card(canvas, "周 · main"), frame, "images")).toBe(
      false,
    );
    // The clip's ask travels with its pictures as references — no frame has
    // been given a shoot role — so the wire runs into the images port, the
    // same one a frame's own drawn-from pictures use.
    expect(joined(canvas, frame, clip, "images")).toBe(true);
    expect(joined(canvas, frame, clip, "firstFrame")).toBe(false);
    // A turn-around is drawn from the one picture of the character there is.
    expect(
      joined(
        canvas,
        card(canvas, "林 · main"),
        card(canvas, "林 · turn-around"),
        "images",
      ),
    ).toBe(true);
  });

  it("wires a clip the way the shoot role of its piece says its pictures travel", () => {
    const { moka, story } = fixture();
    story.chapters[0].acts[0].keyframes[0].filmRole = "firstFrame";
    const canvas = planStoryCanvas(story, moka, "雨夜列车");
    const frame = card(canvas, "1.1.1 · frame");
    const clip = card(canvas, "1.1 · clip");

    // A frame marked as a first frame opens a piece of its own, and the wire
    // runs into the port that role names rather than into the images port.
    expect(joined(canvas, frame, clip, "firstFrame")).toBe(true);
    expect(joined(canvas, frame, clip, "images")).toBe(false);
  });

  it("carries the ask each card was made with", () => {
    const { moka, story, canvas } = board();
    const asked = (node: WorkflowNode) =>
      (
        node.data as {
          generation?: {
            prompt: string;
            params: Record<string, unknown>;
            inputMode: string;
          };
        }
      ).generation;

    expect(asked(card(canvas, "Premise"))?.prompt).toBe(
      planOutline(story, { mode: "expand", chapters: 2 })[0]?.prompt,
    );
    // The standing instruction a written answer was asked under rides in the
    // parameters, where a text ask carries the framing of its answer.
    expect(asked(card(canvas, "Premise"))?.params.instructions).toBe(
      planOutline(story, { mode: "expand", chapters: 2 })[0]?.system,
    );
    expect(asked(card(canvas, "1. 第一章 站台"))?.prompt).toBe(
      planStoryboard(story, [ids.chapterFirst])[0]?.prompt,
    );
    const frame = card(canvas, "1.1.1 · frame");
    const frameAsk = planKeyframeArt(story, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ])[0];
    expect(asked(frame)?.params).toEqual(frameAsk?.params);
    // A card whose ask travelled with a picture says so where the ask names it,
    // rather than leaving the name as prose: the name the room wrote the
    // character with is the card its picture belongs to, and the ask is read
    // the way it is written — the pictures it names are the ones it sends.
    expect(asked(frame)?.inputMode).toBe("mentions");
    expect(asked(frame)?.prompt).toContain(
      `@[node:${card(canvas, "林 · main").id}]`,
    );
    expect(asked(frame)?.prompt).not.toContain("林 —");
    // The words the ask was written with are otherwise kept.
    expect(asked(frame)?.prompt).toContain("雨中的站台");
    // A card of words that nothing was asked for carries no ask at all.
    expect(asked(card(canvas, "1.1.1"))).toBeUndefined();
    // An ask that named nothing it travelled with is asked from the wiring.
    expect(asked(card(canvas, "1.1 · clip"))?.inputMode).toBe("upstream");
    expect(moka.stories?.[0]).toBe(story);
  });

  it("writes the picture an ask was drawn from into its prompt by name", () => {
    const { canvas } = board();
    const asked = (title: string) =>
      (
        card(canvas, title).data as {
          generation?: { prompt: string; inputMode: string };
        }
      ).generation;
    const drawn = card(canvas, "林 · main");

    // A turn-around asks for the character by their name and travels with the
    // one picture of them there is, so the name is that picture's card.
    expect(asked("林 · turn-around")?.inputMode).toBe("mentions");
    expect(asked("林 · turn-around")?.prompt).toContain(`@[node:${drawn.id}]`);
    // A main picture is drawn from its description alone, so its own name is
    // the ask's subject rather than a picture travelling with it.
    expect(asked("林 · main")?.inputMode).toBe("upstream");
    expect(asked("林 · main")?.prompt).toContain("林");
  });

  it("is a canvas the document takes as it stands", () => {
    const { moka, canvas } = board();
    const applied = applyCommands(moka, [{ type: "addCanvas", canvas }]);
    expect(applied.next.canvas).toHaveLength(moka.canvas.length + 1);
    // Cards that share a row never overlap, and neither do the rows.
    const boxes = canvas.nodes.map((node) => node.bounds);
    for (let one = 0; one < boxes.length; one += 1) {
      for (let other = one + 1; other < boxes.length; other += 1) {
        const a = boxes[one];
        const b = boxes[other];
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart).toBe(true);
      }
    }
    // The board also says where it wants to be looked at from: a point it
    // covers, held whole rather than magnified past its own size.
    const xs = boxes.flatMap((box) => [box.x, box.x + box.width]);
    const ys = boxes.flatMap((box) => [box.y, box.y + box.height]);
    expect(canvas.viewport.x).toBeGreaterThan(Math.min(...xs));
    expect(canvas.viewport.x).toBeLessThan(Math.max(...xs));
    expect(canvas.viewport.y).toBeGreaterThan(Math.min(...ys));
    expect(canvas.viewport.y).toBeLessThan(Math.max(...ys));
    expect(canvas.viewport.zoom).toBeLessThanOrEqual(1);
  });

  it("counts what there is to import, and says when there is nothing", () => {
    const { story } = fixture();
    expect(canvasImportCounts(story)).toEqual({
      chapters: 2,
      elements: 4,
      pictures: 5,
      clips: 1,
      sounds: 0,
    });
    expect(hasCanvasImport(story)).toBe(true);
    const empty = buildEmptyStory();
    expect(hasCanvasImport(empty.stories![0])).toBe(false);
    expect(planStoryCanvas(empty.stories![0], empty, "新的故事").nodes).toEqual(
      [],
    );
  });
});

/** A recording on the shelf, as the project measured it. */
function voice(id: string, durationMs: number) {
  return {
    id,
    name: `${id}.mp3`,
    path: `assets/voice/${id}.mp3`,
    mime: "audio/mpeg",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    probe: {
      mime: "audio/mpeg",
      bytes: 2_048,
      sha256: "1".repeat(64),
      durationMs,
    },
  };
}

/**
 * The fixture's telling with both lines of its first shot read aloud, each in
 * its own voice and at its own length.
 */
function read(): { moka: MokaFile; story: StoryDocument } {
  const { moka, story } = fixture();
  moka.resources.voice = [voice("said-one", 900), voice("said-two", 1_100)];
  const frame = story.chapters[0]!.acts[0]!.keyframes[0]!;
  frame.dialogue = [
    {
      id: ids.lineFirst,
      characterId: ids.hero,
      speaker: "林",
      text: "车已经停运了。",
      tone: "平静",
    },
    { id: "line-2", speaker: "", text: "门也不开了。" },
  ];
  frame.voices = [
    {
      lineId: ids.lineFirst,
      text: "车已经停运了。",
      voice: "reader-1",
      slot: {
        takes: [
          {
            assetIds: ["said-one"],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    },
    {
      lineId: "line-2",
      text: "门也不开了。",
      voice: "reader-2",
      slot: {
        takes: [
          {
            assetIds: ["said-two"],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    },
  ];
  return { moka, story };
}

describe("a telling whose lines are read one by one", () => {
  it("is a card a line, each carrying the ask that read it", () => {
    const { moka, story } = read();
    const canvas = planStoryCanvas(story, moka, "雨夜列车");
    const act = card(canvas, "1.1 第 1 幕 空站台");
    const first = card(canvas, "1.1 · Line 1 · 林");
    const second = card(canvas, "1.1 · Line 2");
    const asked = (node: WorkflowNode) =>
      (node.data as {
        assetId?: string;
        audioCategory?: string;
        generation?: { prompt: string; params: Record<string, unknown> };
      }) ?? {};

    // The file of each reading, named rather than copied, and filed as a voice.
    expect(asked(first).assetId).toBe("said-one");
    expect(asked(second).assetId).toBe("said-two");
    expect(asked(first).audioCategory).toBe("voice");
    // The ask each card carries is the one line it read, and the tone that
    // line is said in rides in the instructions rather than in the words.
    expect(asked(first).generation?.prompt).toContain("车已经停运了。");
    expect(asked(first).generation?.prompt).not.toContain("门也不开了。");
    expect(String(asked(first).generation?.params.instructions)).toContain(
      "平静",
    );
    expect(asked(second).generation?.prompt).toContain("门也不开了。");
    // Both cards are the act's own, wired the way every card of the board is.
    expect(joined(canvas, act, first, "prompt")).toBe(true);
    expect(joined(canvas, act, second, "prompt")).toBe(true);
    // And the whole act's reading is not a card: what the act sounds like is
    // its lines, so a card for the older reading would be a lie.
    expect(canvas.nodes.some((node) => node.title === "1.1 · voice-over")).toBe(
      false,
    );
  });

  it("counts a reading a card, and keeps the older whole-act reading when it is all there is", () => {
    const { story } = read();
    expect(canvasImportCounts(story).sounds).toBe(2);

    // The same act with no line read: the older reading of the whole act is
    // what the board holds, and it is one card exactly as it always was.
    const whole = fixture();
    whole.moka.resources.voice = [voice("said-whole", 4_000)];
    const act = whole.story.chapters[0]!.acts[0]!;
    act.voice = {
      takes: [{ assetIds: ["said-whole"], createdAt: "2026-01-01T00:00:00Z" }],
    };
    const canvas = planStoryCanvas(whole.story, whole.moka, "雨夜列车");
    expect(canvasImportCounts(whole.story).sounds).toBe(1);
    const carded = card(canvas, "1.1 · voice-over");
    expect((carded.data as { assetId?: string }).assetId).toBe("said-whole");
    expect(
      (carded.data as { generation?: { prompt: string } }).generation?.prompt,
    ).toContain("车已经停运了。");
  });
});
