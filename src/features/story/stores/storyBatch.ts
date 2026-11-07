/**
 * How many generations the story room asks one model to serve at once.
 *
 * The count is about the machine and the provider rather than about a telling,
 * so it is kept beside the project like the models themselves. A batch carries
 * it so the server can queue the pieces: the same model never runs more than
 * this many at once, however many batches are asking it, while a different
 * model is a different queue with the same number of slots of its own.
 *
 * The deployment's own ceiling is read from the public configuration, so the
 * picker never offers a count the server would refuse.
 */

import { create } from "zustand";

import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";
import { useAppStore } from "../../editor/stores/appStore";

export const STORY_PARALLEL_MIN = 1;
export const STORY_PARALLEL_MAX = 8;
export const STORY_PARALLEL_DEFAULT = 3;

function clamp(value: number): number {
  return Math.min(
    STORY_PARALLEL_MAX,
    Math.max(STORY_PARALLEL_MIN, Math.round(value)),
  );
}

/** The most this deployment lets one model serve at once. */
export function storyMaxParallel(): number {
  const ceiling = useAppStore.getState().config?.storyMaxParallelItems;
  return typeof ceiling === "number" && ceiling >= STORY_PARALLEL_MIN
    ? Math.min(STORY_PARALLEL_MAX, Math.floor(ceiling))
    : STORY_PARALLEL_MAX;
}

function read(): number {
  const kept = currentUiPrefs().storyParallel;
  const value = typeof kept === "number" ? kept : STORY_PARALLEL_DEFAULT;
  return Math.min(clamp(value), storyMaxParallel());
}

interface StoryBatchState {
  parallel: number;
  /** Sets the count, within what this deployment allows. */
  choose: (value: number) => void;
}

export const useStoryBatch = create<StoryBatchState>()((set) => ({
  parallel: read(),

  choose(value) {
    const parallel = Math.min(clamp(value), storyMaxParallel());
    rememberUiPrefs({ storyParallel: parallel });
    set({ parallel });
  },
}));

/** The count a batch is started with, read where it is started. */
export function storyParallel(): number {
  return Math.min(useStoryBatch.getState().parallel, storyMaxParallel());
}
