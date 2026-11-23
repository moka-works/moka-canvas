/**
 * How far a chapter's board is from the time the chapter was given.
 *
 * A telling is cut to a running time before its episodes are written, and a
 * board that plans far past or far short of that time is a board whose film is
 * already the wrong length. The board is not refused for it — a story may
 * argue with its own target — but the difference is said where the reader is,
 * and travels with a repair ask when one is being made anyway.
 */

import { actPlannedMs } from "../../../shared/domain/story";
import type { StoryChapter } from "../../../shared/domain/types";

/** How far a chapter's plan stands from its target. */
export type BudgetState = "ok" | "warn" | "far";

export interface ChapterBudget {
  plannedMs: number;
  targetMs: number;
  /** The planned time over the target; one when there is no target. */
  ratio: number;
  state: BudgetState;
}

/** The time a chapter's acts plan for, bridges included. */
export function plannedChapterMs(chapter: StoryChapter): number {
  return chapter.acts.reduce((sum, act) => sum + actPlannedMs(act), 0);
}

/** A chapter's plan against its target. */
export function chapterBudget(chapter: StoryChapter): ChapterBudget {
  const plannedMs = plannedChapterMs(chapter);
  const targetMs = chapter.targetDurationMs;
  if (targetMs <= 0) {
    return { plannedMs, targetMs, ratio: 1, state: "ok" };
  }
  const ratio = plannedMs / targetMs;
  const state: BudgetState =
    ratio >= 0.8 && ratio <= 1.25
      ? "ok"
      : ratio >= 0.5 && ratio <= 2
        ? "warn"
        : "far";
  return { plannedMs, targetMs, ratio, state };
}

/**
 * The difference as a repair ask would say it, when it is worth saying.
 *
 * This is context for an ask that is already being made: the budget never
 * starts a model call of its own.
 */
export function budgetProblem(chapter: StoryChapter): string | undefined {
  const budget = chapterBudget(chapter);
  if (budget.state === "ok" || budget.plannedMs === 0) return undefined;
  const planned = Math.round(budget.plannedMs / 100) / 10;
  const target = Math.round(budget.targetMs / 100) / 10;
  return `the board plans ${planned} s for a chapter that should run about ${target} s`;
}
