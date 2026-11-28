import {
  MAX_CLIPS_PER_COMMAND,
  MIN_CLIP_DURATION_MS,
  TIMELINE_NAME_MAX,
  createClipFromAsset,
  newId,
  nowIso,
  type AssetId,
  type ClipId,
  type ClipKind,
  type ClipPatch,
  type DocumentCommand,
  type MokaFile,
  type ResourceEntry,
  type TimelineClip,
  type TimelineDocument,
  type TimelineTrack,
  type TimelineTransition,
  type TrackId,
  type TrackKind,
} from "../../../shared/domain";
import {
  followerOf,
  trackAccepts,
  trackClipsInOrder,
  transitionsOfSeams,
} from "../../../shared/domain/timeline";
import { execute } from "../../editor/commands/execute";
import { shelfOf } from "../../editor/panels/canvasAssets";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { i18n } from "../../../shared/i18n";
import {
  useClipStore,
  type ClipSelection,
  type PlacementMode,
} from "../stores/clipStore";
import type { TimelineHit } from "../timeline/geometry";
import { frameAligned } from "../timeline/timecode";
import { alignMoves, type AlignMode } from "./alignment";
import type { DraftClip } from "./gestures";
import { snapContext, snapMs } from "./snapping";

/**
 * What the cutting room does to a cut, as commands.
 *
 * Every action here is a thin assembly: what a drop, a split or a deletion
 * means is decided in the document layer, and this file only says which
 * commands carry that meaning and which command starts the step — one label,
 * one entry of history. What the document layer refuses is toasted where it
 * is refused; the words spoken here are only the ones the room itself has to
 * say before a command could ever be built (a shelf that makes no clip, a row
 * that takes none, a track that is locked).
 */

function toast(kind: "info" | "success" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

/** The cut being worked on, read from the two stores that hold it. */
export function activeTimeline(): TimelineDocument | null {
  const moka = useProjectStore.getState().moka;
  const id = useClipStore.getState().activeTimelineId;
  if (!moka || !id) return null;
  return (moka.timelines ?? []).find((timeline) => timeline.id === id) ?? null;
}

/** The asset an id names, wherever on the shelf it is filed, or null. */
function findAsset(
  moka: MokaFile | null,
  assetId: AssetId,
): ResourceEntry | null {
  for (const entries of Object.values(moka?.resources ?? {})) {
    const found = entries.find((entry) => entry.id === assetId);
    if (found) return found;
  }
  return null;
}

function trackOf(
  timeline: TimelineDocument,
  trackId: TrackId,
): TimelineTrack | null {
  return timeline.tracks.find((track) => track.id === trackId) ?? null;
}

function isLocked(timeline: TimelineDocument, clip: TimelineClip): boolean {
  return trackOf(timeline, clip.trackId)?.locked === true;
}

/** A list cut into the batches one command may land. */
function inBatches<T>(items: T[], size: number = MAX_CLIPS_PER_COMMAND): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    batches.push(items.slice(at, at + size));
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Reading the cut
// ---------------------------------------------------------------------------

/** The chosen clips, in the order the timeline holds them. */
export function selectedClips(
  timeline: TimelineDocument,
  selection: ClipSelection,
): TimelineClip[] {
  const chosen = new Set(selection.clipIds);
  return timeline.clips.filter((clip) => chosen.has(clip.id));
}

/**
 * The clips the playhead is over, on rows that will take an edit.
 *
 * A locked row is left out: its clips can be pointed at, but nothing that
 * changes the cut may touch them, so an action looking for work skips it
 * rather than finding some it cannot do.
 */
export function clipsCrossingPlayhead(
  timeline: TimelineDocument,
  ms: number,
): TimelineClip[] {
  return timeline.clips.filter((clip) => {
    const track = trackOf(timeline, clip.trackId);
    return (
      track !== null &&
      !track.locked &&
      clip.startMs < ms &&
      ms < clip.startMs + clip.durationMs
    );
  });
}

/**
 * The nearest clip edge up or down the cut, across every row that draws.
 *
 * An edge is the head or the tail of a clip; the search is strict, so a
 * playhead already on an edge steps to its neighbour rather than standing
 * still. A cut with no edge that way answers null and the playhead stays put.
 */
export function nearestClipEdgeMs(
  timeline: TimelineDocument,
  ms: number,
  dir: -1 | 1,
): number | null {
  let nearest: number | null = null;
  for (const clip of timeline.clips) {
    const track = trackOf(timeline, clip.trackId);
    if (!track || track.hidden) continue;
    for (const edge of [clip.startMs, clip.startMs + clip.durationMs]) {
      if (dir === -1 ? edge >= ms : edge <= ms) continue;
      if (nearest === null || (dir === -1 ? edge > nearest : edge < nearest)) {
        nearest = edge;
      }
    }
  }
  return nearest;
}

/** The clips of a track from the anchor to a click, in track order, or null when the two do not share a row. */
export function rangeBetween(
  timeline: TimelineDocument,
  fromId: ClipId,
  toId: ClipId,
): ClipId[] | null {
  const from = timeline.clips.find((clip) => clip.id === fromId);
  const to = timeline.clips.find((clip) => clip.id === toId);
  if (!from || !to || from.trackId !== to.trackId) return null;
  const ordered = trackClipsInOrder(timeline, from.trackId);
  const a = ordered.findIndex((clip) => clip.id === from.id);
  const b = ordered.findIndex((clip) => clip.id === to.id);
  if (a < 0 || b < 0) return null;
  return ordered
    .slice(Math.min(a, b), Math.max(a, b) + 1)
    .map((clip) => clip.id);
}

/** How a click adds to what is held. */
export type ClipClickMode = "replace" | "add" | "toggle";

/**
 * What a pointer click leaves selected.
 *
 * A plain click takes one clip and makes it the anchor; a Shift click reaches
 * from the anchor to the clicked clip along its own row; Ctrl or the command
 * key takes one clip in or out. A click on a seam badge takes the seam, and a
 * click on anything else lets go of everything.
 */
export function clickSelection(
  timeline: TimelineDocument,
  selection: ClipSelection,
  hit: TimelineHit,
  mode: ClipClickMode,
  anchorId: ClipId | null,
): ClipSelection {
  if (hit.kind === "transition") {
    return { clipIds: [], transitionId: hit.transition.id };
  }
  if (hit.kind !== "clip") {
    return { clipIds: [], transitionId: null };
  }
  const clip = hit.clip;
  if (mode === "add" && anchorId) {
    const range = rangeBetween(timeline, anchorId, clip.id);
    if (range) {
      return {
        clipIds: [...new Set([...selection.clipIds, ...range])],
        transitionId: null,
      };
    }
  }
  if (mode === "toggle") {
    const held = selection.clipIds.includes(clip.id);
    return {
      clipIds: held
        ? selection.clipIds.filter((id) => id !== clip.id)
        : [...selection.clipIds, clip.id],
      transitionId: null,
    };
  }
  return { clipIds: [clip.id], transitionId: null };
}

/** Everything on the cut, across its rows. */
export function selectAll(): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  useClipStore.getState().select({
    clipIds: timeline.clips.map((clip) => clip.id),
    transitionId: null,
  });
}

