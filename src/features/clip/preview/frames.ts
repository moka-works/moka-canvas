import type {
  AssetId,
  ClipId,
  TimelineClip,
  TimelineDocument,
} from "../../../shared/domain";
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
import {
  materialMoment,
  type FramePicture,
  type FrameSources,
} from "./compositor";

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
  /**
   * Prepares the pictures the clock is about to reach.
   *
   * Called while the clock runs: the clips the coming window will show have
   * their runs opened and fed now, so a cut begins on a frame already decoded
   * rather than on a fetch, a decoder and a loading place.
   */
  prepareAhead(
    timeline: TimelineDocument,
    atMs: number,
    lookAheadMs?: number,
  ): void;
  /** Stops every playing run: the clock has stopped, so the elements do too. */
  stopPlayback(): void;
}

/** How far ahead of the clock the runs of the clips about to be shown are made. */
export const PREPARE_AHEAD_MS = 3_000;
/**
 * The runs kept at once, by clip.
 *
 * Two clips are on screen at a cut, and the runs made ahead for the pieces
 * after them are two more: four covers the window without letting a long
 * playback accumulate a decoder for every clip it has passed.
 */
const MAX_STREAMS = 4;

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
  /**
   * The runs playing clips own, by clip, oldest first; a paused room holds none.
   *
   * A run made ahead of a cut is `protected`: it has no picture yet, so the
   * sweep that keeps the pool small lets the runs a finished piece left behind
   * go before it.
   */
  const streams = new Map<
    ClipId,
    { stream: FrameStream; assetId: AssetId; protected: boolean }
  >();
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
   * The run a clip reads, started at the moment it was asked for.
   *
   * A run that has given up on the file is let go of so the still path can
   * read it, and the pool is kept to a few runs: the ones made ahead of a cut
   * are held while the pieces that are done leave theirs behind.
   */
  const streamFor = (
    clip: TimelineClip,
    materialMs: number,
    ahead = false,
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
    const entry = streams.get(clip.id);
    if (entry) {
      // A run the picture is showing is no longer merely prepared, and either
      // way asking for it is what keeps it: the sweep takes the quiet ones.
      if (!ahead) entry.protected = false;
      streams.delete(clip.id);
      streams.set(clip.id, entry);
      return entry.stream;
    }
    const made = streamFrom(assetId, materialMs);
    if (!made) return null;
    while (streams.size >= MAX_STREAMS) {
      // A prepared run goes before one the picture has reached, oldest first.
      let victim: ClipId | undefined;
      for (const [id, kept2] of streams)
        if (!kept2.protected) {
          victim = id;
          break;
        }
      victim ??= streams.keys().next().value;
      if (victim === undefined) break;
      streams.get(victim)?.stream.close();
      streams.delete(victim);
    }
    streams.set(clip.id, { stream: made, assetId, protected: ahead });
    return made;
  };

  /** Opens the run — or prepares the element — a clip will be read through. */
  const prepareRun = (
    clip: TimelineClip,
    engine: AssetEngine,
    materialMs: number,
  ): void => {
    const assetId = clip.assetId as AssetId;
    if (engine === "webcodecs") streamFor(clip, materialMs, true);
    else if (engine === "element")
      elementEngine().prepare(assetId, clip.id, materialMs);
  };

  /**
   * Opens the runs and elements of the clips the coming window will show, so
   * the cut into any of them begins on a picture rather than on a wait.
   *
   * The clip at the clock is asked for its run as well — a playback starting
   * mid-piece is the same cold start as a cut — and a file no paint has drawn
   * yet has its engine decided the way a paint would decide it, since the
   * piece after this one is exactly the file nothing has looked at.
   */
  const prepareAhead = (
    timeline: TimelineDocument,
    atMs: number,
    lookAheadMs = PREPARE_AHEAD_MS,
  ): void => {
    if (!useClipStore.getState().playing) return;
    for (const track of timeline.tracks) {
      // A row of sound has no picture, and a hidden row has none either.
      if (track.hidden || track.kind === "audio") continue;
      for (const clip of timeline.clips) {
        if (clip.trackId !== track.id) continue;
        if (clip.kind !== "video" || !clip.assetId) continue;
        const covering = clip.startMs <= atMs;
        if (!covering && clip.startMs > atMs + lookAheadMs) continue;
        if (covering && clip.startMs + clip.durationMs <= atMs) continue;
        // The moment the clip will be read at: where the clock stands in it if
        // it is on screen, and its own first frame if it is not yet.
        const materialMs = covering
          ? materialMoment(clip, atMs)
          : clip.inPointMs;
        const engine = engines.get(clip.assetId);
        if (engine !== undefined) {
          prepareRun(clip, engine, materialMs);
          continue;
        }
        void engineFor(clip.assetId).then((decided) => {
          // The clock may have stopped while the file was being looked at.
          if (decided === null || !useClipStore.getState().playing) return;
          prepareRun(clip, decided, materialMs);
        });
      }
    }
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
        // The run is told where the clock itself stands in this clip, not only
        // where the picture was last asked about: the two agree while paints
        // keep up, and the clock is the one that keeps the run moving when
        // they do not.
        const clockMs = useClipStore.getState().playheadMs;
        const decoded = stream.frameAt(
          materialMs,
          materialMoment(clip, clockMs),
        );
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
      // paint asks the decoder again. Anything else that came back empty — a
      // moment a newer read took the place of, a decoder busy with the one
      // after it — is a wait, not a reason to walk an element to the same
      // place the decoder is already on its way to.
      if (isElementOnly(assetId)) engines.set(assetId, "element");
      else return { kind: "waiting" };
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
    prepareAhead,
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
