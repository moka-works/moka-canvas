import type { AssetId } from "../../../shared/domain";
import { assetUrl } from "../../../api";
import {
  openMp4,
  readRange,
  type Mp4Index,
  type Mp4Sample,
  type Mp4VideoTrack,
} from "./mp4";
import { planFor, sampleAt, type SampleChunk } from "./samplePlan";

/**
 * Frames straight out of the file, through WebCodecs.
 *
 * A decoder is asked for one frame at a time: the samples from a keyframe to
 * the moment are fetched as one window and handed over as chunks, the frame
 * that shows the moment is kept and the rest of the run is let go of as it
 * comes out. Two decoders are kept and shared, because a cut with two picture
 * tracks on screen at once is the case this exists for, and the frames
 * themselves live in a small cache with an eviction rule — dragging the
 * playhead across a second of video must not decode that second again for
 * every move of the pointer.
 *
 * An asset that cannot be decoded is remembered as such for the session, so
 * the element engine is asked for it rather than the same failure being
 * rediscovered on every frame. Frames belong to the cache: a caller draws from
 * one and never closes it.
 */

export interface DecodedPicture {
  frame: VideoFrame;
  /** What the display matrix asks for, in degrees; WebCodecs applies nothing itself. */
  rotationDeg: number;
}

const MAX_DECODERS = 2;
const MAX_CACHED_FRAMES = 240;
const MAX_CACHED_BYTES = 256 * 1024 * 1024;
/** How many of the newest frames are never evicted: one frame's worth of pictures, at most. */
const FRESH_FRAMES = 8;
/** How long one decode may take before it is given up on and the asset sent to the elements. */
const DECODE_TIMEOUT_MS = 8_000;

interface Slot {
  decoder: VideoDecoder;
  /** Where the job in flight's frames are collected; null between jobs. */
  sink: ((frame: VideoFrame) => void) | null;
  /** The job in flight, which the next caller on this decoder waits behind. */
  busy: Promise<VideoFrame | null> | null;
  /** Whether the job in flight failed, which its own await cannot always say. */
  failed: boolean;
  usedAt: number;
}

const slots: Slot[] = [];
const cache = new Map<string, { frame: VideoFrame; bytes: number }>();
let cachedBytes = 0;
/**
 * The assets this preview has given up decoding, and why where it knows.
 *
 * The why is the parser's own complaint, or nothing: a browser that has no
 * video decoder at all has no sentence to hand over, and a shrug written here
 * would be a reason-shaped hole.
 */
const elementOnly = new Map<AssetId, string | null>();

/** How big a frame is taken to be for the cache's ceiling. */
function frameBytes(frame: VideoFrame): number {
  try {
    // The frame's own answer, which some formats decline to give.
    return Math.max(0, frame.allocationSize());
  } catch {
    // A 4:2:0 plane and a half is what a decoded picture usually costs.
    return Math.round(frame.codedWidth * frame.codedHeight * 1.5);
  }
}

/** The configuration a video track is handed to a decoder with. */
function videoConfig(video: Mp4VideoTrack): VideoDecoderConfig {
  return {
    codec: video.codec,
    // The configuration record is written beside the samples, where there is one.
    description: video.description,
    codedWidth: video.width > 0 ? video.width : undefined,
    codedHeight: video.height > 0 ? video.height : undefined,
    optimizeForLatency: true,
  };
}

function cacheFrame(key: string, frame: VideoFrame): VideoFrame {
  const kept = cache.get(key);
  if (kept) {
    cache.delete(key);
    cachedBytes -= kept.bytes;
    kept.frame.close();
  }
  const bytes = frameBytes(frame);
  cache.set(key, { frame, bytes });
  cachedBytes += bytes;
  // Evicted oldest first, never one of the newest few — a composition in
  // flight may be holding those, and a frame handed to a caller is only
  // closed once nobody is drawing from it.
  const protectedKeys = new Set([...cache.keys()].slice(-FRESH_FRAMES));
  for (const [oldestKey, oldest] of [...cache]) {
    if (cache.size <= MAX_CACHED_FRAMES && cachedBytes <= MAX_CACHED_BYTES)
      break;
    if (protectedKeys.has(oldestKey)) continue;
    cache.delete(oldestKey);
    cachedBytes -= oldest.bytes;
    oldest.frame.close();
  }
  return frame;
}

function cached(key: string): VideoFrame | undefined {
  const kept = cache.get(key);
  if (!kept) return undefined;
  // A hit is the newest thing in the cache, so the sweep takes other frames first.
  cache.delete(key);
  cache.set(key, kept);
  return kept.frame;
}