export function clearSelection(): void {
  useClipStore.getState().select({ clipIds: [], transitionId: null });
}

/** What was copied from a cut, kept for the session rather than on disk. */
let clipboard: TimelineClip[] | null = null;

export function clearClipboard(): void {
  clipboard = null;
}

export function clipboardHasContent(): boolean {
  return clipboard !== null && clipboard.length > 0;
}

function copyOf(clip: TimelineClip): TimelineClip {
  return {
    ...clip,
    adjust: clip.adjust ? { ...clip.adjust } : undefined,
    text: clip.text
      ? { content: clip.text.content, style: { ...clip.text.style } }
      : undefined,
  };
}

/** Copies the chosen clips, keeping everything each one wears. */
export function copySelection(): boolean {
  const timeline = activeTimeline();
  if (!timeline) return false;
  const chosen = new Set(useClipStore.getState().selection.clipIds);
  const clips = timeline.clips.filter((clip) => chosen.has(clip.id));
  if (clips.length === 0) return false;
  clipboard = clips.map(copyOf);
  return true;
}

export function cutSelection(): void {
  if (!copySelection()) return;
  deleteSelection();
}

/** Pulls a row's clips left until its gaps are gone, or every row's. */
export function closeGapsOn(trackId?: TrackId): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  execute(
    i18n.t(
      trackId ? "clip:history.closeGapsOnTrack" : "clip:history.closeGaps",
    ),
    [
      {
        type: "closeGaps",
        timelineId: timeline.id,
        ...(trackId ? { trackId } : {}),
      },
    ],
  );
}

/** Takes the gap under a moment out and pulls the rest of the row back. */
export function deleteGapOn(trackId: TrackId, atMs: number): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  execute(i18n.t("clip:history.deleteGap"), [
    {
      type: "deleteGap",
      timelineId: timeline.id,
      trackId,
      atMs,
      scope: useClipStore.getState().rippleScope,
    },
  ]);
}

/**
 * Trims the clip under the playhead back to it, from its start (Q) or to it
 * from its end (W), taking the time out of the rows the room is rippling.
 */
