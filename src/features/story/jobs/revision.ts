/**
 * A board revision: what a model answered, and what it writes onto the board.
 *
 * The answer is a patch by id, never a board written again. A shot it does not
 * name is a shot the outline left standing, and a patch it cannot place in the
 * chapter as it stands — an id that is gone, a line that belongs to another
 * shot — makes the whole answer unreadable rather than half-written: a patch
 * landing on the wrong shot is worse than a revision asked for again.
 *
 * Applying one is all or nothing in the same way. Every change the answer keeps
 * is written, and the chapter's version moves on only when every one of them
 * landed; a reader who leaves one out leaves the board behind the outline,
 * which is where the update button says so.
 */

import type { DocumentCommand } from "../../../shared/domain/types";
import {
  STORY_CAMERA_ANGLES,
  STORY_CAMERA_MOVES,
  STORY_SHOT_SIZES,
  type StoryAct,
  type StoryCameraAngle,
  type StoryCameraMove,
  type StoryChapter,
  type StoryDialogueLine,
  type StoryDocument,
  type StoryKeyframe,
  type StoryShotSize,
} from "../../../shared/domain/types";
import { newId } from "../../../shared/domain/ids";
import {
  chapterRevision,
  recognizeKeyframeReferences,
  storyMentions,
  syncChapterBoard,
} from "../../../shared/domain/story";
import {
  matchCameraAngle,
  matchCameraMove,
  matchShotSize,
} from "../../../shared/domain/parse/aliases";
import { parseStoryJson } from "../../../shared/domain/parse/json";

/** How much of an answer one field may keep, past which it is cut. */
const CONTENT_MAX = 1000;
const SUMMARY_MAX = 2000;
const TITLE_MAX = 200;
const SUMMARY_LINE_MAX = 400;

/** One line of a shot's dialogue as a revision writes it. */
export interface RevisionDialogueLine {
  /** The line it replaces; absent on a line the revision adds. */
  id?: string;
  speaker: string;
  text: string;
  tone?: string;
}

/** What a revision says about one shot. */
export interface RevisionKeyframePatch {
  actId: string;
  keyframeId: string;
  reason?: string;
  content?: string;
  dialogue?: RevisionDialogueLine[];
  shotSize?: StoryShotSize;
  cameraMove?: StoryCameraMove;
  angle?: StoryCameraAngle;
}

/** What a revision says about one act. */
export interface RevisionActPatch {
  actId: string;
  title?: string;
  summary?: string;
}

/** A revision answer, read and checked against the chapter it is for. */
export interface RevisionAnswer {
  summary: string;
  needsRebuild: boolean;
  unmapped: string[];
  acts: RevisionActPatch[];
  keyframes: RevisionKeyframePatch[];
}

/** What reading one answer came out as. */
export interface RevisionReading {
  answer?: RevisionAnswer;
  /** Things the answer said that could not be used as written. */
  warnings: string[];
  /** Why it could not be read at all, when it could not. */
  error?: string;
}

/** A change in the cast a shot's words name, for the preview to show. */
export interface RevisionReferenceChange {
  keyframeId: string;
  before: string[];
  after: string[];
}

/** What writing a revision onto a board came out as. */
export interface RevisionApplication {
  commands: DocumentCommand[];
  /** Shots whose words were rewritten. */
  keyframes: number;
  /** Acts whose title or summary was rewritten. */
  acts: number;
  /**
   * Whether every change the answer kept was applied. Only then does the
   * chapter's version move on to the outline it was revised from.
   */
  complete: boolean;
  /** Whether the outline has moved on since the answer was planned. */
  stale: boolean;
  references: RevisionReferenceChange[];
}

/** The changes the preview starts with: every one the answer kept. */
export interface RevisionSelection {
  keyframes: Set<string>;
  acts: Set<string>;
}

/** Every change the answer kept, selected. */
export function selectAllRevision(answer: RevisionAnswer): RevisionSelection {
  return {
    keyframes: new Set(answer.keyframes.map((patch) => patch.keyframeId)),
    acts: new Set(answer.acts.map((patch) => patch.actId)),
  };
}

/** The chapter and revision a revision piece was planned for. */
export function revisionStampOf(
  id: string,
): { chapterId: string; revision: number } | undefined {
  const match = /^outlineRevision:([^:]+):(\d+)$/.exec(id);
  if (match === null) return undefined;
  const revision = Number(match[2]);
  return Number.isInteger(revision) && revision > 0
    ? { chapterId: match[1]!, revision }
    : undefined;
}