function openSlot(): Slot {
  const slot: Slot = {
    decoder: null as unknown as VideoDecoder,
    sink: null,
    busy: null,
    failed: false,
    usedAt: 0,
  };
  slot.decoder = new VideoDecoder({
    // A frame that arrives with no job waiting for it is one nobody kept.
    output: (frame) => (slot.sink ? slot.sink(frame) : frame.close()),
    error: () => {
      // The failure is read from the job's own await, which is where it can be acted on.
      slot.failed = true;
    },
  });
  return slot;
}

/** A decoder to work on: an idle one, a free pool place, or the one idle longest. */
async function takeSlot(): Promise<Slot> {
  for (;;) {
    const idle = slots.filter((slot) => slot.busy === null);
    if (idle.length > 0) {
      const slot = idle.reduce((a, b) => (a.usedAt <= b.usedAt ? a : b));
      slot.usedAt = Date.now();
      return slot;
    }
    if (slots.length < MAX_DECODERS) {
      const slot = openSlot();
      slots.push(slot);
      slot.usedAt = Date.now();
      return slot;
    }
    // Both are working: wait for whichever finishes first, then look again.
    await Promise.race(slots.map((slot) => slot.busy ?? Promise.resolve()));
  }
}

/** A decoder that has stopped answering is closed and taken out of the pool. */
function dropSlot(slot: Slot): void {
  const at = slots.indexOf(slot);
  if (at >= 0) slots.splice(at, 1);
  try {
    slot.decoder.close();
  } catch {
    // A decoder already closed by its own error has nothing left to close.
  }
}

/** A promise, or null once the clock runs out: a decoder that stops answering is not waited on forever. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Where the reader is told the frames of an asset are out of reach. */
function elementOnlyNow(assetId: AssetId, reason: string | null = null): void {
  elementOnly.set(assetId, reason);
}

/** How many reads may fail for a reason that may pass before an asset is handed to the elements. */
const MAX_TRANSIENT_FAILURES = 3;

/**
 * The assets whose reads have failed for reasons that may pass, and how often.
 *
 * A fetch that timed out, a decoder that stumbled under contention: these are
 * the failures a busy preview meets in ordinary use, and holding one against
 * an asset for the session would send a perfectly decodable file to the
 * elements for good. They are counted instead, and only a run of them — never
 * a single bad moment — rules the file out.
 */
const transientFailures = new Map<AssetId, number>();

/** A read that failed for a reason that may pass: counted, and only a run of them rules the asset out. */
function transient(assetId: AssetId, detail: string): void {
  const count = (transientFailures.get(assetId) ?? 0) + 1;
  transientFailures.set(assetId, count);
  if (count >= MAX_TRANSIENT_FAILURES) elementOnlyNow(assetId, detail);
}

/** A read that succeeded: whatever went wrong before was this moment's trouble, not the file's. */
function cleared(assetId: AssetId): void {
  transientFailures.delete(assetId);
}

/**
 * Gives every asset its recoverable failures back.
 *
 * Called when playback stops: a new run is a new chance for the decode path,
 * and only the files that are unreadable on their own terms stay ruled out.
 */
export function resetTransientFailures(): void {
  transientFailures.clear();
}

/** Whether decode has been ruled out for an asset this session. */
export function isElementOnly(assetId: AssetId): boolean {
  return elementOnly.has(assetId);
}

/**
 * Why decode was ruled out for an asset, where the parser said why.
 *
 * Read by the report a reader sees: "「clip.mp4」读不出来" says what
 * happened and not why, and the parser's own words are the half that can be
 * acted on — or handed to somebody who can.
 */
export function elementOnlyReason(assetId: AssetId): string | undefined {
  return elementOnly.get(assetId) ?? undefined;
}

/**
 * An asset's index, or null when the file cannot be read as an MP4 this
 * preview decodes.
 *
 * A file that will not parse is not asked about again: the element engine owns
 * it from here, and which degradation is on screen is the stage's business
 * rather than a console's.
 */
export async function mp4IndexFor(assetId: AssetId): Promise<Mp4Index | null> {
  if (elementOnly.has(assetId)) return null;
  try {
    return await openMp4(assetUrl(assetId), { assetId });
  } catch (problem) {
    elementOnlyNow(
      assetId,
      problem instanceof Error ? problem.message : String(problem),
    );
    return null;
  }
}