export function rippleTrimToPlayhead(edge: "start" | "end"): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  const playhead = useClipStore.getState().playheadMs;
  const chosen = new Set(useClipStore.getState().selection.clipIds);
  const crossing = clipsCrossingPlayhead(timeline, playhead);
  const target = crossing.find((clip) => chosen.has(clip.id)) ?? crossing[0];
  if (!target) return;
  const startMs = edge === "start" ? target.startMs : playhead;
  const endMs =
    edge === "start" ? playhead : target.startMs + target.durationMs;
  if (endMs <= startMs) return;
  const scope = useClipStore.getState().rippleScope;
  execute(
    i18n.t(
      edge === "start"
        ? "clip:history.rippleTrimStart"
        : "clip:history.rippleTrimEnd",
    ),
    [
      {
        type: "removeRange",
        timelineId: timeline.id,
        startMs,
        endMs,
        scope,
        ...(scope === "track" ? { trackId: target.trackId } : {}),
      },
    ],
  );
}

/** Deletes the chosen clips and pulls what followed them back. */
export function rippleDeleteSelection(): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  const { selection } = useClipStore.getState();
  const clips = selectedClips(timeline, selection);
  if (clips.length === 0) return;
  if (clips.some((clip) => isLocked(timeline, clip))) {
    toast("error", i18n.t("clip:actions.trackLocked"));
    return;
  }
  const done = execute(i18n.t("clip:history.rippleDeleteClips"), [
    {
      type: "rippleDeleteClips",
      timelineId: timeline.id,
      clipIds: clips.map((clip) => clip.id),
      scope: useClipStore.getState().rippleScope,
    },
  ]);
  if (done) useClipStore.getState().select({ clipIds: [], transitionId: null });
}

/** Pastes the clipboard at the playhead, with the room's current placement. */
export function pasteAtPlayhead(): void {
  const timeline = activeTimeline();
  if (!timeline || !clipboard || clipboard.length === 0) return;
  const startMs = Math.min(...clipboard.map((clip) => clip.startMs));
  const atMs = frameAligned(
    useClipStore.getState().playheadMs,
    timeline.settings.fps,
  );
  const shift = atMs - startMs;
  const now = nowIso();
  const clips = clipboard.map((clip) => ({
    ...copyOf(clip),
    id: newId(),
    startMs: clip.startMs + shift,
    createdAt: now,
    updatedAt: now,
  }));
  const placement = useClipStore.getState().placement;
  const done = execute(i18n.t("clip:history.pasteClips"), [
    {
      type: "insertClips",
      timelineId: timeline.id,
      clips,
      mode: placement === "insert" ? "ripple" : "overwrite",
      rippleScope: useClipStore.getState().rippleScope,
    },
  ]);
  if (done)
    useClipStore.getState().select({
      clipIds: clips.map((clip) => clip.id),
      transitionId: null,
    });
}

// ---------------------------------------------------------------------------
// Landing media on a row
// ---------------------------------------------------------------------------

/**
 * The kind of clip an asset lands as, or null for a shelf that makes none.
 *
 * Words have a page of their own and are refused here with a pointer to it;
 * an audio file lands as sound and everything else — a video, a picture, a
 * file whose mime says nothing — lands as the picture kind the factory gives
 * a picture clip.
 */
function clipKindFor(entry: ResourceEntry): ClipKind | null {
  if (shelfOf(entry) === "texts" || entry.mime?.startsWith("text/")) {
    return null;
  }
  return entry.mime?.startsWith("audio/") ? "audio" : "video";
}

/** What the room says when an asset's kind is not the row's. */
function kindMismatch(kind: ClipKind): string {
  return kind === "audio"
    ? i18n.t("clip:actions.audioOnAudioTrack")
    : i18n.t("clip:actions.videoOnVideoTrack");
}

/**
 * Whether the factory will have to fall back to its four-second default.
 *
 * Only material does this: a picture may be four seconds by design, while a
 * video or a sound nobody measured is a clip whose length the document only
 * appears to know.
 */
function durationIsUnknown(entry: ResourceEntry): boolean {
  const material =
    entry.mime?.startsWith("video/") === true ||
    entry.mime?.startsWith("audio/") === true;
  return material && entry.probe?.durationMs === undefined;
}

