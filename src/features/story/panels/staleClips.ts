/**
 * Whether a clip was made before the pictures it stands on changed.
 *
 * A clip is not remade when a frame is: what was filmed stays what was filmed,
 * and the reader decides whether the newer frame is worth filming again. The
 * board says the clip is older than its frames rather than taking it away —
 * an old clip that still plays is the thing a reader has, and a marker is not
 * a reason to lose it.
 */

import { currentTake } from "../../../shared/domain";
import type { StoryAct, StoryKeyframe } from "../../../shared/domain/types";

/** Whether an act's whole clip is older than any frame it was filmed from. */
export function actClipStale(act: StoryAct): boolean {
  const clip = currentTake(act.video);
  if (clip === undefined) return false;
  return act.keyframes.some((keyframe) => {
    const frame = currentTake(keyframe.art);
    return frame !== undefined && frame.createdAt > clip.createdAt;
  });
}

/** Whether a shot's own clip is older than the frame it was filmed from. */
export function shotClipStale(keyframe: StoryKeyframe): boolean {
  const clip = currentTake(keyframe.video);
  const frame = currentTake(keyframe.art);
  return (
    clip !== undefined &&
    frame !== undefined &&
    frame.createdAt > clip.createdAt
  );
}
