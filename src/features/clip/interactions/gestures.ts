import {
  MIN_CLIP_DURATION_MS,
  type ClipId,
  type ClipKind,
  type Rect,
  type TimelineClip,
  type TimelineDocument,
  type TrackId,
  type TransitionId,
} from "../../../shared/domain";
import { trackAccepts } from "../../../shared/domain/timeline";
import {
  clipRect,
  type ClipEdge,
  type TimelineView,
  type TrackRow,
} from "../timeline/geometry";
import { frameAligned } from "../timeline/timecode";
import { snapExtremes, type SnapContext } from "./snapping";

/**
 * The geometry a gesture is drawing, and the arithmetic behind it.
 *
 * A drag, a trim and a marquee are all "draft then commit": while the pointer
 * is down the document is not touched at all, and what moves is this model —
 * blocks where the gesture would leave them, the guide a snapped edge sits
 * on, and the rectangle a marquee covers. Nothing here reads or writes a
 * store or a canvas: the drawings are pure functions of the document the
 * gesture started on, so what a release commits is exactly what was drawn.
 */

/** How far a pointer may wander between down and up and still be a click. */
export const CLICK_SLOP_PX = 4;

/** A block as a draft holds it: where a gesture would put it, not where it is. */
export interface DraftClip {
  clipId: ClipId;
  trackId: TrackId;
  kind: ClipKind;
  startMs: number;
  durationMs: number;
}

/**
 * What the canvas draws between a pointer's down and its up.
 *
 * A move carries every block the drag took; a trim carries the one block
 * being stretched, and its duration is what the bubble reads out. The guide
 * is the moment a snapped edge landed on, and `rowTrackId` is the row a
 * cross-track drag is landing on — null while it stays where it was. A seam
 * drag carries the window it would give the transition it grabbed, which the
 * canvas recomputes against the moment under the pointer. A drop carries the
 * block a file dragged from the shelf would become, placed where the release
 * would lay it down.
 */
export type TimelineDraft =
  | {
      kind: "move";
      clips: DraftClip[];
      guideMs: number | null;
      rowTrackId: TrackId | null;
    }
  | { kind: "trim"; clip: DraftClip; edge: ClipEdge; guideMs: number | null }
  | {
      kind: "drop";
      clip: DraftClip;
      guideMs: number | null;
      /** Set where the release would be refused for the place it asks for. */
      conflict: "overlap" | null;
    }
  | { kind: "marquee"; rect: Rect }
  | { kind: "seam"; transitionId: TransitionId; durationMs: number }
  | {
      kind: "fade";
      clip: TimelineClip;
      edge: "in" | "out";
      valueMs: number;
    };