/** Lands one asset on one row, or says why the row will not take it. */
function landOnTrack(
  timeline: TimelineDocument,
  entry: ResourceEntry,
  track: TimelineTrack,
  startMs: number,
  placement: PlacementMode = useClipStore.getState().placement,
): TimelineClip | null {
  const kind = clipKindFor(entry);
  if (kind === null) {
    toast("info", i18n.t("clip:actions.textClipsOnTextPage"));
    return null;
  }
  if (track.locked) {
    toast("error", i18n.t("clip:actions.trackLocked"));
    return null;
  }
  if (!trackAccepts(track, kind)) {
    toast("error", kindMismatch(kind));
    return null;
  }
  if (durationIsUnknown(entry)) {
    toast("info", i18n.t("clip:actions.durationUnknown"));
  }
  const clip = createClipFromAsset(entry, track.id, startMs);
  const mode: "ripple" | "overwrite" =
    placement === "insert" ? "ripple" : "overwrite";
  const done = execute(
    i18n.t(
      placement === "insert"
        ? "clip:history.insertClip"
        : "clip:history.overwriteClip",
    ),
    [
      {
        type: "insertClips",
        timelineId: timeline.id,
        clips: [clip],
        mode,
        rippleScope: useClipStore.getState().rippleScope,
      },
    ],
  );
  return done ? clip : null;
}

/**
 * The moment a dropped head lands on: the moment the pointer gave it, caught
 * by the magnet when an existing edge stands within a hand's width of it.
 */
function landingMs(
  timeline: TimelineDocument,
  startMs: number,
): { startMs: number; guideMs: number | null } {
  const store = useClipStore.getState();
  const caught = snapMs(
    startMs,
    snapContext(timeline, store.playheadMs),
    store.view.pxPerSec,
    store.snapEnabled,
  );
  return { startMs: caught ?? startMs, guideMs: caught };
}

/**
 * What a file hanging over the rows would lay down, or null where the row
 * would refuse it.
 *
 * The ghost a drag draws: the block the release would add — its kind, its
 * length, and the very place the head would land, magnet included — or null
 * for a row that will not take the file (a locked row, another kind's row, a
 * file that makes no clip at all). The drawing reads this, and the drop lands
 * through the same arithmetic, so what is seen while dragging is exactly what
 * the release does.
 */
export function dropPreview(
  timeline: TimelineDocument,
  assetId: AssetId,
  trackId: TrackId | null,
  startMs: number,
  placement: "fit" | PlacementMode = "fit",
): {
  clip: DraftClip;
  guideMs: number | null;
  conflict: "overlap" | null;
} | null {
  const entry = findAsset(useProjectStore.getState().moka, assetId);
  if (!entry) return null;
  const track = trackId === null ? null : trackOf(timeline, trackId);
  if (!track) return null;
  const kind = clipKindFor(entry);
  if (kind === null || track.locked || !trackAccepts(track, kind)) return null;
  const landed = landingMs(timeline, startMs);
  const clip = createClipFromAsset(entry, track.id, landed.startMs);
  const endMs = clip.startMs + clip.durationMs;
  // Only a fit drop asks for the place as it stands; an insert or an overwrite
  // is exactly the answer to an occupied place, so it is never refused for it.
  const conflict =
    placement === "fit" &&
    timeline.clips.some(
      (other) =>
        other.trackId === track.id &&
        other.startMs < endMs &&
        clip.startMs < other.startMs + other.durationMs,
    );
  return {
    clip: {
      clipId: clip.id,
      trackId: clip.trackId,
      kind: clip.kind,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
    },
    guideMs: landed.guideMs,
    conflict: conflict ? "overlap" : null,
  };
}

/**
 * A file dropped from the shelf lands where the pointer put it.
 *
 * A drag that outlived the shelf it started on is ignored without a word: the
 * id names nothing, so there is nothing to say about it. Everything else the
 * row decides: its kind, its lock, and the place the pointer's moment falls on
 * the frame clock — the same arithmetic the drag's ghost was drawn from.
 */
export function dropAssetOnTrack(
  timeline: TimelineDocument,
  assetId: AssetId,
  trackId: TrackId | null,
  startMs: number,
  placement: PlacementMode = useClipStore.getState().placement,
): void {
  const entry = findAsset(useProjectStore.getState().moka, assetId);
  if (!entry) return;
  const track = trackId === null ? null : trackOf(timeline, trackId);
  if (!track) return;
  const clip = landOnTrack(
    timeline,
    entry,
    track,
    landingMs(timeline, startMs).startMs,
    placement,
  );
  if (clip) {
    useClipStore.getState().select({ clipIds: [clip.id], transitionId: null });
  }
}

/** The row a file dragged by an id would land on: display order, topmost first. */
export function firstAcceptingTrack(
  timeline: TimelineDocument,
  kind: ClipKind,
): TimelineTrack | null {
  // The rows draw in reversed document order, so the top of the stack is the
  // last track and the first row that takes the kind is found from the end.
  for (let i = timeline.tracks.length - 1; i >= 0; i -= 1) {
    const track = timeline.tracks[i];
    if (!track.locked && trackAccepts(track, kind)) return track;
  }
  return null;
}

