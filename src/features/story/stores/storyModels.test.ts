// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentUiPrefs,
  defaultUiPrefs,
  replaceUiPrefs,
  resetUiPrefs,
} from "../../../shared/prefs/prefsData";
import type { UiPreferences } from "../../../shared/prefs/types";
import {
  askPlaceOfKind,
  storyAskModel,
  storyAskModelHead,
  storyAskModels,
  storyTargetModel,
  useStoryModels,
} from "./storyModels";

beforeEach(() => {
  resetUiPrefs();
  useStoryModels.setState({ choices: {} });
});

describe("the models a story room is set to", () => {
  it("keeps a list per kind of work, and hands it back", () => {
    useStoryModels.getState().choose("text", ["scribe-2", "scribe-3"]);
    useStoryModels.getState().choose("music", ["composer-1"]);

    expect(storyAskModels("outline")).toEqual(["scribe-2", "scribe-3"]);
    expect(storyAskModelHead("elements")).toBe("scribe-2");
    // A voice and a score are both audio work and are not the same choice.
    expect(storyAskModels("music")).toEqual(["composer-1"]);
    expect(storyAskModels("voice")).toEqual([]);
  });

  it("takes the asks of one place in turns through its list", () => {
    useStoryModels.getState().choose("text", ["scribe-2", "scribe-3"]);

    expect(storyAskModel("outline")).toBe("scribe-2");
    expect(storyAskModel("elements")).toBe("scribe-3");
    expect(storyAskModel("storyboard")).toBe("scribe-2");
  });

  it("keeps a standing target on one model and spreads the next target", () => {
    useStoryModels.getState().choose("image", ["paint-1", "paint-2"]);

    // A frame is planned, re-planned and retried; all of it must read the one
    // model the frame was handed.
    expect(storyTargetModel("keyframeArt", "frame-1")).toBe("paint-1");
    expect(storyTargetModel("keyframeArt", "frame-1")).toBe("paint-1");
    expect(storyTargetModel("keyframeArt", "frame-2")).toBe("paint-2");
    expect(storyTargetModel("keyframeArt", "frame-3")).toBe("paint-1");
  });

  it("starts the turns over when the list changes", () => {
    useStoryModels.getState().choose("image", ["paint-1", "paint-2"]);
    expect(storyTargetModel("keyframeArt", "frame-1")).toBe("paint-1");

    useStoryModels.getState().choose("image", ["paint-2", "paint-1"]);
    expect(storyTargetModel("keyframeArt", "frame-1")).toBe("paint-2");
  });

  it("clears a choice back to the deployment's default", () => {
    useStoryModels.getState().choose("image", ["painter-1"]);
    expect(storyAskModelHead("keyframeArt")).toBe("painter-1");

    useStoryModels.getState().choose("image", []);
    expect(storyAskModel("keyframeArt")).toBeNull();
    expect(storyTargetModel("keyframeArt", "frame-1")).toBeNull();
    // Nothing left behind for the next reader of this machine.
    expect(currentUiPrefs().storyModels).toEqual({});
  });

  it("drops empty and repeated references rather than rotating over them", () => {
    useStoryModels
      .getState()
      .choose("text", ["scribe-2", "", "scribe-2", "scribe-3"]);

    expect(storyAskModels("outline")).toEqual(["scribe-2", "scribe-3"]);
    expect(currentUiPrefs().storyModels).toEqual({
      text: ["scribe-2", "scribe-3"],
    });
  });

  it("reads back what the machine kept, and only what is a model", async () => {
    replaceUiPrefs({
      ...defaultUiPrefs(),
      storyModels: {
        text: "scribe-2",
        nonsense: "x",
        image: 7,
        music: "",
      },
    } as unknown as UiPreferences);
    vi.resetModules();

    // A file written before places kept several models names one reference per
    // place as a string, and that is read as the one-model list it meant.
    const fresh = await import("./storyModels");
    expect(fresh.storyAskModels("outline")).toEqual(["scribe-2"]);
    expect(fresh.storyAskModels("keyframeArt")).toEqual([]);
    expect(fresh.storyAskModels("music")).toEqual([]);
  });

  it("says which asking is which place", () => {
    expect(askPlaceOfKind("outline")).toBe("text");
    expect(askPlaceOfKind("elementArt")).toBe("image");
    expect(askPlaceOfKind("keyframeVideo")).toBe("video");
    expect(askPlaceOfKind("voice")).toBe("audio");
    expect(askPlaceOfKind("music")).toBe("music");
  });
});
