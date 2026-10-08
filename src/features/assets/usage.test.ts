import { describe, expect, it } from "vitest";
import type { MokaFile, WorkflowNode } from "../../shared/domain";
import {
  buildGoldenMokaFile,
  buildStoryMokaFile,
  goldenNodeIds,
  storyIds,
  timelineIds,
} from "../../shared/domain/fixtures";
import { assetUses, groupUses } from "./usage";

/** The card on the golden board whose material a test moves about. */
function imageCard(moka: MokaFile): WorkflowNode {
  const ids = goldenNodeIds();
  const canvas = moka.canvas.find((held) => held.id === ids.canvasMain);
  const node = canvas?.nodes.find((held) => held.id === ids.image);
  if (!node) throw new Error("the golden board holds no image card");
  return node;
}

/**
 * The picture a story place keeps, which a card shows and a clip is cut from:
 * one file the whole project is built on, used in every room at once.
 */
function heldEverywhere(): MokaFile {
  const moka = buildStoryMokaFile();
  imageCard(moka).data = { assetId: storyIds().heroMain };
  const timeline = moka.timelines![0];
  timeline.clips.push({
    id: "clip-hero",
    trackId: timelineIds().videoTrack,
    kind: "video",
    label: "hero-main",
    assetId: storyIds().heroMain,
    startMs: 10_000,
    durationMs: 2_000,
    inPointMs: 0,
    outPointMs: 2_000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return moka;
}

describe("where a file is used", () => {
  it("names a card by its board and title", () => {
    const ids = goldenNodeIds();
    expect(assetUses(buildGoldenMokaFile(), ids.assetImage)).toEqual([
      {
        room: "canvas",
        holder: { kind: "node", canvasId: ids.canvasMain, nodeId: ids.image },
        title: "Canvas 1 · Reference image",
        blocking: false,
      },
    ]);
  });

  it("names a clip out of its own timeline and label", () => {
    const uses = assetUses(buildStoryMokaFile(), timelineIds().videoAsset);
    expect(uses).toEqual([
      {
        room: "clip",
        holder: {
          kind: "clip",
          timelineId: timelineIds().timeline,
          timelineName: "Timeline 1",
          clipId: timelineIds().videoClip,
          clipLabel: "opening.mp4",
        },
        title: "Timeline 1 · opening.mp4",
        blocking: true,
      },
    ]);
  });

  it("tells a place's working drawing from an old take", () => {
    const moka = buildStoryMokaFile();
    expect(assetUses(moka, storyIds().heroMain)).toEqual([
      {
        room: "story",
        holder: {
          kind: "drawingInUse",
          storyId: storyIds().story,
          storyName: "雨夜列车",
          target: {
            kind: "element",
            elementId: storyIds().hero,
            view: "main",
          },
        },
        title: "雨夜列车 · 林 · Main picture",
        blocking: true,
      },
    ]);

    // A redraw the place keeps but is not using is an old take: worth a mark,
    // and a delete may let it go.
    const hero = moka.stories![0].elements.find(
      (element) => element.id === storyIds().hero,
    )!;
    hero.main.takes.push({
      assetIds: ["asset-hero-redrawn"],
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    expect(assetUses(moka, storyIds().heroMain)).toEqual([
      {
        room: "story",
        holder: {
          kind: "drawing",
          storyId: storyIds().story,
          storyName: "雨夜列车",
          target: {
            kind: "element",
            elementId: storyIds().hero,
            view: "main",
          },
        },
        title: "雨夜列车 · 林 · Main picture",
        blocking: false,
        oldDrawing: true,
      },
    ]);
  });

  it("names the manuscript as the story's own", () => {
    expect(assetUses(buildStoryMokaFile(), storyIds().source)).toEqual([
      {
        room: "story",
        holder: {
          kind: "storyFile",
          storyId: storyIds().story,
          storyName: "雨夜列车",
          what: "manuscript",
        },
        title: "雨夜列车 · manuscript",
        blocking: true,
      },
    ]);
  });

  it("names the voice wearing a recording, character and narrator alike", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0];
    story.narrator = {
      model: "",
      voice: "",
      referenceAssetId: "asset-narrator-voice",
    };
    story.elements.find((element) => element.id === storyIds().hero)!.voice = {
      model: "",
      voice: "",
      referenceAssetId: "asset-hero-voice",
    };
    expect(assetUses(moka, "asset-hero-voice")).toEqual([
      {
        room: "story",
        holder: {
          kind: "voiceReference",
          storyId: storyIds().story,
          storyName: "雨夜列车",
          elementId: storyIds().hero,
        },
        title: "雨夜列车 · 林",
        blocking: false,
      },
    ]);
    expect(assetUses(moka, "asset-narrator-voice")).toEqual([
      {
        room: "story",
        holder: {
          kind: "voiceReference",
          storyId: storyIds().story,
          storyName: "雨夜列车",
        },
        title: "雨夜列车 · the narrator",
        blocking: false,
      },
    ]);
  });

  it("gathers a file's uses under their rooms, boards first", () => {
    const uses = assetUses(heldEverywhere(), storyIds().heroMain);
    expect(uses.map((use) => use.room)).toEqual(["canvas", "clip", "story"]);
    expect(groupUses(uses).map((group) => group.room)).toEqual([
      "canvas",
      "clip",
      "story",
    ]);
    expect(groupUses(uses)[1].uses.map((use) => use.title)).toEqual([
      "Timeline 1 · hero-main",
    ]);
  });

  it("reads a file nothing points at as used nowhere", () => {
    expect(assetUses(buildGoldenMokaFile(), "asset-nobody")).toEqual([]);
    expect(groupUses([])).toEqual([]);
  });
});
