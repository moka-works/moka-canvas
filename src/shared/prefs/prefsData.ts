import type { UiPreferences, UiPrefsPatch } from "./types";

/**
 * The interface choices the server last read out, held here for the stores
 * that need them before a request could answer.
 *
 * The document itself lives in the metadata directory; this module is only
 * the copy the running window reads synchronously. It is kept on the global
 * rather than in a module binding so a test that re-imports a store sees the
 * same "file" a fresh visit would, exactly as the old storage did.
 */
const SLOT = "__mokaCanvasUiPrefs";

interface Host {
  __mokaCanvasUiPrefs?: UiPreferences;
}

function host(): Host {
  return globalThis as unknown as Host;
}

/** The interface as it is before anybody has changed anything. */
export function defaultUiPrefs(): UiPreferences {
  return {
    locale: "system",
    canvasTheme: "graphite",
    panelFolds: { left: false, right: false },
    panelWidths: { left: null, right: null },
    pictureTools: { shown: null, cropRatio: null, grid: null },
    openCanvases: {},
    clipTimelines: {},
    clipViews: {},
    clipQuality: "full",
    clipVolume: 1,
    clipSnap: true,
    stageSplit: 0.6,
    storyModels: {},
    storyPlaces: {},
    directorOnboarding: null,
    lastUpdateCheck: null,
  };
}

/** The choices this window is working from. */
export function currentUiPrefs(): UiPreferences {
  const kept = host()[SLOT];
  if (kept !== undefined) return kept;
  const defaults = defaultUiPrefs();
  host()[SLOT] = defaults;
  return defaults;
}

/** Adopts what the server read out, or what a test stands in for it. */
export function replaceUiPrefs(next: UiPreferences): void {
  host()[SLOT] = next;
}

/** Puts the snapshot back to the defaults, as a fresh machine would be. */
export function resetUiPrefs(): void {
  host()[SLOT] = defaultUiPrefs();
}

/**
 * Applies a patch to the snapshot.
 *
 * Scalars replace; a map entry with a value is written and one with `null` is
 * removed; a field the patch does not name is left alone.
 */
export function applyUiPatch(
  current: UiPreferences,
  patch: UiPrefsPatch,
): UiPreferences {
  const next: UiPreferences = {
    ...current,
    panelFolds: { ...current.panelFolds },
    panelWidths: { ...current.panelWidths },
    pictureTools: { ...current.pictureTools },
    openCanvases: { ...current.openCanvases },
    clipTimelines: { ...current.clipTimelines },
    clipViews: { ...current.clipViews },
    storyModels: { ...current.storyModels },
    storyPlaces: { ...current.storyPlaces },
  };
  if (patch.locale !== undefined) next.locale = patch.locale;
  if (patch.canvasTheme !== undefined) next.canvasTheme = patch.canvasTheme;
  if (patch.panelFolds !== undefined) next.panelFolds = { ...patch.panelFolds };
  if (patch.panelWidths !== undefined) {
    next.panelWidths = { ...patch.panelWidths };
  }
  if (patch.pictureTools !== undefined) {
    next.pictureTools = { ...patch.pictureTools };
  }
  if (patch.clipQuality !== undefined) next.clipQuality = patch.clipQuality;
  if (patch.clipVolume !== undefined) next.clipVolume = patch.clipVolume;
  if (patch.clipSnap !== undefined) next.clipSnap = patch.clipSnap;
  if (patch.stageSplit !== undefined) next.stageSplit = patch.stageSplit;
  if (patch.directorOnboarding !== undefined) {
    next.directorOnboarding = patch.directorOnboarding;
  }
  if (patch.lastUpdateCheck !== undefined) {
    next.lastUpdateCheck = patch.lastUpdateCheck;
  }
  assignMap(next.openCanvases, patch.openCanvases);
  assignMap(next.clipTimelines, patch.clipTimelines);
  assignMap(next.clipViews, patch.clipViews);
  assignMap(next.storyModels, patch.storyModels);
  assignMap(next.storyPlaces, patch.storyPlaces);
  return next;
}

/** Writes the rows a patch carries, and drops the ones it sends as `null`. */
function assignMap<T>(
  target: Record<string, T>,
  patch: Record<string, T | null> | undefined,
): void {
  if (patch === undefined) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else target[key] = value;
  }
}

type Writer = (patch: UiPrefsPatch) => void;

let writer: Writer | null = null;

/** The one place that knows how a snapshot change reaches the file. */
export function setUiPrefsWriter(next: Writer | null): void {
  writer = next;
}

/** Changes the interface here at once, and asks the file to catch up. */
export function rememberUiPrefs(patch: UiPrefsPatch): void {
  replaceUiPrefs(applyUiPatch(currentUiPrefs(), patch));
  writer?.(patch);
}
