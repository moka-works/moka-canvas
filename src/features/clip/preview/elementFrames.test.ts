// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetId, ClipId } from "../../../shared/domain";
import { elementEngine, type ElementEngine } from "./elementFrames";

/**
 * The pool the element fallback reads from, over elements the tests record.
 *
 * jsdom carries no media pipeline, so each element is given the little the
 * engine touches: a position that remembers where it was put, a ready state a
 * test can raise, and a play that does not throw. What is asserted is the
 * pool's own arithmetic — which element a reader gets, when a position is
 * written, and how many elements a file costs.
 */

const clipId = (id: string) => id as ClipId;
const assetId = (id: string) => id as AssetId;

/** One element as the tests see it. */
interface Recorded {
  element: HTMLVideoElement;
  seeks: number[];
  readyState: number;
}

const made: Recorded[] = [];
let loadCalls = 0;

function record(element: HTMLVideoElement): Recorded {
  const entry: Recorded = { element, seeks: [], readyState: 0 };
  let time = 0;
  Object.defineProperty(element, "currentTime", {
    get: () => time,
    set: (value: number) => {
      time = value;
      entry.seeks.push(value);
    },
    configurable: true,
  });
  Object.defineProperty(element, "readyState", {
    get: () => entry.readyState,
    set: (value: number) => {
      entry.readyState = value;
    },
    configurable: true,
  });
  Object.defineProperty(element, "paused", {
    value: true,
    writable: true,
    configurable: true,
  });
  made.push(entry);
  return entry;
}

/** The picture the element holds is the one on screen. */
function loaded(entry: Recorded | undefined): void {
  if (!entry) throw new Error("no element was made for that file");
  entry.readyState = 2;
  entry.element.dispatchEvent(new Event("loadeddata"));
}

/** The elements a file is read from, in the order they were made. */
function forAsset(id: AssetId): Recorded[] {
  return made.filter((entry) =>
    (entry.element.getAttribute("src") ?? "").endsWith(`/assets/${id}`),
  );
}

/**
 * Starts a run the way the room does: the first ask is answered with nothing —
 * jsdom has no loader to have given the element data — the picture arrives,
 * and the ask is made again.
 */
function start(
  engine: ElementEngine,
  asset: AssetId,
  clip: ClipId,
  materialMs: number,
  speed = 1,
): HTMLVideoElement | null {
  const first = engine.startPlaying(asset, clip, materialMs, speed);
  if (first) return first;
  loaded(forAsset(asset).at(-1));
  return engine.startPlaying(asset, clip, materialMs, speed);
}

const realCreate = Document.prototype.createElement;

