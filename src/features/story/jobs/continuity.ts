/**
 * The staging a board's shots must agree on, written back as a patch.
 *
 * A check is not a board: it may move a person, turn a face, place a camera or
 * rewrite the still frame, and it may never add a shot, take one away, or say
 * a different line. That is what makes it safe to apply as one step — and why
 * an answer that names a shot the board no longer holds is refused whole.
 */

import type { DocumentCommand } from "../../../shared/domain/types";
import {
  STORY_CAMERA_ANGLES,
  STORY_CAMERA_MOVES,
  STORY_SHOT_SIZES,
  type StoryCameraAngle,
  type StoryCameraMove,
  type StoryChapter,
  type StoryDocument,
  type StoryShotSize,
} from "../../../shared/domain/types";
import { parseStoryJson } from "../../../shared/domain/parse/json";
import type { StoryJobItem } from "../../../api/story";
import { chapterRevision } from "../../../shared/domain/story";
import { continuityFingerprint, jobKey } from "./plan";

/** One shot's staging as the check would have it. */
export interface ContinuityPatch {
  actId: string;
  keyframeId: string;
  reason?: string;
  content?: string;
  motion?: string;
  shotSize?: StoryShotSize;
  cameraMove?: StoryCameraMove;
  angle?: StoryCameraAngle;
}

/** What a check's answer said, once it was read strictly. */
export type ContinuityRead =
  | { ok: true; summary: string; patches: ContinuityPatch[] }
  | { ok: false; error: string };

