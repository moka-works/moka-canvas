import { describe, expect, it } from "vitest";
import type { TimelineDocument } from "../../../shared/domain";
import {
  buildCutMokaFile,
  cutFixtureIds,
} from "../../../shared/domain/fixtures";
import {
  SNAP_THRESHOLD_PX,
  snapContext,
  snapExtremes,
  snapMs,
  snapThresholdMs,
} from "./snapping";

function cut(): TimelineDocument {
  return buildCutMokaFile().timelines![0];
}

/**
 * The fixture's edges: A 0–4,000, B 3,500–5,500 (pulled back into its seam),
 * C 0–8,000, and D 0–2,000 — with the playhead parked clear of them all.
 */
function videoContext(playheadMs = 9_000) {
  return snapContext(cut(), playheadMs, []);
}

describe("the snap threshold", () => {
  it("is eight pixels however tight the scale", () => {
    expect(snapThresholdMs(60)).toBeCloseTo(
      (SNAP_THRESHOLD_PX / 60) * 1_000,
      6,
    );
    // Pulling the view out makes the same eight pixels a longer moment: the
    // catch is a hand's width on screen, not a count of milliseconds.
    expect(snapThresholdMs(4)).toBe(2_000);
    expect(snapThresholdMs(240)).toBeCloseTo(1_000 / 30, 6);
    expect(snapThresholdMs(4)).toBeGreaterThan(snapThresholdMs(60));
  });
});

describe("what a gesture snaps against", () => {
  it("carries every edge but the dragged clips' own", () => {
    const ids = cutFixtureIds();
    const ctx = snapContext(cut(), 5_000, [ids.clipA]);
    // A's own tail is left out, while B still offers both of its edges.
    expect(ctx.playheadMs).toBe(5_000);
    expect(ctx.edges).toContain(3_500);
    expect(ctx.edges).toContain(5_500);
    expect(ctx.edges).not.toContain(4_000);
    expect(ctx.edges).toHaveLength(6);
  });
});

describe("catching an edge", () => {
  it("takes the nearest moment inside the threshold and nothing outside it", () => {
    const ctx = videoContext();
    // 4,000 is A's tail; at 60px/s the reach is 133ms.
    expect(snapMs(4_050, ctx, 60, true)).toBe(4_000);
    expect(snapMs(4_150, ctx, 60, true)).toBeNull();
    // A moment already carried stays where it is.
    expect(snapMs(4_000, ctx, 60, true)).toBe(4_000);
  });

  it("widens in milliseconds as the view is pulled out", () => {
    const ctx = videoContext();
    // 200ms away is out of reach at 60px/s and in reach at 4px/s.
    expect(snapMs(4_200, ctx, 60, true)).toBeNull();
    expect(snapMs(4_200, ctx, 4, true)).toBe(4_000);
  });

  it("gives the playhead the tie against a clip's edge", () => {
    // Halfway between the playhead and A's tail, neither is nearer: the clock
    // was put there deliberately, so the clock is the one that catches.
    const ctx = snapContext(cut(), 4_100, []);
    expect(snapMs(4_050, ctx, 60, true)).toBe(4_100);
    // And a point the edge is nearer to goes to the edge.
    expect(snapMs(4_040, ctx, 60, true)).toBe(4_000);
  });

  it("answers nothing at all when snapping is off", () => {
    const ctx = videoContext();
    expect(snapMs(4_050, ctx, 60, false)).toBeNull();
    expect(snapExtremes([4_050, 8_000], ctx, 60, false)).toBeNull();
  });

  it("catches markers and the edges of the working range", () => {
    const timeline = cut();
    timeline.markers = [
      { id: "marker-1", atMs: 1_200, label: "Verse", color: "yellow" },
    ];
    timeline.inPointMs = 800;
    timeline.outPointMs = 7_500;
    const ctx = snapContext(timeline, 0, []);
    expect(ctx.edges).toContain(1_200);
    expect(ctx.edges).toContain(800);
    expect(ctx.edges).toContain(7_500);
  });

  it("picks the nearer of two moving edges and moves the group by its catch", () => {
    const ctx = videoContext();
    // A block carried with edges at 3,960 and 6,000: its head is 40ms from
    // A's tail, while its own tail catches on nothing.
    expect(snapExtremes([3_960, 6_000], ctx, 60, true)).toEqual({
      deltaMs: 40,
      ms: 4_000,
    });
    // The tail's own catch, when the head is out of reach.
    expect(snapExtremes([5_000, 5_450], ctx, 60, true)).toEqual({
      deltaMs: 50,
      ms: 5_500,
    });
    // Each edge is 100ms from a catch: equally near, so the first listed wins.
    expect(snapExtremes([4_100, 5_600], ctx, 60, true)).toEqual({
      deltaMs: -100,
      ms: 4_000,
    });
  });
});
