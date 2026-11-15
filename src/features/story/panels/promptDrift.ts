/**
 * Whether what a frame or a clip was made from still says what the board says.
 *
 * A picture is not a live wire: it was drawn from the words the shot had at the
 * time, and a revision that rewrites those words does not repaint it. The same
 * is true of a clip, which was asked for with the words around the frames it
 * filmed. The board says so rather than deciding for the reader — a line
 * changed on purpose may leave the old picture standing, and one changed by
 * mistake is worth seeing before it is redrawn.
 *
 * The words compared are the whole prompt the next ask would send, read off the
 * asset's provenance: that is what the reader would be paying for a second
 * time, and a title or a description that moved on is part of it.
 */

import type {
  ResourceRegistry,
  StoryAct,
  StoryChapter,
  StoryDocument,
} from "../../../shared/domain/types";
import { currentTake } from "../../../shared/domain/story";
import { jobKey, planActVideos, planKeyframeArt } from "../jobs/plan";

/** The prompt each filed asset was made with, by the asset's own id. */
export type PromptSnapshots = Map<string, string>;

/** A shot whose words no longer match its picture. */
export interface DriftedFrame {
  chapterId: string;
  actId: string;
  keyframeId: string;
}

/**
 * The prompts the project's assets were filed with.
 *
 * An asset from before provenance kept the words has no prompt to compare and
 * is left out rather than guessed at: "unknown" is not "changed".
 */
export function promptSnapshots(
  resources: ResourceRegistry | undefined,
): PromptSnapshots {
  const snapshots: PromptSnapshots = new Map();
  if (resources === undefined) return snapshots;
  for (const entries of Object.values(resources)) {
    for (const entry of entries) {
      const snapshot = entry.provenance?.parameterSnapshot;
      const prompt =
        typeof snapshot === "object" && snapshot !== null
          ? (snapshot as Record<string, unknown>).prompt
          : undefined;
      if (typeof prompt === "string" && prompt !== "") {
        snapshots.set(entry.id, prompt);
      }
    }
  }
  return snapshots;
}

/** The shots of one chapter whose pictures were drawn from older words. */
export function driftedFrameTargets(
  story: StoryDocument,
  chapter: StoryChapter,
  snapshots: PromptSnapshots,
): DriftedFrame[] {
  const targets = chapter.acts.flatMap((act) =>
    act.transition === undefined
      ? act.keyframes.map((keyframe) => ({
          chapterId: chapter.id,
          actId: act.id,
          keyframeId: keyframe.id,
        }))
      : [],
  );
  const planned = new Map(
    planKeyframeArt(story, targets).map((item) => [
      jobKey(item.target),
      item.prompt,
    ]),
  );
  return targets.filter(({ actId, keyframeId }) => {
    const act = chapter.acts.find((held) => held.id === actId);
    const keyframe = act?.keyframes.find((held) => held.id === keyframeId);
    const take = keyframe === undefined ? undefined : currentTake(keyframe.art);
    if (take === undefined || take.assetIds.length === 0) return false;
    const was = snapshots.get(take.assetIds[0]);
    const now = planned.get(
      jobKey({ kind: "keyframeArt", chapterId: chapter.id, actId, keyframeId }),
    );
    return was !== undefined && now !== undefined && was !== now;
  });
}

/** Whether an act's clip was filmed from words that have since changed. */
export function actVideoPromptDrifted(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  snapshots: PromptSnapshots,
): boolean {
  if (act.transition !== undefined) return false;
  const take = currentTake(act.video);
  if (take === undefined) return false;
  const planned = planActVideos(story, chapterId, [act.id]).map(
    (item) => item.prompt,
  );
  if (planned.length !== take.assetIds.length) return true;
  return take.assetIds.some((assetId, at) => {
    const was = snapshots.get(assetId);
    return was !== undefined && planned[at] !== was;
  });
}
