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
  PANEL_MAX,
  PANEL_MIN,
  clampPanelWidth,
  panelCeiling,
  usePanelWidths,
} from "./panelWidths";

/** A window wide enough that the ceiling on paper is the one that applies. */
function wideWindow() {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 2000,
  });
}

describe("panelWidths", () => {
  beforeEach(() => {
    resetUiPrefs();
    wideWindow();
    usePanelWidths.setState({ left: null, right: null });
  });

  it("holds a dragged column inside the room a column may take", () => {
    usePanelWidths.getState().setWidth("left", 320);
    expect(usePanelWidths.getState().left).toBe(320);

    usePanelWidths.getState().setWidth("left", 40);
    expect(usePanelWidths.getState().left).toBe(PANEL_MIN);

    usePanelWidths.getState().setWidth("left", 4000);
    expect(usePanelWidths.getState().left).toBe(PANEL_MAX);
  });

  it("keeps the two columns apart from one another", () => {
    usePanelWidths.getState().setWidth("left", 300);
    usePanelWidths.getState().setWidth("right", 420);

    expect(usePanelWidths.getState().left).toBe(300);
    expect(usePanelWidths.getState().right).toBe(420);
  });

  it("hands a column back to its stylesheet on a reset", () => {
    usePanelWidths.getState().setWidth("right", 500);
    usePanelWidths.getState().resetWidth("right");

    // `null` is not a width of zero but no width at all, which is what leaves
    // the column at the width its own stylesheet gives it.
    expect(usePanelWidths.getState().right).toBeNull();
  });

  it("keeps the widths in the preferences file, and reads them back", async () => {
    usePanelWidths.getState().setWidth("left", 275);
    expect(currentUiPrefs().panelWidths).toEqual({ left: 275, right: null });

    // Read again the way a second visit to the editor reads: from what was kept.
    vi.resetModules();
    const kept = await import("./panelWidths");
    expect(kept.usePanelWidths.getState().left).toBe(275);
  });

  it("takes nothing from a file holding something else", async () => {
    replaceUiPrefs({
      ...defaultUiPrefs(),
      panelWidths: { left: "wide", right: Number.NaN },
    } as unknown as UiPreferences);

    vi.resetModules();
    const kept = await import("./panelWidths");
    expect(kept.usePanelWidths.getState().left).toBeNull();
    expect(kept.usePanelWidths.getState().right).toBeNull();
  });

  it("narrows the ceiling to a window too narrow for it", () => {
    expect(clampPanelWidth(900)).toBe(PANEL_MAX);

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    expect(panelCeiling()).toBe(360);
    usePanelWidths.getState().setWidth("left", 900);
    expect(usePanelWidths.getState().left).toBe(360);
  });

  it("never narrows a column below the floor, however narrow the window", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 120,
    });
    expect(panelCeiling()).toBe(PANEL_MIN);
    expect(clampPanelWidth(600, panelCeiling())).toBe(PANEL_MIN);
  });
});