/** A failure in the answer's shape, raised while reading it. */
class RevisionReadError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function words(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function cut(
  text: string,
  limit: number,
  label: string,
  warnings: string[],
): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  warnings.push(`${label} was cut to ${limit} characters`);
  return `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RevisionReadError(`${label} was not a list`);
  }
  return value.flatMap((entry) => {
    const text = words(entry);
    return text === undefined ? [] : [text];
  });
}

/**
 * One answer, read against the chapter whose board it revises.
 *
 * An id the chapter does not hold is refused rather than skipped: it names a
 * shot this revision cannot find, and the answer was written against a board
 * that is no longer there. A framing the lists do not know is dropped with a
 * warning instead, since the words it came with still stand.
 */
export function readRevisionAnswer(
  chapter: StoryChapter,
  text: string,
): RevisionReading {
  const parsed = parseStoryJson(text);
  if (!parsed.ok) return { warnings: [], error: parsed.error };
  const value = parsed.value;
  if (!isObject(value)) {
    return { warnings: [], error: "the answer was not a revision" };
  }
  const warnings: string[] = [];
  try {
    const acts = new Map<string, StoryAct>();
    const frames = new Map<string, StoryKeyframe>();
    const frameAct = new Map<string, string>();
    for (const act of chapter.acts) {
      if (act.transition !== undefined) continue;
      acts.set(act.id, act);
      for (const keyframe of act.keyframes) {
        frames.set(keyframe.id, keyframe);
        frameAct.set(keyframe.id, act.id);
      }
    }

    const needsRebuild = value.needsRebuild ?? false;
    if (typeof needsRebuild !== "boolean") {
      throw new RevisionReadError("needsRebuild was not true or false");
    }
    const unmapped = stringList(value.unmapped, "unmapped");

    const rawActs = value.acts ?? [];
    if (!Array.isArray(rawActs)) {
      throw new RevisionReadError("acts was not a list");
    }
    const actPatches: RevisionActPatch[] = [];
    const seenActs = new Set<string>();
    for (const entry of rawActs) {
      if (!isObject(entry)) {
        throw new RevisionReadError("an act patch was not an object");
      }
      const actId = words(entry.actId);
      if (actId === undefined || !acts.has(actId)) {
        throw new RevisionReadError(
          `the answer named an act this chapter does not have: ${String(entry.actId ?? "")}`,
        );
      }
      if (seenActs.has(actId)) {
        throw new RevisionReadError(`act ${actId} was revised twice`);
      }
      seenActs.add(actId);
      const title = words(entry.title);
      const summary = words(entry.summary);
      if (title === undefined && summary === undefined) {
        warnings.push(`act ${actId} was named with nothing to change`);
        continue;
      }
      actPatches.push({
        actId,
        ...(title === undefined
          ? {}
          : { title: cut(title, TITLE_MAX, `act ${actId}'s title`, warnings) }),
        ...(summary === undefined
          ? {}
          : {
              summary: cut(
                summary,
                SUMMARY_MAX,
                `act ${actId}'s summary`,
                warnings,
              ),
            }),
      });
    }

    const rawKeyframes = value.keyframes ?? [];
    if (!Array.isArray(rawKeyframes)) {
      throw new RevisionReadError("keyframes was not a list");
    }
    const keyframePatches: RevisionKeyframePatch[] = [];
    const seenFrames = new Set<string>();
    for (const entry of rawKeyframes) {
      if (!isObject(entry)) {
        throw new RevisionReadError("a shot patch was not an object");
      }
      const actId = words(entry.actId);
      const keyframeId = words(entry.keyframeId);
      if (
        actId === undefined ||
        keyframeId === undefined ||
        frameAct.get(keyframeId) !== actId
      ) {
        throw new RevisionReadError(
          `the answer named a shot this chapter does not have: ${String(
            entry.keyframeId ?? "",
          )}`,
        );
      }
      if (seenFrames.has(keyframeId)) {
        throw new RevisionReadError(`shot ${keyframeId} was revised twice`);
      }
      seenFrames.add(keyframeId);
      const keyframe = frames.get(keyframeId)!;

      const content = words(entry.content);
      const dialogue =
        entry.dialogue === undefined
          ? undefined
          : readDialogue(entry.dialogue, keyframe, keyframeId);
      const shotSize = framing(
        entry.shotSize,
        matchShotSize,
        STORY_SHOT_SIZES,
        `shot ${keyframeId}'s framing`,
        warnings,
      );
      const cameraMove = framing(
        entry.cameraMove,
        matchCameraMove,
        STORY_CAMERA_MOVES,
        `shot ${keyframeId}'s camera move`,
        warnings,
      );
      const angle = framing(
        entry.angle,
        matchCameraAngle,
        STORY_CAMERA_ANGLES,
        `shot ${keyframeId}'s angle`,
        warnings,
      );
      if (
        content === undefined &&
        dialogue === undefined &&
        shotSize === undefined &&
        cameraMove === undefined &&
        angle === undefined
      ) {
        warnings.push(`shot ${keyframeId} was named with nothing to change`);
        continue;
      }
      const reason = words(entry.reason);
      keyframePatches.push({
        actId,
        keyframeId,
        ...(reason === undefined
          ? {}
          : {
              reason: cut(
                reason,
                SUMMARY_LINE_MAX,
                `shot ${keyframeId}'s reason`,
                warnings,
              ),
            }),
        ...(content === undefined
          ? {}
          : {
              content: cut(
                content,
                CONTENT_MAX,
                `shot ${keyframeId}'s content`,
                warnings,
              ),
            }),
        ...(dialogue === undefined ? {} : { dialogue }),
        ...(shotSize === undefined ? {} : { shotSize }),
        ...(cameraMove === undefined ? {} : { cameraMove }),
        ...(angle === undefined ? {} : { angle }),
      });
    }

    const summary = words(value.summary);
    return {
      answer: {
        summary:
          summary === undefined
            ? ""
            : cut(
                summary,
                SUMMARY_LINE_MAX,
                "the revision's summary",
                warnings,
              ),
        needsRebuild,
        unmapped,
        acts: actPatches,
        keyframes: keyframePatches,
      },
      warnings,
    };
  } catch (problem) {
    if (problem instanceof RevisionReadError) {
      return { warnings, error: problem.message };
    }
    throw problem;
  }
}

