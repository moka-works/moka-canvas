// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetId } from "../../../shared/domain";
import {
  decodeFrameAt,
  elementOnlyReason,
  isElementOnly,
  mp4IndexFor,
  resetTransientFailures,
  streamFrom,
} from "./decode";

/**
 * What a reader is told when a file cannot be decoded, and what a busy preview
 * is allowed to hold against one.
 *
 * The stage falls back to the element engine either way, so what this layer
 * owes anybody is the sentence under the notice — the parser's own complaint
 * where there is a parser to have one — and the promise not to keep asking.
 * Its other duty is the quieter one: a read that failed once under load is not
 * a file's verdict, and only a run of them hands it to the elements.
 */

const notAnMp4 = (id: string) => id as AssetId;

const fetchMock = vi.fn<typeof fetch>();

/** The suite's long-GOP fixture, whose sample tables every fake decode reads. */
const fixture = new Uint8Array(readFileSync("e2e/fixtures/longgop.mp4"));

// ---------------------------------------------------------------------------
// A decoder the tests drive, in place of the browser's own
// ---------------------------------------------------------------------------

/** What the fake decoder does when it is handed a run. */
let mode: "frames" | "silent" | "unsupported" = "frames";
/** How many chunk decodes were asked for, and how many decoders were made. */
let decodes = 0;
let decoders = 0;
/** The material moment the run has decoded up to, in milliseconds. */
let headMs = 0;

/** As much of a frame as the cache touches. */
function frameAt(timestamp: number): VideoFrame {
  return {
    timestamp,
    codedWidth: 320,
    codedHeight: 180,
    displayWidth: 320,
    displayHeight: 180,
    allocationSize: () => 16,
    close: () => undefined,
  } as unknown as VideoFrame;
}

class FakeChunk {
  type: string;
  timestamp: number;
  data: Uint8Array;
  constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}

class FakeDecoder {
  private readonly output: (frame: VideoFrame) => void;
  constructor(init: {
    output: (frame: VideoFrame) => void;
    error: (error: Error) => void;
  }) {
    decoders += 1;
    this.output = init.output;
  }
  static async isConfigSupported(): Promise<{ supported: boolean }> {
    return { supported: mode !== "unsupported" };
  }
  configure(): void {}
  reset(): void {}
  decode(chunk: FakeChunk): void {
    decodes += 1;
    // What the run has reached, in material milliseconds, for tests that read
    // how far a lead let the pump work.
    headMs = chunk.timestamp / 1_000;
    // A frame out for every chunk is a run that works; silence is a run that
    // produced nothing, which is the read that failed without saying so.
    if (mode === "frames") this.output(frameAt(chunk.timestamp));
  }
  async flush(): Promise<void> {}
  close(): void {}
}