/**
 * The row's plus: the asset lands at the playhead rather than under a pointer.
 *
 * The first row that takes the kind and will hold an edit, topmost first, is
 * the one it lands on; the words said afterwards are the only answer a reader
 * gets, since the clip may well land out of sight of where they are looking.
 * A batch of files is the same act repeated, each one taking up where the last
 * left off — see `addAssetsAtPlayhead`.
 */
export function addAssetAtPlayhead(assetId: AssetId): void {
  addAssetsAtPlayhead([assetId]);
}

/**
 * Lands the chosen files on the cut, one after another from the playhead.
 *
 * A batch reads as a sequence rather than a pile: the first file lands at the
 * playhead and each one after it at the end of the one before, walking the
 * cursor along as it goes. What a single file is refused with — words belong
 * on the text page, a locked row, the wrong kind of row — refuses that file
 * here too, and the rest still land: a reader picking ten files is not to lose
 * nine of them to one that had nowhere to go. The document moves once per
 * file, so each landing is one step of history on its own.
 */
export function addAssetsAtPlayhead(assetIds: AssetId[]): void {
  let cursor: number | null = null;
  let landed = 0;
  for (const assetId of assetIds) {
    const timeline = activeTimeline();
    if (!timeline) return;
    const entry = findAsset(useProjectStore.getState().moka, assetId);
    if (!entry) continue;
    const kind = clipKindFor(entry);
    if (kind === null) {
      toast("info", i18n.t("clip:actions.textClipsOnTextPage"));
      continue;
    }
    const track = firstAcceptingTrack(timeline, kind);
    if (!track) {
      const takesKind = timeline.tracks.some((row) => trackAccepts(row, kind));
      toast(
        "error",
        takesKind ? i18n.t("clip:actions.trackLocked") : kindMismatch(kind),
      );
      continue;
    }
    const startMs =
      cursor ??
      frameAligned(useClipStore.getState().playheadMs, timeline.settings.fps);
    const clip = landOnTrack(timeline, entry, track, startMs);
    if (!clip) continue;
    cursor = clip.startMs + clip.durationMs;
    landed += 1;
    useClipStore.getState().select({ clipIds: [clip.id], transitionId: null });
    if (assetIds.length === 1) {
      toast("success", i18n.t("clip:actions.added", { name: entry.name }));
    }
  }
  // One word for a batch rather than one a file: what was refused already said
  // so for itself, and a reader who picked ten files does not need ten lines.
  // A batch that landed one file is nothing to report beyond that file's own
  // arrival in the cut, which the timeline already shows.
  if (landed > 1) {
    toast("success", i18n.t("clip:actions.addedInOrder", { count: landed }));
  }
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * Whether a clip's material clock is its own duration — a cue, or a still.
 *
 * Such a clip has no window into anything longer than itself, so neither half
 * of a split may read the material at an offset: each one starts its own
 * clock, the way the factory made it.
 */
function readsItsOwnClock(moka: MokaFile | null, clip: TimelineClip): boolean {
  if (clip.kind === "text") return true;
  const asset = clip.assetId ? findAsset(moka, clip.assetId) : null;
  return asset?.mime?.startsWith("image/") === true;
}

/**
 * The two pieces a split at `p` leaves: the patch that shortens the clip the
 * timeline already holds, and the right-hand piece that follows it.
 *
 * Both sides round their own run of material to the millisecond, which is
 * what the document's timing identity is stated in; a sped clip may leave a
 * millisecond of material between the two windows, which is the honest width
 * of a whole-millisecond grid.
 */
function splitPieces(
  moka: MokaFile | null,
  clip: TimelineClip,
  p: number,
): { patch: ClipPatch; right: TimelineClip } {
  const end = clip.startMs + clip.durationMs;
  const leftMs = p - clip.startMs;
  const rightMs = end - p;
  const right: TimelineClip = {
    ...clip,
    id: newId(),
    startMs: p,
    durationMs: rightMs,
  };
  if (readsItsOwnClock(moka, clip)) {
    return {
      patch: { durationMs: leftMs, outPointMs: leftMs },
      right: { ...right, inPointMs: 0, outPointMs: rightMs },
    };
  }
  return {
    patch: {
      durationMs: leftMs,
      outPointMs: clip.inPointMs + Math.round(leftMs * clip.speed),
    },
    right: {
      ...right,
      inPointMs: clip.outPointMs - Math.round(rightMs * clip.speed),
      outPointMs: clip.outPointMs,
    },
  };
}

/** The run of seams from the one behind a clip down to the last, left to right. */
function seamRunFrom(
  timeline: TimelineDocument,
  leaderId: ClipId,
): TimelineTransition[] {
  const run: TimelineTransition[] = [];
  let leader = timeline.clips.find((clip) => clip.id === leaderId);
  while (leader) {
    const held: TimelineClip = leader;
    const transition = timeline.transitions.find(
      (seam) => seam.afterClipId === held.id,
    );
    if (!transition) break;
    run.push(transition);
    leader = followerOf(timeline, held);
  }
  return run;
}

/**
 * Every seam the split has to take down and put back, once each.
 *
 * A seam's follower is held against the tail of the clip ahead of it, so
 * shortening that clip would tear the seam; and releasing one seam shifts a
 * whole chain of them, so the run from the first seam rightwards comes down
 * and goes back up as one batch — the same shape the transition tools use.
 */
function seamsToReassemble(
  timeline: TimelineDocument,
  crossings: TimelineClip[],
): TimelineTransition[] {
  const seams: TimelineTransition[] = [];
  const seen = new Set<string>();
  for (const clip of crossings) {
    for (const transition of seamRunFrom(timeline, clip.id)) {
      if (seen.has(transition.id)) continue;
      seen.add(transition.id);
      seams.push(transition);
    }
  }
  return seams;
}

/** The clips a split would cut: the selection when there is one, every crossing clip otherwise. */
function crossingsToSplit(
  timeline: TimelineDocument,
  selection: ClipSelection,
  p: number,
): TimelineClip[] {
  const crossed = (clip: TimelineClip) =>
    clip.startMs < p && p < clip.startMs + clip.durationMs;
  const candidates =
    selection.clipIds.length > 0
      ? selectedClips(timeline, selection)
      : clipsCrossingPlayhead(timeline, p);
  return candidates
    .filter(crossed)
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
}

/**
 * Cuts what is selected — or everything the playhead is over — in one step.
 *
 * The left half keeps its id and is shortened first, so the right half lands
 * in a place that was just vacated; the pieces then satisfy the document's
 * timing identity on their own, and a piece too short to be seen refuses the
 * whole batch rather than leaving half a cut behind.
 */
export function splitSelectionAtPlayhead(): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  const { selection, playheadMs } = useClipStore.getState();
  const p = frameAligned(playheadMs, timeline.settings.fps);
  const crossings = crossingsToSplit(timeline, selection, p);
  if (crossings.length === 0) {
    toast("info", i18n.t("clip:actions.playheadNotOverClip"));
    return;
  }
  if (crossings.some((clip) => isLocked(timeline, clip))) {
    toast("error", i18n.t("clip:actions.trackLocked"));
    return;
  }
  if (
    crossings.some(
      (clip) =>
        p - clip.startMs < MIN_CLIP_DURATION_MS ||
        clip.startMs + clip.durationMs - p < MIN_CLIP_DURATION_MS,
    )
  ) {
    toast("error", i18n.t("clip:actions.tooShortToSplit"));
    return;
  }

  const moka = useProjectStore.getState().moka;
  const pieces = crossings.map((clip) => ({
    original: clip,
    ...splitPieces(moka, clip, p),
  }));
  // The seams a split affects come down first and go back up last: a follower
  // released mid-batch is a follower butted against its leader, which is the
  // only state the split's own commands may see.
  const seams = seamsToReassemble(timeline, crossings);
  const commands: DocumentCommand[] = [];
  if (seams.length > 0) {
    commands.push({
      type: "removeTransitions",
      timelineId: timeline.id,
      transitionIds: seams.map((seam) => seam.id),
    });
  }
  for (const { original, patch, right } of pieces) {
    commands.push({
      type: "updateClips",
      timelineId: timeline.id,
      patches: [{ clipId: original.id, patch }],
    });
    commands.push({
      type: "addClips",
      timelineId: timeline.id,
      clips: [right],
    });
  }
  if (seams.length > 0) {
    commands.push({
      type: "addTransitions",
      timelineId: timeline.id,
      // The seam behind a split piece now follows its right half — the
      // geometry is unchanged, only who stands on the left of the seam is.
      transitions: seams.map((seam) => {
        const split = pieces.find(
          (piece) => piece.original.id === seam.afterClipId,
        );
        return split ? { ...seam, afterClipId: split.right.id } : seam;
      }),
    });
  }
  const done = execute(i18n.t("clip:history.splitClips"), commands);
  if (!done) return;
  // The right-hand pieces stay selected: cutting the tail further is the move
  // that usually follows cutting a clip in two.
  useClipStore.getState().select({
    clipIds: pieces.map((piece) => piece.right.id),
    transitionId: null,
  });
}

