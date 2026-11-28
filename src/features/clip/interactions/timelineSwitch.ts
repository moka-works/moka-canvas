import type { TimelineDocument, TimelineId } from "../../../shared/domain";
import { historyBoundary } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import { useOpenTimelines } from "../stores/openTimelines";

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

/**
 * Puts a tab down without touching the cut it shows.
 *
 * Closing the cut being looked at is looking elsewhere: the tab beside it, in
 * the order the strip draws, takes its place — and stepping there is a seam
 * like any other switch. Closing any other tab leaves the room where it was.
 */
export function closeTimeline(timelineId: TimelineId): void {
  const open = useOpenTimelines.getState();
  if (!open.ids.includes(timelineId)) return;
  const timelines = useProjectStore.getState().moka?.timelines ?? [];
  const shown = timelines.filter((timeline) => open.ids.includes(timeline.id));
  const at = shown.findIndex((timeline) => timeline.id === timelineId);
  if (!open.close(timelineId)) return;
  if (useClipStore.getState().activeTimelineId !== timelineId) return;
  const rest = shown.filter((timeline) => timeline.id !== timelineId);
  const next = rest[Math.min(at, rest.length - 1)] ?? rest[0] ?? null;
  if (next) switchTimeline(next);
  else useClipStore.getState().setActiveTimeline(null);
}
