import type { ClipId, TimelineDocument } from "../../../shared/domain";

/**
 * The moments a moving edge may be caught by, and how near is near enough.
 *
 * The catch is the head of the cut, the playhead, and every edge a block
 * already draws — the edges read as the document holds them, so a follower
 * pulled back into a seam offers its seam edge and not the place it would
 * have stood without one. The dragged blocks' own edges are left out: an edge
 * that catches on itself is not a snap but a drag that will not move.
 *
 * The threshold is physical: eight pixels however tightly the cut is drawn,
 * which is what keeps the catch feeling the same hand at every zoom.
 */

/** How near an edge a moving edge must come, in screen pixels. */
export const SNAP_THRESHOLD_PX = 8;

/** What a drag snaps against: the playhead and the edges it is not carrying. */
export interface SnapContext {
  playheadMs: number;
  edges: readonly number[];
}

/**
 * The moments a gesture starting from this cut can be caught by.
 *
 * A cut at the head only: it is the playhead, the head of the cut, and the
 * edges the given clips do not carry themselves.
 */
export function snapContext(
  timeline: TimelineDocument,
  playheadMs: number,
  exclude: readonly ClipId[] = [],
): SnapContext {
  const carried = new Set(exclude);
  const edges: number[] = [];
  for (const clip of timeline.clips) {
    if (carried.has(clip.id)) continue;
    edges.push(clip.startMs, clip.startMs + clip.durationMs);
  }
  for (const marker of timeline.markers ?? []) edges.push(marker.atMs);
  if (timeline.inPointMs != null) edges.push(timeline.inPointMs);
  if (timeline.outPointMs != null) edges.push(timeline.outPointMs);
  return { playheadMs, edges };
}

/** The catch distance in the document's own milliseconds, from the view's scale. */
export function snapThresholdMs(pxPerSec: number): number {
  return (SNAP_THRESHOLD_PX / pxPerSec) * 1_000;
}

/**
 * The moment a moving edge is caught by, or null when none is near.
 *
 * The playhead is asked first and keeps a tie: a block edge landing exactly
 * as near as the playhead is what a reader placing a cut against the clock
 * wants, and the clock is the one thing they put there deliberately.
 */
export function snapMs(
  candidateMs: number,
  ctx: SnapContext,
  pxPerSec: number,
  enabled: boolean,
): number | null {
  if (!enabled || !Number.isFinite(candidateMs)) return null;
  const threshold = snapThresholdMs(pxPerSec);
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const moment of [ctx.playheadMs, 0, ...ctx.edges]) {
    const distance = Math.abs(moment - candidateMs);
    if (distance > threshold || distance >= bestDistance) continue;
    best = moment;
    bestDistance = distance;
  }
  return best;
}

/**
 * Which of the moving edges is caught, and how far the whole group moves.
 *
 * A block being moved carries two edges and either may catch; the nearer
 * catch wins, and the group is shifted rigidly so both edges keep the same
 * place relative to each other.
 */
export function snapExtremes(
  edges: readonly number[],
  ctx: SnapContext,
  pxPerSec: number,
  enabled: boolean,
): { deltaMs: number; ms: number } | null {
  let best: { deltaMs: number; ms: number } | null = null;
  for (const edge of edges) {
    const moment = snapMs(edge, ctx, pxPerSec, enabled);
    if (moment === null) continue;
    const deltaMs = moment - edge;
    if (best === null || Math.abs(deltaMs) < Math.abs(best.deltaMs)) {
      best = { deltaMs, ms: moment };
    }
  }
  return best;
}