/** Waits until what a test is watching has happened, or the clock runs out. */
async function settle(ready: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!ready() && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Serves the fixture's bytes by range, whatever URL is asked for. */
function serveFixture(): void {
  fetchMock.mockImplementation((_input, init) => {
    const range = new Headers(init?.headers).get("Range");
    const match = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
    if (!match)
      return Promise.resolve(
        new Response(fixture as unknown as BodyInit, { status: 200 }),
      );
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]) + 1, fixture.byteLength);
    return Promise.resolve(
      new Response(fixture.subarray(start, end) as unknown as BodyInit, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end - 1}/${fixture.byteLength}`,
        },
      }),
    );
  });
}

beforeEach(() => {
  mode = "frames";
  decodes = 0;
  decoders = 0;
  headMs = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(new Uint8Array([0, 0, 0, 4, 0x6a, 0x75, 0x6e, 0x6b]), {
        status: 200,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", FakeChunk);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an asset the decoder gave up on", () => {
  it("keeps the parser's complaint, and does not ask a second time", async () => {
    const assetId = notAnMp4("asset-not-an-mp4");

    expect(await mp4IndexFor(assetId)).toBeNull();
    expect(isElementOnly(assetId)).toBe(true);
    const said = elementOnlyReason(assetId);
    expect(said).toBeTruthy();
    expect(said).not.toContain("undefined");

    // Ruled out for the session: the elements own it now, and the reason it
    // was handed over is still there to be said.
    await mp4IndexFor(assetId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elementOnlyReason(assetId)).toBe(said);
  });

  it("says nothing about an asset nobody has tried to decode", () => {
    const assetId = notAnMp4("asset-not-looked-at");

    expect(isElementOnly(assetId)).toBe(false);
    expect(elementOnlyReason(assetId)).toBeUndefined();
  });
});

describe("the failures a busy preview meets", () => {
  it("reads a frame from the fixture's samples when the decoder works", async () => {
    serveFixture();
    const assetId = notAnMp4("asset-reads-fine");

    const picture = await decodeFrameAt(assetId, 1_500);
    expect(picture).not.toBeNull();
    expect(picture?.frame.displayWidth).toBe(320);
    // The moment is deep in the file's one group: the whole run was decoded.
    expect(decodes).toBeGreaterThan(1);
  });

  it("does not hold one empty read against the file", async () => {
    serveFixture();
    const assetId = notAnMp4("asset-one-miss");
    mode = "silent";

    expect(await decodeFrameAt(assetId, 1_500)).toBeNull();
    expect(isElementOnly(assetId)).toBe(false);
    expect(elementOnlyReason(assetId)).toBeUndefined();

    // The next ask goes to the decoder again, rather than living with the miss.
    const reads = fetchMock.mock.calls.length;
    expect(await decodeFrameAt(assetId, 2_500)).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(reads);
  });

  it("hands the file to the elements after a run of empty reads, and says why", async () => {
    serveFixture();
    const assetId = notAnMp4("asset-three-misses");
    mode = "silent";

    for (const materialMs of [500, 1_500, 2_500])
      expect(await decodeFrameAt(assetId, materialMs)).toBeNull();
    expect(isElementOnly(assetId)).toBe(true);
    expect(elementOnlyReason(assetId)).toContain(
      "No frame came out of the run",
    );

    // Ruled out now: the file is not read a fourth time.
    const reads = fetchMock.mock.calls.length;
    expect(await decodeFrameAt(assetId, 3_500)).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(reads);
  });

  it("rules a file out at once when the browser has no decoder for its codec", async () => {
    serveFixture();
    const assetId = notAnMp4("asset-no-codec");
    mode = "unsupported";

    expect(await decodeFrameAt(assetId, 1_500)).toBeNull();
    // Nothing about this can pass on a later try: the file is the elements'.
    expect(isElementOnly(assetId)).toBe(true);
    expect(decodes).toBe(0);
  });

  it("gives the failures back when the clock stops, and on a read that works", async () => {
    serveFixture();
    const assetId = notAnMp4("asset-forgiven");
    mode = "silent";

    await decodeFrameAt(assetId, 1_500);
    await decodeFrameAt(assetId, 2_500);
    // A stopped clock is the seam between two playbacks: the count starts over.
    resetTransientFailures();
    await decodeFrameAt(assetId, 3_000);
    expect(isElementOnly(assetId)).toBe(false);

    // A read that works clears what went wrong before it, so two more misses
    // after one are two, not four: still short of the run that rules a file out.
    mode = "frames";
    expect(await decodeFrameAt(assetId, 3_500)).not.toBeNull();
    mode = "silent";
    await decodeFrameAt(assetId, 1_500);
    await decodeFrameAt(assetId, 500);
    expect(isElementOnly(assetId)).toBe(false);
  });

  it("works from the clock, and never further than its ceiling", async () => {
    serveFixture();
    const assetId = notAnMp4("asset-clocked");
    const stream = streamFrom(assetId, 0);
    expect(stream).not.toBeNull();
    // The picture asks for the very head of the file while the clock stands a
    // second and a half in: the run works from the clock, so the frames under
    // the playhead are decoded before they are asked about.
    stream?.frameAt(0, 1_500);
    // The run fills to whichever ceiling comes first: the lead's two seconds
    // past the clock, or the queue's own thirty-two frames — which for this
    // fixture, ten frames a second, is the queue's.
    await settle(() => headMs >= 3_000 || (stream?.failed ?? true), 2_000);
    // The floor the clock leaves behind: at least a second of frames past it.
    expect(headMs).toBeGreaterThanOrEqual(2_500);
    expect(headMs).toBeLessThanOrEqual(3_200);
    stream?.close();
  });

  it("does not walk a run back when the picture is behind the clock", async () => {
    serveFixture();
    const assetId = notAnMp4("asset-clocked-back");
    const stream = streamFrom(assetId, 0);
    stream?.frameAt(0, 1_500);
    await settle(() => headMs >= 3_000, 2_000);
    const reached = headMs;
    // A stale paint asks about an earlier moment than the clock: the run is
    // not dragged back, and nothing more is decoded on its account.
    stream?.frameAt(0, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(headMs).toBe(reached);
    stream?.close();
  });

  it("runs one decode however many paints ask for the same frame", async () => {
    serveFixture();
    const assetId = notAnMp4("asset-shared-read");
    decodes = 0;

    const asked = await Promise.all([
      decodeFrameAt(assetId, 3_500),
      decodeFrameAt(assetId, 3_500),
      decodeFrameAt(assetId, 3_500),
    ]);
    expect(asked[0]).not.toBeNull();
    // One frame, handed to all three: the second and third waited on the
    // first's read rather than competing for a decoder with it.
    expect(asked[1]).toBe(asked[0]);
    expect(asked[2]).toBe(asked[0]);
    // No second decoder was made for them, and the group was crossed once:
    // three jobs would have decoded its thirty-six chunks three times over.
    expect(decoders).toBeLessThanOrEqual(1);
    expect(decodes).toBeGreaterThan(30);
    expect(decodes).toBeLessThan(45);
  });
});
