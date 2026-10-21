import type { AgentRoom, AgentScope } from "../../../api";
import { useEditorStore } from "../../editor/stores/editorStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../../clip/stores/clipStore";
import { useAssetsStore } from "../../assets/stores/assetsStore";
import { useStoryStore } from "../../story/stores/storyStore";

/**
 * Where the reader is standing, as the server reads a scope.
 *
 * The document answers for names; this only says which ids are in front of the
 * reader. An id that has gone is dropped by the server with a warning, so a
 * stale selection can never make a tool act on something else.
 */
export function buildScope(room: AgentRoom): AgentScope {
  const project = useProjectStore.getState();
  const scope: AgentScope = { room };
  if (room === "canvas") {
    const canvasId = project.activeCanvasId ?? project.moka?.canvas[0]?.id;
    if (canvasId) scope.canvasId = canvasId;
    const nodeIds = useEditorStore.getState().selection.nodeIds;
    if (nodeIds.length > 0) scope.nodeIds = [...nodeIds];
    return scope;
  }
  if (room === "clip") {
    const clip = useClipStore.getState();
    if (clip.activeTimelineId) scope.timelineId = clip.activeTimelineId;
    if (clip.selection.clipIds.length > 0) {
      scope.clipIds = [...clip.selection.clipIds];
    }
    scope.playheadMs = clip.playheadMs;
    return scope;
  }
  if (room === "assets") {
    const assets = useAssetsStore.getState();
    if (assets.inspectedAssetId) scope.assetId = assets.inspectedAssetId;
    scope.assetFilter = {
      ...(assets.kind === "all" ? {} : { kind: assets.kind }),
      ...(assets.view === "unused" ? { unused: true } : {}),
    };
    return scope;
  }
  const story = useStoryStore.getState();
  if (story.storyId) scope.storyId = story.storyId;
  scope.step = story.step;
  if (story.openChapterId) scope.chapterId = story.openChapterId;
  return scope;
}

/** A short human label for the room, for the dock's context line. */
export function roomLabel(room: AgentRoom): string {
  return `agent:rooms.${room}`;
}
