/**
 * Whether a board's answer is a board the story can keep.
 *
 * Reading a board is deliberately forgiving — a framing nobody offered is read
 * as a medium shot rather than losing the shot — but an act with no shots, a
 * line for someone who is not in the cast, or a shot whose length no clip can
 * hold are not forgiving readings. They are answers that would put a board in
 * the story that the story cannot use, so they are asked about again with these
 * differences in hand instead of being written down.
 */

import {
  MAX_ACTS_PER_CHAPTER,
  MAX_DIALOGUE_LINE_LENGTH,
  MAX_DIALOGUE_LINES_PER_KEYFRAME,
  MAX_KEYFRAMES_PER_ACT,
  MAX_KEYFRAME_MS,
  MAX_VIDEO_SECONDS,
  MIN_KEYFRAME_MS,
} from "../../../shared/domain/constants";
import {
  chapterActPlan,
  storyMentions,
  type ActDraft,
  type KeyframeDraft,
} from "../../../shared/domain/story";
import type {
  StoryChapter,
  StoryDocument,
  StoryElement,
} from "../../../shared/domain/types";
import { videoCeiling } from "./plan";

/** What a board's answer said, as the reading of it came out. */
export interface BoardAnswer {
  drafts?: ActDraft[];
  warnings: string[];
  /** The answer as it was read, before the board was fitted to the story. */
  raw?: unknown;
  /** Why it could not be read, when it could not. */
  error?: string;
}