// ---------------------------------------------------------------------------
// Removing and duplicating
// ---------------------------------------------------------------------------

/**
 * Takes the chosen clips — and a chosen seam — out of the cut in one step.
 *
 * The clips go first, in the batches one command may hold: removing a clip
 * takes the seams it touched with it, so a seam the batch named is left to
 * that cascade rather than named twice. Everything comes back on one undo.
 */
export function deleteSelection(): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  const { selection } = useClipStore.getState();
  const clips = selectedClips(timeline, selection);
  const seam =
    timeline.transitions.find((each) => each.id === selection.transitionId) ??
    null;
  if (clips.length === 0 && !seam) return;
  if (clips.some((clip) => isLocked(timeline, clip))) {
    toast("error", i18n.t("clip:actions.trackLocked"));
    return;
  }
  const commands: DocumentCommand[] = [];
  for (const batch of inBatches(clips.map((clip) => clip.id))) {
    commands.push({
      type: "removeClips",
      timelineId: timeline.id,
      clipIds: batch,
    });
  }
  if (
    seam &&
    !transitionsOfSeams(
      timeline,
      clips.map((c) => c.id),
    ).some((each) => each.id === seam.id)
  ) {
    commands.push({
      type: "removeTransitions",
      timelineId: timeline.id,
      transitionIds: [seam.id],
    });
  }
  const done = execute(i18n.t("clip:history.deleteClips"), commands);
  if (done) {
    useClipStore.getState().select({ clipIds: [], transitionId: null });
  }
}

