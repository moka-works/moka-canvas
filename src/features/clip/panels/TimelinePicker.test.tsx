// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createTimeline } from "../../../shared/domain/factories";
import {
  buildTimelineMokaFile,
  timelineIds,
} from "../../../shared/domain/fixtures";
import { resetUiPrefs } from "../../../shared/prefs/prefsData";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import { TimelinePicker } from "./TimelinePicker";

/** The project with the fixture's cut open, and maybe one started beside it. */
function openCut(another = false) {
  const moka = buildTimelineMokaFile();
  if (another) {
    moka.timelines = [...(moka.timelines ?? []), createTimeline("Timeline 2")];
  }
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-timeline-picker-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useClipStore.setState({ activeTimelineId: timelineIds().timeline });
  render(<TimelinePicker />);
}

beforeEach(() => {
  resetUiPrefs();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useClipStore.setState({ activeTimelineId: null, newTimelineOpen: false });
});

afterEach(() => {
  cleanup();
});

describe("the rail's timeline selector", () => {
  it("reads the project's cuts and marks the one that is open", () => {
    openCut(true);

    expect(screen.getByTestId("timeline-picker-Timeline 1")).toBeTruthy();
    expect(screen.getByTestId("timeline-picker-Timeline 2")).toBeTruthy();
    expect(
      screen
        .getByTestId("timeline-picker-Timeline 1")
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("timeline-picker-Timeline 2")
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("opens a cut in the stage when its row is pressed", () => {
    openCut(true);

    fireEvent.click(screen.getByTestId("timeline-picker-Timeline 2"));
    expect(useClipStore.getState().activeTimelineId).not.toBe(
      timelineIds().timeline,
    );
    expect(
      screen
        .getByTestId("timeline-picker-Timeline 2")
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("offers the one thing there is to do when the project holds no cut", () => {
    const moka = buildTimelineMokaFile();
    moka.timelines = [];
    useProjectStore.getState().hydrate({
      moka,
      root: "/tmp/moka-timeline-picker-test",
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
    render(<TimelinePicker />);

    expect(screen.getByTestId("timeline-picker-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("timeline-picker-new"));
    expect(useClipStore.getState().newTimelineOpen).toBe(true);
  });
});
