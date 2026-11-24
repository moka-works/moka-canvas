import { describe, expect, it } from "vitest";

import type {
  ResourceEntry,
  TimelineDocument,
  TimelineTrack,
} from "../../shared/domain";
import { createTimeline } from "../../shared/domain/factories";
import { presetById } from "./textStyles";
import { coverCommands } from "./cover";

const T0 = "2026-01-01T00:00:00.000Z";

const picture: ResourceEntry = {
  id: "asset-cover",
  name: "cover.png",
  path: "assets/images/cover.png",
  mime: "image/png",
  bytes: 2_048,
  createdAt: T0,
  updatedAt: T0,
  probe: {
    mime: "image/png",
    bytes: 2_048,
    sha256: "a".repeat(64),
    width: 1_920,
    height: 1_080,
  },
};

function track(kind: "video" | "text", id: string): TimelineTrack {
  return {
    id,
    kind,
    name: id,
    muted: false,
    hidden: false,
    locked: false,
    createdAt: T0,
  };
}

function cover(timeline: TimelineDocument, startMs = 0, withPicture = true) {
  return coverCommands(timeline, {
    startMs,
    title: "第 1 集 站台",
    label: "Cover · 第 1 集 站台",
    style: presetById("cover")!.style,
    ...(withPicture ? { resource: picture } : {}),
  });
}

describe("laying a cover on a cut", () => {
  it("puts the picture under the title and the title in the text row", () => {
    const timeline = createTimeline("Cover");
    const plan = cover(timeline);

    expect(plan.error).toBeUndefined();
    expect(plan.commands.map((command) => command.type)).toEqual([
      "addTrack",
      "addClips",
    ]);
    const [videoRow, clips] = plan.commands;
    if (videoRow?.type !== "addTrack" || clips?.type !== "addClips") {
      throw new Error("a cover is rows then clips");
    }
    // The picture's row is inserted before the text rows, so the preview draws
    // the words over it and the export burns them last.
    expect(videoRow.track.kind).toBe("video");
    expect(videoRow.index).toBe(
      timeline.tracks.findIndex((held) => held.kind === "text"),
    );
    const textRow = timeline.tracks.find((held) => held.kind === "text")!;
    const image = clips.clips.find((clip) => clip.assetId !== undefined)!;
    const text = clips.clips.find((clip) => clip.kind === "text")!;
    expect(image.trackId).toBe(videoRow.track.id);
    expect(image.assetId).toBe(picture.id);
    expect(image.durationMs).toBe(2_500);
    expect(text.trackId).toBe(textRow.id);
    expect(text.text?.content).toBe("第 1 集 站台");
    expect(text.text?.style).toEqual(presetById("cover")!.style);
    expect(text.label).toBe("Cover · 第 1 集 站台");
    expect(plan.textClipId).toBe(text.id);
  });

  it("adds a text row when the text row is taken at that time", () => {
    const timeline = createTimeline("Cover");
    const textRow = timeline.tracks.find((held) => held.kind === "text")!;
    timeline.clips.push({
      id: "existing-text",
      trackId: textRow.id,
      kind: "text",
      label: "words",
      startMs: 0,
      durationMs: 3_000,
      inPointMs: 0,
      outPointMs: 3_000,
      speed: 1,
      volume: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
      muted: false,
      opacity: 1,
      text: {
        content: "words",
        style: presetById("basic")!.style,
      },
      createdAt: T0,
      updatedAt: T0,
    });

    const plan = cover(timeline);

    expect(plan.commands.map((command) => command.type)).toEqual([
      "addTrack",
      "addTrack",
      "addClips",
    ]);
    const textTrack = plan.commands[1];
    if (textTrack?.type !== "addTrack") throw new Error("a text row");
    expect(textTrack.track.kind).toBe("text");
    expect(textTrack.index).toBeUndefined();
  });

  it("reuses an overlay row that already has room", () => {
    const timeline = createTimeline("Cover");
    const overlay = track("video", "overlay");
    timeline.tracks.splice(1, 0, overlay);

    const plan = cover(timeline);

    expect(plan.commands.every((command) => command.type === "addClips")).toBe(
      true,
    );
    const clips = plan.commands[0];
    if (clips?.type !== "addClips") throw new Error("clips");
    expect(clips.clips[0]?.trackId).toBe("overlay");
  });

  it("adds only words when the episode has no picture", () => {
    const timeline = createTimeline("Cover");
    const plan = cover(timeline, 0, false);

    expect(plan.commands).toHaveLength(1);
    const clips = plan.commands[0];
    if (clips?.type !== "addClips") throw new Error("clips");
    expect(clips.clips).toHaveLength(1);
    expect(clips.clips[0]?.kind).toBe("text");
  });

  it("refuses when the timeline has no row to give", () => {
    const timeline = createTimeline("Cover");
    while (timeline.tracks.length < 8) {
      timeline.tracks.push(track("video", `full-${timeline.tracks.length}`));
    }
    for (const held of timeline.tracks.filter((row) => row.kind === "video")) {
      timeline.clips.push({
        id: `clip-${held.id}`,
        trackId: held.id,
        kind: "video",
        label: "",
        startMs: 0,
        durationMs: 3_000,
        inPointMs: 0,
        outPointMs: 3_000,
        speed: 1,
        volume: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        muted: false,
        opacity: 1,
        assetId: "asset",
        createdAt: T0,
        updatedAt: T0,
      });
    }

    const plan = cover(timeline);

    expect(plan.error).toContain("no room");
    expect(plan.commands).toEqual([]);
    expect(plan.textClipId).toBe("");
  });
});
