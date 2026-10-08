// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import type { MokaFile } from "../../shared/domain";
import {
  buildStoryMokaFile,
  goldenNodeIds,
  storyIds,
  timelineIds,
} from "../../shared/domain/fixtures";
import { useClipStore } from "../clip/stores/clipStore";
import { useAppStore } from "../editor/stores/appStore";
import { EMPTY_SELECTION, useEditorStore } from "../editor/stores/editorStore";
import { useHistoryStore } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { useStoryStore } from "../story/stores/storyStore";
import { openNode, openUse } from "./goToHolder";
import { assetUses, type AssetUse } from "./usage";

function openProject(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-assets-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useAppStore.getState().setPhase("assets");
}

/** The one use a file has, for a test that means to follow it. */
function onlyUse(moka: MokaFile, assetId: string): AssetUse {
  const uses = assetUses(moka, assetId);
  if (uses.length !== 1) {
    throw new Error(`expected one use for ${assetId}, found ${uses.length}`);
  }
  return uses[0];
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useEditorStore.setState({
    selection: EMPTY_SELECTION,
    inspectedAssetId: null,
  });
  useAppStore.setState({ phase: "launcher", toasts: [] });
  useClipStore.setState({
    activeTimelineId: null,
    selection: { clipIds: [], transitionId: null },
    playheadMs: 0,
    playing: false,
  });
  useStoryStore.getState().forget();
});

afterEach(cleanup);

describe("going to the thing that holds a file", () => {
  it("opens the board a card sits on and frames it", () => {
    const moka = buildStoryMokaFile();
    openProject(moka);

    openUse(onlyUse(moka, goldenNodeIds().assetImage));

    expect(useAppStore.getState().phase).toBe("editing");
    expect(useProjectStore.getState().activeCanvasId).toBe(
      goldenNodeIds().canvasMain,
    );
    expect(useEditorStore.getState().selection.nodeIds).toEqual([
      goldenNodeIds().image,
    ]);
  });

  it("opens a cut on the clip, the playhead at its head", () => {
    const moka = buildStoryMokaFile();
    openProject(moka);
    useClipStore.getState().setPlayhead(5_000);

    openUse(onlyUse(moka, timelineIds().videoAsset));

    const clip = useClipStore.getState();
    expect(useAppStore.getState().phase).toBe("clip");
    expect(clip.activeTimelineId).toBe(timelineIds().timeline);
    expect(clip.selection.clipIds).toEqual([timelineIds().videoClip]);
    expect(clip.playheadMs).toBe(0);
  });

  it("opens a story on the step that shows the place, its episode in hand", () => {
    const moka = buildStoryMokaFile();
    openProject(moka);

    openUse(onlyUse(moka, storyIds().frameArt));

    const story = useStoryStore.getState();
    expect(useAppStore.getState().phase).toBe("story");
    expect(story.storyId).toBe(storyIds().story);
    expect(story.step).toBe("storyboard");
    expect(story.openChapterId).toBe(storyIds().chapterFirst);
  });

  it("stands on the work the story has got to when the place's step is not open yet", () => {
    const moka = buildStoryMokaFile();
    // Nothing settled: the boarding is not a door yet, and a jump onto nothing
    // would be worse than landing where the work stands.
    moka.stories![0].confirmedSteps = [];
    openProject(moka);

    openUse(onlyUse(moka, storyIds().frameArt));

    expect(useStoryStore.getState().step).toBe("idea");
  });

  it("opens a story at the step its manuscript is read in", () => {
    const moka = buildStoryMokaFile();
    openProject(moka);

    openUse(onlyUse(moka, storyIds().source));

    expect(useAppStore.getState().phase).toBe("story");
    expect(useStoryStore.getState().storyId).toBe(storyIds().story);
    expect(useStoryStore.getState().step).toBe("idea");
  });

  it("opens a story on the cast step a voice's recording is written in", () => {
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
    openProject(moka);

    // The character's card is where the recording is picked.
    openUse(onlyUse(moka, "asset-hero-voice"));
    expect(useAppStore.getState().phase).toBe("story");
    expect(useStoryStore.getState().storyId).toBe(storyIds().story);
    expect(useStoryStore.getState().step).toBe("elements");

    // A narrator's lands on the same step, with no card to stand on.
    openUse(onlyUse(moka, "asset-narrator-voice"));
    expect(useStoryStore.getState().step).toBe("elements");
  });

  it("finds the card's board when the caller does not name it", () => {
    openProject(buildStoryMokaFile());

    openNode(undefined, goldenNodeIds().image);

    expect(useProjectStore.getState().activeCanvasId).toBe(
      goldenNodeIds().canvasMain,
    );
    expect(useAppStore.getState().phase).toBe("editing");
  });
});