/** A point pair as the rectangle between them, in either direction. */
export function marqueeRect(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** The clips a marquee touches: any block, on any row, that its rect overlaps. */
export function clipsInRect(
  timeline: TimelineDocument,
  rows: TrackRow[],
  view: TimelineView,
  rect: Rect,
): ClipId[] {
  const touches = (block: Rect) =>
    rect.x < block.x + block.width &&
    block.x < rect.x + rect.width &&
    rect.y < block.y + block.height &&
    block.y < rect.y + rect.height;
  return timeline.clips
    .filter((clip) => touches(clipRect(clip, rows, view)))
    .map((clip) => clip.id);
}

/**
 * Whether the whole group may shift rows, and by how many.
 *
 * Every block has to land on a row that takes its kind and will hold an
 * edit; one that would not keeps the whole group horizontal. A group carries
 * its internal row spacing with it, so a column lifted out of a stack comes
 * down as a column and not as scattered blocks.
 */
export function resolveRowDelta(
  rows: TrackRow[],
  clips: readonly TimelineClip[],
  rowDelta: number,
): number {
  if (rowDelta === 0) return 0;
  for (const clip of clips) {
    const from = rows.findIndex((row) => row.track.id === clip.trackId);
    const row = rows[from + rowDelta];
    if (!row || row.track.locked || !trackAccepts(row.track, clip.kind))
      return 0;
  }
  return rowDelta;
}

export interface MoveDraftInput {
  /** The clips the drag carries, as the document held them when it started. */
  clips: readonly TimelineClip[];
  /** The block the pointer went down on, whose row the highlight follows. */
  pressedId: ClipId;
  /** The rows as the view draws them, display order. */
  rows: TrackRow[];
  /** How many rows down the pointer has taken the group, before the kind check. */
  rowDelta: number;
  /** Where the pointer has taken the group, in milliseconds, before snapping. */
  deltaMs: number;
  fps: number;
  ctx: SnapContext;
  pxPerSec: number;
  snapEnabled: boolean;
}

export interface MoveDraft {
  clips: DraftClip[];
  guideMs: number | null;
  /** The row the group is landing on, or null while it stays where it was. */
  rowTrackId: TrackId | null;
}

/**
 * Where a drag would leave every block it carries.
 *
 * The group moves rigidly: one delta for all of it, stopped at the head of
 * the cut by its earliest block rather than each block clamping alone. Either
 * of the two extreme edges may catch on a candidate, and the catch shifts the
 * whole group so the edges keep their spacing.
 */
export function moveDraft(input: MoveDraftInput): MoveDraft {
  const { clips, fps, rows } = input;
  if (clips.length === 0) return { clips: [], guideMs: null, rowTrackId: null };
  const rowDelta = resolveRowDelta(rows, clips, input.rowDelta);
  const placed = clips.map((clip) => {
    const from = rows.findIndex((row) => row.track.id === clip.trackId);
    return { clip, row: rows[from + rowDelta] ?? rows[from] };
  });
  const minStart = Math.min(...clips.map((clip) => clip.startMs));
  const maxEnd = Math.max(
    ...clips.map((clip) => clip.startMs + clip.durationMs),
  );
  let delta = Math.max(input.deltaMs, -minStart);
  const caught = snapExtremes(
    [minStart + delta, maxEnd + delta],
    input.ctx,
    input.pxPerSec,
    input.snapEnabled,
  );
  if (caught) delta = Math.max(delta + caught.deltaMs, -minStart);
  const ghosts = placed.map(({ clip, row }) => ({
    clipId: clip.id,
    trackId: row.track.id,
    kind: clip.kind,
    startMs: frameAligned(Math.max(0, clip.startMs + delta), fps),
    durationMs: clip.durationMs,
  }));
  const pressed = placed.find(({ clip }) => clip.id === input.pressedId);
  return {
    clips: ghosts,
    guideMs: caught && caughtEdge(ghosts, caught.ms) ? caught.ms : null,
    rowTrackId: rowDelta === 0 || !pressed ? null : pressed.row.track.id,
  };
}

/** Whether the drawn edges hold the moment a catch named. */
function caughtEdge(ghosts: readonly DraftClip[], ms: number): boolean {
  return ghosts.some(
    (ghost) =>
      Math.abs(ghost.startMs - ms) < 0.5 ||
      Math.abs(ghost.startMs + ghost.durationMs - ms) < 0.5,
  );
}

/** What a clip's material says about how far its edges may be pulled. */
export interface TrimMaterial {
  /** An image or a cue reads its own clock: its window is its own duration. */
  ownClock: boolean;
  /** How long the file itself runs, when it was measured; null when nobody did. */
  durationMs: number | null;
}

export interface TrimDraftInput {
  clip: TimelineClip;
  edge: ClipEdge;
  /** Where the grabbed edge would land, in milliseconds, before snapping. */
  deltaMs: number;
  fps: number;
  material: TrimMaterial;
  ctx: SnapContext;
  pxPerSec: number;
  snapEnabled: boolean;
}

export interface TrimDraft {
  startMs: number;
  durationMs: number;
  inPointMs: number;
  outPointMs: number;
  guideMs: number | null;
}

/** The shortest a block may be trimmed to: a whole frame, never under the document's floor. */
export function minDurationMs(fps: number): number {
  const rate = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30;
  const frames = Math.max(1, Math.ceil((MIN_CLIP_DURATION_MS * rate) / 1_000));
  return Math.round((frames / rate) * 1_000);
}

/**
 * Where a trim would leave the block.
 *
 * The timeline's own geometry leads and the material window follows: the new
 * duration is what the block draws, and the in or out point is rounded from
 * the run of material that duration reads — the same shape the split uses, so
 * the timing identity the document holds survives every drag by construction.
 *
 * The bounds are clamped rather than refused: a left edge stops where the
 * material's head is (an image or a cue has none, its material being itself),
 * a right edge stops at the file's measured end, and both stop a whole frame
 * short of closing the block. A block with no room to move at all keeps the
 * geometry it had, and the command that would carry no change is never sent.
 */
export function trimDraft(input: TrimDraftInput): TrimDraft {
  const { clip, fps, material } = input;
  const endMs = clip.startMs + clip.durationMs;
  const min = minDurationMs(fps);
  const wanted =
    (input.edge === "start" ? clip.startMs : endMs) + input.deltaMs;
  const caught = snapExtremes(
    [wanted],
    input.ctx,
    input.pxPerSec,
    input.snapEnabled,
  );
  const edgeMs = frameAligned(caught ? wanted + caught.deltaMs : wanted, fps);

  if (input.edge === "start") {
    const ceiling = endMs - min;
    // in + round(Δ × speed) ≥ 0: the material's head bounds how far left a
    // block may be drawn open, and the cut's own head bounds it at zero.
    const floor = material.ownClock
      ? 0
      : Math.max(
          0,
          clip.startMs + Math.ceil((-clip.inPointMs - 0.5) / clip.speed),
        );
    if (floor > ceiling) return unchanged(clip);
    const startMs = Math.min(Math.max(edgeMs, floor), ceiling);
    const durationMs = endMs - startMs;
    const inPointMs = material.ownClock
      ? 0
      : clip.inPointMs + Math.round((startMs - clip.startMs) * clip.speed);
    return {
      startMs,
      durationMs,
      inPointMs,
      outPointMs: material.ownClock
        ? durationMs
        : inPointMs + Math.round(durationMs * clip.speed),
      guideMs: caught && Math.abs(caught.ms - startMs) < 0.5 ? caught.ms : null,
    };
  }

  const floor = clip.startMs + min;
  const ceiling =
    material.ownClock || material.durationMs === null
      ? Number.POSITIVE_INFINITY
      : clip.startMs +
        Math.floor((material.durationMs - clip.inPointMs) / clip.speed);
  if (floor > ceiling) return unchanged(clip);
  const end = Math.min(Math.max(edgeMs, floor), ceiling);
  const durationMs = end - clip.startMs;
  return {
    startMs: clip.startMs,
    durationMs,
    inPointMs: material.ownClock ? 0 : clip.inPointMs,
    outPointMs: material.ownClock
      ? durationMs
      : clip.inPointMs + Math.round(durationMs * clip.speed),
    guideMs: caught && Math.abs(caught.ms - end) < 0.5 ? caught.ms : null,
  };
}

/** The block as it stands, for a gesture with no room to move it. */
function unchanged(clip: TimelineClip): TrimDraft {
  return {
    startMs: clip.startMs,
    durationMs: clip.durationMs,
    inPointMs: clip.inPointMs,
    outPointMs: clip.outPointMs,
    guideMs: null,
  };
}
