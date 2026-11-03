import { create } from "zustand";
import type { PictureTool } from "../../../api/tools";
import { MAX_DIVISIONS } from "../../../shared/domain";
import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";

/** The tools that work on a picture here, without asking anybody for anything. */
export const PICTURE_TOOLS: readonly PictureTool[] = [
  "crop",
  "split",
  "resize",
  "tilt",
];

/**
 * Everything the bar can offer, in the order it offers them.
 *
 * Wider than the local tools: a repaint and a reading-back both ask a model
 * rather than working the pixels here, but they are offered in the same row and
 * hidden by the same setting, because from the node each is one more way of
 * getting something out of the picture that is there.
 */
export type BarEntry = PictureTool | "repaint" | "describe";

export const BAR_ENTRIES: readonly BarEntry[] = [
  ...PICTURE_TOOLS,
  "repaint",
  "describe",
];

/**
 * The entries answered by a dialog of their own.
 *
 * What each of them asks for is not a set of numbers: one is a region drawn on
 * the picture, and the other is a question put to a model that can see it. Both
 * are asked of a picture and both end in a model, which is what makes them one
 * kind of thing apart from the four that work the pixels here.
 */
export const ASKING_A_MODEL: readonly BarEntry[] = ["repaint", "describe"];

/**
 * Whether an entry is one of the four that work the pixels here.
 *
 * Asked rather than compared against a list of four, so an entry added to either
 * side moves both answers with it.
 */
export function isPictureTool(entry: BarEntry): entry is PictureTool {
  return !ASKING_A_MODEL.includes(entry);
}

/**
 * What each entry is called on the bar.
 *
 * "Resample" rather than "resize" because a resize here is arithmetic on the
 * pixels that are there: it can make a picture smaller cleanly and larger only
 * by guessing, and the word has to say which of those it is doing before the
 * model that can actually add detail is offered beside it.
 */
export const TOOL_LABELS: Record<BarEntry, string> = {
  crop: "editor:tool.crop",
  split: "editor:tool.split",
  resize: "editor:tool.resize",
  tilt: "editor:tool.tilt",
  repaint: "editor:tool.repaint",
  describe: "editor:tool.describe",
};

/** The ratios the crop field offers before anything is typed into it. */
export const CROP_RATIOS: readonly string[] = [
  "1:1",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
];

/** The grids the split field offers before anything is typed into it. */
export const SPLIT_GRIDS: readonly { rows: number; cols: number }[] = [
  { rows: 1, cols: 2 },
  { rows: 2, cols: 2 },
  { rows: 3, cols: 3 },
];

/** The widest a division may be asked for, which is the piece ceiling's root. */
export const MAX_DIVISIONS_PER_SIDE = Math.floor(Math.sqrt(MAX_DIVISIONS));

interface StoredPrefs {
  shown: BarEntry[];
  cropRatio: string | null;
  grid: { rows: number; cols: number } | null;
}

const START: StoredPrefs = {
  shown: [...BAR_ENTRIES],
  cropRatio: null,
  grid: null,
};

/**
 * Where these are kept: the interface preferences file.
 *
 * Which tools somebody likes to see, and the grid they last divided by, are
 * about them rather than about the work, so they are kept beside the work and
 * never inside it — a package handed to somebody else carries none of it.
 */
function read(): StoredPrefs {
  const kept = currentUiPrefs().pictureTools;
  return {
    shown: Array.isArray(kept.shown)
      ? BAR_ENTRIES.filter((entry) => kept.shown?.includes(entry))
      : START.shown,
    cropRatio: typeof kept.cropRatio === "string" ? kept.cropRatio : null,
    grid:
      kept.grid &&
      Number.isInteger(kept.grid.rows) &&
      Number.isInteger(kept.grid.cols)
        ? { rows: kept.grid.rows, cols: kept.grid.cols }
        : null,
  };
}

function keep(prefs: StoredPrefs) {
  rememberUiPrefs({ pictureTools: prefs });
}

export interface ToolPrefsState extends StoredPrefs {
  toggleShown: (entry: BarEntry) => void;
  rememberCrop: (ratio: string | null) => void;
  rememberGrid: (grid: { rows: number; cols: number } | null) => void;
}

const prefsOf = (state: ToolPrefsState): StoredPrefs => ({
  shown: state.shown,
  cropRatio: state.cropRatio,
  grid: state.grid,
});

export const useToolPrefs = create<ToolPrefsState>()((set, get) => {
  const write = (next: StoredPrefs) => {
    keep(next);
    set(next);
  };
  return {
    ...read(),
    // Put back in the order the bar offers them, so an entry hidden and shown
    // again does not move to the end of the row.
    toggleShown: (entry) =>
      write({
        ...prefsOf(get()),
        shown: BAR_ENTRIES.filter((candidate) =>
          candidate === entry
            ? !get().shown.includes(entry)
            : get().shown.includes(candidate),
        ),
      }),
    rememberCrop: (ratio) => write({ ...prefsOf(get()), cropRatio: ratio }),
    rememberGrid: (grid) => write({ ...prefsOf(get()), grid }),
  };
});
