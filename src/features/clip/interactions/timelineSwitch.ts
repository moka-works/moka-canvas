import type { TimelineDocument } from "../../../shared/domain";
import { historyBoundary } from "../../editor/commands/execute";
import { useClipStore } from "../stores/clipStore";

/**
 * Turns the room over to a timeline.
 *
 * Undoing a cut on one timeline is not undoing a cut on another, so the seam
 * between them is the name of the timeline the reader stepped onto. Every door
 * to a cut — the strip across the bar, the rail's selector — goes through here
 * so the two cannot drift apart.
 */
export function switchTimeline(timeline: TimelineDocument): void {
  if (timeline.id === useClipStore.getState().activeTimelineId) return;
  useClipStore.getState().setActiveTimeline(timeline.id);
  historyBoundary(timeline.name);
}
