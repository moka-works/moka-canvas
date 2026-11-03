// @vitest-environment jsdom
import { resetUiPrefs } from "../../../shared/prefs/prefsData";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { PANEL_MIN, usePanelWidths } from "../stores/panelWidths";
import { PanelResizer } from "./PanelResizer";
import { panelWidthStyle } from "./panelWidthVars";

/** A column beside the edge that drags it, as the editor row holds them. */
function renderRow(side: "left" | "right") {
  const column = <aside data-testid="column" />;
  render(
    <div>
      {side === "left" ? (
        <>
          {column}
          <PanelResizer side={side} />
        </>
      ) : (
        <>
          <PanelResizer side={side} />
          {column}
        </>
      )}
    </div>,
  );
  return screen.getByTestId(`panel-resizer-${side}`);
}

const DOWN = {
  button: 0,
  pointerType: "mouse",
} as const;

describe("panelResizer", () => {
  beforeEach(() => {
    resetUiPrefs();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 2000,
    });
    usePanelWidths.setState({ left: null, right: null });
    // A drag holds the edge it started on, however far the pointer travels.
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => true);
  });

  afterEach(() => {
    cleanup();
    document.body.classList.remove("is-dragging-panel");
  });

  it("drags the left column wider to the right", () => {
    const edge = renderRow("left");

    fireEvent.pointerDown(edge, { ...DOWN, clientX: 240, pointerId: 1 });
    expect(document.body.classList.contains("is-dragging-panel")).toBe(true);

    fireEvent.pointerMove(edge, { clientX: 330, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 330, pointerId: 1 });

    // The column started where its stylesheet left it and grew by the travel.
    expect(usePanelWidths.getState().left).toBe(330);
    expect(document.body.classList.contains("is-dragging-panel")).toBe(false);
  });

  it("drags the right column wider to the left", () => {
    const edge = renderRow("right");

    fireEvent.pointerDown(edge, { ...DOWN, clientX: 700, pointerId: 2 });
    fireEvent.pointerMove(edge, { clientX: 620, pointerId: 2 });
    fireEvent.pointerUp(edge, { clientX: 620, pointerId: 2 });

    expect(usePanelWidths.getState().right).toBe(320);
  });

  it("leaves a column alone for a pointer it is not holding", () => {
    const edge = renderRow("left");

    fireEvent.pointerDown(edge, { ...DOWN, clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 400, pointerId: 9 });
    fireEvent.pointerUp(edge, { clientX: 400, pointerId: 1 });

    // Nothing was asked of the column, so no width was written for it either.
    expect(usePanelWidths.getState().left).toBeNull();
  });

  it("answers the arrow keys, and Shift for a longer step", () => {
    const edge = renderRow("left");

    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(usePanelWidths.getState().left).toBe(248);

    fireEvent.keyDown(edge, { key: "ArrowRight", shiftKey: true });
    expect(usePanelWidths.getState().left).toBe(296);

    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(usePanelWidths.getState().left).toBe(288);

    // An arrow that is not about this edge is left to the canvas beside it.
    fireEvent.keyDown(edge, { key: "ArrowUp" });
    expect(usePanelWidths.getState().left).toBe(288);
  });

  it("widens the right column with the arrow pointing into it", () => {
    const edge = renderRow("right");

    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(usePanelWidths.getState().right).toBe(248);

    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(usePanelWidths.getState().right).toBe(240);
  });

  it("stops at the floor of a column, by key or by drag", () => {
    const edge = renderRow("left");
    act(() => usePanelWidths.getState().setWidth("left", PANEL_MIN + 2));

    fireEvent.keyDown(edge, { key: "ArrowLeft", shiftKey: true });
    expect(usePanelWidths.getState().left).toBe(PANEL_MIN);

    fireEvent.pointerDown(edge, { ...DOWN, clientX: 200, pointerId: 3 });
    fireEvent.pointerMove(edge, { clientX: 0, pointerId: 3 });
    fireEvent.pointerUp(edge, { clientX: 0, pointerId: 3 });
    expect(usePanelWidths.getState().left).toBe(PANEL_MIN);
  });

  it("says how wide the column is to a reader who cannot see it", () => {
    const edge = renderRow("left");

    expect(edge.getAttribute("role")).toBe("separator");
    expect(edge.getAttribute("aria-orientation")).toBe("vertical");
    expect(edge.getAttribute("aria-valuenow")).toBe("240");

    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(edge.getAttribute("aria-valuenow")).toBe("248");
  });

  it("puts a column back to its stylesheet on a double-click", () => {
    const edge = renderRow("left");
    act(() => usePanelWidths.getState().setWidth("left", 380));

    fireEvent.doubleClick(edge);

    expect(usePanelWidths.getState().left).toBeNull();
  });
});

describe("panelWidthStyle", () => {
  it("asks nothing of the stylesheet while no column has been dragged", () => {
    expect(panelWidthStyle(null, null)).toBeUndefined();
  });

  it("writes down only the columns that have been dragged", () => {
    expect(panelWidthStyle(300, null)).toEqual({
      "--panel-left-width": "300px",
    });
    expect(panelWidthStyle(null, 420)).toEqual({
      "--panel-right-width": "420px",
    });
    expect(panelWidthStyle(300, 420)).toEqual({
      "--panel-left-width": "300px",
      "--panel-right-width": "420px",
    });
  });
});
