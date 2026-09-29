import type { AssetId, ClipId, TimelineClip } from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { i18n } from "../../../shared/i18n";
import { useClipStore } from "../stores/clipStore";
import {
  decodeFrameAt,
  elementOnlyReason,
  isElementOnly,
  mp4IndexFor,
  resetTransientFailures,
  streamFrom,
  type FrameStream,
} from "./decode";
import { elementEngine } from "./elementFrames";
import type { AssetEngine, PreviewEngine } from "./capabilities";
import type { FramePicture, FrameSources } from "./compositor";

/**
 * Where each clip's picture comes from.
 *
 * Three ways in, decided once per asset and held for the session: a picture is
 * an image decoded once, a video is frames from the file's own samples when a
 * decoder and a readable MP4 are both there, and otherwise a video element
 * walked to the moment. The choice is one asset's, not one frame's — a file
 * read two ways across a cut would show two different pictures — and the
 * engine an asset landed on is what the stage's badge is written from.
 *
 * While the clock runs the video paths change shape: a decodable file is fed
 * forward in order rather than re-decoded per frame, and a file on the
 * elements plays its own picture rather than being seeked to each one. Both
 * are closed the moment the clock stops, so a paused room holds no frames and
 * no running elements.
 *
 * A file the browser will not give up is reported once by name: a toast says
 * which one, rather than a frame that is quietly the background.
 */

export interface PreviewFrameSources extends FrameSources {
  /** Which engine an asset landed on, once it has been asked for. */
  engineOf(assetId: AssetId): AssetEngine | undefined;
  /** Subscribes to pictures arriving late, which is when the preview repaints. */
  onArrive(listener: () => void): () => void;
  /** Stops every playing run: the clock has stopped, so the elements do too. */
  stopPlayback(): void;
}

/** The asset's entry in the project, which is what says what kind of file it is. */
function entryFor(assetId: AssetId) {
  const resources = useProjectStore.getState().moka?.resources;
  if (!resources) return undefined;
  for (const entries of Object.values(resources)) {
    const found = entries.find((entry) => entry.id === assetId);
    if (found) return found;
  }
  return undefined;
}

const IMAGE_SUFFIX = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

function looksLikeImage(name: string, mime: string | undefined): boolean {
  if (mime?.startsWith("image/")) return true;
  // A document written before a file was probed carries no mime; the name is
  // the only thing left that says what it is.
  return mime === undefined && IMAGE_SUFFIX.test(name);
}

/** What the picture under the playhead is being made with, for the stage's own account. */
export function frameEngine(
  clips: TimelineClip[],
  engineOf: (assetId: AssetId) => AssetEngine | undefined,
): PreviewEngine {
  if (clips.length === 0) return "none";
  let element = false;
  let coded = false;
  for (const clip of clips) {
    if (clip.kind !== "video" || !clip.assetId) continue;
    const engine = engineOf(clip.assetId);
    if (engine === "element") element = true;
    else if (engine === "webcodecs") coded = true;
  }
  // The weakest engine in the frame is the one worth saying: an approximate
  // picture is approximate whatever else is drawn over it.
  if (element) return "element";
  if (coded) return "webcodecs";
  return "image";
}

