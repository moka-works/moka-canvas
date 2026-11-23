import { describe, expect, it } from "vitest";

import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { targetKey } from "../../../shared/domain/story";
import { planStaleRedraw } from "./stalePlan";

const ids = storyIds();
const LATER = "2027-01-01T00:00:00Z";

describe("planning what is out of date", () => {
  it("finds a frame drawn before an element it stands on changed", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const hero = story.elements.find((element) => element.id === ids.hero)!;
    const turnaround = hero.turnaround;
    if (turnaround === undefined) throw new Error("the hero has a sheet");
    // A character's frames stand on the turnaround when it has one.
    turnaround.takes = [
      ...turnaround.takes,
      { assetIds: [ids.heroSheet], createdAt: LATER },
    ];

    const plan = planStaleRedraw(story, new Set());

    expect(plan.frames.length).toBeGreaterThan(0);
    expect(plan.frames[0]?.elements).toContain(ids.hero);
  });

  it("finds a clip filmed before its frame was drawn again", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const act = story.chapters[0]!.acts[0]!;
    const frame = act.keyframes[0]!;
    // Every shot of the act must stand for its whole clip to be refilmed.
    act.keyframes[1]!.art = {
      takes: [
        { assetIds: [ids.frameArt], createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    };
    frame.art = {
      takes: [
        ...frame.art.takes,
        { assetIds: [ids.frameArt], createdAt: LATER },
      ],
    };

    const plan = planStaleRedraw(story, new Set());

    expect(plan.clips).toContainEqual({
      chapterId: story.chapters[0]!.id,
      actId: act.id,
    });
  });

  it("leaves a place already being made out of the plan", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const act = story.chapters[0]!.acts[0]!;
    const frame = act.keyframes[0]!;
    act.keyframes[1]!.art = {
      takes: [
        { assetIds: [ids.frameArt], createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    };
    frame.art = {
      takes: [
        ...frame.art.takes,
        { assetIds: [ids.frameArt], createdAt: LATER },
      ],
    };
    const busy = new Set([
      targetKey({
        kind: "actVideo",
        chapterId: story.chapters[0]!.id,
        actId: act.id,
      }),
    ]);

    const plan = planStaleRedraw(story, busy);

    expect(plan.clips).toEqual([]);
  });

  it("has nothing to plan for a board the telling has not moved past", () => {
    const story = buildStoryMokaFile().stories![0]!;
    expect(planStaleRedraw(story, new Set())).toEqual({
      frames: [],
      clips: [],
    });
  });
});
