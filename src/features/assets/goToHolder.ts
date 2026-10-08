import type {
  CanvasId,
  ClipId,
  NodeId,
  StorySlotTarget,
  StoryStep,
  TimelineId,
} from "../../shared/domain";
import {
  stepReachable,
  storyCurrentStep,
  storyProgress,
} from "../../shared/domain";
import { focusNodes } from "../editor/interactions/actions";
import { openCanvas } from "../editor/interactions/canvasTree";
import { useAppStore } from "../editor/stores/appStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { useClipStore } from "../clip/stores/clipStore";
import { useStoryStore } from "../story/stores/storyStore";
import type { AssetUse } from "./usage";

/**
 * Going from a use to the thing that holds it.
 *
 * The files room asks where a file is used, and a reader pointing at one of
 * the answers means to stand in front of it: the card on its board, the clip
 * in its cut, the place in its story. Each room is opened the way the rest of
 * the app opens it — the store the room already reads is moved to the thing
 * and the phase follows — so a jump from here and a jump from anywhere else
 * land in the same place.
 */

/** Opens the room holding this use and lands on the thing that holds it. */
export function openUse(use: AssetUse): void {
  const holder = use.holder;
  switch (holder.kind) {
    case "node":
      openNode(holder.canvasId, holder.nodeId);
      return;
    case "clip":
      openClip(holder.timelineId, holder.clipId);
      return;
    case "storyFile":
      openStoryPlace(holder.storyId, null);
      return;
    case "drawing":
    case "drawingInUse":
      openStoryPlace(holder.storyId, holder.target);
      return;
    case "voiceReference":
      // A voice is written on the cast step, narrator and characters alike:
      // there is no place in the chapters to land on, only the card.
      openStoryPlace(
        holder.storyId,
        holder.elementId === undefined
          ? null
          : { kind: "element", elementId: holder.elementId, view: "main" },
        "elements",
      );
  }
}

/**
 * Opens the board a node sits on and frames that card.
 *
 * The board is named by whoever asked to go there — a use carries the canvas
 * it was found on, provenance the one a run recorded — but a record can be
 * older than the tree, so a board that is not named is searched for: the card
 * is the thing being asked for, and the board holding it is the answer.
 */
export function openNode(canvasId: CanvasId | undefined, nodeId: NodeId): void {
  const moka = useProjectStore.getState().moka;
  const board =
    canvasId ??
    moka?.canvas.find((canvas) =>
      canvas.nodes.some((node) => node.id === nodeId),
    )?.id;
  if (board) openCanvas(board);
  focusNodes([nodeId]);
  useAppStore.getState().setPhase("editing");
}

/** Opens a timeline on one of its clips, the playhead at the clip's head. */
function openClip(timelineId: TimelineId, clipId: ClipId): void {
  const moka = useProjectStore.getState().moka;
  const clip = moka?.timelines
    ?.find((timeline) => timeline.id === timelineId)
    ?.clips.find((held) => held.id === clipId);
  const clipStore = useClipStore.getState();
  clipStore.setActiveTimeline(timelineId);
  clipStore.select({ clipIds: [clipId], transitionId: null });
  if (clip) clipStore.setPlayhead(clip.startMs);
  useAppStore.getState().setPhase("clip");
}

/** Which step of a story shows a place, by the kind of place it is. */
function stepFor(target: StorySlotTarget): StoryStep {
  switch (target.kind) {
    case "element":
      return "elements";
    case "keyframe":
    case "keyframeVideo":
    case "actVideo":
    case "actVoice":
    case "lineVoice":
    case "actMusic":
      return "storyboard";
  }
}

/**
 * Opens a story on the place that holds the file — a manuscript's story opens
 * at the step the manuscript is read in, which is where the file itself is —
 * or on the step named outright, for a holder with no place among the
 * chapters, like a voice written on the cast.
 *
 * The step is asked of the story's own progress before it is stood on: a place
 * can hold a file while the work around it was undone, and a door onto nothing
 * is worse than standing where the work has got to. The chapter is opened
 * regardless, so a reader who walks the steps afterwards finds the episode
 * waiting for them.
 */
function openStoryPlace(
  storyId: string,
  target: StorySlotTarget | null,
  wanted?: StoryStep,
): void {
  const moka = useProjectStore.getState().moka;
  const story = (moka?.stories ?? []).find((held) => held.id === storyId);
  if (!story) return;
  const storyStore = useStoryStore.getState();
  if (storyStore.storyId !== storyId) storyStore.select(storyId);
  const step: StoryStep =
    wanted ?? (target === null ? "idea" : stepFor(target));
  const progress = storyProgress(story);
  useStoryStore
    .getState()
    .goStep(
      stepReachable(progress, step) ? step : storyCurrentStep(progress).step,
    );
  if (target && "chapterId" in target) {
    useStoryStore.getState().openChapter(target.chapterId);
  }
  useAppStore.getState().setPhase("story");
}
