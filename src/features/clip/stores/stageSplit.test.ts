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
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_START,
  clampSplit,
  useStageSplit,
} from "./stageSplit";

describe("stageSplit", () => {
  beforeEach(() => {
    resetUiPrefs();
    useStageSplit.setState({ share: SPLIT_START });
  });

  it("starts at the 60/40 the stage is first split at", () => {
    expect(clampSplit(SPLIT_START)).toBe(0.6);
  });

  it("holds a drag inside the room each pane may take", () => {
    useStageSplit.getState().setShare(0.72);
    expect(useStageSplit.getState().share).toBe(0.72);

    useStageSplit.getState().setShare(0.05);
    expect(useStageSplit.getState().share).toBe(SPLIT_MIN);

    useStageSplit.getState().setShare(0.99);
    expect(useStageSplit.getState().share).toBe(SPLIT_MAX);
  });

  it("asks the start for a share that is not a number", () => {
    expect(clampSplit(Number.NaN)).toBe(SPLIT_START);
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(SPLIT_MAX);
  });

  it("puts the split back to 60/40 on a reset", () => {
    useStageSplit.getState().setShare(0.4);
    useStageSplit.getState().resetShare();
    expect(useStageSplit.getState().share).toBe(SPLIT_START);
  });

  it("keeps the share in the preferences file, and reads it back", async () => {
    useStageSplit.getState().setShare(0.42);
    expect(currentUiPrefs().stageSplit).toBe(0.42);

    // Read again the way a second visit to the room reads: from what was kept.
    vi.resetModules();
    const kept = await import("./stageSplit");
    expect(kept.useStageSplit.getState().share).toBe(0.42);
  });

  it("takes nothing from a file holding something else", async () => {
    replaceUiPrefs({
      ...defaultUiPrefs(),
      stageSplit: "wide",
    } as unknown as UiPreferences);

    vi.resetModules();
    const kept = await import("./stageSplit");
    expect(kept.useStageSplit.getState().share).toBe(SPLIT_START);

    replaceUiPrefs({ ...defaultUiPrefs(), stageSplit: 4 });
    vi.resetModules();
    const clamped = await import("./stageSplit");
    expect(clamped.useStageSplit.getState().share).toBe(SPLIT_MAX);
  });
});
