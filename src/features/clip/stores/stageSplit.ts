import { create } from "zustand";
import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";

/**
 * How much of the stage the preview takes, the timeline taking the rest.
 *
 * A ratio rather than a height: the two panes share whatever room the window
 * gives the stage, and a window resized under them does not change the share
 * each was left with. Which share reads right is about the reader and their
 * screen, so it is kept beside the column widths and never inside a project.
 */
export const SPLIT_START = 0.6;
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.85;

/** A step of the arrow keys, and the step held with Shift. */
export const SPLIT_STEP = 0.02;
export const SPLIT_BIG_STEP = 0.08;

/** A share kept inside the room a pane may take. */
export function clampSplit(share: number): number {
  if (Number.isNaN(share)) return SPLIT_START;
  const clamped = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, share));
  // Kept to a hundredth of a percent: a drag is read to the pixel, and a
  // number with a tail is a number that reads as noise in the stored file.
  return Math.round(clamped * 10_000) / 10_000;
}

function read(): number {
  const kept: unknown = currentUiPrefs().stageSplit;
  return typeof kept === "number" ? clampSplit(kept) : SPLIT_START;
}

function keep(share: number) {
  rememberUiPrefs({ stageSplit: share });
}

interface StageSplitState {
  /** The share of the stage the preview takes, in the 0–1 range. */
  share: number;
  /** Drag the splitter, kept inside the room each pane may take. */
  setShare: (share: number) => void;
  /** What a double-click does: back to the 60/40 the stage starts at. */
  resetShare: () => void;
}

export const useStageSplit = create<StageSplitState>()((set) => ({
  share: read(),

  setShare(share) {
    const next = clampSplit(share);
    keep(next);
    set({ share: next });
  },
  resetShare() {
    keep(SPLIT_START);
    set({ share: SPLIT_START });
  },
}));
