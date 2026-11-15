import { describe, expect, it } from "vitest";

import type { StoryJobRecord, StoryJobStatus } from "../../../api/story";
import { busyPlaces, mergePlaces } from "./places";

function piece(
  at: number,
  status: StoryJobStatus,
): StoryJobRecord["items"][number] {
  return {
    id: `keyframe:chapter-1:act-1:frame-${at}`,
    target: {
      kind: "keyframeArt",
      chapterId: "chapter-1",
      actId: "act-1",
      keyframeId: `frame-${at}`,
    },
    capability: "image",
    prompt: `雨中的站台 ${at}`,
    inputs: [],
    params: {},
    status,
  };
}

function job(
  items: StoryJobRecord["items"],
  overrides: Partial<StoryJobRecord> = {},
): StoryJobRecord {
  return {
    id: "job-1",
    projectId: "project-1",
    storyId: "story-1",
    kind: "keyframeArt",
    status: "running",
    model: "a-painter",
    items,
    cancelRequested: false,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

describe("what a place is doing just now", () => {
  it("tells the one holding a slot from those waiting for one", () => {
    const places = busyPlaces([
      job([piece(1, "running"), piece(2, "queued"), piece(3, "queued")]),
    ]);

    expect(places.get("keyframe:chapter-1:act-1:frame-1")).toEqual({
      state: "running",
    });
    expect(places.get("keyframe:chapter-1:act-1:frame-2")).toEqual({
      state: "queued",
      at: 1,
      of: 2,
    });
    expect(places.get("keyframe:chapter-1:act-1:frame-3")).toEqual({
      state: "queued",
      at: 2,
      of: 2,
    });
  });

  it("counts the line afresh as the pieces ahead start", () => {
    const places = busyPlaces([
      job([
        piece(1, "succeeded"),
        piece(2, "running"),
        piece(3, "queued"),
        piece(4, "queued"),
      ]),
    ]);

    expect(places.has("keyframe:chapter-1:act-1:frame-1")).toBe(false);
    expect(places.get("keyframe:chapter-1:act-1:frame-3")).toEqual({
      state: "queued",
      at: 1,
      of: 2,
    });
  });

  it("leaves a settled batch's places alone", () => {
    const places = busyPlaces([
      job([piece(1, "queued")], { status: "succeeded" }),
    ]);
    expect(places.size).toBe(0);
  });
});

describe("one place made by several pieces", () => {
  it("is being made as soon as any piece holds a slot", () => {
    expect(
      mergePlaces([
        { state: "queued", at: 2, of: 5 },
        { state: "running" },
        undefined,
      ]),
    ).toEqual({ state: "running" });
  });

  it("waits in the earliest line otherwise, and says nothing when idle", () => {
    expect(
      mergePlaces([
        { state: "queued", at: 3, of: 5 },
        { state: "queued", at: 1, of: 4 },
      ]),
    ).toEqual({ state: "queued", at: 1, of: 4 });
    expect(mergePlaces([undefined, undefined])).toBeUndefined();
  });
});
