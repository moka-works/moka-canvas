import type { NodeId } from "../../../shared/domain";
import type { NodeRunView } from "../stores/runStore";

/** How far a card outside the related chain is drawn back. */
export const DIMMED_OPACITY = 0.35;
/**
 * How far one being worked on is drawn back instead.
 *
 * It is dimmed like any other card outside the chain — pointing at a card is
 * still the reader asking about that chain — but not to the point where its
 * ring and sweeps stop being seen. The light says work is going on right now,
 * and it has to survive a hover somewhere else on the canvas.
 */
export const RUNNING_DIMMED_OPACITY = 0.7;

/**
 * Whether the related highlight draws this card back.
 *
 * Pointing at (or selecting) one card lights its immediate chain and leaves
 * the rest standing back. A card being worked on is no exception; only how far
 * back it stands differs, which `dimOpacity` answers.
 */
export function relatedDimmed(
  related: ReadonlySet<NodeId> | null,
  nodeId: NodeId,
): boolean {
  return related !== null && !related.has(nodeId);
}

/** Whether a run still has something left to do on this card. */
function working(run: NodeRunView | null): boolean {
  return run?.status === "queued" || run?.status === "running";
}

/** The opacity a card drawn back by the related highlight is given. */
export function dimOpacity(run: NodeRunView | null): number {
  return working(run) ? RUNNING_DIMMED_OPACITY : DIMMED_OPACITY;
}
