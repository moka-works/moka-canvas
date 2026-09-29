// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCutMokaFile } from "../../../shared/domain/fixtures";
import { useClipStore } from "../stores/clipStore";
import { PreviewStage } from "./PreviewStage";

/**
 * Where the composition loop stands against React.
 *
 * A composition happens on every frame the playhead moves, and what one
 * reports — the engine, the moment drawn, whether a loading place was drawn —
 * is written on the stage itself rather than rendered: the room is not put
 * through a render for a frame, and the clocks that read the moment do it
 * themselves. The number of renders is counted through the sources the stage
 * asks for on every one of them.
 */

const frame = vi.hoisted(() => {
  const arrivals: (() => void)[] = [];
  const report = {
    current: {
      clips: [],
      coloursSkipped: false,
      materialMs: 42 as number | null,
      waiting: false,
    },
  };
  const sources = {
    frameFor: async () => null,
    engineOf: () => undefined,
    beginFrame: () => undefined,
    prepareAhead: () => undefined,
    stopPlayback: () => undefined,
    onArrive: (listener: () => void) => {
      arrivals.push(listener);
      return () => undefined;
    },
  };
  return {
    arrivals,
    report,
    sources,
    previewFrames: vi.fn(() => sources),
    composeFrame: vi.fn(async () => report.current),
  };
});

vi.mock("../preview/frames", () => ({
  previewFrames: frame.previewFrames,
  frameEngine: () => "none",
}));

vi.mock("../preview/compositor", () => ({
  composeFrame: frame.composeFrame,
}));

const timeline = buildCutMokaFile().timelines![0]!;

/** Waits out the paint the stage has scheduled, animation frame and all. */
async function painted(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

beforeEach(() => {
  frame.previewFrames.mockClear();
  frame.arrivals.length = 0;
  frame.report.current.materialMs = 42;
  frame.report.current.waiting = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  // A pane with room in it and a canvas to draw into, which is all the paint
  // asks of a DOM before it composes.
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get: () => 360,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: () => undefined,
  } as unknown as CanvasRenderingContext2D);
  useClipStore.setState({ playheadMs: 0, playing: false, quality: "full" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "clientWidth");
  Reflect.deleteProperty(Element.prototype, "clientHeight");
});

describe("the stage and the clock over it", () => {
  it("writes what a composition reported without rendering for it", async () => {
    render(<PreviewStage timeline={timeline} />);
    await painted();
    const renders = frame.previewFrames.mock.calls.length;
    expect(renders).toBeGreaterThan(0);
    const stage = document.querySelector(".clip-preview") as HTMLElement;
    expect(stage.getAttribute("data-frame-ms")).toBe("0");
    expect(stage.getAttribute("data-frame-material-ms")).toBe("42");
    expect(stage.getAttribute("data-picture-state")).toBe("picture");
    expect(stage.getAttribute("data-engine")).toBe("none");

    // Another composition of the very same news: the readings are written
    // again, and the room is not rendered again for them.
    for (const listener of frame.arrivals) listener();
    await painted();
    expect(frame.previewFrames.mock.calls.length).toBe(renders);
  });

  it("moves the moment under the clock without re-rendering the stage", async () => {
    render(<PreviewStage timeline={timeline} />);
    await painted();
    const renders = frame.previewFrames.mock.calls.length;

    act(() => {
      useClipStore.setState({ playheadMs: 1_000 });
    });
    await painted();
    // The moment moving is the clock's own news and the canvas's own business:
    // the pane and the transport row under it are left exactly as they were.
    expect(frame.previewFrames.mock.calls.length).toBe(renders);
    expect(screen.getByTestId("preview-timecode").textContent).toBe(
      "00:00:01:00",
    );
    const stage = document.querySelector(".clip-preview") as HTMLElement;
    expect(stage.getAttribute("data-frame-ms")).toBe("1000");
  });

  it("renders again for a change the picture is made with", async () => {
    render(<PreviewStage timeline={timeline} />);
    await painted();
    const renders = frame.previewFrames.mock.calls.length;

    act(() => {
      useClipStore.setState({ quality: "half" });
    });
    await painted();
    expect(frame.previewFrames.mock.calls.length).toBeGreaterThan(renders);
  });
});
