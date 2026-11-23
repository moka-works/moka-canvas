/**
 * A written answer asked again when it could not be read.
 *
 * A model that answers with prose, a fence that never closes or a shape the
 * reader cannot use has still answered something. Rather than leave the step
 * with a note and no work, the same ask travels again with the reading's own
 * reason in hand — twice, and then the note stands for the reader to act on.
 *
 * A manuscript's element reading is left to the step that asked for it: its
 * parts are merged with one another, and a repair landing between the merge
 * and the cast it was made from would be worse than asking by hand.
 */

import type { StoryJobItemDraft, StoryJobRecord } from "../../../api/story";
import type { StoryDocument } from "../../../shared/domain/types";
import { storyAnswerRepairPrompt } from "../../../shared/prompts";
import {
  readElementsAnswer,
  readOutlineAnswer,
  type UnreadableAnswer,
} from "./apply";

/** How many times one answer is asked for again before the note stands. */
export const MAX_ANSWER_REPAIRS = 2;

const attempts = new Map<string, number>();

/** Forgets every count, for a room opened on another story. */
export function clearDoctorAttempts(): void {
  attempts.clear();
}

function attemptKey(
  storyId: string,
  kind: UnreadableAnswer["kind"],
  itemId: string,
): string {
  return `${storyId}:${kind}:${itemId}`;
}

/** An answer that came home whole again: the count for its place starts over. */
export function forgetAnswerRepair(
  storyId: string,
  kind: UnreadableAnswer["kind"],
  itemId: string,
): void {
  attempts.delete(attemptKey(storyId, kind, itemId));
}

/**
 * The ask that would repair this unreadable answer, or nothing when it is not
 * one to repair.
 *
 * The same place and the same id travel, so what comes back is read into the
 * step that was waiting for it rather than beside it.
 */
export function planAnswerRepair(
  story: StoryDocument,
  record: StoryJobRecord,
  entry: UnreadableAnswer,
): StoryJobItemDraft | undefined {
  // A part of a manuscript's element reading is merged with its neighbours;
  // its own step is where that reading is asked for again.
  if (entry.kind === "elements" && /^elements:\d+$/.test(entry.id)) {
    return undefined;
  }
  const item = record.items.find((held) => held.id === entry.id);
  if (item === undefined || item.status !== "succeeded") return undefined;
  const text = item.text ?? "";
  const reason =
    entry.kind === "outline"
      ? readOutlineAnswer(text).error
      : readElementsAnswer(text).error;
  if (reason === undefined) return undefined;
  const key = attemptKey(story.id, entry.kind, item.id);
  const tried = attempts.get(key) ?? 0;
  if (tried >= MAX_ANSWER_REPAIRS) return undefined;
  attempts.set(key, tried + 1);
  return {
    id: item.id,
    target: item.target,
    capability: "text",
    ...(item.system === undefined ? {} : { system: item.system }),
    prompt: storyAnswerRepairPrompt(
      item.prompt,
      Array.from(text).slice(0, 8_000).join(""),
      [reason],
    ),
  };
}
