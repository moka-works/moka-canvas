// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentUiPrefs,
  defaultUiPrefs,
  replaceUiPrefs,
  resetUiPrefs,
} from "../../../shared/prefs/prefsData";
import type { UiPreferences } from "../../../shared/prefs/types";
import { usePanelFolds } from "./panelFolds";

describe("panelFolds", () => {
  beforeEach(() => {
    resetUiPrefs();
    usePanelFolds.setState({ left: false, right: false });
  });

  it("starts with both columns standing", () => {
    expect(usePanelFolds.getState().left).toBe(false);
    expect(usePanelFolds.getState().right).toBe(false);
  });

  it("folds one column away without asking the other about it", () => {
    usePanelFolds.getState().toggle("left");
    expect(usePanelFolds.getState().left).toBe(true);
    expect(usePanelFolds.getState().right).toBe(false);

    usePanelFolds.getState().toggle("left");
    expect(usePanelFolds.getState().left).toBe(false);
  });

  it("folds a column to the state it was asked for", () => {
    usePanelFolds.getState().setFolded("right", true);
    usePanelFolds.getState().setFolded("right", true);
    expect(usePanelFolds.getState().right).toBe(true);
    // The column on the other side is still standing.
    expect(usePanelFolds.getState().left).toBe(false);

    usePanelFolds.getState().setFolded("right", false);
    expect(usePanelFolds.getState().right).toBe(false);
  });

  it("keeps what was folded in the preferences file, and reads it back", async () => {
    usePanelFolds.getState().setFolded("left", true);
    expect(currentUiPrefs().panelFolds).toEqual({
      left: true,
      right: false,
    });

    // Read again the way a second visit to the editor reads: from what was kept.
    vi.resetModules();
    const kept = await import("./panelFolds");
    expect(kept.usePanelFolds.getState().left).toBe(true);
    expect(kept.usePanelFolds.getState().right).toBe(false);
  });

  it("takes nothing from a file holding something else", async () => {
    replaceUiPrefs({
      ...defaultUiPrefs(),
      panelFolds: { left: "folded away", right: 3 },
    } as unknown as UiPreferences);

    vi.resetModules();
    const kept = await import("./panelFolds");
    expect(kept.usePanelFolds.getState().left).toBe(false);
    expect(kept.usePanelFolds.getState().right).toBe(false);
  });
});
