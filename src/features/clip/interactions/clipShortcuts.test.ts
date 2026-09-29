// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
} from "@testing-library/react";
import { createElement } from "react";
import {
  buildCutMokaFile,
  cutFixtureIds,
} from "../../../shared/domain/fixtures";
import { redo, undo } from "../../editor/commands/execute";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import {
  clearSelection,
  deleteSelection,
  duplicateSelection,
  selectAll,
  splitSelectionAtPlayhead,
} from "./clipActions";
import { useClipShortcuts, type ClipShortcutOptions } from "./clipShortcuts";

vi.mock("../../editor/commands/execute", () => ({
  undo: vi.fn(),
  redo: vi.fn(),
}));

vi.mock("./clipActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clipActions")>();
  return {
    ...actual,
    clearSelection: vi.fn(),
    deleteSelection: vi.fn(),
    duplicateSelection: vi.fn(),
    selectAll: vi.fn(),
    splitSelectionAtPlayhead: vi.fn(),
  };
});

/** The room's page, cut down to the hook and a field to type in.
 *
 * Written without JSX because the plan names this file `.ts`: a hook needs a
 * component to be rendered in, and an element made by hand is one.
 */
function Harness({ options }: { options?: ClipShortcutOptions }) {
  useClipShortcuts(options);
  return createElement("input", { "aria-label": "A field" });
}

/** The room's hook with its options, for the cases that pass any. */
function harness(options?: ClipShortcutOptions) {
  return createElement(Harness, { options });
}

/** A key press that reaches the window the hook listens on. */
function press(init: KeyboardEventInit): KeyboardEvent {
  const event = createEvent.keyDown(document.body, init);
  fireEvent(document.body, event);
  return event as KeyboardEvent;
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useClipStore.setState({
    activeTimelineId: null,
    selection: { clipIds: [], transitionId: null },
    view: { pxPerSec: 60, scrollLeftPx: 0 },
    playheadMs: 0,
    playing: false,
    viewportPx: 0,
  });
  vi.mocked(undo).mockReset();
  vi.mocked(redo).mockReset();
  vi.mocked(splitSelectionAtPlayhead).mockReset();
  vi.mocked(deleteSelection).mockReset();
  vi.mocked(duplicateSelection).mockReset();
  vi.mocked(selectAll).mockReset();
  vi.mocked(clearSelection).mockReset();
});

afterEach(() => {
  cleanup();
});

/** Opens the cut fixture, so the keys that move along the cut have edges. */
function openCut() {
  const ids = cutFixtureIds();
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka: buildCutMokaFile(),
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useClipStore.setState({ activeTimelineId: ids.timeline });
  return ids;
}

