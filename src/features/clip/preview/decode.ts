import type { AssetId } from "../../../shared/domain";
import { assetUrl } from "../../../api";
import {
  openMp4,
  readRange,
  type Mp4Index,
  type Mp4Sample,
  type Mp4VideoTrack,
} from "./mp4";
import {
  planFor,
  sampleAt,
  type SampleChunk,
  type SamplePlan,
} from "./samplePlan";

/**
 * Frames straight out of the file, through WebCodecs.
 *
 * A still is read by a run fed forward from the keyframe the moment sits
 * behind: the samples between are fetched and handed over once, and the frame
 * that shows the moment is kept — in a small shared cache with an eviction
 * rule, since a moment drawn once is one a later paint asks for again. A drag
 * asks for a new moment every paint, so each file keeps its run between the
 * asks of one drag: a further moment costs only the samples between it and the
 * last, never the whole group over again.
 *
 * Two decoders are shared between the files being read, which is what a cut
 * with two picture tracks on screen at once needs; a file whose asks have
 * stopped offers its decoder up as soon as another file wants one. An asset
 * that cannot be decoded is remembered as such for the session, so the element
 * engine is asked for it rather than the same failure being rediscovered on
 * every frame. Frames belong to the cache: a caller draws from one and never
 * closes it.
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
  /** Where the holder's frames are delivered; null while the slot is free. */
  sink: ((frame: VideoFrame) => void) | null;
  /** The reader holding this decoder, or null while it is free to lend. */
  loan: Loan | null;
  /** Whether the decoder failed on the run it was last given. */
  failed: boolean;
  usedAt: number;
}

/** One reader's hold on a decoder, given back by the reader or on request. */
interface Loan {
  /** Resolved when the slot is given back, whichever way it went. */
  held: Promise<void>;
  freed: boolean;
  /** Lets the slot go when the holder has nothing in flight; false when it has. */
  yieldTo: () => boolean;
  /** Gives the slot back: nothing more is delivered on it, and it can be lent. */
  give(): void;
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
    loan: null,
    failed: false,
    usedAt: 0,
  };
  slot.decoder = new VideoDecoder({
    // A frame that arrives with no holder waiting for it is one nobody kept.
    output: (frame) => (slot.sink ? slot.sink(frame) : frame.close()),
    error: () => {
      // The failure is read from the run's own await, which is where it can be acted on.
      slot.failed = true;
    },
  });
  return slot;
}

/**
 * Hands a decoder over to one reader, held until the reader gives it back.
 *
 * The hold is what keeps a run warm between the asks of a drag — the decoder
 * is not re-lent and reconfigured under it — and the loan is what lets a file
 * that has stopped asking offer its decoder up instead of keeping it from a
 * file that is being read now.
 */
function lend(slot: Slot): Slot {
  let resolveHeld = (): void => undefined;
  const loan: Loan = {
    held: new Promise((resolve) => {
      resolveHeld = resolve;
    }),
    freed: false,
    yieldTo: () => false,
    give() {
      if (loan.freed) return;
      loan.freed = true;
      slot.loan = null;
      slot.sink = null;
      resolveHeld();
    },
  };
  slot.usedAt = Date.now();
  slot.loan = loan;
  return slot;
}

