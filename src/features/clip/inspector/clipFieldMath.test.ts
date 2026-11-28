import { describe, expect, it } from "vitest";
import {
  MAX_CLIPS_PER_COMMAND,
  type ClipAdjust,
  type TimelineClip,
} from "../../../shared/domain";
import type { TrimMaterial } from "../interactions/gestures";
import {
  adjustFromSlider,
  adjustIsUntouched,
  clampAdjust,
  clampFade,
  durationPatch,
  labelText,
  patchCommands,
  sharedValue,
  sliderFromAdjust,
  speedIsLocked,
  speedPatch,
  wholeNumberIn,
} from "./clipFieldMath";

const NOW = "2026-01-01T00:00:00.000Z";

/** A material clip holding the document's identity at whole milliseconds. */
function clip(patch: Partial<TimelineClip> = {}): TimelineClip {
  const base: TimelineClip = {
    id: "clip-1",
    trackId: "v1",
    kind: "video",
    label: "Piece",
    startMs: 1_000,
    durationMs: 4_000,
    inPointMs: 0,
    outPointMs: 4_000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const merged = { ...base, ...patch };
  return {
    ...merged,
    outPointMs:
      patch.outPointMs ??
      merged.inPointMs + Math.round(merged.durationMs * merged.speed),
  };
}

const MATERIAL: TrimMaterial = { ownClock: false, durationMs: 10_000 };
const OWN_CLOCK: TrimMaterial = { ownClock: true, durationMs: null };

describe("changing a clip's pace", () => {
  it("reads the same window at the new speed, over a shorter block", () => {
    expect(speedPatch(clip(), 2)).toEqual({ speed: 2, durationMs: 2_000 });
    expect(speedPatch(clip(), 0.5)).toEqual({ speed: 0.5, durationMs: 8_000 });
    expect(speedPatch(clip(), 1)).toEqual({ speed: 1, durationMs: 4_000 });
  });

  it("works the two ends of the speed range", () => {
    const long = clip({ durationMs: 8_000, outPointMs: 8_000 });
    expect(speedPatch(long, 4)).toEqual({ speed: 4, durationMs: 2_000 });
    expect(speedPatch(long, 0.25)).toEqual({ speed: 0.25, durationMs: 32_000 });
    // Outside the range is not a speed the document holds.
    expect(speedPatch(long, 0.1)).toBeNull();
    expect(speedPatch(long, 8)).toBeNull();
    expect(speedPatch(long, Number.NaN)).toBeNull();
  });

  it("keeps the window by the millisecond when the rounding costs one", () => {
    const odd = clip({
      inPointMs: 1_000,
      durationMs: 1_001,
      outPointMs: 2_001,
    });
    // 1001ms of material at 3× is 334ms on the timeline: the out point follows.
    expect(speedPatch(odd, 3)).toEqual({
      speed: 3,
      durationMs: 334,
      outPointMs: 2_002,
    });
  });

  it("refuses a speed that would leave a clip too short to be seen", () => {
    const short = clip({ durationMs: 200, outPointMs: 200 });
    // At the floor exactly: a hundred milliseconds is still a clip.
    expect(speedPatch(short, 2)).toEqual({ speed: 2, durationMs: 100 });
    expect(speedPatch(short, 4)).toBeNull();
  });

  it("keeps a still at its own pace: its window is its length", () => {
    expect(speedPatch(clip(), 2, true)).toBeNull();
    expect(speedPatch(clip(), 1, true)).toBeNull();
    expect(speedIsLocked(OWN_CLOCK)).toBe(true);
    expect(speedIsLocked(MATERIAL)).toBe(false);
  });
});

describe("typing a clip's length", () => {
  it("clamps the right edge between a whole frame and the material's end", () => {
    // The material ends at 10,000ms: the longest a 0-in clip runs is that,
    // and the window follows the duration the trim settled on.
    expect(durationPatch(clip(), 12_000, 30, MATERIAL)).toEqual({
      durationMs: 10_000,
      outPointMs: 10_000,
    });
    // A shorter request is honoured as typed, and the window shrinks with it.
    expect(durationPatch(clip(), 3_000, 30, MATERIAL)).toEqual({
      durationMs: 3_000,
      outPointMs: 3_000,
    });
    // Twenty milliseconds is below the frame floor, which the trim clamps.
    expect(durationPatch(clip(), 20, 30, MATERIAL)).toEqual({
      durationMs: 100,
      outPointMs: 100,
    });
  });

  it("reads the window from the duration for a picture, which has no run of its own", () => {
    expect(durationPatch(clip(), 6_000, 30, OWN_CLOCK)).toEqual({
      durationMs: 6_000,
      outPointMs: 6_000,
    });
  });

  it("clamps a material window that starts part-way into the file", () => {
    const held = clip({
      inPointMs: 9_500,
      durationMs: 500,
      outPointMs: 10_000,
    });
    // Only half a second of material is left after 9.5s, so a longer ask
    // leaves the clip exactly as it stands — no patch at all.
    expect(durationPatch(held, 4_000, 30, MATERIAL)).toEqual({});
    expect(durationPatch(held, 200, 30, MATERIAL)).toEqual({
      durationMs: 200,
      outPointMs: 9_700,
    });
  });
});

describe("what a set of clips agrees on", () => {
  it("answers the shared value, and null when they disagree", () => {
    expect(sharedValue([2, 2, 2])).toBe(2);
    expect(sharedValue([2, 2, 3])).toBeNull();
    expect(sharedValue([])).toBeNull();
    expect(sharedValue(["Clip one"])).toBe("Clip one");
  });

  it("reads whole numbers only inside the field's own range", () => {
    expect(wholeNumberIn(" 250 ", 0, 4_000)).toBe(250);
    expect(wholeNumberIn("0", 0, 4_000)).toBe(0);
    expect(wholeNumberIn("-5", 0, 4_000)).toBeNull();
    expect(wholeNumberIn("4 000", 0, 4_000)).toBeNull();
    expect(wholeNumberIn("2.5", 0, 4_000)).toBeNull();
    expect(wholeNumberIn("", 0, 4_000)).toBeNull();
    expect(wholeNumberIn("5000", 0, 4_000)).toBeNull();
  });
});

describe("fades, names and grades", () => {
  it("keeps the two fades inside the clip between them", () => {
    expect(clampFade(500, 4_000, 0)).toBe(500);
    expect(clampFade(5_000, 4_000, 0)).toBe(4_000);
    expect(clampFade(3_000, 4_000, 2_000)).toBe(2_000);
    expect(clampFade(-40, 4_000, 0)).toBe(0);
    expect(clampFade(Number.NaN, 4_000, 0)).toBe(0);
  });

  it("takes a name of a workable length and refuses the rest", () => {
    expect(labelText("  Opening shot  ")).toBe("Opening shot");
    expect(labelText("   ")).toBeNull();
    expect(labelText("x".repeat(81))).toBeNull();
  });

  it("reads a hundred-unit slider as the fraction a grade is stated in", () => {
    expect(adjustFromSlider(50)).toBe(0.5);
    expect(adjustFromSlider(-100)).toBe(-1);
    expect(adjustFromSlider(140)).toBe(1);
    expect(adjustFromSlider(Number.NaN)).toBe(0);
    expect(sliderFromAdjust(0.5)).toBe(50);
    expect(sliderFromAdjust(-2)).toBe(-100);
    expect(adjustFromSlider(sliderFromAdjust(-0.27))).toBe(-0.27);
  });

  it("clamps a grade to the range and reads an untouched one", () => {
    const wild: ClipAdjust = {
      brightness: 4,
      contrast: -3,
      saturation: Number.NaN,
      temperature: 2,
      tint: Number.NaN,
    };
    expect(clampAdjust(wild)).toEqual({
      brightness: 1,
      contrast: -1,
      saturation: 0,
      temperature: 1,
    });
    expect(
      adjustIsUntouched({ brightness: 0, contrast: 0, saturation: 0 }),
    ).toBe(true);
    expect(
      adjustIsUntouched({ brightness: 0.4, contrast: 0, saturation: 0 }),
    ).toBe(false);
    expect(
      adjustIsUntouched({
        brightness: 0,
        contrast: 0,
        saturation: 0,
        temperature: 0.3,
      }),
    ).toBe(false);
  });
});

describe("writing many clips at once", () => {
  it("splits a wide selection into the patches one command may hold", () => {
    const total = MAX_CLIPS_PER_COMMAND + 20;
    const patches = Array.from({ length: total }, (_, index) => ({
      clipId: `clip-${index}`,
      patch: { volume: 0.5 },
    }));
    const commands = patchCommands("timeline-1", patches);
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.type)).toEqual([
      "updateClips",
      "updateClips",
    ]);
    const sizes = commands.map((command) =>
      command.type === "updateClips" ? command.patches.length : 0,
    );
    expect(sizes).toEqual([MAX_CLIPS_PER_COMMAND, 20]);
  });
});