describe("the room's keys", () => {
  it("leaves a key typed into a field to the field", () => {
    const { getByLabelText } = render(harness());
    fireEvent.keyDown(getByLabelText("A field"), {
      ctrlKey: true,
      key: "b",
    });
    expect(splitSelectionAtPlayhead).not.toHaveBeenCalled();
  });

  it("cuts, deletes, duplicates and selects all", () => {
    render(harness());

    press({ key: "b", ctrlKey: true });
    expect(splitSelectionAtPlayhead).toHaveBeenCalledTimes(1);

    press({ key: "Delete" });
    press({ key: "Backspace" });
    expect(deleteSelection).toHaveBeenCalledTimes(2);

    const duplicated = press({ key: "d", ctrlKey: true });
    expect(duplicateSelection).toHaveBeenCalledTimes(1);
    // The browser would take this one for a bookmark.
    expect(duplicated.defaultPrevented).toBe(true);

    const all = press({ key: "a", ctrlKey: true });
    expect(selectAll).toHaveBeenCalledTimes(1);
    expect(all.defaultPrevented).toBe(true);

    press({ key: "Escape" });
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(selectAll).toHaveBeenCalledTimes(1);
  });

  it("undoes and redoes with either platform's modifier", () => {
    render(harness());

    press({ key: "z", ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    press({ key: "Z", metaKey: true, shiftKey: true });
    expect(redo).toHaveBeenCalledTimes(1);
    press({ key: "y", ctrlKey: true });
    expect(redo).toHaveBeenCalledTimes(2);
  });

  it("walks the playhead to the head, the end, and the next edge", () => {
    openCut();
    render(harness());

    press({ key: "End" });
    // The last tail on a row that draws: the locked audio row still draws.
    expect(useClipStore.getState().playheadMs).toBe(8_000);

    press({ key: "Home" });
    expect(useClipStore.getState().playheadMs).toBe(0);

    useClipStore.getState().setPlayhead(3_000);
    press({ key: "ArrowDown" });
    expect(useClipStore.getState().playheadMs).toBe(3_500);
    press({ key: "ArrowUp" });
    expect(useClipStore.getState().playheadMs).toBe(2_000);
    // An edge already stood on is stepped past rather than landed on again.
    press({ key: "ArrowUp" });
    expect(useClipStore.getState().playheadMs).toBe(0);
  });

  it("plays and pauses the cut with Space", () => {
    openCut();
    render(harness());

    const started = press({ key: " " });
    expect(started.defaultPrevented).toBe(true);
    expect(useClipStore.getState().playing).toBe(true);

    press({ key: " " });
    expect(useClipStore.getState().playing).toBe(false);
  });

  it("walks the clock a frame at a time, and a second with Shift", () => {
    openCut();
    render(harness());
    useClipStore.getState().setPlayhead(1_000);

    const right = press({ key: "ArrowRight" });
    expect(right.defaultPrevented).toBe(true);
    expect(useClipStore.getState().playheadMs).toBe(1_033);

    press({ key: "ArrowLeft" });
    expect(useClipStore.getState().playheadMs).toBe(1_000);

    press({ key: "ArrowRight", shiftKey: true });
    expect(useClipStore.getState().playheadMs).toBe(2_000);
    press({ key: "ArrowLeft", shiftKey: true });
    expect(useClipStore.getState().playheadMs).toBe(1_000);

    // The head is the floor: a step before it is the head.
    useClipStore.getState().setPlayhead(0);
    press({ key: "ArrowLeft" });
    expect(useClipStore.getState().playheadMs).toBe(0);
  });

  it("stops the clock when a key places the playhead", () => {
    openCut();
    render(harness());
    useClipStore.getState().play();
    expect(useClipStore.getState().playing).toBe(true);

    press({ key: "ArrowRight" });
    expect(useClipStore.getState().playing).toBe(false);
    expect(useClipStore.getState().playheadMs).toBe(33);
  });

  it("zooms a step either way", () => {
    render(harness());

    press({ key: "+" });
    expect(useClipStore.getState().view.pxPerSec).toBe(90);
    press({ key: "-" });
    expect(useClipStore.getState().view.pxPerSec).toBe(60);
  });

  it("keeps the help list and lets a dialog keep its own keys", () => {
    const onShowHelp = vi.fn();
    const { rerender } = render(harness({ onShowHelp }));

    const asked = press({ key: "?", shiftKey: true });
    expect(onShowHelp).toHaveBeenCalledTimes(1);
    expect(asked.defaultPrevented).toBe(true);

    onShowHelp.mockClear();
    rerender(harness({ isBlocked: () => true, onShowHelp }));
    press({ key: "?", shiftKey: true });
    press({ key: "b", ctrlKey: true });
    press({ key: "Delete" });
    expect(onShowHelp).not.toHaveBeenCalled();
    expect(splitSelectionAtPlayhead).not.toHaveBeenCalled();
    expect(deleteSelection).not.toHaveBeenCalled();
  });

  it("ignores a key another handler has already answered", () => {
    render(harness());
    const answered = createEvent.keyDown(document.body, {
      key: "b",
      ctrlKey: true,
    });
    answered.preventDefault();
    fireEvent(document.body, answered);
    press({ key: "b", ctrlKey: true, repeat: true });
    expect(splitSelectionAtPlayhead).not.toHaveBeenCalled();
  });
});
