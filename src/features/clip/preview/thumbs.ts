import type { AssetId } from "../../../shared/domain";
import { decodeFrameAt } from "./decode";
import { elementEngine } from "./elementFrames";

/**
 * A video's opening frame, drawn small for the timeline to lay in a strip.
 *
 * The probe writes no poster for a video, so the room makes its own: the
 * decodable path takes the frame at material zero, and a file that needs the
 * elements is asked for its first picture once the element holds data. What
 * comes out is a 64×36 canvas per asset, kept for the session — a strip tiles
 * one picture rather than holding a film of frames.
 *
 * A file that never answers leaves the clip without pictures, which is the
 * same block the timeline drew before any of this: the failing is silent, and
 * the watching of the file is asked for once.
 */

/** The canvas a first frame is drawn into: 16:9 so a strip tiles evenly. */
export const THUMB_WIDTH = 64;
export const THUMB_HEIGHT = 36;

/** How long an element is given to produce a first frame before the asset is left bare. */
const THUMB_DEADLINE_MS = 8_000;

const thumbs = new Map<AssetId, HTMLCanvasElement>();
const started = new Set<AssetId>();
const givenUp = new Set<AssetId>();
let listeners: (() => void)[] = [];

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribes to thumbnails arriving, which is when the timeline repaints. */
export function onFirstFrame(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((kept) => kept !== listener);
  };
}

/** The first-frame thumbnail for an asset, when one has been made. */
export function firstFrameThumb(assetId: AssetId): CanvasImageSource | null {
  if (thumbs.has(assetId) || givenUp.has(assetId)) {
    return thumbs.get(assetId) ?? null;
  }
  if (!started.has(assetId)) {
    started.add(assetId);
    void load(assetId);
  }
  return thumbs.get(assetId) ?? null;
}

async function load(assetId: AssetId): Promise<void> {
  try {
    const decoded = await decodeFrameAt(assetId, 0);
    if (decoded) {
      store(
        assetId,
        decoded.frame,
        decoded.frame.displayWidth,
        decoded.frame.displayHeight,
      );
      return;
    }
  } catch {
    // A file the decoder will not open is asked of the elements below.
  }
  // The element engine answers with a frame once it holds one; the deadline is
  // for the file that never will, so one bad asset does not keep a watcher.
  const deadline = setTimeout(() => {
    off();
    givenUp.add(assetId);
  }, THUMB_DEADLINE_MS);
  const off = elementEngine().onArrive(() => {
    const element = elementEngine().elementFor(assetId, 0);
    if (!element) return;
    clearTimeout(deadline);
    off();
    store(assetId, element, element.videoWidth, element.videoHeight);
  });
}

/** Draws a picture into the strip's own canvas, contained on black. */
function store(
  assetId: AssetId,
  source: CanvasImageSource,
  width: number,
  height: number,
): void {
  if (typeof document === "undefined") return;
  if (!(width > 0) || !(height > 0)) {
    // An element that never had a picture — an audio file, a file that would
    // not open — is an asset with no thumbnail rather than a black rectangle.
    givenUp.add(assetId);
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  try {
    const scale = Math.min(THUMB_WIDTH / width, THUMB_HEIGHT / height);
    const drawnWidth = width * scale;
    const drawnHeight = height * scale;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    ctx.drawImage(
      source,
      (THUMB_WIDTH - drawnWidth) / 2,
      (THUMB_HEIGHT - drawnHeight) / 2,
      drawnWidth,
      drawnHeight,
    );
  } catch {
    // A frame that will not draw leaves the asset without a thumbnail.
    givenUp.add(assetId);
    return;
  }
  thumbs.set(assetId, canvas);
  notify();
}
