// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { MokaFile, WorkflowNode } from "../../../shared/domain";
import {
  buildGoldenMokaFile,
  buildStoryMokaFile,
  goldenNodeIds,
  storyIds,
  timelineIds,
} from "../../../shared/domain/fixtures";
import { useClipStore } from "../../clip/stores/clipStore";
import { useAppStore } from "../../editor/stores/appStore";
import {
  EMPTY_SELECTION,
  useEditorStore,
} from "../../editor/stores/editorStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useStoryStore } from "../../story/stores/storyStore";
import { useAssetsStore } from "../stores/assetsStore";
import { AssetsStage } from "./AssetsStage";

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

/** The stage with a project open and a file chosen on it. */
function show(moka: MokaFile, assetId: string) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-assets-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useAssetsStore.getState().select(assetId);
  render(<AssetsStage />);
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useEditorStore.setState({
    selection: EMPTY_SELECTION,
    previewAssetId: null,
    assetDeletePrompt: null,
    inspectedAssetId: null,
  });
  useAppStore.setState({ phase: "assets", toasts: [] });
  useClipStore.setState({
    activeTimelineId: null,
    selection: { clipIds: [], transitionId: null },
    playheadMs: 0,
    playing: false,
  });
  useStoryStore.getState().forget();
  useAssetsStore.setState({
    inspectedAssetId: null,
    view: "all",
    kind: "image",
  });
});

afterEach(cleanup);

describe("the file on the stage", () => {
  it("says every place the file is used, room by room", () => {
    show(heldEverywhere(), storyIds().heroMain);

    expect(screen.getByTestId("assets-stage-file")).toBeTruthy();
    expect(
      within(screen.getByTestId("assets-uses-canvas")).getByText(
        "Canvas 1 · Reference image",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("assets-uses-clip")).getByText(
        "Timeline 1 · hero-main",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("assets-uses-story")).getByText(
        "雨夜列车 · 林 · Main picture",
      ),
    ).toBeTruthy();
  });

  it("takes the open on a use to the room it lives in", () => {
    show(heldEverywhere(), storyIds().heroMain);

    fireEvent.click(
      within(screen.getByTestId("assets-uses-clip")).getByRole("button", {
        name: "Open Timeline 1 · hero-main",
      }),
    );

    expect(useAppStore.getState().phase).toBe("clip");
    expect(useClipStore.getState().activeTimelineId).toBe(
      timelineIds().timeline,
    );
    expect(useClipStore.getState().selection.clipIds).toEqual(["clip-hero"]);
  });

  it("marks a place keeping the file as an old take", () => {
    const moka = buildStoryMokaFile();
    // The old take is the card's picture: a place keeps it, but a redraw is
    // the one it is using.
    imageCard(moka).data = { assetId: goldenNodeIds().assetImage };
    const prop = moka.stories![0].elements.find(
      (element) => element.id === storyIds().prop,
    )!;
    prop.main.takes.push(
      {
        assetIds: [goldenNodeIds().assetImage],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        assetIds: ["asset-prop-redrawn"],
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    );
    show(moka, goldenNodeIds().assetImage);

    expect(screen.getByTestId("assets-uses-story").textContent).toContain(
      "old take",
    );
  });

  it("asks before letting go of a file a card and an old take hold", () => {
    const moka = buildStoryMokaFile();
    imageCard(moka).data = { assetId: goldenNodeIds().assetImage };
    const prop = moka.stories![0].elements.find(
      (element) => element.id === storyIds().prop,
    )!;
    prop.main.takes.push(
      {
        assetIds: [goldenNodeIds().assetImage],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        assetIds: ["asset-prop-redrawn"],
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    );
    show(moka, goldenNodeIds().assetImage);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    const prompt = useEditorStore.getState().assetDeletePrompt;
    expect(prompt?.assetId).toBe(goldenNodeIds().assetImage);
    expect(prompt?.nodeIds).toEqual([goldenNodeIds().image]);
    expect(prompt?.drawings).toHaveLength(1);
  });

  it("reads a file nothing holds as used nowhere", () => {
    show(buildStoryMokaFile(), timelineIds().followerAsset);

    expect(screen.getByTestId("assets-uses-none")).toBeTruthy();
    expect(screen.queryByTestId("assets-uses-canvas")).toBeNull();
  });

  it("opens the picture on the stage into the full view", () => {
    show(buildGoldenMokaFile(), goldenNodeIds().assetImage);

    fireEvent.click(screen.getByTestId("asset-preview-image"));

    expect(useEditorStore.getState().previewAssetId).toBe(
      goldenNodeIds().assetImage,
    );
  });
});
