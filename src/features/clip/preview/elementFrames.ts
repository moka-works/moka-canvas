import type { AssetId, ClipId } from "../../../shared/domain";
import { assetUrl } from "../../../api";

/**
 * The picture when there is no decoder to be had: a `<video>` walked to the
 * moment and drawn from.
 *
 * A browser that will not hand over frames will still show a file, so this is
 * the floor the preview stands on — approximate by nature, since a seek lands
 * on whatever the browser decides is near enough, and the badge says so.
 *
 * Elements belong to files rather than to clips: two pieces cut from one file
 * read the same element across a cut, so the second piece's first frame is
 * already loaded rather than a source and a load away. A file read in two
 * places at once — a seam's two sides, two rows of the same material — keeps a
 * spare element under `${assetId}:alt`, because one element cannot stand at
 * two moments. Three files are kept, and the quietest element is the one given
 * back when another file wants one.
 *
 * While the clock runs the element is not walked at all: it is put where the
 * moment stands once and then left to play, at the clip's own speed and pitch,
 * with the compositor drawing whatever frame is on it. That is what makes the
 * fallback path watchable rather than a seek per frame. Frames arriving are
 * announced where `requestVideoFrameCallback` can say so, and where it cannot
 * the preview's own clock already repaints each frame the playhead moves.
 *
 * Elements are made on first use, so a test without a DOM never makes one.
 */

const MAX_ELEMENTS = 3;
/** How far a seek may be off before the element is moved to the moment asked for. */
const SEEK_TOLERANCE_MS = 40;
/** A picture can be drawn from a position once the element holds data for it. */
const HAVE_CURRENT_DATA = 2;

interface Slot {
  key: string;
  assetId: AssetId;
  element: HTMLVideoElement;
  /** The clip this element is playing for, or null when it is between runs. */
  busyClip: ClipId | null;
  /** The frame the claim above was made in, which is how fresh it is. */
  claimFrame: number;
  /** The clip this element was last put in position for; a new one is a new position. */
  playedClip: ClipId | null;
  /** Where a prepared element was left, in material milliseconds; null when nothing was prepared. */
  primedAtMs: number | null;
  /** The moment the element was last asked for, in milliseconds; null = a seek is due. */
  askedMs: number | null;
  /** Whether the picture on screen is the one that was asked for. */
  ready: boolean;
  /** Whether a frame callback is registered for a playing element. */
  watching: boolean;
}

/** Asset id (or an asset's spare) to element: the place a picture is read from. */
const slots = new Map<string, Slot>();

/**
 * The frame being composed, counted so a claim can be told fresh from stale.
 *
 * A seam's two sides ask within one composition; the next piece of a cut asks
 * in the next one. A claim is live for the frame that made it — which is what
 * lets the second reader of a file have the spare while the piece that follows
 * it takes its element over.
 */
let frame = 0;

/** A frame is being composed: claims from the last one are no longer fresh. */
export function markFrame(): void {
  frame += 1;
}

/**
 * The key a reader takes: the element it already holds, the file's own when it
 * is free, or the spare while another reader is in the middle of it.
 */
function keyFor(assetId: AssetId, clipId: ClipId | null): string {
  if (clipId !== null) {
    for (const [key, slot] of slots)
      if (slot.assetId === assetId && slot.busyClip === clipId) return key;
  }
  const own = slots.get(assetId);
  if (own && own.busyClip !== null && own.busyClip !== clipId) {
    // A clip new to the file takes its element over from a piece that has
    // stopped asking — the frame the claim lives in is what tells the two
    // apart. A reader asking beside a run that is still going, which is the
    // far side of a seam or a strip's own look at the file, is given the
    // spare instead.
    const beside = clipId === null || own.claimFrame === frame;
    if (beside) return `${assetId}:alt`;
  }
  return assetId;
}

let arrivals: (() => void)[] = [];
let problems: ((assetId: AssetId) => void)[] = [];

function notifyArrive(): void {
  for (const listener of arrivals) listener();
}

function notifyProblem(assetId: AssetId): void {
  for (const listener of problems) listener(assetId);
}