/** What applying a check did to the board. */
export interface ContinuityApplication {
  commands: DocumentCommand[];
  changed: number;
  summary?: string;
  stale?: boolean;
  error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function words(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

const PATCH_KEYS = new Set([
  "actId",
  "keyframeId",
  "reason",
  "content",
  "motion",
  "shotSize",
  "cameraMove",
  "angle",
]);

/**
 * The patches a check's answer holds, or why the answer cannot be used.
 *
 * The reading is all-or-nothing: a patch whose shot is gone, whose framing is
 * not a framing, or that tries to say a line is a patch the board would have
 * to be trusted with, and none of them are written.
 */
export function readContinuityAnswer(item: StoryJobItem): ContinuityRead {
  const read = parseStoryJson(item.text ?? "");
  if (!read.ok) return { ok: false, error: read.error };
  if (!isObject(read.value)) {
    return { ok: false, error: "the answer was not an object" };
  }
  const raw = read.value.patches;
  if (!Array.isArray(raw)) {
    return { ok: false, error: "the answer held no patches list" };
  }
  const summary = words(read.value.summary) ?? "";
  const seen = new Set<string>();
  const patches: ContinuityPatch[] = [];
  for (const [at, entry] of raw.entries()) {
    const where = `patch ${at + 1}`;
    if (!isObject(entry)) {
      return { ok: false, error: `${where} was not an object` };
    }
    for (const key of Object.keys(entry)) {
      if (!PATCH_KEYS.has(key)) {
        return { ok: false, error: `${where} asked to change ${key}` };
      }
    }
    const actId = words(entry.actId);
    const keyframeId = words(entry.keyframeId);
    if (actId === undefined || keyframeId === undefined) {
      return { ok: false, error: `${where} did not name its act and shot` };
    }
    const target = `${actId}:${keyframeId}`;
    if (seen.has(target)) {
      return { ok: false, error: `${where} patched the same shot twice` };
    }
    seen.add(target);
    const content =
      entry.content === undefined ? undefined : words(entry.content);
    const motion = entry.motion === undefined ? undefined : words(entry.motion);
    const shotSize = oneOf(entry.shotSize, STORY_SHOT_SIZES);
    const cameraMove = oneOf(entry.cameraMove, STORY_CAMERA_MOVES);
    const angle = oneOf(entry.angle, STORY_CAMERA_ANGLES);
    for (const [field, value] of [
      ["content", entry.content],
      ["motion", entry.motion],
      ["shotSize", entry.shotSize],
      ["cameraMove", entry.cameraMove],
      ["angle", entry.angle],
    ] as const) {
      if (value === undefined) continue;
      if (
        (field === "content" && content === undefined) ||
        (field === "motion" && motion === undefined) ||
        (field === "shotSize" && shotSize === undefined) ||
        (field === "cameraMove" && cameraMove === undefined) ||
        (field === "angle" && angle === undefined)
      ) {
        return {
          ok: false,
          error: `${where} gave ${field} a value the board cannot use`,
        };
      }
    }
    if (content !== undefined && content.trim() === "") {
      return { ok: false, error: `${where} left the still frame empty` };
    }
    if (
      content === undefined &&
      motion === undefined &&
      shotSize === undefined &&
      cameraMove === undefined &&
      angle === undefined
    ) {
      return { ok: false, error: `${where} changed nothing` };
    }
    patches.push({
      actId,
      keyframeId,
      ...(words(entry.reason) === undefined
        ? {}
        : { reason: words(entry.reason)! }),
      ...(content === undefined ? {} : { content }),
      ...(motion === undefined ? {} : { motion }),
      ...(shotSize === undefined ? {} : { shotSize }),
      ...(cameraMove === undefined ? {} : { cameraMove }),
      ...(angle === undefined ? {} : { angle }),
    });
  }
  return { ok: true, summary, patches };
}

/** Whether a check's answer was written against this board. */
export function continuityIsStale(
  chapter: StoryChapter,
  item: StoryJobItem,
): boolean {
  const prefix = `${jobKey({ kind: "continuity", chapterId: chapter.id })}:`;
  if (!item.id.startsWith(prefix)) return true;
  const [revision, fingerprint] = item.id.slice(prefix.length).split(":");
  return (
    Number(revision) !== chapterRevision(chapter) ||
    fingerprint !== continuityFingerprint(chapter)
  );
}

/**
 * The board with a check's patches written into it.
 *
 * A patch changes a shot's existing fields and nothing else: the dialogue, the
 * references, the pictures and the clips stay where they are, and an act's
 * cast, place and sound are not the check's to move.
 */
export function applyContinuity(
  story: StoryDocument,
  chapter: StoryChapter,
  item: StoryJobItem,
): ContinuityApplication {
  if (continuityIsStale(chapter, item)) {
    return { commands: [], changed: 0, stale: true };
  }
  const read = readContinuityAnswer(item);
  if (!read.ok) return { commands: [], changed: 0, error: read.error };
  if (read.patches.length === 0) {
    return { commands: [], changed: 0, summary: read.summary };
  }
  const acts = new Map(
    chapter.acts
      .filter((act) => act.transition === undefined)
      .map((act) => [act.id, act]),
  );
  const byShot = new Map(
    [...acts.values()].flatMap((act) =>
      act.keyframes.map(
        (keyframe) => [`${act.id}:${keyframe.id}`, keyframe] as const,
      ),
    ),
  );
  for (const patch of read.patches) {
    if (!byShot.has(`${patch.actId}:${patch.keyframeId}`)) {
      return {
        commands: [],
        changed: 0,
        error: `the shot ${patch.keyframeId} is no longer in the board`,
      };
    }
  }
  const changed = new Set<string>();
  const next = chapter.acts.map((act) => {
    if (act.transition !== undefined) return act;
    return {
      ...act,
      keyframes: act.keyframes.map((keyframe) => {
        const patch = read.patches.find(
          (held) => held.actId === act.id && held.keyframeId === keyframe.id,
        );
        if (patch === undefined) return keyframe;
        changed.add(keyframe.id);
        return {
          ...keyframe,
          ...(patch.content === undefined ? {} : { content: patch.content }),
          ...(patch.motion === undefined ? {} : { motion: patch.motion }),
          ...(patch.shotSize === undefined ? {} : { shotSize: patch.shotSize }),
          ...(patch.cameraMove === undefined
            ? {}
            : { cameraMove: patch.cameraMove }),
          ...(patch.angle === undefined ? {} : { angle: patch.angle }),
        };
      }),
    };
  });
  if (changed.size === 0) {
    return { commands: [], changed: 0, summary: read.summary };
  }
  return {
    commands: [
      {
        type: "setStoryActs",
        storyId: story.id,
        chapterId: chapter.id,
        acts: next,
      },
    ],
    changed: changed.size,
    summary: read.summary,
  };
}