async function decodeOn(
  slot: Slot,
  assetId: AssetId,
  index: Mp4Index,
  materialMs: number,
): Promise<VideoFrame | null> {
  const video = index.video;
  if (!video) return null;
  const plan = planFor(video, materialMs);
  if (!plan) return null;
  const wanted = video.samples[plan.target];
  const key = `${assetId}:${wanted.ctsUs}`;
  const kept = cached(key);
  if (kept) return kept;

  const config: VideoDecoderConfig = videoConfig(video);
  const support = await VideoDecoder.isConfigSupported(config).catch(
    () => null,
  );
  if (!support?.supported) {
    elementOnlyNow(assetId);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DECODE_TIMEOUT_MS);
  let hit: VideoFrame | null = null;
  let stopped = false;
  /** Why this read did not succeed, in the terms the failure is counted in. */
  let why = "The decode did not answer";
  try {
    const fetched = await readRange(
      assetUrl(assetId),
      plan.startOffset,
      plan.endOffset,
      controller.signal,
    );
    const bytes = fetched.bytes;
    slot.failed = false;
    slot.sink = (frame) => {
      if (frame.timestamp === wanted.ctsUs && hit === null) hit = frame;
      else frame.close();
    };
    // A reset decoder starts from a keyframe, which is the plan's first chunk.
    slot.decoder.reset();
    slot.decoder.configure(config);
    for (const chunk of plan.chunks) {
      const at = chunk.offset - plan.startOffset;
      slot.decoder.decode(
        new EncodedVideoChunk({
          type: chunk.key ? "key" : "delta",
          timestamp: chunk.ctsUs,
          // The sample's own place in the window; the chunk takes its copy.
          data: bytes.subarray(at, at + chunk.size),
        }),
      );
    }
    // The frame wanted waits for the flush, which is where a decode order that
    // reaches back for a B-frame finally comes out.
    const flushed = await withDeadline(
      slot.decoder.flush().then(
        () => true,
        () => false,
      ),
      DECODE_TIMEOUT_MS,
    );
    // A run that stopped answering, failed, or produced nothing at all is a
    // read that did not succeed: counted, and a run of them hands the file to
    // the elements — one bad moment under load is not the file's verdict.
    if (flushed === null) why = "The decoder did not answer in time";
    else if (slot.failed) why = "The decoder failed on the run";
    else if (hit === null) why = "No frame came out of the run";
    if (flushed === null || slot.failed || hit === null) {
      stopped = true;
      return null;
    }
    cleared(assetId);
    return cacheFrame(key, hit);
  } catch (problem) {
    stopped = true;
    why = problem instanceof Error ? problem.message : String(problem);
    return null;
  } finally {
    clearTimeout(timer);
    slot.sink = null;
    if (stopped) {
      transient(assetId, why);
      if (!hit) dropSlot(slot);
    }
  }
}

/**
 * The reads in flight, by asset and target sample.
 *
 * Several paints can ask for the same frame at once — a fresh seek repaints
 * the ruler and the stage in the same turn — and one decode is enough for all
 * of them: the second caller waits on the first's promise rather than
 * competing for a decoder with it, which is what made concurrent reads fail
 * each other in the first place.
 */
const inFlight = new Map<string, Promise<DecodedPicture | null>>();

/**
 * A frame for a material moment, or null when this asset cannot be decoded.
 *
 * The frame belongs to the cache: it is drawn with and never closed by the
 * caller, and a key it was stored under is a frame a later call gets back.
 */
