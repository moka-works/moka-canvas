// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentUiPrefs,
  defaultUiPrefs,
  replaceUiPrefs,
  resetUiPrefs,
} from "../../../shared/prefs/prefsData";
import type { UiPreferences } from "../../../shared/prefs/types";
import { askPlaceOfKind, storyAskModel, useStoryModels } from "./storyModels";

beforeEach(() => {
  resetUiPrefs();
  useStoryModels.setState({ choices: {} });
});

describe("the models a story room is set to", () => {
  it("keeps a choice per kind of work, and hands it back", () => {
    useStoryModels.getState().choose("text", "scribe-2");
    useStoryModels.getState().choose("music", "composer-1");

    expect(storyAskModel("outline")).toBe("scribe-2");
    expect(storyAskModel("elements")).toBe("scribe-2");
    // A voice and a score are both audio work and are not the same choice.
    expect(storyAskModel("music")).toBe("composer-1");
    expect(storyAskModel("voice")).toBeNull();
  });

  it("clears a choice back to the deployment's default", () => {
    useStoryModels.getState().choose("image", "painter-1");
    expect(storyAskModel("keyframeArt")).toBe("painter-1");

    useStoryModels.getState().choose("image", null);
    expect(storyAskModel("keyframeArt")).toBeNull();
    // Nothing left behind for the next reader of this machine.
    expect(currentUiPrefs().storyModels).toEqual({});
  });

  it("reads back what the machine kept, and only what is a model", async () => {
    replaceUiPrefs({
      ...defaultUiPrefs(),
      storyModels: { text: "scribe-2", nonsense: "x", image: 7, music: "" },
    } as unknown as UiPreferences);
    vi.resetModules();

    // What the store is made of on a machine that has been used before: the
    // places it knows, and a reference rather than whatever else was written.
    const fresh = await import("./storyModels");
    expect(fresh.storyAskModel("outline")).toBe("scribe-2");
    expect(fresh.storyAskModel("keyframeArt")).toBeNull();
    expect(fresh.storyAskModel("music")).toBeNull();
  });

  it("says which asking is which place", () => {
    expect(askPlaceOfKind("outline")).toBe("text");
    expect(askPlaceOfKind("elementArt")).toBe("image");
    expect(askPlaceOfKind("keyframeVideo")).toBe("video");
    expect(askPlaceOfKind("voice")).toBe("audio");
    expect(askPlaceOfKind("music")).toBe("music");
  });
});