function createSlot(key: string, assetId: AssetId): Slot | null {
  if (
    typeof document === "undefined" ||
    typeof HTMLVideoElement === "undefined"
  )
    return null;
  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.preload = "auto";
  const slot: Slot = {
    key,
    assetId,
    element,
    busyClip: null,
    claimFrame: -1,
    playedClip: null,
    primedAtMs: null,
    askedMs: null,
    ready: false,
    watching: false,
  };
  // A picture arriving is what wakes the preview up; a seek is only the walk
  // towards one, so the frame that shows is drawn once the element has data.
  element.addEventListener("loadeddata", () => {
    slot.ready = true;
    notifyArrive();
  });
  element.addEventListener("seeked", () => {
    slot.ready = true;
    notifyArrive();
  });
  element.addEventListener("error", () => {
    slot.ready = false;
    notifyProblem(assetId);
    notifyArrive();
  });
  return slot;
}

/** Gives an element back: its source is dropped so the browser can let the file go. */
function releaseElement(key: string): void {
  const slot = slots.get(key);
  if (!slot) return;
  slots.delete(key);
  slot.element.removeAttribute("src");
  slot.element.load();
}

/**
 * Gives one quiet element back so another file can have one.
 *
 * The ceiling counts files, and an element in the middle of a run is not a
 * candidate: the longest-untouched element of another file goes first, and
 * when every element is in use the pool is simply left to grow — two visible
 * clips and a strip's own read are the most that ever ask at once.
 */
function evictQuietest(assetId: AssetId): void {
  const others = new Set(
    [...slots.values()]
      .filter((slot) => slot.assetId !== assetId)
      .map((slot) => slot.assetId),
  );
  if (others.size < MAX_ELEMENTS) return;
  for (const [key, slot] of slots) {
    if (slot.assetId === assetId || slot.busyClip !== null) continue;
    releaseElement(key);
    return;
  }
}

/** The slot a reader's picture is read from, made or reclaimed from the pool. */
function slotFor(assetId: AssetId, clipId: ClipId | null): Slot | null {
  const key = keyFor(assetId, clipId);
  let slot = slots.get(key);
  if (!slot) {
    evictQuietest(assetId);
    const made = createSlot(key, assetId);
    if (!made) return null;
    made.element.src = assetUrl(assetId);
    made.element.load();
    slots.set(key, made);
    slot = made;
  }
  // Asked for is what keeps an element; the sweep above takes the quiet ones.
  slots.delete(key);
  slots.set(key, slot);
  return slot;
}

/**
 * The element a clip's picture is read from, or null when it is not there yet.
 *
 * A null is a wait rather than an absence — the element is loading or seeking —
 * and `onArrive` says when to ask again.
 */
export function elementFor(
  assetId: AssetId,
  materialMs: number,
): HTMLVideoElement | null {
  const slot = slotFor(assetId, null);
  if (!slot) return null;
  if (
    slot.askedMs === null ||
    Math.abs(slot.askedMs - materialMs) > SEEK_TOLERANCE_MS
  ) {
    slot.askedMs = materialMs;
    // A seek is a wait, whatever the element was holding: what it shows now is
    // the old place, which is not the one being asked about.
    slot.ready = false;
    slot.element.currentTime = Math.max(0, materialMs / 1_000);
  }
  if (!slot.ready || slot.element.readyState < HAVE_CURRENT_DATA) return null;
  return slot.element;
}

/** Frames of a playing element wake the preview, once they can be heard about. */
function watchFrames(slot: Slot): void {
  const element = slot.element;
  if (slot.watching) return;
  if (typeof element.requestVideoFrameCallback !== "function") return;
  slot.watching = true;
  const arrived = () => {
    if (!slot.watching) return;
    slot.ready = true;
    notifyArrive();
    if (slot.watching) element.requestVideoFrameCallback(arrived);
  };
  element.requestVideoFrameCallback(arrived);
}

/**
 * The element a clip's playing picture is read from, or null until it holds data.
 *
 * A clip new to this element is put where its run starts — the clock carries
 * it from there — and every ask after it is the same element, playing. A hop
 * is never made mid-run: the positions the room asks about advance by a frame
 * at a time, and re-seeking to each would be the walk this replaces.
 */
