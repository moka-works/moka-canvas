/**
 * Where each line of a telling lands on the timeline, and how it is made to fit.
 *
 * Every line of a story was read on its own and comes back as its own file, so
 * what a reader hears over a shot is what that shot says: each reading is cued
 * inside the shot it belongs to, and the lines sharing one shot share its
 * window. Everything here is arithmetic over the document and the material —
 * nothing reads a store or asks a server — so the assembly, the warning a
 * reader is shown, and the note under a line on the board all say the same
 * thing because they are the same answer.
 *
 * A window is not always enough for what was said in it. A reading that outruns
 * its window is sped up, but only so far: past that the words would stop
 * sounding like a voice, and a telling is better served by running a little
 * long than by a character gabbling. Past the ceiling the line is laid at the
 * fastest it may be and said to overrun, and a reading nobody measured is laid
 * at the shot's own length rather than guessed at.
 */

import { MIN_CLIP_DURATION_MS } from "../../shared/domain/constants";
import { voiceTakeOf } from "../../shared/domain/story";
import type {
  AssetId,
  StoryDocument,
  StoryKeyframe,
} from "../../shared/domain/types";
import { i18n } from "../../shared/i18n";
import { shotWindows, type AssemblyUnit } from "./assembly";

/** The most a reading is sped up to fit the shot it is said in. */
export const LINE_FIT_SPEED_MAX = 1.35;

/** How a reading came to sit in the window it was given. */
export type DubFit = "natural" | "sped" | "overrun" | "unmeasured";

/** One line of the telling, as it will be laid down under its own shot. */
export interface DubCue {
  chapterId: string;
  actId: string;
  keyframeId: string;
  lineId: string;
  /** The file that is played, which is the line's latest reading. */
  assetId: AssetId;
  /** Where the reading begins: the head of the line's own window. */
  startMs: number;
  /** How long the reading holds the timeline. */
  durationMs: number;
  /** What it is played at to hold it that long. */
  speed: number;
  fit: DubFit;
  /** The share of the shot this line may call its own. */
  windowMs: number;
  /** What the file measures, where it could be measured at all. */
  materialMs?: number;
}

/** Something about the sound that the reader should know before assembling. */
export interface DubWarning {
  kind: "lineOverrun" | "lineUnmeasured";
  chapterId: string;
  actId: string;
  keyframeId: string;
  lineId: string;
  /** Where the shot is, in the reader's language: "Episode 2 · Act 3". */
  place: string;
  /** How far past its window the reading runs, when it runs past it. */
  overMs?: number;
}

/** What a telling's lines would sound like, and what is worth saying about it. */
export interface DubPlan {
  cues: DubCue[];
  warnings: DubWarning[];
}

/** How long a file runs, as the project's own records measure it. */
export type Measure = (assetId: AssetId) => number | undefined;

/**
 * Every line of a telling as it is laid down, act by act and shot by shot.
 *
 * A line that has not been read is not laid down at all: its window is silence,
 * and it keeps its share of the shot so that a reading made later lands where
 * the line is rather than where the readings already made happen to end. A
 * shot the plan left out has no window — no picture, no place for a voice.
 */
export function planDubbing(
  story: StoryDocument,
  units: AssemblyUnit[],
  measure: Measure,
  limits?: { maxSpeed?: number },
): DubPlan {
  const ceiling = limits?.maxSpeed ?? LINE_FIT_SPEED_MAX;
  const cues: DubCue[] = [];
  const warnings: DubWarning[] = [];
  story.chapters.forEach((chapter, chapterAt) => {
    chapter.acts.forEach((act, actAt) => {
      const place = i18n.t("story:edit.place", {
        chapter: chapterAt + 1,
        act: actAt + 1,
      });
      const windows = shotWindows(story, act, units);
      for (const keyframe of act.keyframes) {
        const window = windows.get(keyframe.id);
        // Words with no picture under them are not placed: what is said in a
        // shot nobody filmed has nowhere to be heard from.
        if (window === undefined) continue;
        const told = spokenLines(keyframe);
        if (told.length === 0) continue;
        // The shot's window is shared out among the lines it is said in, and a
        // line takes its share whether or not it has been read: a reading made
        // later lands beside the ones already there rather than pushing them on.
        const share = Math.round(window.durationMs / told.length);
        told.forEach((line, at) => {
          const take = voiceTakeOf(keyframe, line.id);
          const assetId = take?.slot.takes.at(-1)?.assetIds[0];
          if (assetId === undefined) return;
          const startMs = window.startMs + share * at;
          const where = {
            chapterId: chapter.id,
            actId: act.id,
            keyframeId: keyframe.id,
            lineId: line.id,
            place,
          };
          const material = measure(assetId);
          if (material === undefined || material <= 0) {
            warnings.push({ kind: "lineUnmeasured", ...where });
            cues.push({
              ...where,
              assetId,
              startMs,
              durationMs: Math.max(share, MIN_CLIP_DURATION_MS),
              speed: 1,
              fit: "unmeasured",
              windowMs: share,
            });
            return;
          }
          const fitted = fitLine(material, share, ceiling);
          if (fitted.fit === "overrun") {
            warnings.push({
              kind: "lineOverrun",
              ...where,
              overMs: fitted.durationMs - share,
            });
          }
          cues.push({
            ...where,
            assetId,
            startMs,
            ...fitted,
            windowMs: share,
            materialMs: material,
          });
        });
      }
    });
  });
  return { cues, warnings };
}

/**
 * How long a reading holds the timeline, and how fast it is played to get there.
 *
 * A reading that fits its window is left alone. One that does not is sped up no
 * further than the ceiling, and one still too long past that is played as fast
 * as it may be and said to overrun. The duration is rounded first and the speed
 * read back off it, so that the clip the assembly writes keeps the timeline's
 * own identity: its window over its speed is exactly what the file measures.
 */
function fitLine(
  material: number,
  windowMs: number,
  ceiling: number,
): { durationMs: number; speed: number; fit: DubFit } {
  if (material <= windowMs) {
    const durationMs = Math.max(material, MIN_CLIP_DURATION_MS);
    return { durationMs, speed: material / durationMs, fit: "natural" };
  }
  const wanted = Math.min(material / windowMs, ceiling);
  const durationMs = Math.max(
    Math.round(material / wanted),
    MIN_CLIP_DURATION_MS,
  );
  return {
    durationMs,
    speed: material / durationMs,
    fit: durationMs > windowMs ? "overrun" : "sped",
  };
}

/**
 * The lines of a shot that are said at all, in the order the board holds them.
 *
 * The same list the captions are written from: a line with nothing written in
 * it is not said, so it is not read and not counted against its shot's window.
 */
export function spokenLines(keyframe: StoryKeyframe) {
  return keyframe.dialogue.filter((line) => line.text.trim() !== "");
}
