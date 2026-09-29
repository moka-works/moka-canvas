// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TimelineClip,
  TimelineDocument,
  TimelineTrack,
} from "../../../shared/domain";
import { useClipStore } from "../stores/clipStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { createFrameSources } from "./frames";

/**
 * What the preview prepares, and when.
 *
 * The runs and elements of the clips near the clock are made before they are
 * needed; the decode and the element pool are stood in for here, so what is
 * being tested is the choosing — which clips, at which moments, and which are
 * left to the first paint that draws them.
 */

const decodeMocks = vi.hoisted(() => ({
  streamFrom: vi.fn(),
  decodeFrameAt: vi.fn(),
  mp4IndexFor: vi.fn(),
  isElementOnly: vi.fn(),
  elementOnlyReason: vi.fn(),
  resetTransientFailures: vi.fn(),
}));

vi.mock("./decode", () => ({
  decodeFrameAt: decodeMocks.decodeFrameAt,
  elementOnlyReason: decodeMocks.elementOnlyReason,
  isElementOnly: decodeMocks.isElementOnly,
  mp4IndexFor: decodeMocks.mp4IndexFor,
  resetTransientFailures: decodeMocks.resetTransientFailures,
  streamFrom: decodeMocks.streamFrom,
}));

const elementMocks = vi.hoisted(() => ({
  elementFor: vi.fn(),
  startPlaying: vi.fn(),
  prepare: vi.fn(),
  beginFrame: vi.fn(),
  stopPlayback: vi.fn(),
  onArrive: vi.fn(),
  onProblem: vi.fn(),
}));

vi.mock("./elementFrames", () => ({
  elementEngine: () => elementMocks,
}));

const T0 = "2026-01-01T00:00:00.000Z";

/** The assets the decoder is not to have: every ask about them goes to the elements. */
let elementOnly: Set<string>;

/** The runs made, in the order they were asked for. */
interface MadeRun {
  assetId: string;
  fromMs: number;
  closed: boolean;
}
let made: MadeRun[];

