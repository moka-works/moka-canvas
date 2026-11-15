/**
 * Whether a shot's picture was drawn before one of the references it stands on
 * changed.
 *
 * A reference is not a live wire: the frame was drawn from the picture that
 * was kept at the time, and a character redrawn afterwards does not repaint a
 * frame that was made from the older one. The board says so rather than
 * deciding for the reader — a face changed on purpose may leave the frames as
 * they are, and one changed by mistake is worth seeing before a clip is made.
 */

import { currentTake } from "../../../shared/domain";
import type {
  StoryAct,
  StoryDocument,
  StoryElement,
  StoryKeyframe,
} from "../../../shared/domain/types";
import { actDefaultReferences, keyframeCast } from "../jobs/plan";

/**
 * The elements whose picture is newer than the frame that was drawn with it.
 *
 * Only the references the ask actually carried are counted: a picture past the
 * story's limit never travelled with the frame, so a newer one changes nothing
 * about what was drawn. A frame with no picture of its own has nothing to be
 * stale about — it is missing, which the board already says.
 */
export function staleReferences(
  story: StoryDocument,
  act: StoryAct,
  keyframe: StoryKeyframe,
): StoryElement[] {
  const frame = currentTake(keyframe.art);
  if (frame === undefined) return [];
  return keyframeCast(
    story,
    keyframe.content,
    keyframe.references,
    keyframe.variantChoices ?? {},
    actDefaultReferences(act),
  ).carried.flatMap((reference) => {
    // A file reference has no newer version to be stale against.
    if (reference.element === undefined) return [];
    const held = currentTake(
      reference.variant === undefined
        ? reference.element.main
        : reference.variant.main,
    );
    if (held === undefined) return [];
    return held.createdAt > frame.createdAt ? [reference.element] : [];
  });
}

/** The same, for every shot of a board that can be redrawn right now. */
export function staleFrames(
  story: StoryDocument,
  act: StoryAct,
  busy: (keyframeId: string) => boolean,
): StoryKeyframe[] {
  return act.keyframes.filter(
    (keyframe) =>
      !busy(keyframe.id) &&
      currentTake(keyframe.art) !== undefined &&
      staleReferences(story, act, keyframe).length > 0,
  );
}
