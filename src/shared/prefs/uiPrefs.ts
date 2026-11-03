import { uiPrefsApi } from "../../api/uiPrefs";
import { replaceUiPrefs, setUiPrefsWriter } from "./prefsData";
import type { UiPrefsPatch } from "./types";

/**
 * How long changes gather before they are written.
 *
 * Dragging a panel edge changes a width on every pointer move, and the file
 * only needs the width the hand stopped at.
 */
const FLUSH_DELAY_MS = 400;

let pending: UiPrefsPatch | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Reads the interface choices out and starts writing changes back.
 *
 * A failure leaves the defaults in place for this visit rather than keeping
 * the window from opening: the interface still works, it just starts fresh.
 */
export async function loadUiPrefs(): Promise<void> {
  try {
    replaceUiPrefs(await uiPrefsApi.get());
  } catch {
    // The defaults already in the snapshot are what a fresh machine means.
  }
  setUiPrefsWriter(queue);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      void flushUiPrefs(true);
    });
  }
}

function queue(patch: UiPrefsPatch): void {
  pending = pending === null ? patch : mergePatches(pending, patch);
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushUiPrefs();
  }, FLUSH_DELAY_MS);
}

/** Writes whatever is waiting, and does nothing when nothing is. */
export async function flushUiPrefs(keepalive = false): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const patch = pending;
  pending = null;
  if (patch === null) return;
  try {
    await uiPrefsApi.patch(patch, keepalive);
  } catch (error) {
    // A choice that did not reach the file still stands for this visit.
    console.warn("interface preferences were not saved:", error);
  }
}

/** Two patches as one, with map rows merged rather than replaced. */
function mergePatches(base: UiPrefsPatch, next: UiPrefsPatch): UiPrefsPatch {
  return {
    ...base,
    ...next,
    openCanvases: mergeRows(base.openCanvases, next.openCanvases),
    clipTimelines: mergeRows(base.clipTimelines, next.clipTimelines),
    clipViews: mergeRows(base.clipViews, next.clipViews),
    storyModels: mergeRows(base.storyModels, next.storyModels),
    storyPlaces: mergeRows(base.storyPlaces, next.storyPlaces),
  };
}

function mergeRows<T>(
  base: Record<string, T> | undefined,
  next: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (base === undefined) return next;
  if (next === undefined) return base;
  return { ...base, ...next };
}