function clip(
  patch: Partial<TimelineClip> & { id: string; trackId: string },
): TimelineClip {
  return {
    kind: "video",
    label: "piece.mp4",
    startMs: 0,
    durationMs: 4_000,
    inPointMs: 0,
    outPointMs: 4_000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

function track(id: string, patch: Partial<TimelineTrack> = {}): TimelineTrack {
  return {
    id,
    kind: "video",
    name: id,
    muted: false,
    hidden: false,
    locked: false,
    createdAt: T0,
    ...patch,
  };
}

function cut(tracks: TimelineTrack[], clips: TimelineClip[]): TimelineDocument {
  return {
    id: "timeline-1",
    name: "Cut",
    schemaVersion: 1,
    settings: { fps: 30, width: 1920, height: 1080, background: "#000000" },
    tracks,
    clips,
    transitions: [],
    createdAt: T0,
    updatedAt: T0,
  };
}

/** The project's own records of the files, which is what says they are videos. */
function fileAssets(...ids: string[]): void {
  useProjectStore.setState({
    moka: {
      resources: {
        video: ids.map((id) => ({ id, name: `${id}.mp4`, mime: "video/mp4" })),
      },
    },
  } as never);
}

beforeEach(() => {
  elementOnly = new Set();
  made = [];
  decodeMocks.streamFrom
    .mockReset()
    .mockImplementation((assetId: string, fromMs: number) => {
      const entry: MadeRun = { assetId, fromMs, closed: false };
      made.push(entry);
      return {
        frameAt: () => null,
        failed: false,
        close: () => {
          entry.closed = true;
        },
      };
    });
  decodeMocks.decodeFrameAt.mockReset().mockResolvedValue(null);
  decodeMocks.mp4IndexFor
    .mockReset()
    .mockImplementation(async (assetId: string) =>
      elementOnly.has(assetId)
        ? null
        : { video: { samples: [], rotationDeg: 0 } },
    );
  decodeMocks.isElementOnly
    .mockReset()
    .mockImplementation((assetId: string) => elementOnly.has(assetId));
  elementMocks.onArrive.mockReturnValue(() => undefined);
  elementMocks.onProblem.mockReturnValue(() => undefined);
  elementMocks.elementFor.mockReturnValue(null);
  elementMocks.startPlaying.mockReturnValue(null);
  // The browser's own decoder is stood in for by "there is one": the engine
  // only takes the decode path where a decoder exists to take it.
  vi.stubGlobal("VideoDecoder", class {});
  useClipStore.setState({ playing: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useClipStore.setState({ playing: false });
});

describe("the pictures prepared ahead of the clock", () => {
  it("opens a run for the piece after this one, at its own first moment", async () => {
    fileAssets("asset-a", "asset-b");
    const sources = createFrameSources();
    const timeline = cut(
      [track("v1")],
      [
        clip({ id: "a", trackId: "v1", assetId: "asset-a", startMs: 0 }),
        clip({
          id: "b",
          trackId: "v1",
          assetId: "asset-b",
          startMs: 5_000,
          inPointMs: 1_000,
        }),
      ],
    );
    // The engine is decided by a paint, as it is in the room.
    await sources.frameFor(timeline.clips[0], 3_000);
    expect(made).toEqual([
      { assetId: "asset-a", fromMs: 3_000, closed: false },
    ]);

    sources.prepareAhead(timeline, 3_000);
    // The file after this one has never been drawn, so its engine is decided
    // the way a paint would decide it; the run follows a turn later.
    expect(made.map((run) => run.assetId)).toEqual(["asset-a"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The piece on screen is asked for where the clock stands in it, and the
    // piece after it at its own first moment — not anywhere the clock is now.
    expect(made.map((run) => [run.assetId, run.fromMs])).toEqual([
      ["asset-a", 3_000],
      ["asset-b", 1_000],
    ]);

    sources.stopPlayback();
    expect(made.every((run) => run.closed)).toBe(true);
  });

  it("leaves the pieces beyond the window, the hidden rows and the sound alone", async () => {
    fileAssets("asset-a", "asset-far", "asset-hidden", "asset-sound");
    const sources = createFrameSources();
    const timeline = cut(
      [
        track("v1"),
        track("v2", { hidden: true }),
        track("a1", { kind: "audio" }),
      ],
      [
        clip({ id: "a", trackId: "v1", assetId: "asset-a", startMs: 0 }),
        clip({
          id: "far",
          trackId: "v1",
          assetId: "asset-far",
          startMs: 30_000,
        }),
        clip({
          id: "hidden",
          trackId: "v2",
          assetId: "asset-hidden",
          startMs: 4_000,
        }),
        clip({
          id: "sound",
          trackId: "a1",
          assetId: "asset-sound",
          kind: "audio",
          startMs: 4_000,
        }),
      ],
    );
    await sources.frameFor(timeline.clips[0], 0);
    made.length = 0;

    sources.prepareAhead(timeline, 0);
    expect(made).toEqual([]);
  });

  it("prepares an element for a file the decoder has given up on", async () => {
    fileAssets("asset-el");
    elementOnly.add("asset-el");
    const sources = createFrameSources();
    const timeline = cut(
      [track("v1")],
      [
        clip({ id: "a", trackId: "v1", assetId: "asset-el", startMs: 0 }),
        clip({
          id: "b",
          trackId: "v1",
          assetId: "asset-el",
          startMs: 5_000,
          inPointMs: 2_000,
        }),
      ],
    );
    // A paint is what lands the asset on the elements.
    await sources.frameFor(timeline.clips[0], 0);

    sources.prepareAhead(timeline, 3_000);
    expect(elementMocks.prepare).toHaveBeenCalledWith("asset-el", "b", 2_000);
    // Nothing was opened for the decoder: this file is not its business.
    expect(made).toEqual([]);
  });

  it("prepares nothing while the clock is stopped", async () => {
    fileAssets("asset-a", "asset-b");
    const sources = createFrameSources();
    const timeline = cut(
      [track("v1")],
      [
        clip({ id: "a", trackId: "v1", assetId: "asset-a", startMs: 0 }),
        clip({ id: "b", trackId: "v1", assetId: "asset-b", startMs: 5_000 }),
      ],
    );
    await sources.frameFor(timeline.clips[0], 0);
    made.length = 0;

    useClipStore.setState({ playing: false });
    sources.prepareAhead(timeline, 3_000);
    expect(made).toEqual([]);
  });
});