/**
 * Lays a copy of each chosen clip right after it, in one step.
 *
 * The copy has a new id and the same words, and lands on the tail of the
 * piece it copies. A copy that lands on something is refused whole — finding
 * a hole would be the room guessing at where the reader wanted it.
 */
export function duplicateSelection(): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  const { selection } = useClipStore.getState();
  const clips = selectedClips(timeline, selection);
  if (clips.length === 0) return;
  if (clips.some((clip) => isLocked(timeline, clip))) {
    toast("error", i18n.t("clip:actions.trackLocked"));
    return;
  }
  const copies = clips.map((clip) => ({
    ...clip,
    id: newId(),
    startMs: clip.startMs + clip.durationMs,
  }));
  const commands: DocumentCommand[] = [];
  for (const batch of inBatches(copies)) {
    commands.push({ type: "addClips", timelineId: timeline.id, clips: batch });
  }
  execute(i18n.t("clip:history.duplicateClips"), commands);
}

/** The name a row wears: the next number past the ones already taken. */
export function nextTrackName(
  timeline: TimelineDocument,
  kind: ClipKind,
): string {
  const template =
    kind === "video"
      ? "clip:defaults.trackVideo"
      : kind === "audio"
        ? "clip:defaults.trackAudio"
        : "clip:defaults.trackText";
  const name = (n: number) => i18n.t(template, { n });
  const used = new Set(timeline.tracks.map((track) => track.name));
  let n = timeline.tracks.filter((track) => track.kind === kind).length + 1;
  while (used.has(name(n))) n += 1;
  return name(n);
}

/**
 * Lifts the sound of the chosen video clips onto a row of its own.
 *
 * The copy reads the same material from the same window and lands on the same
 * place; the picture is then muted, since its sound is the other clip's now.
 * The first audio row that will hold an edit takes it, topmost first, and a
 * cut with no such row grows one in the same step.
 */
export function detachAudio(): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  const { selection } = useClipStore.getState();
  const clips = selectedClips(timeline, selection).filter(
    (clip) => clip.kind === "video",
  );
  if (clips.length === 0) return;
  if (clips.some((clip) => isLocked(timeline, clip))) {
    toast("error", i18n.t("clip:actions.trackLocked"));
    return;
  }
  const commands: DocumentCommand[] = [];
  const held = firstAcceptingTrack(timeline, "audio");
  const target: TimelineTrack = held ?? {
    id: newId(),
    kind: "audio",
    name: nextTrackName(timeline, "audio"),
    muted: false,
    hidden: false,
    locked: false,
    createdAt: nowIso(),
  };
  if (!held) {
    commands.push({ type: "addTrack", timelineId: timeline.id, track: target });
  }
  const sound = clips.map((clip) => ({
    ...clip,
    id: newId(),
    trackId: target.id,
    kind: "audio" as const,
  }));
  for (const batch of inBatches(sound)) {
    commands.push({ type: "addClips", timelineId: timeline.id, clips: batch });
  }
  for (const batch of inBatches(clips)) {
    commands.push({
      type: "updateClips",
      timelineId: timeline.id,
      patches: batch.map((clip) => ({
        clipId: clip.id,
        patch: { muted: true },
      })),
    });
  }
  execute(i18n.t("clip:history.detachAudio"), commands);
}

// ---------------------------------------------------------------------------
// What a clip's material allows, and the rows themselves
// ---------------------------------------------------------------------------

/** What a clip's material says about how far its edges may be pulled. */
export interface ClipMaterial {
  /** An image or a cue reads its own clock: its window is its own duration. */
  ownClock: boolean;
  /** How long the file itself runs, when it was measured; null when nobody did. */
  durationMs: number | null;
  /** A material file whose length nobody measured, whose end is therefore unknown. */
  unprobed: boolean;
}

