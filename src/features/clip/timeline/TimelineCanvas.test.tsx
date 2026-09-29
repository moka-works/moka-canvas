// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { TimelineDocument } from "../../../shared/domain";
import {
  buildCutMokaFile,
  cutFixtureIds,
} from "../../../shared/domain/fixtures";
import { ASSET_DRAG_MIME } from "../../editor/interactions/actions";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import { TimelineCanvas } from "./TimelineCanvas";

function cut(): TimelineDocument {
  return buildCutMokaFile().timelines![0];
}

/** The canvas with the headers column beside it, as the room lays them out. */
function Harness({ timeline }: { timeline: TimelineDocument }) {
  const headersRef = useRef<HTMLDivElement>(null);
  return (
    <div className="clip-timeline">
      <div data-testid="headers" ref={headersRef} />
      <TimelineCanvas headersRef={headersRef} timeline={timeline} />
    </div>
  );
}

/** A window with no raster in it still has to answer, or the canvas can never be asked to draw. */
function stubContext(): CanvasRenderingContext2D {
  const noop = () => undefined;
  return new Proxy(
    { measureText: () => ({ width: 0 }) },
    {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value : noop;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

const RECT = {
  bottom: 300,
  height: 300,
  left: 0,
  right: 800,
  top: 0,
  width: 800,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

beforeEach(() => {
  localStorage.clear();
  useClipStore.setState({
    activeTimelineId: null,
    view: { pxPerSec: 60, scrollLeftPx: 0 },
    playheadMs: 0,
    viewportPx: 0,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLCanvasElement.prototype.getContext = (() =>
    stubContext()) as unknown as HTMLCanvasElement["getContext"];
  // Capture and the element's box are the browser's; a pointer needs both.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function viewportOf(container: HTMLElement): HTMLDivElement {
  return container.querySelector(".clip-tl-viewport") as HTMLDivElement;
}

function canvasOf(container: HTMLElement): HTMLCanvasElement {
  return container.querySelector(".clip-tl-canvas") as HTMLCanvasElement;
}

describe("the timeline canvas", () => {
  it("puts the playhead under a click on the ruler and follows the drag", () => {
    const { container } = render(<Harness timeline={cut()} />);
    const canvas = canvasOf(container);

    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 300,
      clientY: 10,
      pointerId: 1,
    });
    expect(useClipStore.getState().playheadMs).toBe(5_000);

    fireEvent.pointerMove(canvas, { clientX: 600, clientY: 12, pointerId: 1 });
    expect(useClipStore.getState().playheadMs).toBe(10_000);

    fireEvent.pointerUp(canvas, { clientX: 600, clientY: 12, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 900, clientY: 12, pointerId: 1 });
    expect(useClipStore.getState().playheadMs).toBe(10_000);
  });

  it("leaves a press below the ruler to the packages that act on clips", () => {
    const { container } = render(<Harness timeline={cut()} />);
    const canvas = canvasOf(container);

    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 300,
      clientY: 80,
      pointerId: 1,
    });
    fireEvent.pointerMove(canvas, { clientX: 600, clientY: 90, pointerId: 1 });
    expect(useClipStore.getState().playheadMs).toBe(0);
  });

  it("reads the scroll into the store and moves the headers with it", () => {
    const { container } = render(<Harness timeline={cut()} />);
    const viewport = viewportOf(container);
    Object.defineProperty(viewport, "scrollLeft", {
      configurable: true,
      value: 250,
      writable: true,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 40,
      writable: true,
    });

    fireEvent.scroll(viewport);

    expect(useClipStore.getState().view.scrollLeftPx).toBe(250);
    const headers = container.querySelector(
      "[data-testid=headers]",
    ) as HTMLElement;
    expect(headers.style.transform).toBe("translateY(-40px)");
  });

  it("applies a zoom back onto the scroller, which only the browser has been scrolling", () => {
    const { container } = render(<Harness timeline={cut()} />);
    const viewport = viewportOf(container);
    Object.defineProperty(viewport, "scrollLeft", {
      configurable: true,
      value: 0,
      writable: true,
    });

    useClipStore.getState().setViewportPx(800);
    useClipStore.getState().setPlayhead(5_000);
    useClipStore.getState().zoomTo(90);

    expect(useClipStore.getState().view).toEqual({
      pxPerSec: 90,
      scrollLeftPx: 50,
    });
    expect(viewport.scrollLeft).toBe(50);
  });

  it("hangs the block a dragged file would land as, and lets it go with the drag", async () => {
    const ids = cutFixtureIds();
    useProjectStore.getState().hydrate({
      root: "/tmp/moka-test",
      moka: buildCutMokaFile(),
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
    useClipStore.setState({ activeTimelineId: ids.timeline });
    const { container } = render(<Harness timeline={cut()} />);
    const room = container.querySelector(".clip-timeline") as HTMLElement;
    const canvas = canvasOf(container);
    // A window with room in it, so the frame that draws also writes down what
    // it drew: the room's own attributes are where a test reads the pixels.
    const viewport = viewportOf(container);
    Object.defineProperty(viewport, "clientWidth", { value: 800 });
    Object.defineProperty(viewport, "clientHeight", { value: 600 });

    // The drag begins on a shelf row: the row's own contract says which file
    // is in flight, since a drag's data is private to the drop that ends it.
    const row = document.createElement("li");
    row.setAttribute("data-asset-id", ids.videoAssetA);
    document.body.append(row);
    row.dispatchEvent(new Event("dragstart", { bubbles: true }));

    // Six and a half seconds in on the video row, clear of every edge: the
    // head stands on the pointer's own frame and the file's four seconds run
    // from there.
    dragover(canvas, 390, 150);
    await waitFor(() =>
      expect(room.getAttribute("data-drop-preview")).toBe(
        `${ids.videoTrack}:6500:4000`,
      ),
    );

    // The pointer wandering off the rows is the drag letting go of it.
    canvas.dispatchEvent(new Event("dragleave", { bubbles: true }));
    await waitFor(() =>
      expect(room.getAttribute("data-drop-preview")).toBe(""),
    );
    row.remove();
  });
});

/**
 * A drag hovering the canvas at a point, as the platform delivers one.
 *
 * The drag data is written onto the event rather than built by the test
 * library: what a drag carries is the browser's own store, and a pointer and
 * that data arrive on one event.
 */
function dragover(node: HTMLElement, x: number, y: number) {
  const event = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    dataTransfer: { value: { dropEffect: "", types: [ASSET_DRAG_MIME] } },
  });
  node.dispatchEvent(event);
}
