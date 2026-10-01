import { describe, expect, it } from "vitest";
import { decodeMokaFile, encodeMokaFile } from "./codec";
import { buildEmptyStory, buildLongStory } from "./fixtures";
import type { MokaFile, StoryKeyframe } from "./types";
import { validateMokaFile } from "./validate";

/**
 * What a telling costs to hold, measured at the ceilings the room allows.
 *
 * The file is the whole of a project: every episode, act, shot, line and take
 * lives in one document that is read at open and written on every save, so the
 * largest telling the room will let a reader build is a budget and not a
 * curiosity. What is measured here is one round trip — bytes out, bytes back,
 * and the reading over the document that came back — since that is what a save
 * and the next open cost together.
 */

/** How long a reader will wait for one document to turn around. */
const BUDGET_MS = 1_200;
/** The plan's own idea of an extreme telling, and its size budget. */
const PLANNED_CHAPTERS = 60;
const PLANNED_ACTS = 8;
const PLANNED_SHOTS = 4;
const PLANNED_LINES = 12;
const PLANNED_MB = 4 * 1024 * 1024;
/** What one deployment will take by default (`max_moka_file_bytes`). */
const FILE_LIMIT = 33_554_432;

/** Every shot of a telling saying the same number of lines. */
function everyShotSays(moka: MokaFile, lines: number): MokaFile {
  for (const chapter of moka.stories?.[0]?.chapters ?? []) {
    for (const act of chapter.acts) {
      for (const keyframe of act.keyframes) {
        keyframe.dialogue = Array.from({ length: lines }, (_, at) => ({
          id: `${keyframe.id}-line-${at + 1}`,
          speaker: "阿澈",
          text: `第 ${at + 1} 句台词，说给夜里停下的这班车听。`,
        }));
      }
    }
  }
  return moka;
}

/** A telling of the shape the plan called extreme, which is not the ceiling. */
function plannedShape(): MokaFile {
  const moka = buildEmptyStory("按计划的形状");
  const story = moka.stories![0];
  const shot = (c: number, a: number, k: number): StoryKeyframe => ({
    id: `frame-${c}-${a}-${k}`,
    title: `#${k + 1}`,
    shotSize: "medium",
    cameraMove: "static",
    angle: "eyeLevel",
    content: "画面",
    dialogue: [],
    durationMs: 1_000,
    art: { takes: [] },
    video: { takes: [] },
  });
  story.chapters = Array.from({ length: PLANNED_CHAPTERS }, (_, c) => ({
    id: `chapter-${c}`,
    title: `第 ${c + 1} 章`,
    synopsis: "梗概",
    targetDurationMs: 60_000,
    acts: Array.from({ length: PLANNED_ACTS }, (_, a) => ({
      id: `act-${c}-${a}`,
      title: `第 ${a + 1} 幕`,
      summary: "内容",
      characterIds: [],
      propIds: [],
      sound: { music: "", sfx: "" },
      keyframes: Array.from({ length: PLANNED_SHOTS }, (_, k) => shot(c, a, k)),
      video: { takes: [] },
    })),
  }));
  return everyShotSays(moka, PLANNED_LINES);
}

/** One save: out to bytes, back, and the reading over what came home. */
function turnAround(moka: MokaFile): { bytes: number; issues: number } {
  const bytes = encodeMokaFile(moka);
  const back = decodeMokaFile(bytes);
  return { bytes: bytes.length, issues: validateMokaFile(back).length };
}

describe("a telling the room will let a reader build", () => {
  it("turns around in one file, within the sizes a deployment takes", () => {
    const moka = buildLongStory();
    // The suite runs its files side by side and a worker's first pass pays
    // the warm-up for the code it is first to reach, so one timing can be
    // starved by the company it keeps. The quickest of two passes is the
    // fairer reading of the cost; the budget is an outer bound, not a target.
    const passes = Array.from({ length: 2 }, () => {
      const started = performance.now();
      const measured = turnAround(moka);
      return { measured, took: performance.now() - started };
    });
    const quickest = passes.reduce((a, b) => (a.took <= b.took ? a : b));

    expect(quickest.measured.issues).toBe(0);
    expect(quickest.measured.bytes).toBeLessThan(FILE_LIMIT);
    expect(quickest.took).toBeLessThan(BUDGET_MS);
  });

  it("holds a plan-sized telling in the four megabytes it was budgeted", () => {
    const measured = turnAround(plannedShape());
    expect(measured.issues).toBe(0);
    expect(measured.bytes).toBeLessThan(PLANNED_MB);
  });
});