/** What is wrong with a board, split by whether it may be written. */
export interface BoardCheck {
  errors: string[];
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawActs(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (!isObject(raw)) return undefined;
  return Array.isArray(raw.acts) ? raw.acts : undefined;
}

function rawShotCount(raw: unknown): number {
  return (rawActs(raw) ?? []).reduce<number>((sum, act) => {
    if (!isObject(act) || !Array.isArray(act.keyframes)) return sum;
    return sum + act.keyframes.length;
  }, 0);
}

/** The shot sizes that may leave their place out of the frame's words. */
function mayLeavePlace(shot: KeyframeDraft): boolean {
  return shot.shotSize === "close" || shot.shotSize === "extremeClose";
}

function elementName(
  elements: StoryElement[],
  id: string | undefined,
): string | undefined {
  if (id === undefined) return undefined;
  return elements.find((element) => element.id === id)?.name;
}

/**
 * The differences between a board's answer and a board the story can keep.
 *
 * Errors are the things that make the answer unusable — a lost act, an actor
 * the story does not hold, a line that cannot be cut. Warnings are things the
 * story can keep and a reader should be told: a place not named in a frame's
 * words, a name nothing can draw, a movement written with the app's own marks.
 */
export function checkBoard(
  story: StoryDocument,
  chapter: StoryChapter,
  answer: BoardAnswer,
): BoardCheck {
  const errors: string[] = [];
  const warnings: string[] = [...answer.warnings];

  if (answer.error !== undefined) {
    errors.push(`the answer could not be read: ${answer.error}`);
    return { errors, warnings };
  }

  const drafts = answer.drafts ?? [];
  if (drafts.length === 0) {
    errors.push("the answer held no acts that could be read");
    return { errors, warnings };
  }
  if (drafts.length > MAX_ACTS_PER_CHAPTER) {
    errors.push(
      `the answer held ${drafts.length} acts, and a chapter keeps at most ${MAX_ACTS_PER_CHAPTER}`,
    );
  }

  const rawRead = rawActs(answer.raw);
  if (rawRead !== undefined && rawRead.length > drafts.length) {
    errors.push(
      `the answer wrote ${rawRead.length} acts, and only ${drafts.length} could be read`,
    );
  }
  const shotsWritten = rawShotCount(answer.raw);
  const shotsRead = drafts.reduce((sum, act) => sum + act.keyframes.length, 0);
  if (shotsWritten > shotsRead) {
    errors.push(
      `the answer wrote ${shotsWritten} shots, and only ${shotsRead} could be read`,
    );
  }

  // A chapter planned before its board is boarded as the acts it planned: the
  // answer must name them by id, in their order, and not invent or drop one.
  const planned = chapterActPlan(chapter) ?? [];
  if (planned.length > 0) {
    if (drafts.length !== planned.length) {
      errors.push(
        `the chapter was planned as ${planned.length} acts, and the answer boarded ${drafts.length}`,
      );
    }
    drafts.forEach((draft, at) => {
      const held = planned[at];
      if (held === undefined) {
        errors.push(`act ${at + 1} was not one of the chapter's planned acts`);
        return;
      }
      if (draft.actId !== held.id) {
        errors.push(
          `act ${at + 1} must board the planned act ${held.id}, not ${draft.actId ?? "an unnamed act"}`,
        );
        return;
      }
      if (draft.title !== "" && draft.title !== held.title) {
        warnings.push(
          `act ${at + 1} renamed the planned act “${held.title}” to “${draft.title}”`,
        );
      }
    });
  }

  const ceilingMs = Math.max(
    MIN_KEYFRAME_MS,
    Math.min(videoCeiling(), MAX_VIDEO_SECONDS) * 1000,
  );
  const names = new Set(story.elements.map((element) => element.name));
  const characters = story.elements.filter(
    (element) => element.kind === "character",
  );

  drafts.forEach((act, actAt) => {
    const actNumber = actAt + 1;
    if (act.title.trim() === "") {
      warnings.push(`act ${actNumber} was left without a title`);
    }
    if (act.summary.trim() === "") {
      warnings.push(`act ${actNumber} was left without a summary`);
    }
    if (act.keyframes.length === 0) {
      errors.push(`act ${actNumber} was boarded with no shots`);
      return;
    }
    if (act.keyframes.length > MAX_KEYFRAMES_PER_ACT) {
      errors.push(
        `act ${actNumber} has ${act.keyframes.length} shots, and an act keeps at most ${MAX_KEYFRAMES_PER_ACT}`,
      );
    }
    const planned = act.keyframes.reduce(
      (sum, keyframe) => sum + keyframe.durationMs,
      0,
    );
    if (planned > ceilingMs) {
      warnings.push(
        `act ${actNumber} plans ${Math.round(planned / 100) / 10} s, and one clip films at most ${Math.round(ceilingMs / 100) / 10} s`,
      );
    }
    const sceneName = elementName(story.elements, act.scene);

    act.keyframes.forEach((keyframe, shotAt) => {
      const where = `shot ${shotAt + 1} of act ${actNumber}`;
      if (!Number.isInteger(keyframe.durationMs)) {
        errors.push(`${where} is held for a length that is not a whole number`);
      } else if (
        keyframe.durationMs < MIN_KEYFRAME_MS ||
        keyframe.durationMs > Math.min(MAX_KEYFRAME_MS, ceilingMs)
      ) {
        errors.push(
          `${where} is held for ${keyframe.durationMs} ms, outside the ${MIN_KEYFRAME_MS}–${Math.min(MAX_KEYFRAME_MS, ceilingMs)} ms a shot may be held`,
        );
      }
      if (keyframe.dialogue.length > MAX_DIALOGUE_LINES_PER_KEYFRAME) {
        errors.push(
          `${where} has ${keyframe.dialogue.length} lines, and a shot may be spoken with at most ${MAX_DIALOGUE_LINES_PER_KEYFRAME}`,
        );
      }
      const mentions = new Set(
        storyMentions(keyframe.content).map((mention) => mention.name),
      );
      for (const mention of storyMentions(keyframe.content)) {
        if (!names.has(mention.name)) {
          warnings.push(
            `${where} names \`${mention.name}\`, which is not one of the story's elements`,
          );
        }
      }
      if (keyframe.motion.includes("`")) {
        warnings.push(
          `${where} writes its motion with backticks, which are for the still frame alone`,
        );
      }
      if (
        sceneName !== undefined &&
        !mayLeavePlace(keyframe) &&
        !mentions.has(sceneName)
      ) {
        warnings.push(
          `${where} does not name its place \`${sceneName}\` in the still frame`,
        );
      }
      keyframe.dialogue.forEach((line, lineAt) => {
        const said = `${where}, line ${lineAt + 1}`;
        if (line.text.length > MAX_DIALOGUE_LINE_LENGTH) {
          errors.push(
            `${said} runs ${line.text.length} characters, and a line keeps at most ${MAX_DIALOGUE_LINE_LENGTH}`,
          );
        }
        if (line.speaker.trim() === "") {
          warnings.push(`${said} does not say who speaks it`);
          return;
        }
        const character =
          line.characterId === undefined
            ? undefined
            : characters.find((held) => held.id === line.characterId);
        if (character === undefined) {
          // A telling may speak through its narrator: a line whose speaker is
          // not in the cast is read aloud rather than refused.
          warnings.push(
            `${said} is spoken by ${line.speaker}, who is not one of the story's characters and will be read by the narrator`,
          );
          return;
        }
        if (!mentions.has(character.name)) {
          warnings.push(
            `${said} is spoken by ${character.name}, who is not named in backticks in the still frame`,
          );
        }
      });
    });
  });

  return { errors, warnings };
}