function readDialogue(
  value: unknown,
  keyframe: StoryKeyframe,
  keyframeId: string,
): RevisionDialogueLine[] {
  if (!Array.isArray(value)) {
    throw new RevisionReadError(`shot ${keyframeId}'s dialogue was not a list`);
  }
  const held = new Set(keyframe.dialogue.map((line) => line.id));
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!isObject(entry)) {
      throw new RevisionReadError(
        `a dialogue line of shot ${keyframeId} was not an object`,
      );
    }
    const speaker = words(entry.speaker);
    const text = words(entry.text);
    if (speaker === undefined || text === undefined) {
      throw new RevisionReadError(
        `a dialogue line of shot ${keyframeId} had no speaker or no words`,
      );
    }
    const id = words(entry.id);
    if (id !== undefined && !held.has(id)) {
      throw new RevisionReadError(
        `shot ${keyframeId} named a line it does not have: ${id}`,
      );
    }
    if (id !== undefined && seen.has(id)) {
      throw new RevisionReadError(`line ${id} was written twice`);
    }
    if (id !== undefined) seen.add(id);
    const tone = words(entry.tone);
    return {
      ...(id === undefined ? {} : { id }),
      speaker,
      text,
      ...(tone === undefined ? {} : { tone }),
    };
  });
}

function framing<T extends string>(
  value: unknown,
  match: (word: string) => T | undefined,
  allowed: readonly T[],
  label: string,
  warnings: string[],
): T | undefined {
  const word = words(value);
  if (word === undefined) return undefined;
  const matched = match(word);
  if (matched !== undefined) return matched;
  warnings.push(
    `${label} was "${word}", which is not one of ${allowed.join(", ")}`,
  );
  return undefined;
}

/**
 * The board with the changes the reader kept written onto it.
 *
 * Nothing but the words a revision is allowed to touch changes: a shot keeps its
 * drawings, its clips, its voices, its references and its chosen form, and a
 * hand-written video prompt stays its reader's. The chapter's version moves on
 * only when every change the answer kept was applied, and the answer is refused
 * outright when the chapter has moved on since it was planned.
 */