export function startPlayingElement(
  assetId: AssetId,
  clipId: ClipId,
  materialMs: number,
  speed: number,
): HTMLVideoElement | null {
  const slot = slotFor(assetId, clipId);
  if (!slot) return null;
  const element = slot.element;
  slot.busyClip = clipId;
  slot.claimFrame = frame;
  // A clip new to this element is put where its run starts, once: after that
  // the element plays on its own and no ask moves it — which is also what lets
  // the next piece of a cut carry on from the element its file already has.
  const beginning = slot.playedClip !== clipId;
  slot.playedClip = clipId;
  // A prepared element is already standing at the run's first moment, and only
  // a prepared position near enough to it is left alone: anything further is a
  // place the picture would keep playing from, out of step with the clock.
  const primed =
    slot.primedAtMs !== null &&
    Math.abs(slot.primedAtMs - materialMs) <= SEEK_TOLERANCE_MS;
  slot.primedAtMs = null;
  if (primed) {
    slot.askedMs = Math.max(0, materialMs);
  } else if (beginning || slot.askedMs === null) {
    slot.askedMs = Math.max(0, materialMs);
    slot.ready = false;
    try {
      element.currentTime = slot.askedMs / 1_000;
    } catch {
      // An element with no data yet takes the position once it has some.
    }
  }
  element.playbackRate = speed;
  // The export keeps the pitch with `atempo`; the preview must not part ways.
  element.preservesPitch = true;
  if (element.paused) {
    void element.play().catch(() => {
      // A browser that will not play the file still draws its first frame;
      // the room's clock is not held up for it.
    });
  }
  watchFrames(slot);
  if (element.readyState < HAVE_CURRENT_DATA) return null;
  return element;
}

/**
 * Puts an element where a clip's run will start, without starting it.
 *
 * This is what a cut is given ahead of itself: the file is loaded and the
 * element stands on the run's first moment, so when the clock arrives the
 * first frame is already there rather than a source, a load and a seek away.
 * The element is not played — the clock decides when — and the position is
 * only good for a run that begins near it.
 */
export function prepareElement(assetId: AssetId, materialMs: number): void {
  const slot = slotFor(assetId, null);
  if (!slot) return;
  slot.primedAtMs = Math.max(0, materialMs);
  if (
    slot.askedMs === null ||
    Math.abs(slot.askedMs - materialMs) > SEEK_TOLERANCE_MS
  ) {
    slot.askedMs = Math.max(0, materialMs);
    slot.ready = false;
    try {
      slot.element.currentTime = slot.askedMs / 1_000;
    } catch {
      // An element with no data yet takes the position once it has some.
    }
  }
}

/**
 * Stops every playing element and marks its position stale.
 *
 * A stopped element is one seek away from a picture again: the paused path
 * positions it at the moment it is asked about, which is why the asked moment
 * is forgotten rather than kept — and the same forgetting is given to the
 * prepared position, since nothing prepared for this run is prepared for the
 * next ask.
 */
export function stopElementPlayback(): void {
  for (const slot of slots.values()) {
    if (!slot.element.paused) slot.element.pause();
    slot.watching = false;
    slot.busyClip = null;
    slot.primedAtMs = null;
    slot.askedMs = null;
    slot.ready = false;
  }
}

export interface ElementEngine {
  elementFor(assetId: AssetId, materialMs: number): HTMLVideoElement | null;
  /** The element a clip's picture plays from, or null until it holds data. */
  startPlaying(
    assetId: AssetId,
    clipId: ClipId,
    materialMs: number,
    speed: number,
  ): HTMLVideoElement | null;
  /** Puts an element where a clip's run will start, without starting it. */
  prepare(assetId: AssetId, materialMs: number): void;
  /** A frame is being composed: the claims of the last one are no longer fresh. */
  beginFrame(): void;
  /** Stops every playing element; the paused path repositions from here. */
  stopPlayback(): void;
  /** Subscribes to pictures arriving late, which is when the preview repaints. */
  onArrive(listener: () => void): () => void;
  /** Subscribes to a file the browser could not read. */
  onProblem(listener: (assetId: AssetId) => void): () => void;
}

const engine: ElementEngine = {
  elementFor,
  startPlaying: startPlayingElement,
  prepare: prepareElement,
  beginFrame: markFrame,
  stopPlayback: stopElementPlayback,
  onArrive(listener) {
    arrivals.push(listener);
    return () => {
      arrivals = arrivals.filter((kept) => kept !== listener);
    };
  },
  onProblem(listener) {
    problems.push(listener);
    return () => {
      problems = problems.filter((kept) => kept !== listener);
    };
  },
};

/** The one pool, shared by whoever is drawing pictures. */
export function elementEngine(): ElementEngine {
  return engine;
}
