/**
 * What a board would redraw if it brought every out-of-date picture and clip
 * up to the telling as it stands.
 *
 * Two waves, in the order the work depends on: a frame is drawn from the
 * element pictures and words around it, and a clip is filmed from its frame.
 * A clip whose frame is about to be drawn is counted again after the drawing
 * lands, since the new frame is what makes it out of date.
 */

import {
  actGranularity,
  actHasAllArt,
  actHasPicturelessShot,
  targetKey,
  type StoryMissingClip,
} from "../../../shared/domain/story";
import type { StoryDocument } from "../../../shared/domain/types";
import { actClipStale, shotClipStale } from "./staleClips";
import { staleFrames, staleReferences } from "./stalePictures";

/** One frame the elements it stands on have moved past. */
export interface StaleFrame {
  chapterId: string;
  actId: string;
  keyframeId: string;
  /** The elements whose newer picture makes this frame out of date. */
  elements: string[];
}

/** The two waves, as one plan a reader is shown before any of it is asked. */
export interface StaleRedrawPlan {
  frames: StaleFrame[];
  clips: StoryMissingClip[];
}

/** The places already being made, which this plan must not ask for again. */
export function planStaleRedraw(
  story: StoryDocument,
  busy: ReadonlySet<string>,
): StaleRedrawPlan {
  const frames: StaleFrame[] = [];
  const clips: StoryMissingClip[] = [];

  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      if (act.transition !== undefined) continue;
      const stale = staleFrames(story, act, (keyframeId) =>
        busy.has(
          targetKey({
            kind: "keyframe",
            chapterId: chapter.id,
            actId: act.id,
            keyframeId,
          }),
        ),
      );
      for (const keyframe of stale) {
        frames.push({
          chapterId: chapter.id,
          actId: act.id,
          keyframeId: keyframe.id,
          elements: staleReferences(story, act, keyframe).map(
            (element) => element.id,
          ),
        });
      }
    }
  }

  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      if (act.transition !== undefined || !actHasAllArt(act)) continue;
      if (actGranularity(act, story.shotGranularity) === "keyframe") {
        // A pictureless shot cannot be filmed shot by shot; its act card
        // films the act whole, and that is not this press's work.
        if (actHasPicturelessShot(act)) continue;
        for (const keyframe of act.keyframes) {
          if (!shotClipStale(keyframe)) continue;
          if (
            busy.has(
              targetKey({
                kind: "keyframeVideo",
                chapterId: chapter.id,
                actId: act.id,
                keyframeId: keyframe.id,
              }),
            )
          ) {
            continue;
          }
          clips.push({
            chapterId: chapter.id,
            actId: act.id,
            keyframeId: keyframe.id,
          });
        }
      } else if (
        actClipStale(act) &&
        !busy.has(
          targetKey({
            kind: "actVideo",
            chapterId: chapter.id,
            actId: act.id,
          }),
        )
      ) {
        clips.push({ chapterId: chapter.id, actId: act.id });
      }
    }
  }

  return { frames, clips };
}