export function applyRevision(
  story: StoryDocument,
  chapter: StoryChapter,
  answer: RevisionAnswer,
  revision: number,
  selection: RevisionSelection,
): RevisionApplication {
  const empty: RevisionApplication = {
    commands: [],
    keyframes: 0,
    acts: 0,
    complete: false,
    stale: false,
    references: [],
  };
  if (chapterRevision(chapter) !== revision) {
    return { ...empty, stale: true };
  }
  if (answer.needsRebuild || answer.unmapped.length > 0) return empty;

  const actPatches = new Map(answer.acts.map((patch) => [patch.actId, patch]));
  const framePatches = new Map(
    answer.keyframes.map((patch) => [patch.keyframeId, patch]),
  );
  const references: RevisionReferenceChange[] = [];
  let keyframes = 0;
  let acts = 0;

  const nextActs = chapter.acts.map((act) => {
    const actPatch = actPatches.get(act.id);
    const applyAct = actPatch !== undefined && selection.acts.has(act.id);
    const kept = act.keyframes.flatMap((keyframe) => {
      const patch = framePatches.get(keyframe.id);
      return patch !== undefined && selection.keyframes.has(keyframe.id)
        ? [{ keyframe, patch }]
        : [];
    });
    if (!applyAct && kept.length === 0) return act;
    if (applyAct) acts += 1;
    const nextKeyframes =
      kept.length === 0
        ? act.keyframes
        : act.keyframes.map((keyframe) => {
            const found = kept.find(
              (entry) => entry.keyframe.id === keyframe.id,
            );
            if (found === undefined) return keyframe;
            keyframes += 1;
            const before = mentionNames(keyframe.content);
            let next: StoryKeyframe = { ...keyframe };
            if (found.patch.content !== undefined) {
              next.content = found.patch.content;
            }
            if (found.patch.dialogue !== undefined) {
              next.dialogue = revisedDialogue(
                story,
                keyframe,
                found.patch.dialogue,
              );
            }
            if (found.patch.shotSize !== undefined) {
              next.shotSize = found.patch.shotSize;
            }
            if (found.patch.cameraMove !== undefined) {
              next.cameraMove = found.patch.cameraMove;
            }
            if (found.patch.angle !== undefined) {
              next.angle = found.patch.angle;
            }
            next = recognizeKeyframeReferences(story, next);
            const after = mentionNames(next.content);
            if (!sameNames(before, after)) {
              references.push({ keyframeId: keyframe.id, before, after });
            }
            return next;
          });
    return {
      ...act,
      ...(applyAct && actPatch?.title !== undefined
        ? { title: actPatch.title }
        : {}),
      ...(applyAct && actPatch?.summary !== undefined
        ? { summary: actPatch.summary }
        : {}),
      keyframes: nextKeyframes,
    };
  });

  const complete =
    answer.acts.every((patch) => selection.acts.has(patch.actId)) &&
    answer.keyframes.every((patch) =>
      selection.keyframes.has(patch.keyframeId),
    );

  const commands: DocumentCommand[] = [];
  if (keyframes > 0 || acts > 0) {
    commands.push({
      type: "setStoryActs",
      storyId: story.id,
      chapterId: chapter.id,
      acts: nextActs,
    });
  }
  if (complete) {
    commands.push({
      type: "setStoryChapters",
      storyId: story.id,
      chapters: story.chapters.map((held) =>
        held.id === chapter.id
          ? syncChapterBoard({ ...chapter, acts: nextActs })
          : held,
      ),
    });
  }
  return { commands, keyframes, acts, complete, stale: false, references };
}

/** The cast names a shot's words mention, once each, in the order written. */
function mentionNames(content: string): string[] {
  return [...new Set(storyMentions(content).map((mention) => mention.name))];
}

function sameNames(one: string[], other: string[]): boolean {
  return (
    one.length === other.length && one.every((name, at) => name === other[at])
  );
}

/** One shot's dialogue, with every kept line's id and speaker kept. */
function revisedDialogue(
  story: StoryDocument,
  keyframe: StoryKeyframe,
  lines: RevisionDialogueLine[],
): StoryDialogueLine[] {
  const held = new Map(keyframe.dialogue.map((line) => [line.id, line]));
  return lines.map((line) => {
    const existing = line.id === undefined ? undefined : held.get(line.id);
    const characterId =
      existing?.characterId ?? characterIdFor(story, line.speaker);
    const tone = line.tone ?? existing?.tone;
    return {
      id: existing?.id ?? newId(),
      ...(characterId === undefined ? {} : { characterId }),
      speaker: line.speaker,
      text: line.text,
      ...(tone === undefined ? {} : { tone }),
    };
  });
}

function characterIdFor(
  story: StoryDocument,
  speaker: string,
): string | undefined {
  const name = speaker.trim();
  return story.elements.find(
    (element) => element.kind === "character" && element.name.trim() === name,
  )?.id;
}
