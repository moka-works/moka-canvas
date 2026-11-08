// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { buildStoryMokaFile } from "../../../shared/domain/fixtures";
import { actClipStale, shotClipStale } from "./staleClips";

const LATER = "2027-01-01T00:00:00.000Z";

function scene() {
  const story = buildStoryMokaFile().stories![0]!;
  const act = story.chapters[0]!.acts[0]!;
  return { story, act };
}

describe("a clip made before its frames changed", () => {
  it("says nothing while the frames are the ones it was filmed from", () => {
    const { act } = scene();
    expect(actClipStale(act)).toBe(false);
  });

  it("is stale once a frame it was filmed from has changed", () => {
    const { act } = scene();
    const frame = act.keyframes.find((held) => held.art.takes.length > 0)!;
    frame.art = {
      takes: [{ assetIds: ["asset-frame-new"], createdAt: LATER }],
    };
    expect(actClipStale(act)).toBe(true);
  });

  it("keeps a shot's own clip marked while it still plays", () => {
    const { act } = scene();
    const frame = act.keyframes[0]!;
    frame.video = {
      takes: [
        {
          assetIds: ["asset-shot-clip"],
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    };
    expect(shotClipStale(frame)).toBe(false);
    frame.art = {
      takes: [{ assetIds: ["asset-frame-new"], createdAt: LATER }],
    };
    expect(shotClipStale(frame)).toBe(true);
    // The clip is still on the place: stale is a mark, not a removal.
    expect(frame.video.takes).toHaveLength(1);
  });

  it("has nothing to say about a place with no clip", () => {
    const { act } = scene();
    act.video = { takes: [] };
    expect(actClipStale(act)).toBe(false);
    expect(shotClipStale(act.keyframes[1]!)).toBe(false);
  });
});