beforeEach(() => {
  made.length = 0;
  loadCalls = 0;
  vi.spyOn(document, "createElement").mockImplementation(function (
    this: Document,
    tag: string,
  ) {
    const element = realCreate.call(this, tag);
    if (tag === "video") return record(element as HTMLVideoElement).element;
    return element;
  });
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(
    function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", {
        value: false,
        writable: true,
        configurable: true,
      });
      return Promise.resolve();
    },
  );
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(
    function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", {
        value: true,
        writable: true,
        configurable: true,
      });
    },
  );
  vi.spyOn(window.HTMLMediaElement.prototype, "load").mockImplementation(() => {
    loadCalls += 1;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the elements a file is read from", () => {
  it("carries the next piece of a cut on the element the file already has", () => {
    const engine = elementEngine();
    const asset = assetId("asset-cut");
    engine.beginFrame();
    const first = start(engine, asset, clipId("clip-1"), 0);
    expect(first).not.toBeNull();
    const element = forAsset(asset)[0];

    // The clock runs on, and the next piece of the same file arrives at a cut.
    engine.beginFrame();
    const second = start(engine, asset, clipId("clip-2"), 5_000);
    // One element, one load, and the new piece's first moment written into it.
    expect(second).toBe(first);
    expect(forAsset(asset)).toHaveLength(1);
    expect(loadCalls).toBe(1);
    expect(element.seeks).toEqual([0, 5]);
  });

  it("keeps a second asker apart when both ask in the same frame", () => {
    const engine = elementEngine();
    const asset = assetId("asset-seam");
    engine.beginFrame();
    const leader = start(engine, asset, clipId("leader"), 4_000);
    const follower = start(engine, asset, clipId("follower"), 0);
    expect(leader).not.toBeNull();
    expect(follower).not.toBeNull();
    // One element cannot stand at two moments: the far side has its own.
    expect(follower).not.toBe(leader);
    expect(forAsset(asset)).toHaveLength(2);

    // Every frame after this one, each side keeps the element it started with.
    engine.beginFrame();
    expect(engine.startPlaying(asset, clipId("leader"), 4_016, 1)).toBe(leader);
    expect(engine.startPlaying(asset, clipId("follower"), 16, 1)).toBe(
      follower,
    );
    const [leaderElement, followerElement] = forAsset(asset);
    expect(leaderElement.seeks).toEqual([4]);
    expect(followerElement.seeks).toEqual([0]);
  });

  it("leaves the other file's element alone when a new one is asked for", () => {
    const engine = elementEngine();
    const quiet = assetId("asset-quiet");
    engine.beginFrame();
    start(engine, quiet, clipId("quiet-clip"), 0);
    const quietElement = forAsset(quiet)[0];

    const busy = assetId("asset-busy");
    engine.beginFrame();
    start(engine, busy, clipId("busy-clip"), 0);
    expect(forAsset(busy)).toHaveLength(1);
    // Two files are well under the ceiling: nothing was given back.
    expect(forAsset(quiet)).toHaveLength(1);
    expect(quietElement.element.getAttribute("src")).not.toBeNull();
  });

  it("takes a prepared element up where it stands, without seeking again", () => {
    const engine = elementEngine();
    const asset = assetId("asset-prepared");
    engine.prepare(asset, 2_000);
    const element = forAsset(asset)[0];
    loaded(element);
    expect(element.seeks).toEqual([2]);

    // The run begins where the element was prepared: nothing to move.
    engine.beginFrame();
    const playing = engine.startPlaying(asset, clipId("clip"), 2_010, 1);
    expect(playing).toBe(element.element);
    expect(element.seeks).toEqual([2]);
  });

  it("moves a prepared element when the run begins somewhere else", () => {
    const engine = elementEngine();
    const asset = assetId("asset-prepared-late");
    engine.prepare(asset, 2_000);
    const element = forAsset(asset)[0];
    loaded(element);

    // The clock was moved before the cut arrived: the picture must not play on
    // from a place the room has left.
    engine.beginFrame();
    start(engine, asset, clipId("clip"), 4_000);
    expect(element.seeks).toEqual([2, 4]);
  });

  it("lets the claims go when the clock stops, and a still read takes the element", () => {
    const engine = elementEngine();
    const asset = assetId("asset-paused");
    engine.beginFrame();
    start(engine, asset, clipId("clip"), 0);
    const element = forAsset(asset)[0];

    engine.stopPlayback();
    // A stopped element is not playing and not claimed: a still read of the
    // file takes it rather than making an element of its own.
    expect(element.element.paused).toBe(true);
    engine.beginFrame();
    engine.elementFor(asset, 1_000);
    expect(forAsset(asset)).toHaveLength(1);
    expect(element.seeks).toEqual([0, 1]);
  });

  it("gives a still read the spare while a run is playing the file", () => {
    const engine = elementEngine();
    const asset = assetId("asset-still");
    engine.beginFrame();
    start(engine, asset, clipId("clip"), 3_000);
    const playing = forAsset(asset)[0];

    // A strip's own read of the same file must not drag the playing picture.
    engine.beginFrame();
    engine.elementFor(asset, 0);
    const still = forAsset(asset)[1];
    expect(still).toBeDefined();
    expect(still.seeks).toEqual([0]);
    expect(playing.seeks).toEqual([3]);
  });
});
