/**
 * A cover laid onto a cut: one picture under one title.
 *
 * A cover is not a new kind of clip: it is an image on a video row and words
 * on a text row, held over the same stretch of time. The rows it lands on are
 * chosen from what the timeline already has — an overlay row with room at that
 * time is reused — and only added when there is none. A new video row always
 * goes under the text rows, because the preview draws later rows on top and
 * the exported text is burned last.
 */

import {
  MAX_TRACKS_PER_TIMELINE,
  type DocumentCommand,
  type ResourceEntry,
  type TextClipStyle,
  type TimelineClip,
  type TimelineDocument,
  type TimelineTrack,
} from "../../shared/domain";
import {
  createClipFromAsset,
  createTextClip,
} from "../../shared/domain/factories";
import { newId, nowIso } from "../../shared/domain/ids";
import { i18n } from "../../shared/i18n";

/** What a cover is made of, and where it stands. */
export interface CoverRequest {
  startMs: number;
  durationMs?: number;
  title: string;
  /** What the two clips are called, so the reader can find them again. */
  label: string;
  style: TextClipStyle;
  /** The picture under the title; without one the cover is words alone. */
  resource?: ResourceEntry;
}

/** The commands that lay a cover down, and the title's own clip. */
export interface CoverPlan {
  commands: DocumentCommand[];
  textClipId: string;
  error?: string;
}

const DEFAULT_COVER_MS = 2_500;

function overlaps(
  timeline: TimelineDocument,
  track: TimelineTrack,
  startMs: number,
  endMs: number,
): boolean {
  return timeline.clips.some(
    (clip) =>
      clip.trackId === track.id &&
      clip.startMs < endMs &&
      startMs < clip.startMs + clip.durationMs,
  );
}

function freeTrack(
  timeline: TimelineDocument,
  track: TimelineTrack,
  startMs: number,
  endMs: number,
): boolean {
  return (
    !track.hidden && !track.locked && !overlaps(timeline, track, startMs, endMs)
  );
}

function newTrack(kind: "video" | "text", n: number): TimelineTrack {
  return {
    id: newId(),
    kind,
    name:
      kind === "video"
        ? i18n.t("clip:defaults.trackVideo", { n })
        : i18n.t("clip:defaults.trackText", { n }),
    muted: false,
    hidden: false,
    locked: false,
    createdAt: nowIso(),
  };
}

function isPicture(
  resource: ResourceEntry | undefined,
): resource is ResourceEntry {
  return (
    resource !== undefined &&
    (resource.mime?.startsWith("image/") === true ||
      resource.mime?.startsWith("video/") === true)
  );
}

/**
 * The cover as one batch: the rows it needs, then the two clips on them.
 *
 * Reuses a row that has room so a timeline of covers does not grow a pair of
 * rows per episode; adds rows only where none is free, and refuses rather than
 * exceeding what a timeline may hold.
 */
export function coverCommands(
  timeline: TimelineDocument,
  request: CoverRequest,
): CoverPlan {
  const durationMs = request.durationMs ?? DEFAULT_COVER_MS;
  const startMs = Math.max(0, Math.round(request.startMs));
  const endMs = startMs + durationMs;
  const tracks = timeline.tracks;
  const baseVideo = tracks.findIndex((track) => track.kind === "video");
  const textAt = tracks.findIndex((track) => track.kind === "text");
  const freeVideo = tracks.findIndex(
    (track, at) =>
      track.kind === "video" &&
      at > baseVideo &&
      freeTrack(timeline, track, startMs, endMs),
  );
  const freeText = tracks.findIndex(
    (track) =>
      track.kind === "text" && freeTrack(timeline, track, startMs, endMs),
  );

  const addingVideo = freeVideo < 0 && request.resource !== undefined;
  const addingText = freeText < 0;
  if (
    tracks.length + (addingVideo ? 1 : 0) + (addingText ? 1 : 0) >
    MAX_TRACKS_PER_TIMELINE
  ) {
    return {
      commands: [],
      textClipId: "",
      error: i18n.t("clip:cover.noTrack"),
    };
  }

  const commands: DocumentCommand[] = [];
  let videoTrackId = freeVideo >= 0 ? tracks[freeVideo]!.id : undefined;
  if (addingVideo) {
    const track = newTrack(
      "video",
      tracks.filter((held) => held.kind === "video").length + 1,
    );
    // Before the first text row: preview draws later rows on top, and the
    // exported words are burned above every picture.
    commands.push({
      type: "addTrack",
      timelineId: timeline.id,
      track,
      index: textAt < 0 ? tracks.length : textAt,
    });
    videoTrackId = track.id;
  }
  let textTrackId = freeText >= 0 ? tracks[freeText]!.id : undefined;
  if (addingText) {
    const track = newTrack(
      "text",
      tracks.filter((held) => held.kind === "text").length + 1,
    );
    commands.push({ type: "addTrack", timelineId: timeline.id, track });
    textTrackId = track.id;
  }
  if (textTrackId === undefined) {
    return {
      commands: [],
      textClipId: "",
      error: i18n.t("clip:cover.noTrack"),
    };
  }

  const clips: TimelineClip[] = [];
  if (isPicture(request.resource) && videoTrackId !== undefined) {
    const picture = createClipFromAsset(
      request.resource,
      videoTrackId,
      startMs,
    );
    clips.push({
      ...picture,
      label: request.label,
      durationMs,
      outPointMs: durationMs,
    });
  }
  const text = createTextClip(request.title, textTrackId, startMs, durationMs);
  text.label = request.label;
  text.text = { content: request.title, style: { ...request.style } };
  clips.push(text);
  commands.push({ type: "addClips", timelineId: timeline.id, clips });
  return { commands, textClipId: text.id };
}