export function createFrameSources(): PreviewFrameSources {
  const images = new Map<AssetId, HTMLImageElement>();
  const started = new Set<AssetId>();
  const engines = new Map<AssetId, AssetEngine>();
  const reported = new Set<AssetId>();
  /** The runs playing clips own, by clip, oldest first; a paused room holds none. */
  const streams = new Map<ClipId, { stream: FrameStream; assetId: AssetId }>();
  /**
   * The clips whose run gave up this playback.
   *
   * A run that failed for a passing reason is not remade on the next paint —
   * that would be a fetch per frame against a file already struggling — and
   * the clip reads from the elements until the clock stops, where every run is
   * let go of and the next playback gives the decode path its fresh start.
   */
  const gaveUp = new Set<ClipId>();
  let arrivals: (() => void)[] = [];

  const notifyArrive = (): void => {
    for (const listener of arrivals) listener();
  };

  const reportMissing = (assetId: AssetId): void => {
    if (reported.has(assetId)) return;
    reported.add(assetId);
    const name =
      entryFor(assetId)?.name ?? i18n.t("clip:preview.filePlaceholder");
    useAppStore
      .getState()
      .pushToast(
        "error",
        i18n.t("clip:preview.cannotBeRead", { name }),
        undefined,
        elementOnlyReason(assetId),
      );
  };

  // A file the browser could not play is one to say so about, exactly once.
  elementEngine().onProblem(reportMissing);
  elementEngine().onArrive(notifyArrive);

  /** An image decoded once, which is all a still frame ever needs. */
  const imageFor = (assetId: AssetId): HTMLImageElement | null => {
    const kept = images.get(assetId);
    if (kept) return kept;
    // A test without a DOM never makes an image, the same way the shelf never
    // makes a sound in one.
    if (started.has(assetId) || typeof Image === "undefined") return null;
    started.add(assetId);
    const image = new Image();
    image.onload = () => {
      images.set(assetId, image);
      notifyArrive();
    };
    image.onerror = () => reportMissing(assetId);
    image.src = assetUrl(assetId);
    return null;
  };

  const engineFor = async (assetId: AssetId): Promise<AssetEngine | null> => {
    const kept = engines.get(assetId);
    if (kept) return kept;
    const entry = entryFor(assetId);
    if (!entry) {
      // The document no longer holds the file: there is nothing to read.
      reportMissing(assetId);
      return null;
    }
    if (looksLikeImage(entry.name, entry.mime)) {
      engines.set(assetId, "image");
      return "image";
    }
    if (typeof VideoDecoder !== "undefined" && !isElementOnly(assetId)) {
      const index = await mp4IndexFor(assetId);
      if (index?.video) {
        engines.set(assetId, "webcodecs");
        return "webcodecs";
      }
    }
    engines.set(assetId, "element");
    return "element";
  };

  /** A decoded frame as the compositor draws it. */
  const decodedPicture = (
    frame: VideoFrame,
    rotationDeg: number,
  ): FramePicture => ({
    kind: "picture",
    picture: {
      source: frame,
      width: frame.displayWidth,
      height: frame.displayHeight,
      rotationDeg,
    },
  });

  /** An element stands its own picture up: the browser applies the display matrix. */
  const elementPicture = (element: HTMLVideoElement): FramePicture => ({
    kind: "picture",
    picture: {
      source: element,
      width: element.videoWidth,
      height: element.videoHeight,
      rotationDeg: 0,
    },
  });

  /**
   * The run a playing clip reads, started at the moment it was asked for.
   *
   * A run that has given up on the file is let go of so the still path can
   * read it, and only the two newest runs are kept: two clips is what a cut
   * shows at once, and a run nobody has asked about is frames left decoding.
   */
  const streamFor = (
    clip: TimelineClip,
    materialMs: number,
  ): FrameStream | null => {
    const assetId = clip.assetId;
    if (!assetId) return null;
    if (gaveUp.has(clip.id)) return null;
    const kept = streams.get(clip.id);
    if (kept && (kept.assetId !== assetId || kept.stream.failed)) {
      kept.stream.close();
      streams.delete(clip.id);
      if (kept.stream.failed && kept.assetId === assetId) gaveUp.add(clip.id);
    }
    let stream = streams.get(clip.id)?.stream ?? null;
    if (stream) {
      // Asked for is what keeps a run, the sweep below takes the quiet ones.
      const recent = streams.get(clip.id) as {
        stream: FrameStream;
        assetId: AssetId;
      };
      streams.delete(clip.id);
      streams.set(clip.id, recent);
      return stream;
    }
    const made = streamFrom(assetId, materialMs);
    if (!made) return null;
    stream = made;
    if (streams.size >= 2) {
      const oldest = streams.keys().next().value;
      if (oldest !== undefined) {
        streams.get(oldest)?.stream.close();
        streams.delete(oldest);
      }
    }
    streams.set(clip.id, { stream, assetId });
    return stream;
  };

  const stopPlayback = (): void => {
    for (const kept of streams.values()) kept.stream.close();
    streams.clear();
    // A stopped clock is the seam between two playbacks: every passing failure
    // is forgotten, so the next run asks the decode path again rather than
    // living with the last one's trouble.
    gaveUp.clear();
    resetTransientFailures();
    elementEngine().stopPlayback();
  };

  const pictureOf = async (
    clip: TimelineClip,
    materialMs: number,
  ): Promise<FramePicture | null> => {
    const assetId = clip.assetId;
    if (!assetId) return null;
    const engine = await engineFor(assetId);
    if (engine === null) return null;
    const playing = useClipStore.getState().playing;
    if (engine === "image") {
      const image = imageFor(assetId);
      if (!image) return { kind: "waiting" };
      return {
        kind: "picture",
        picture: {
          source: image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          rotationDeg: 0,
        },
      };
    }
    if (engine === "webcodecs" && playing) {
      // Playing reads a run fed forward in order; an empty queue answers with
      // the frame last drawn rather than blocking the compositor on a decode.
      const stream = streamFor(clip, materialMs);
      if (stream) {
        const decoded = stream.frameAt(materialMs);
        return decoded
          ? decodedPicture(decoded.frame, decoded.rotationDeg)
          : { kind: "waiting" };
      }
      // No run for this clip this playback — it gave up, and the elements read
      // it until the clock stops. A still decode per paint is the very cost the
      // run exists to avoid, so a playing clip is never sent down that path.
    } else if (engine === "webcodecs") {
      try {
        const decoded = await decodeFrameAt(assetId, materialMs);
        if (decoded) return decodedPicture(decoded.frame, decoded.rotationDeg);
      } catch {
        // A decode that failed after the engine was chosen falls back to the
        // elements for this frame rather than failing it.
      }
      // Only a file the decoder has really given up on changes engines: a read
      // that failed once under load is the moment's trouble, and the next
      // paint asks the decoder again.
      if (isElementOnly(assetId)) engines.set(assetId, "element");
    }
    if (playing) {
      // The element plays its own picture; the room's clock only asks where.
      const element = elementEngine().startPlaying(
        assetId,
        clip.id,
        materialMs,
        clip.speed,
      );
      return element ? elementPicture(element) : { kind: "waiting" };
    }
    const element = elementEngine().elementFor(assetId, materialMs);
    if (!element) return { kind: "waiting" };
    return elementPicture(element);
  };

  return {
    frameFor: pictureOf,
    engineOf: (assetId) => engines.get(assetId),
    // The composition is the frame the elements' claims are counted in: one
    // picture's asks belong together, and the next picture's do not.
    beginFrame: () => elementEngine().beginFrame(),
    stopPlayback,
    onArrive(listener) {
      arrivals.push(listener);
      return () => {
        arrivals = arrivals.filter((kept) => kept !== listener);
      };
    },
  };
}

let shared: PreviewFrameSources | null = null;

/** The one set of frame sources, made on first use so a test without a DOM makes nothing. */
export function previewFrames(): PreviewFrameSources {
  if (!shared) shared = createFrameSources();
  return shared;
}
