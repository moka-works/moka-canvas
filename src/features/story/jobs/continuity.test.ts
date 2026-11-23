import { describe, expect, it } from "vitest";

import type { StoryJobItem } from "../../../api/story";
import { buildStoryMokaFile } from "../../../shared/domain/fixtures";
import { chapterRevision } from "../../../shared/domain/story";
import {
  applyContinuity,
  continuityIsStale,
  readContinuityAnswer,
} from "./continuity";
import { continuityFingerprint } from "./plan";

const story = buildStoryMokaFile().stories![0]!;
const chapter = story.chapters[0]!;
const act = chapter.acts[0]!;
const first = act.keyframes[0]!;

function item(text: unknown, stamp?: string): StoryJobItem {
  return {
    id:
      stamp ??
      `continuity:${chapter.id}:${chapterRevision(chapter)}:${continuityFingerprint(chapter)}`,
    target: { kind: "continuity", chapterId: chapter.id },
    capability: "text",
    prompt: "",
    inputs: [],
    params: {},
    status: "succeeded",
    text: JSON.stringify(text),
  };
}

function patches(...entries: unknown[]) {
  return { summary: "Two people kept their sides.", patches: entries };
}

describe("reading a staging check", () => {
  it("reads a patch that names a shot and changes its framing", () => {
    const read = readContinuityAnswer(
      item(
        patches({
          actId: act.id,
          keyframeId: first.id,
          content: "`林` stands left of the door.",
          shotSize: "medium",
        }),
      ),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.summary).toBe("Two people kept their sides.");
    expect(read.patches[0]?.content).toBe("`林` stands left of the door.");
    expect(read.patches[0]?.shotSize).toBe("medium");
  });

  it("lets a check come back with nothing to change", () => {
    const read = readContinuityAnswer(item(patches()));
    expect(read).toEqual({
      ok: true,
      summary: "Two people kept their sides.",
      patches: [],
    });
  });

  it("refuses a patch for a shot it cannot name", () => {
    const read = readContinuityAnswer(
      item(patches({ actId: act.id, cameraMove: "pushIn" })),
    );
    expect(read.ok).toBe(false);
  });

  it("refuses a patch that tries to change the story", () => {
    const read = readContinuityAnswer(
      item(
        patches({
          actId: act.id,
          keyframeId: first.id,
          dialogue: [],
        }),
      ),
    );
    expect(read.ok).toBe(false);
  });

  it("refuses a framing nobody offered", () => {
    const read = readContinuityAnswer(
      item(
        patches({
          actId: act.id,
          keyframeId: first.id,
          shotSize: "imax",
        }),
      ),
    );
    expect(read.ok).toBe(false);
  });
});

describe("applying a staging check", () => {
  it("writes the patched fields and leaves the rest of the board alone", () => {
    const applied = applyContinuity(
      story,
      chapter,
      item(
        patches({
          actId: act.id,
          keyframeId: first.id,
          content: "`林` stands left of the door.",
          motion: "He turns toward the window.",
        }),
      ),
    );

    expect(applied.changed).toBe(1);
    const command = applied.commands[0];
    if (command?.type !== "setStoryActs") throw new Error("a board write");
    const written = command.acts[0]!.keyframes[0]!;
    expect(written.content).toBe("`林` stands left of the door.");
    expect(written.motion).toBe("He turns toward the window.");
    expect(written.dialogue).toEqual(first.dialogue);
    expect(written.art).toEqual(first.art);
  });

  it("writes nothing for a check that found nothing", () => {
    const applied = applyContinuity(story, chapter, item(patches()));
    expect(applied).toEqual({
      commands: [],
      changed: 0,
      summary: "Two people kept their sides.",
    });
  });

  it("refuses the whole answer when one patch names a missing shot", () => {
    const applied = applyContinuity(
      story,
      chapter,
      item(
        patches(
          {
            actId: act.id,
            keyframeId: first.id,
            content: "A still frame.",
          },
          { actId: act.id, keyframeId: "shot-gone", content: "Another." },
        ),
      ),
    );
    expect(applied.commands).toEqual([]);
    expect(applied.error).toContain("shot-gone");
  });

  it("refuses an answer written against a board that has moved on", () => {
    const stale = item(patches(), `continuity:${chapter.id}:1:stale`);
    expect(continuityIsStale(chapter, stale)).toBe(true);
    expect(applyContinuity(story, chapter, stale).stale).toBe(true);
  });
});
