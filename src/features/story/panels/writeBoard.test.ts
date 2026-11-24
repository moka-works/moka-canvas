import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentCommand, StoryAct } from "../../../shared/domain/types";
import { buildStoryMokaFile } from "../../../shared/domain/fixtures";
import { execute } from "../../editor/commands/execute";
import { mergeActsAt, splitAct } from "./writeBoard";

vi.mock("../../editor/commands/execute", () => ({
  execute: vi.fn(() => []),
}));

/** The acts one write of `writeActs` asked the document to keep. */
function writtenActs(): StoryAct[] {
  const call = vi.mocked(execute).mock.calls.at(-1);
  expect(call).toBeDefined();
  const commands = call![1] as DocumentCommand[];
  const command = commands[0];
  if (command?.type !== "setStoryActs") {
    throw new Error("the board was not written");
  }
  return command.acts;
}

function story() {
  return buildStoryMokaFile().stories![0]!;
}

beforeEach(() => {
  vi.mocked(execute).mockClear();
});

describe("cutting an act in two", () => {
  it("leaves the description with the first half, not written over both", () => {
    const held = story();
    const chapter = held.chapters[0]!;
    const act = chapter.acts[0]!;
    const summary = act.summary;
    expect(summary).not.toBe("");

    splitAct(held, chapter.id, act, 1);

    const [head, tail] = writtenActs();
    expect(head?.summary).toBe(summary);
    expect(tail?.summary).toBe("");
    // The cast and the sound still stand in both halves; only the words that
    // describe the act whole are kept from being said twice.
    expect(tail?.characterIds).toEqual(act.characterIds);
    expect(tail?.sound).toEqual(act.sound);
    // The second half says what it is, in the words its own name carries.
    expect(tail?.title).not.toBe(act.title);
    expect(tail?.title.startsWith(act.title)).toBe(true);
  });

  it("opens the second half on the first, and keeps the first's own mark", () => {
    const held = story();
    const chapter = held.chapters[0]!;
    const act = chapter.acts[0]!;
    act.continueFromPrevious = true;

    splitAct(held, chapter.id, act, 1);

    const [head, tail] = writtenActs();
    expect(head?.continueFromPrevious).toBe(true);
    expect(tail?.continueFromPrevious).toBe(true);
  });
});

describe("joining two acts", () => {
  it("keeps the joined act opening where the first of the two opened", () => {
    const held = story();
    const chapter = held.chapters[0]!;
    const act = chapter.acts[0]!;
    const below: StoryAct = {
      ...structuredClone(act),
      id: "act-below",
      continueFromPrevious: true,
      keyframes: [],
      video: { takes: [] },
    };
    chapter.acts = [act, below];

    mergeActsAt(held, chapter.id, 1);

    // The seam is gone, so the second act's mark has no meaning; the pair is
    // still a continuation only when the first act was one.
    expect(writtenActs()[0]?.continueFromPrevious).toBeUndefined();
  });

  it("says a description the two acts share only once", () => {
    const held = story();
    const chapter = held.chapters[0]!;
    const act = chapter.acts[0]!;
    const below: StoryAct = {
      ...structuredClone(act),
      id: "act-below",
      title: "第 2 幕",
      keyframes: [],
      video: { takes: [] },
    };
    chapter.acts = [act, below];

    mergeActsAt(held, chapter.id, 1);

    const [merged] = writtenActs();
    expect(merged?.summary).toBe(act.summary);
    expect(merged?.sound).toEqual(act.sound);
  });

  it("keeps both descriptions when the acts say different things", () => {
    const held = story();
    const chapter = held.chapters[0]!;
    const act = chapter.acts[0]!;
    const below: StoryAct = {
      ...structuredClone(act),
      id: "act-below",
      title: "第 2 幕",
      summary: "车门在身后合上。",
      sound: { music: "", sfx: "车门蜂鸣" },
      keyframes: [],
      video: { takes: [] },
    };
    chapter.acts = [act, below];

    mergeActsAt(held, chapter.id, 1);

    const [merged] = writtenActs();
    expect(merged?.summary).toBe(`${act.summary}\n\n车门在身后合上。`);
    expect(merged?.sound.music).toBe(act.sound.music);
    expect(merged?.sound.sfx).toBe(`${act.sound.sfx}\n\n车门蜂鸣`);
  });

  it("marries the two halves of a split back into the board it was", () => {
    const held = story();
    const chapter = held.chapters[0]!;
    const act = chapter.acts[0]!;
    const summary = act.summary;

    splitAct(held, chapter.id, act, 1);
    const halves = writtenActs();
    chapter.acts = halves;

    mergeActsAt(held, chapter.id, 1);

    const [merged] = writtenActs();
    expect(merged?.summary).toBe(summary);
    expect(merged?.sound).toEqual(act.sound);
    expect(merged?.keyframes.map((frame) => frame.id)).toEqual(
      act.keyframes.map((frame) => frame.id),
    );
  });
});
