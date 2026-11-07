import { beforeEach, describe, expect, it } from "vitest";
import {
  applyUiPatch,
  currentUiPrefs,
  defaultUiPrefs,
  rememberUiPrefs,
  replaceUiPrefs,
  resetUiPrefs,
  setUiPrefsWriter,
} from "./prefsData";

beforeEach(() => {
  resetUiPrefs();
  setUiPrefsWriter(null);
});

describe("the interface snapshot", () => {
  it("starts from the same defaults the server documents", () => {
    expect(currentUiPrefs()).toEqual(defaultUiPrefs());
  });

  it("changes only the fields a patch names", () => {
    replaceUiPrefs({
      ...defaultUiPrefs(),
      locale: "zh",
      clipTimelines: { p1: "tl-1" },
    });
    rememberUiPrefs({ canvasTheme: "paper" });

    const prefs = currentUiPrefs();
    expect(prefs.canvasTheme).toBe("paper");
    expect(prefs.locale).toBe("zh");
    expect(prefs.clipTimelines.p1).toBe("tl-1");
  });

  it("keeps the count the story room runs at once", () => {
    expect(defaultUiPrefs().storyParallel).toBe(3);
    rememberUiPrefs({ storyParallel: 5 });
    expect(currentUiPrefs().storyParallel).toBe(5);
  });

  it("writes map rows and removes the ones sent as null", () => {
    rememberUiPrefs({
      openCanvases: { p1: ["c1"], p2: ["c2"] },
      storyModels: { text: "scribe" },
    });
    expect(currentUiPrefs().openCanvases).toEqual({
      p1: ["c1"],
      p2: ["c2"],
    });

    rememberUiPrefs({ openCanvases: { p1: null } });
    expect(currentUiPrefs().openCanvases).toEqual({ p2: ["c2"] });
    expect(currentUiPrefs().storyModels).toEqual({ text: "scribe" });
  });

  it("hands every change to the installed writer", () => {
    const written: unknown[] = [];
    setUiPrefsWriter((patch) => written.push(patch));
    rememberUiPrefs({ stageSplit: 0.4 });

    expect(written).toEqual([{ stageSplit: 0.4 }]);
    expect(currentUiPrefs().stageSplit).toBe(0.4);
  });

  it("leaves the snapshot alone when a field is absent from the patch", () => {
    const next = applyUiPatch(
      { ...defaultUiPrefs(), clipVolume: 0.3 },
      { clipSnap: false },
    );
    expect(next.clipVolume).toBe(0.3);
    expect(next.clipSnap).toBe(false);
  });
});
