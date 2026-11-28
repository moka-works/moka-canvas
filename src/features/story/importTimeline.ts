/**
 * One episode handed over to the cutting room as a cut of its own.
 *
 * The fifth step assembles each episode onto the timeline that episode owns;
 * this is the way an episode's cut leaves that timeline: a copy named by the
 * reader that the next assembly never walks over — so what was laid down is a
 * starting point for cutting rather than something the step rewrites.
 */

import type {
  MokaFile,
  StoryChapter,
  StoryDocument,
  TimelineId,
} from "../../shared/domain";
import { i18n } from "../../shared/i18n";
import { execute } from "../editor/commands/execute";
import { useClipStore } from "../clip/stores/clipStore";
import { useAppStore } from "../editor/stores/appStore";
import { importTimelineCommands } from "./assembly";

/**
 * One episode's cut, copied into the project and opened.
 *
 * Adding a timeline, opening the cutting room onto it and saying so is one
 * thing the reader asked for, which is why it is one call; an ask the document
 * refuses — an episode not assembled yet, more clips than a timeline holds, a
 * conflict — says its reason and leaves the reader in the story room with
 * their work.
 */
export function importStoryToTimeline(
  story: StoryDocument,
  moka: MokaFile,
  chapter: StoryChapter,
  name: string,
): TimelineId | null {
  try {
    const { commands, timelineId, clips } = importTimelineCommands(
      story,
      moka,
      chapter,
      name,
    );
    const applied = execute(i18n.t("story:history.importClips"), commands);
    if (applied === null) return null;
    // The room opens onto the cut that was just asked for, rather than onto
    // whichever timeline this machine was last left on.
    useClipStore.getState().setActiveTimeline(timelineId);
    useAppStore.getState().setPhase("clip");
    useAppStore
      .getState()
      .pushToast(
        "success",
        i18n.t("story:import.timeline.done", { count: clips, name }),
      );
    return timelineId;
  } catch (problem) {
    useAppStore
      .getState()
      .pushToast(
        "error",
        problem instanceof Error ? problem.message : String(problem),
      );
    return null;
  }
}
