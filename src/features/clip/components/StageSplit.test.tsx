// @vitest-environment jsdom
import { resetUiPrefs } from "../../../shared/prefs/prefsData";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SPLIT_MAX, SPLIT_START, useStageSplit } from "../stores/stageSplit";
import { StageSplit } from "./StageSplit";

/** A stage the splitter sits in, as the column holds them. */
function renderSplit() {
  render(
    <div data-testid="stage">
      <StageSplit />
    </div>,
  );
  return screen.getByTestId("stage-split");
}

const DOWN = {
  button: 0,
  pointerType: "mouse",
} as const;

/** A rect tall enough to read a drag as a share of the column. */
const STAGE_RECT = {
  bottom: 600,
  height: 600,
  left: 0,
  right: 1200,
  top: 0,
  width: 1200,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

describe("stageSplit control", () => {
  beforeEach(() => {
    resetUiPrefs();
    useStageSplit.setState({ share: SPLIT_START });
    // A drag holds the edge it started on, however far the pointer travels.
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => true);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      STAGE_RECT,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.body.classList.remove("is-dragging-split");
  });

  it("gives the preview more room as the edge is dragged down", () => {
    const edge = renderSplit();

    fireEvent.pointerDown(edge, { ...DOWN, clientY: 300, pointerId: 1 });
    expect(document.body.classList.contains("is-dragging-split")).toBe(true);

    fireEvent.pointerMove(edge, { clientY: 360, pointerId: 1 });
    expect(useStageSplit.getState().share).toBe(0.7);

    fireEvent.pointerUp(edge, { clientY: 360, pointerId: 1 });
    expect(document.body.classList.contains("is-dragging-split")).toBe(false);
  });

  it("leaves the split alone for a pointer it is not holding", () => {
    const edge = renderSplit();

    fireEvent.pointerDown(edge, { ...DOWN, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientY: 500, pointerId: 9 });
    fireEvent.pointerUp(edge, { clientY: 500, pointerId: 1 });

    expect(useStageSplit.getState().share).toBe(SPLIT_START);
  });

  it("stops at the room each pane may take", () => {
    const edge = renderSplit();

    fireEvent.pointerDown(edge, { ...DOWN, clientY: 300, pointerId: 2 });
    fireEvent.pointerMove(edge, { clientY: 900, pointerId: 2 });
    fireEvent.pointerUp(edge, { clientY: 900, pointerId: 2 });

    expect(useStageSplit.getState().share).toBe(SPLIT_MAX);
  });

  it("answers the vertical arrows, and Shift for a longer step", () => {
    const edge = renderSplit();

    fireEvent.keyDown(edge, { key: "ArrowUp" });
    expect(useStageSplit.getState().share).toBe(0.62);

    fireEvent.keyDown(edge, { key: "ArrowUp", shiftKey: true });
    expect(useStageSplit.getState().share).toBe(0.7);

    fireEvent.keyDown(edge, { key: "ArrowDown" });
    expect(useStageSplit.getState().share).toBe(0.68);

    // An arrow that is not about this edge is left to whatever is beside it.
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(useStageSplit.getState().share).toBe(0.68);
  });

  it("says the share to a reader who cannot see the edge", () => {
    const edge = renderSplit();

    expect(edge.getAttribute("role")).toBe("separator");
    expect(edge.getAttribute("aria-orientation")).toBe("horizontal");
    expect(edge.getAttribute("aria-valuenow")).toBe("60");

    fireEvent.keyDown(edge, { key: "ArrowUp" });
    expect(edge.getAttribute("aria-valuenow")).toBe("62");
  });

  it("puts the split back to 60/40 on a double-click", () => {
    const edge = renderSplit();
    useStageSplit.getState().setShare(0.3);

    fireEvent.doubleClick(edge);

    expect(useStageSplit.getState().share).toBe(SPLIT_START);
  });
});