/** A decoder to work on: a free one, a free pool place, or an idle holder's offered up. */
async function takeSlot(): Promise<Slot> {
  for (;;) {
    const free = slots.filter((slot) => slot.loan === null);
    if (free.length > 0)
      return lend(free.reduce((a, b) => (a.usedAt <= b.usedAt ? a : b)));
    if (slots.length < MAX_DECODERS) {
      const slot = openSlot();
      slots.push(slot);
      return lend(slot);
    }
    // Every decoder is in use: one held with nothing in flight lets its own go
    // before anyone waits on a decoder that is working.
    if (slots.some((slot) => slot.loan?.yieldTo())) continue;
    // All of them are working: wait for whichever finishes first, then look again.
    await Promise.race(
      slots.map((slot) => slot.loan?.held ?? Promise.resolve()),
    );
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

// ---------------------------------------------------------------------------
// Reading stills, a run per file
// ---------------------------------------------------------------------------

/** How many frames past the target a read hands over: the reorder depth it covers. */
const SEEK_REORDER_AHEAD = 4;
/** How long a read waits for its frame before the flush fallback is asked. */
const SEEK_HOLD_MS = 250;

/**
 * The assets a decoder has said it takes.
 *
 * The question is asked once per file: its answer does not change between the
 * reads of a drag, and a drag is the reads this exists for. A file the decoder
 * says it cannot take is not remembered here but ruled out for the session,
 * which is a stronger thing than a cached no.
 */
const codecAccepted = new Set<AssetId>();

/** One read of one moment, and the callers waiting on it. */
interface Ask {
  readonly plan: SamplePlan;
  /** The presentation time of the sample that shows the moment. */
  readonly ctsUs: number;
  /** Set when a newer ask became the one being read: this moment is passed over. */
  superseded: boolean;
  /** Set when the frame this ask wants has come out of the run. */
  arrived: boolean;
  /** Set once the waiters have been answered. */
  done: boolean;
  waiters: ((picture: DecodedPicture | null) => void)[];
}

/**
 * The asks one file's stills are answered from, and the run they share.
 *
 * A drag is a stream of reads of one file, and every read after the first has
 * no whole group to decode: the run stays where the last one left it — at the
 * keyframe the moments sit behind, fed forward to the target — and a further
 * moment costs only the samples between. One read of one file is in hand at a
 * time: a read arriving while another is in hand is the newer reading, the ask
 * it passed is told so, and the run carries on to the newer moment rather than
 * starting the group over.
 *
 * The decoder is held across the asks of a drag and offered up the moment
 * anybody else wants one, so a file nobody is reading does not keep a decoder
 * from a file that is.
 */
class StillPipeline {
  private readonly assetId: AssetId;
  private readonly video: Mp4VideoTrack;
  /** The decoder in hand; null between giving one up and the next ask. */
  private slot: Slot | null = null;
  /** The keyframe the run began at, or -1 with no run. */
  private runStart = -1;
  /** The last sample the run was fed, or -1 before its first. */
  private fed = -1;
  /** The moments fed whose frames have not come out yet. */
  private readonly owed = new Set<number>();
  /** The ask being read; the frames arriving on the slot belong to it. */
  private serving: Ask | null = null;
  /** The asks waiting a turn, oldest first; only the newest is read. */
  private pending: Ask[] = [];
  private driving = false;
  /** The read in flight, cut only for a newer moment in another group. */
  private fetch: AbortController | null = null;
  /** Whether the read in flight was cut by its own clock rather than a newer ask. */
  private timedOut = false;
  /** Woken when the frame the served ask waits for arrives. */
  private wake: (() => void) | null = null;

  constructor(assetId: AssetId, video: Mp4VideoTrack) {
    this.assetId = assetId;
    this.video = video;
  }

  /**
   * The frame showing a moment, or null when the moment was passed over.
   *
   * A frame already decoded is the answer at once; otherwise the moment is
   * registered as the one to read and the caller waits. Null is not a failure:
   * it is a moment a newer read has taken the place of, and the paint that
   * asked for it is a paint drawing from the past.
   */
  ask(plan: SamplePlan): Promise<DecodedPicture | null> {
    const wanted = this.video.samples[plan.target];
    const kept = cached(this.key(wanted.ctsUs));
    if (kept)
      return Promise.resolve({
        frame: kept,
        rotationDeg: this.video.rotationDeg,
      });
    const open = this.openAsk(plan.target);
    if (open) return this.waitOn(open);
    const ask: Ask = {
      plan,
      ctsUs: wanted.ctsUs,
      superseded: false,
      arrived: false,
      done: false,
      waiters: [],
    };
    this.supersede(ask);
    this.pending.push(ask);
    void this.drive();
    return this.waitOn(ask);
  }

  /** The ask already open for a sample: the one being read, or one waiting its turn. */
  private openAsk(target: number): Ask | null {
    const serving = this.serving;
    if (serving && !serving.done && serving.plan.target === target)
      return serving;
    for (const ask of this.pending) if (ask.plan.target === target) return ask;
    return null;
  }

  private waitOn(ask: Ask): Promise<DecodedPicture | null> {
    return new Promise((resolve) => ask.waiters.push(resolve));
  }

  /**
   * The newest ask becomes the one being read.
   *
   * The asks it passed are drawings of moments the run has gone by, and their
   * callers are paints that have been overtaken, so they are answered now
   * rather than waited on. The read in flight is cut with them: its bytes are
   * the newest moment's bytes too, and the run's own bookkeeping — the samples
   * fed, the group they came from — is what the newer read starts from, so
   * nothing crossed is crossed again.
   */
  private supersede(newest: Ask): void {
    let cut = false;
    for (const ask of [this.serving, ...this.pending]) {
      if (!ask || ask === newest || ask.done) continue;
      // A moment behind the newest is one the run has gone by, whether or not
      // the paint that asked for it is still on screen.
      if (ask.plan.target >= newest.plan.target) continue;
      ask.superseded = true;
      this.settle(ask, null);
      if (ask === this.serving) {
        this.wakeArrival();
        cut = true;
      }
    }
    if (cut) this.fetch?.abort();
  }

  /** Reads the asks, newest first; the ones it passed are answered as such. */
  private async drive(): Promise<void> {
    if (this.driving) return;
    this.driving = true;
    try {
      while (this.pending.length > 0) {
        const ask = this.pending.pop() as Ask;
        for (const passed of this.pending) this.settle(passed, null);
        this.pending = [];
        this.serving = ask;
        try {
          await this.work(ask);
        } finally {
          this.serving = null;
        }
      }
    } finally {
      this.driving = false;
    }
  }

  /** Reads the frame one ask wants, on the decoder the asks before it kept warm. */
  private async work(ask: Ask): Promise<void> {
    const video = this.video;
    // The frame may have been decoded while this ask waited its turn.
    const kept = cached(this.key(ask.ctsUs));
    if (kept) {
      this.settle(ask, { frame: kept, rotationDeg: video.rotationDeg });
      return;
    }
    // The browser's answer about a codec never changes, so it is asked once per
    // file: an explicit no rules the file out for good, and a question that
    // could not be answered at all is left to the configure below.
    if (!codecAccepted.has(this.assetId)) {
      const support = await VideoDecoder.isConfigSupported(
        videoConfig(video),
      ).catch(() => null);
      if (ask.superseded) {
        this.settle(ask, null);
        return;
      }
      if (support && !support.supported) {
        elementOnlyNow(this.assetId);
        this.settle(ask, null);
        return;
      }
      if (support?.supported) codecAccepted.add(this.assetId);
    }

    if (this.slot === null) {
      const slot = await takeSlot();
      if (ask.superseded) {
        slot.loan?.give();
        this.settle(ask, null);
        return;
      }
      this.keep(slot);
    }
    const slot = this.slot as Slot;

    const plan = ask.plan;
    const reach = Math.min(
      video.samples.length - 1,
      plan.target + SEEK_REORDER_AHEAD,
    );
    // A run that does not cover where this ask begins — another group, or a
    // moment already fed and gone by — is started over from its keyframe.
    if (
      this.runStart !== plan.sync ||
      (plan.target <= this.fed && !this.owed.has(ask.ctsUs))
    )
      this.beginRun(plan, videoConfig(video));

    if (this.fed < reach && !(await this.feed(ask, reach))) return;
    if (ask.superseded) {
      this.settle(ask, null);
      return;
    }
    // The samples past the target cover the reorder the decoder has not handed
    // over yet; the hold is what a deeper one is given before the flush, which
    // is the file's last word on a frame that has still not come out.
    if (await this.waitArrival(ask, SEEK_HOLD_MS)) {
      this.deliver(ask);
      return;
    }
    if (ask.superseded) {
      this.settle(ask, null);
      return;
    }
    if (slot.failed) {
      this.miss(ask, "The decoder failed on the run");
      return;
    }
    const flushed = await withDeadline(
      slot.decoder.flush().then(
        () => true,
        () => false,
      ),
      DECODE_TIMEOUT_MS,
    );
    if (flushed === null) {
      this.miss(ask, "The decoder did not answer in time");
      return;
    }
    if (ask.superseded) {
      this.settle(ask, null);
      return;
    }
    if (slot.failed) {
      this.miss(ask, "The decoder failed on the run");
      return;
    }
    if (!ask.arrived) {
      this.miss(ask, "No frame came out of the run");
      return;
    }
    this.deliver(ask);
  }

  /**
   * Fetches and hands over the samples from where the run stands to `reach`.
   *
   * One read covers the whole step — the bytes from the last sample fed to the
   * reach — so a drag crossing a group pays for it once and every step after
   * it pays only for what the step added. False is an ask already answered:
   * cut short for a newer reading, or failed.
   */
  private async feed(ask: Ask, reach: number): Promise<boolean> {
    const samples = this.video.samples;
    const first = this.fed + 1;
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (let index = first; index <= reach; index += 1) {
      const sample = samples[index];
      start = Math.min(start, sample.offset);
      end = Math.max(end, sample.offset + sample.size);
    }
    const controller = new AbortController();
    this.fetch = controller;
    this.timedOut = false;
    const timer = setTimeout(() => {
      this.timedOut = true;
      controller.abort();
    }, DECODE_TIMEOUT_MS);
    let bytes: Uint8Array;
    try {
      bytes = (
        await readRange(assetUrl(this.assetId), start, end, controller.signal)
      ).bytes;
    } catch (problem) {
      if (ask.superseded) {
        // Cut short for a newer reading: nothing is held against the file.
        this.settle(ask, null);
        return false;
      }
      this.miss(
        ask,
        this.timedOut
          ? "The decoder did not answer in time"
          : problem instanceof Error
            ? problem.message
            : String(problem),
      );
      return false;
    } finally {
      clearTimeout(timer);
      if (this.fetch === controller) this.fetch = null;
    }
    const slot = this.slot as Slot;
    try {
      for (let index = first; index <= reach; index += 1) {
        const sample = samples[index];
        this.owed.add(sample.ctsUs);
        slot.decoder.decode(
          new EncodedVideoChunk({
            type: sample.key ? "key" : "delta",
            timestamp: sample.ctsUs,
            // The sample's own place in the window; the chunk takes its copy.
            data: bytes.subarray(
              sample.offset - start,
              sample.offset - start + sample.size,
            ),
          }),
        );
        this.fed = index;
      }
    } catch {
      this.miss(ask, "The decoder refused a chunk");
      return false;
    }
    return true;
  }

  /** A frame out of the run: kept for the asks to come, and the served ask's answer. */
  private onFrame(frame: VideoFrame): void {
    const ctsUs = frame.timestamp;
    this.owed.delete(ctsUs);
    // A frame out is the file working: earlier trouble was the moment's, not the file's.
    cleared(this.assetId);
    cacheFrame(this.key(ctsUs), frame);
    const serving = this.serving;
    if (serving && serving.ctsUs === ctsUs) {
      serving.arrived = true;
      this.wakeArrival();
    }
  }

  /** Waits for the frame the ask wants: its arrival, a supersede, or the clock. */
  private async waitArrival(ask: Ask, ms: number): Promise<boolean> {
    if (ask.arrived) return true;
    if (ask.superseded) return false;
    const woken = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    await withDeadline(woken, ms);
    this.wake = null;
    return ask.arrived;
  }

  /** Wakes the served ask's wait for its frame: it arrived, or the ask was passed over. */
  private wakeArrival(): void {
    const resolve = this.wake;
    this.wake = null;
    resolve?.();
  }

  /** Hands the frame the run produced to the ask's waiters. */
  private deliver(ask: Ask): void {
    const kept = cached(this.key(ask.ctsUs));
    this.settle(
      ask,
      kept ? { frame: kept, rotationDeg: this.video.rotationDeg } : null,
    );
  }

  private settle(ask: Ask, picture: DecodedPicture | null): void {
    if (ask.done) return;
    ask.done = true;
    const waiters = ask.waiters;
    ask.waiters = [];
    for (const waiter of waiters) waiter(picture);
  }

  /** A read that failed for a reason that may pass: counted, and its decoder let go of. */
  private miss(ask: Ask, why: string): void {
    transient(this.assetId, why);
    if (this.slot) {
      dropSlot(this.slot);
      this.slot = null;
      this.forgetRun();
    }
    this.settle(ask, null);
  }

  /** Starts the run over: the decoder goes back to the keyframe the plan begins at. */
  private beginRun(plan: SamplePlan, config: VideoDecoderConfig): void {
    const slot = this.slot as Slot;
    slot.failed = false;
    slot.decoder.reset();
    slot.decoder.configure(config);
    this.runStart = plan.sync;
    this.fed = plan.sync - 1;
    this.owed.clear();
  }

  /** Forgets where the run stood: the decoder it stood in is not in hand. */
  private forgetRun(): void {
    this.runStart = -1;
    this.fed = -1;
    this.owed.clear();
  }

  /** Takes a decoder for this pipeline, a fresh one for a fresh run. */
  private keep(slot: Slot): void {
    this.slot = slot;
    slot.sink = (frame) => this.onFrame(frame);
    if (slot.loan) slot.loan.yieldTo = () => this.yieldNow();
    // Whatever a decoder held when it was lent out belongs to the reader that
    // configured it; this one starts the file over.
    this.forgetRun();
  }

  /** Gives the decoder back so another file can have it. */
  private letGo(): void {
    const slot = this.slot;
    if (!slot) return;
    slot.loan?.give();
    this.slot = null;
    this.forgetRun();
  }

  /** Offers the decoder up when nothing is in flight; false when something is. */
  private yieldNow(): boolean {
    if (this.driving || this.pending.length > 0) return false;
    this.letGo();
    return true;
  }

  /** The frame cache's key for a sample of this file. */
  private key(ctsUs: number): string {
    return `${this.assetId}:${ctsUs}`;
  }
}

/** The still pipelines, by asset: the run each file's asks are read from. */
const pipelines = new Map<AssetId, StillPipeline>();

/**
 * A frame for a material moment, or null when the moment was passed over.
 *
 * The frame belongs to the cache: it is drawn with and never closed by the
 * caller, and a key it was stored under is a frame a later call gets back.
 * Null is not a failure — it is a moment a newer read has taken the place of,
 * which the stage's own freshness check is the judge of.
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
  let pipeline = pipelines.get(assetId);
  if (!pipeline) {
    pipeline = new StillPipeline(assetId, video);
    pipelines.set(assetId, pipeline);
  }
  return pipeline.ask(plan);
}

// ---------------------------------------------------------------------------
// Playing a file forward
// ---------------------------------------------------------------------------

/** How far ahead of the consumer the pump fetches, so the next second is in hand. */
const STREAM_PREFETCH_MS = 2_000;
/**
 * How far past the anchor a run may decode before it waits.
 *
 * A decoder handed a whole window bursts through it in a frame's time, and
 * frames arriving far ahead of the picture are frames held for a moment no
 * paint has asked about; the run is held to a lead instead of racing to the
 * window's end. The anchor is the clock's own projection, not the last paint,
 * so a slow paint no longer slows the decode down with it.
 */
const STREAM_MAX_LEAD_MS = 2_000;
/**
 * The lead the run aims to hold past the picture.
 *
 * Not a gate — the pump only ever stops at the ceiling — but the reading the
 * ceiling was chosen for: while a run is short of this it never waits on a
 * consumer at all, which is what lets it make up the frames a picture that
 * has fallen behind is owed.
 */
const STREAM_MIN_LEAD_MS = 1_000;
/**
 * The most frames a run may have delivered or in flight at once.
 *
 * The two are counted together: a chunk handed to the decoder is a frame on
 * its way, and a limit that saw only delivered frames would let a burst land
 * past it — the overflow is dropped from the head, which is exactly where the
 * frames the picture is about to ask for are. What the limit leaves is a
 * second of run ahead of the picture at every rate, which is the lead the run
 * is meant to hold.
 */
const STREAM_QUEUE_LIMIT = 32;
/** How long a run waits for the consumer before it looks again. */
const STREAM_WAIT_MS = 100;
/** How long a run that is behind the floor waits: about a frame, not a pause. */
const STREAM_HURRY_WAIT_MS = 16;

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
   * caller, and it stands until a newer one covers the moment. The clock's own
   * reading of this clip's moment may be given beside it, which is where the
   * run is anchored: the picture's asks decide which frame is wanted, and the
   * clock decides how far ahead the run may work.
   */
  frameAt(materialMs: number, clockMaterialMs?: number): DecodedPicture | null;
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
  /** Chunks handed to the decoder whose frames have not come back yet. */
  private inFlight = 0;
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
  /**
   * The clock's own projection of this clip's moment, in microseconds.
   *
   * Written by whoever knows it — the room's clock, through the ask — and
   * never behind the moment the picture last asked about, so the run is driven
   * by the timeline rather than by the paints: a paint that falls a second
   * behind no longer takes the decode a second behind with it.
   */
  private clockUs = 0;
  /** Woken when the consumer moves, which is the pump's room to make more. */
  private room: (() => void) | null = null;
  private closed = false;
  private gaveUp = false;

  constructor(assetId: AssetId, fromMs: number) {
    this.assetId = assetId;
    this.fromMs = fromMs;
    this.lastTargetUs = Math.round(fromMs * 1_000);
    // A run made ahead of a cut is anchored at the moment it will start: the
    // frames between there and the ceiling are what the cut is given.
    this.clockUs = this.lastTargetUs;
  }

  get failed(): boolean {
    return this.gaveUp;
  }

  /** Opens the file and starts the pump; nothing is thrown into a frame's way. */
  start(): void {
    void this.open();
  }

  frameAt(materialMs: number, clockMaterialMs?: number): DecodedPicture | null {
    if (this.closed) return null;
    const targetUs = Math.round(materialMs * 1_000);
    // Where the picture stands is where the lead is measured from, so the
    // moving moment reaches the pump through this one write; the clock's own
    // reading goes with it, and the pump works from whichever is further on.
    this.lastTargetUs = targetUs;
    if (clockMaterialMs !== undefined)
      this.clockUs = Math.round(clockMaterialMs * 1_000);
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
   * much more there is room for. The fallback exists so a consumer that has
   * stopped asking — a stall, a paint dropped for a newer one — cannot leave
   * the pump waiting on news that will not come while it holds frames the
   * picture may already be owed, and a run held short of the floor, whose
   * frames are owed now, looks again about once a frame rather than idling.
   */
  private async waitForConsumer(hurrying: boolean): Promise<void> {
    const moved = new Promise<void>((resolve) => {
      this.room = resolve;
    });
    await Promise.race([
      moved,
      new Promise<void>((resolve) => {
        setTimeout(resolve, hurrying ? STREAM_HURRY_WAIT_MS : STREAM_WAIT_MS);
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
    if (this.inFlight > 0) this.inFlight -= 1;
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
      // past the anchor allows. Checking here, before each frame, is what
      // keeps a fast decoder from bursting through a window: the frames it
      // would make are the ones the next paints need, and a queue that raced
      // ahead of them would be holding only the window's tail.
      //
      // The anchor is the furthest of the picture's last ask and the clock's
      // own projection — so the run works from the timeline, and a paint that
      // is late does not take the run back in time with it.
      const anchorUs = Math.max(this.lastTargetUs, this.clockUs);
      const next = this.nextMomentUs();
      const leadUs = next === null ? 0 : next - anchorUs;
      const overCeiling = next !== null && leadUs > STREAM_MAX_LEAD_MS * 1_000;
      const underFloor = next !== null && leadUs < STREAM_MIN_LEAD_MS * 1_000;
      if (
        this.queue.length + this.inFlight >= STREAM_QUEUE_LIMIT ||
        overCeiling
      ) {
        // A full queue holds a run either behind the floor, whose frames are
        // owed to a picture already past them, or ahead of it; only the first
        // has a reason to look again quickly.
        await this.waitForConsumer(underFloor);
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
        this.inFlight += 1;
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