export async function decodeFrameAt(
  assetId: AssetId,
  materialMs: number,
): Promise<DecodedPicture | null> {
  if (elementOnly.has(assetId)) return null;
  const index = await mp4IndexFor(assetId);
  const video = index?.video;
  if (!index || !video) return null;
  if (typeof VideoDecoder === "undefined") {
    elementOnlyNow(assetId);
    return null;
  }
  const plan = planFor(video, materialMs);
  if (!plan) return null;
  const wanted = video.samples[plan.target];
  const key = `${assetId}:${wanted.ctsUs}`;
  const kept = cached(key);
  if (kept) return { frame: kept, rotationDeg: video.rotationDeg };
  const running = inFlight.get(key);
  if (running) return running;
  const job = (async () => {
    const slot = await takeSlot();
    slot.busy = decodeOn(slot, assetId, index, materialMs);
    try {
      const frame = await slot.busy;
      if (!frame) return null;
      return { frame, rotationDeg: video.rotationDeg };
    } finally {
      slot.busy = null;
    }
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, job);
  return job;
}

// ---------------------------------------------------------------------------
// Playing a file forward
// ---------------------------------------------------------------------------

/** How far ahead of the consumer the pump fetches, so the next second is in hand. */
const STREAM_PREFETCH_MS = 2_000;
/**
 * How far past the consumer's moment a run may decode before it waits.
 *
 * A decoder handed a whole window bursts through it in a frame's time, and
 * frames arriving ahead of the picture are frames the paints in between will
 * need; the run is held to a short lead instead of racing to the window's end.
 */
const STREAM_LEAD_MS = 500;
/** The most frames a run keeps for the consumer; a ceiling the lead stays far under. */
const STREAM_QUEUE_LIMIT = 32;
/** How long a run waits for the consumer before it looks again. */
const STREAM_WAIT_MS = 100;

interface QueuedFrame {
  ctsUs: number;
  frame: VideoFrame;
}

/** A window of samples and the bytes they read from. */
interface StreamWindow {
  bytes: Uint8Array;
  chunks: SampleChunk[];
  /** Where the window's bytes begin in the file. */
  startOffset: number;
  index: number;
}

/**
 * A run of frames fed forward in order, for playing rather than seeking.
 *
 * Random access re-decodes a whole GOP for every frame asked for, which at
 * thirty frames a second is the same group decoded thirty times over; a
 * playing clip instead starts at the keyframe its moment sits behind and is
 * fed sample after sample, one small fetch per couple of seconds. The run
 * decodes only a short lead past the moment the consumer last asked about —
 * the pumps' own doing, not a decoder's pace, since a burst would otherwise
 * run through a window's frames and leave the queue holding moments the
 * picture has not reached while the moments in between are let go of — and an
 * empty queue reuses the frame last drawn rather than blocking the compositor
 * on a decode.
 *
 * The stream owns its decoder for as long as it runs: a decoder handed back
 * between windows would have to start over from a keyframe every time, which
 * is the very cost this exists to avoid. When the file runs out, fails, or is
 * asked to close — a pause, a seek, another clip — every frame it holds is
 * closed with it.
 */
export interface FrameStream {
  /**
   * The frame showing a material moment, or null while one is on its way.
   *
   * The frame belongs to the stream: it is drawn with and not closed by the
   * caller, and it stands until a newer one covers the moment.
   */
  frameAt(materialMs: number): DecodedPicture | null;
  /** Whether the pump has given up; the still path takes the file from here. */
  readonly failed: boolean;
  /** Stops the pump and lets go of every frame it holds. */
  close(): void;
}

class SequentialStream implements FrameStream {
  readonly assetId: AssetId;
  readonly fromMs: number;
  private readonly abort = new AbortController();
  private samples: Mp4Sample[] = [];
  private decoder: VideoDecoder | null = null;
  private window: StreamWindow | null = null;
  /** The next sample to fetch, one past the window in hand. */
  private next = 0;
  private rotationDeg = 0;
  private queue: QueuedFrame[] = [];
  /** Frames already drawn with, newest last; two deep, so a paint is never cut short. */
  private handed: QueuedFrame[] = [];
  /**
   * The moment the consumer last asked about, in microseconds.
   *
   * This is the anchor the lead is measured from: the pump decodes ahead of
   * the picture, not of the run's own head, so a paint always finds the frame
   * covering its moment waiting rather than already let go of.
   */
  private lastTargetUs = 0;
  /** Woken when the consumer moves, which is the pump's room to make more. */
  private room: (() => void) | null = null;
  private closed = false;
  private gaveUp = false;

  constructor(assetId: AssetId, fromMs: number) {
    this.assetId = assetId;
    this.fromMs = fromMs;
    this.lastTargetUs = Math.round(fromMs * 1_000);
  }

  get failed(): boolean {
    return this.gaveUp;
  }

  /** Opens the file and starts the pump; nothing is thrown into a frame's way. */
  start(): void {
    void this.open();
  }

  frameAt(materialMs: number): DecodedPicture | null {
    if (this.closed) return null;
    const targetUs = Math.round(materialMs * 1_000);
    // Where the picture stands is where the lead is measured from, so the
    // moving moment reaches the pump through this one write.
    this.lastTargetUs = targetUs;
    // The covering frame is the last whose presentation time has arrived;
    // frames behind it are let go of, and those ahead keep waiting.
    let covered: QueuedFrame | null = null;
    while (this.queue.length > 0 && this.queue[0].ctsUs <= targetUs) {
      const arriving = this.queue.shift() as QueuedFrame;
      if (covered) covered.frame.close();
      covered = arriving;
    }
    if (covered) this.keep(covered);
    // A moved moment is what a waiting pump is waiting for, whether or not a
    // frame was ready for it: the lead runs on behind the picture.
    this.wake();
    const shown = this.handed[this.handed.length - 1];
    // An empty queue reuses the frame last drawn: a decode in flight is a
    // reason to hold a picture, not a reason to go black.
    return shown ? { frame: shown.frame, rotationDeg: this.rotationDeg } : null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.wake();
    try {
      this.decoder?.close();
    } catch {
      // A decoder already closed by its own error has nothing left to close.
    }
    this.decoder = null;
    for (const queued of this.queue) queued.frame.close();
    this.queue = [];
    for (const kept of this.handed) kept.frame.close();
    this.handed = [];
  }

  /** The frame is handed out; the one before it is let go of once a newer paint is safe. */
  private keep(frame: QueuedFrame): void {
    const previous = this.handed[this.handed.length - 1];
    if (previous && previous !== frame) previous.frame.close();
    this.handed = [frame];
  }

  private wake(): void {
    const resolve = this.room;
    this.room = null;
    resolve?.();
  }

  /**
   * Waits until the consumer has moved, or briefly, so the loop can look again.
   *
   * The wait is what holds the run's lead: a paint at every frame moves the
   * moment and wakes it, and the check after each wait is what decides how
   * much more there is room for. The short fallback exists so a consumer that
   * has stopped asking — a stall, a paint dropped for a newer one — cannot
   * leave the pump waiting on news that will not come while it holds frames
   * the picture may already be owed.
   */
  private async waitForConsumer(): Promise<void> {
    const moved = new Promise<void>((resolve) => {
      this.room = resolve;
    });
    await Promise.race([
      moved,
      new Promise<void>((resolve) => {
        setTimeout(resolve, STREAM_WAIT_MS);
      }),
    ]);
    this.room = null;
  }

  /** A file this run cannot read at all: the elements own it from here on. */
  private unreadable(): void {
    elementOnlyNow(this.assetId);
    this.stop();
  }

  /**
   * A read that failed for a reason that may pass.
   *
   * This run is over — the still path and the elements read the frame in the
   * meantime — but the file is not held against, and the next playback gives
   * the decode path a fresh run at it.
   */
  private stumble(why: string): void {
    transient(this.assetId, why);
    this.stop();
  }

  private stop(): void {
    this.gaveUp = true;
    this.close();
  }

  private async open(): Promise<void> {
    try {
      const index = await mp4IndexFor(this.assetId);
      if (this.closed) return;
      const video = index?.video;
      if (
        !video ||
        video.samples.length === 0 ||
        typeof VideoDecoder === "undefined"
      ) {
        this.unreadable();
        return;
      }
      const config = videoConfig(video);
      const support = await VideoDecoder.isConfigSupported(config).catch(
        () => null,
      );
      if (this.closed) return;
      if (!support?.supported) {
        this.unreadable();
        return;
      }
      this.rotationDeg = video.rotationDeg;
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: () => this.stumble("The decoder failed on the run"),
      });
      this.decoder.configure(config);
      // A run starts where decoding can: back to the keyframe the moment sits
      // behind, since a mid-GOP start decodes to noise until the next one.
      const target = sampleAt(video.samples, this.fromMs);
      if (target < 0) {
        this.unreadable();
        return;
      }
      this.samples = video.samples;
      this.next = target;
      while (this.next > 0 && !this.samples[this.next].key) this.next -= 1;
      void this.pump();
    } catch {
      // A file that will not open for a stream is a file the stills own — and
      // one the parser has already named, where it has a name for it.
      this.unreadable();
    }
  }

  private onFrame(frame: VideoFrame): void {
    if (this.closed) {
      frame.close();
      return;
    }
    // A frame out is the run working: earlier trouble was the moment's, not the file's.
    cleared(this.assetId);
    // A B-frame run arrives out of decode order and the moment is found by
    // presentation time, so the queue is kept in that order.
    let at = this.queue.length;
    while (at > 0 && this.queue[at - 1].ctsUs > frame.timestamp) at -= 1;
    this.queue.splice(at, 0, { ctsUs: frame.timestamp, frame });
    // A ceiling rather than the working size: the lead keeps the queue far
    // under it, and a run past it has outpaced the picture entirely, so the
    // frames nearest the run's own head go first.
    while (this.queue.length > STREAM_QUEUE_LIMIT) {
      (this.queue.shift() as QueuedFrame).frame.close();
    }
    this.wake();
  }

  private async pump(): Promise<void> {
    while (!this.closed && this.decoder) {
      // Nothing is handed over while the run already holds more than the lead
      // past the picture allows. Checking here, before each frame, is what
      // keeps a fast decoder from bursting through a window: the frames it
      // would make are the ones the next paints need, and a queue that raced
      // ahead of them would be holding only the window's tail.
      const next = this.nextMomentUs();
      const ahead =
        next !== null && next - this.lastTargetUs > STREAM_LEAD_MS * 1_000;
      if (this.queue.length >= STREAM_QUEUE_LIMIT || ahead) {
        await this.waitForConsumer();
        continue;
      }
      let chunk: EncodedVideoChunk | null;
      try {
        chunk = await this.nextChunk();
      } catch (problem) {
        // A fetch that failed mid-run ends the run; the stills take over, and
        // the file is not held against for a connection that did not answer.
        this.stumble(
          problem instanceof Error ? problem.message : String(problem),
        );
        return;
      }
      if (this.closed) return;
      if (!chunk) {
        // The file's end: what the decoder still holds is flushed out, and
        // the queue is all the stream has left to give.
        try {
          await this.decoder.flush();
        } catch {
          // A flush that fails has nothing left to flush.
        }
        return;
      }
      try {
        this.decoder.decode(chunk);
      } catch {
        this.stumble("The decoder refused a chunk mid-run");
        return;
      }
    }
  }

  /**
   * The presentation time of the chunk the run would hand over next, or null
   * at the file's end.
   *
   * Read where the next chunk really is — the window in hand comes before the
   * samples still to fetch — so the lead is measured from the frame about to
   * be decoded rather than from somewhere past a window's worth of it.
   */
  private nextMomentUs(): number | null {
    if (this.window && this.window.index < this.window.chunks.length)
      return this.window.chunks[this.window.index].ctsUs;
    const sample = this.samples[this.next];
    return sample ? sample.ctsUs : null;
  }

  /** The next chunk to hand over, fetching the next window when the one in hand runs out. */
  private async nextChunk(): Promise<EncodedVideoChunk | null> {
    for (;;) {
      if (this.window && this.window.index < this.window.chunks.length) {
        const chunk = this.window.chunks[this.window.index];
        this.window.index += 1;
        const at = chunk.offset - this.window.startOffset;
        return new EncodedVideoChunk({
          type: chunk.key ? "key" : "delta",
          timestamp: chunk.ctsUs,
          // The sample's own place in the window; the chunk takes its copy.
          data: this.window.bytes.subarray(at, at + chunk.size),
        });
      }
      if (this.next >= this.samples.length) return null;
      await this.fetchWindow();
      if (this.closed) return null;
    }
  }

  /** Fetches one window of the run: its bytes and the samples that read them. */
  private async fetchWindow(): Promise<void> {
    const first = this.samples[this.next];
    const chunks: SampleChunk[] = [];
    let endOffset = first.offset;
    for (let index = this.next; index < this.samples.length; index += 1) {
      const sample = this.samples[index];
      chunks.push({
        offset: sample.offset,
        size: sample.size,
        dtsUs: sample.dtsUs,
        ctsUs: sample.ctsUs,
        key: sample.key,
      });
      endOffset = Math.max(endOffset, sample.offset + sample.size);
      // At least one sample a window, and no more than the prefetch beyond it.
      if (
        index > this.next &&
        sample.ctsUs - first.ctsUs >= STREAM_PREFETCH_MS * 1_000
      )
        break;
    }
    const fetched = await readRange(
      assetUrl(this.assetId),
      first.offset,
      endOffset,
      this.abort.signal,
    );
    this.window = {
      bytes: fetched.bytes,
      chunks,
      startOffset: first.offset,
      index: 0,
    };
    this.next += chunks.length;
  }
}

/**
 * A run of frames from a material moment, starting at the keyframe behind it.
 *
 * Null is a file the still path has to read: an asset already known to need
 * the elements, a browser without a decoder. The stream is left open until it
 * is closed — a pause, a seek, another clip — and whatever it still holds is
 * closed with it.
 */
export function streamFrom(
  assetId: AssetId,
  fromMs: number,
): FrameStream | null {
  if (elementOnly.has(assetId)) return null;
  if (typeof VideoDecoder === "undefined") {
    elementOnlyNow(assetId);
    return null;
  }
  const stream = new SequentialStream(assetId, fromMs);
  stream.start();
  return stream;
}
