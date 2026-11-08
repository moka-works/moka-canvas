// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { staleFrames, staleReferences } from "./stalePictures";

const ids = storyIds();
const LATER = "2027-01-01T00:00:00.000Z";
const EARLIER = "2025-01-01T00:00:00.000Z";

function scene() {
  const story = buildStoryMokaFile().stories![0]!;
  const frame = story.chapters[0]!.acts[0]!.keyframes[0]!;
  const hero = story.elements.find((element) => element.id === ids.hero)!;
  return { story, frame, hero };
}

describe("a frame drawn before its references changed", () => {
  it("says nothing while the reference is the one the frame was drawn with", () => {
    const { story, frame } = scene();
    expect(staleReferences(story, frame)).toEqual([]);
  });

  it("names the references redrawn after the frame was", () => {
    const { story, frame, hero } = scene();
    hero.main = { takes: [{ assetIds: ["asset-hero-new"], createdAt: LATER }] };
    expect(staleReferences(story, frame).map((element) => element.id)).toEqual([
      ids.hero,
    ]);
  });

  it("is not stale when the picture changed before the frame was drawn", () => {
    const { story, frame, hero } = scene();
    hero.main = {
      takes: [{ assetIds: ["asset-hero-old"], createdAt: EARLIER }],
    };
    expect(staleReferences(story, frame)).toEqual([]);
  });

  it("has nothing to say about a shot nobody has drawn", () => {
    const { story, frame } = scene();
    frame.art = { takes: [] };
    const hero = story.elements.find((element) => element.id === ids.hero)!;
    hero.main = { takes: [{ assetIds: ["asset-hero-new"], createdAt: LATER }] };
    expect(staleReferences(story, frame)).toEqual([]);
  });

  it("leaves a frame already being drawn out of the batch", () => {
    const { story, frame } = scene();
    const hero = story.elements.find((element) => element.id === ids.hero)!;
    hero.main = { takes: [{ assetIds: ["asset-hero-new"], createdAt: LATER }] };
    expect(
      staleFrames(story, [frame], (keyframeId) => keyframeId === frame.id),
    ).toEqual([]);
    expect(staleFrames(story, [frame], () => false)).toEqual([frame]);
  });
});