/**
 * The material bounds a trim reads, for the clip it is about to stretch.
 *
 * A picture or a cue has no file to run past; a video or a sound has whatever
 * the probe measured, and one nobody measured is unbounded with a word said
 * about it rather than a drag that stops for no visible reason.
 */
export function materialOf(clip: TimelineClip): ClipMaterial {
  const moka = useProjectStore.getState().moka;
  if (readsItsOwnClock(moka, clip)) {
    return { ownClock: true, durationMs: null, unprobed: false };
  }
  const asset = clip.assetId ? findAsset(moka, clip.assetId) : null;
  const durationMs = asset?.probe?.durationMs;
  return {
    ownClock: false,
    durationMs: durationMs ?? null,
    unprobed: durationMs === undefined,
  };
}

/**
 * Whether a clip's material is something a listening can be asked of.
 *
 * A still picture rides the video track and looks exactly like a shot; what
 * tells the two apart is what the registry says the file is, which is the same
 * question the trim tools ask as "a still reads its own clock".
 */
export function materialHoldsSound(clip: TimelineClip): boolean {
  return !materialOf(clip).ownClock;
}

/** One switch of a row's own state, as one step of history. */
export type TrackFlag = "muted" | "hidden" | "locked";

const FLAG_TITLES: Record<TrackFlag, [string, string]> = {
  muted: ["clip:history.unmuteTrack", "clip:history.muteTrack"],
  hidden: ["clip:history.showTrack", "clip:history.hideTrack"],
  locked: ["clip:history.unlockTrack", "clip:history.lockTrack"],
};

export function setTrackFlag(
  timeline: TimelineDocument,
  trackId: TrackId,
  flag: TrackFlag,
  value: boolean,
): void {
  const patch: Partial<Pick<TimelineTrack, TrackFlag>> =
    flag === "muted"
      ? { muted: value }
      : flag === "hidden"
        ? { hidden: value }
        : { locked: value };
  execute(i18n.t(FLAG_TITLES[flag][value ? 1 : 0]), [
    {
      type: "updateTrack",
      timelineId: timeline.id,
      trackId,
      patch,
    },
  ]);
}

/** A row's new name, or nothing done when it is not a name. */
export function renameTrack(
  timeline: TimelineDocument,
  trackId: TrackId,
  name: string,
): void {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > TIMELINE_NAME_MAX) return;
  execute(i18n.t("clip:history.renameTrack"), [
    {
      type: "updateTrack",
      timelineId: timeline.id,
      trackId,
      patch: { name: trimmed },
    },
  ]);
}

/**
 * A new empty row of the given kind, at the place named.
 *
 * The index is where the document puts it: the end of the list is the top of
 * the stack, which is where a reader adding a row to look at it wants it. A
 * place past the ends is pulled back to one, by the command itself.
 */
export function addTrackOfKind(
  timeline: TimelineDocument,
  kind: TrackKind,
  index?: number,
): void {
  const track: TimelineTrack = {
    id: newId(),
    kind,
    name: nextTrackName(timeline, kind),
    muted: false,
    hidden: false,
    locked: false,
    createdAt: nowIso(),
  };
  execute(i18n.t("clip:history.addTrack"), [
    {
      type: "addTrack",
      timelineId: timeline.id,
      track,
      index: index ?? timeline.tracks.length,
    },
  ]);
}

/** Takes an empty row out; the command layer refuses one that still holds clips. */
export function removeTrack(
  timeline: TimelineDocument,
  trackId: TrackId,
): void {
  execute(i18n.t("clip:history.removeTrack"), [
    { type: "removeTrack", timelineId: timeline.id, trackId },
  ]);
}

/**
 * Tidies the chosen clips against each other, as one step of history.
 *
 * The moves are built from where the clips stand, so a set that is already
 * tidy sends no command at all. A clip on a locked row keeps the whole
 * action from being built — the document holds no rule about locks, which is
 * exactly why the room says this one before any command could be refused.
 */
export function alignSelection(mode: AlignMode): void {
  const timeline = activeTimeline();
  if (!timeline) return;
  const clips = selectedClips(timeline, useClipStore.getState().selection);
  if (clips.some((clip) => isLocked(timeline, clip))) {
    toast("error", i18n.t("clip:actions.trackLocked"));
    return;
  }
  const moves = alignMoves(clips, mode);
  if (moves.length === 0) return;
  const labels: Record<AlignMode, string> = {
    left: "clip:history.alignLeft",
    distribute: "clip:history.distributeEvenly",
    butted: "clip:history.joinButted",
  };
  execute(i18n.t(labels[mode]), [
    { type: "moveClips", timelineId: timeline.id, moves },
  ]);
}
