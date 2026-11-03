import { create } from "zustand";
import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";

/** Which column beside the canvas is being spoken of. */
export type PanelSide = "left" | "right";

/** The width a column starts at before anybody has dragged its edge. */
export const PANEL_START: Record<PanelSide, number> = {
  left: 240,
  right: 240,
};

/**
 * How far a column may be dragged.
 *
 * The floor is what still shows a row of the tree or a field of the inspector
 * without cutting it in half; the ceiling is where the canvas beside it stops
 * being worth looking at, which is the reason both columns exist.
 */
export const PANEL_MIN = 180;
export const PANEL_MAX = 640;

/** A step of the arrow keys, and the step held with Shift. */
export const PANEL_STEP = 8;
export const PANEL_BIG_STEP = 48;

/** A width kept inside the room a column is allowed to take. */
export function clampPanelWidth(width: number, ceiling = PANEL_MAX): number {
  if (!Number.isFinite(width)) return PANEL_START.left;
  const top = Math.max(PANEL_MIN, ceiling);
  return Math.min(top, Math.max(PANEL_MIN, Math.round(width)));
}

/**
 * The room a column may take of this window.
 *
 * The ceiling above is a ceiling on paper: a window narrow enough that two
 * columns at it would leave the canvas nothing is a window where the columns
 * have to stop earlier, or what they are beside disappears underneath them.
 */
export function panelCeiling(): number {
  if (typeof window === "undefined") return PANEL_MAX;
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth * 0.45));
}

interface StoredWidths {
  left: number | null;
  right: number | null;
}

/**
 * Where the widths are kept: the interface preferences file.
 *
 * How wide somebody likes a column is about them rather than about the work, so
 * it is kept beside the project and never inside it — a package handed to
 * somebody else carries none of it. `null` is not "no width" but "not dragged
 * yet", which leaves the column at the width its own stylesheet gives it: the
 * conversation column reads wider than an inspector, and each keeps that until
 * somebody asks it otherwise.
 */
function read(): StoredWidths {
  const kept = currentUiPrefs().panelWidths;
  return {
    left: keptWidth(kept.left),
    right: keptWidth(kept.right),
  };
}

/** A number that was written here, and nothing else passes as one. */
function keptWidth(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? clampPanelWidth(value)
    : null;
}

function keep(widths: StoredWidths) {
  rememberUiPrefs({ panelWidths: widths });
}

export interface PanelWidthsState extends StoredWidths {
  /** Drag a column to a width, kept inside the room it may take. */
  setWidth: (side: PanelSide, width: number) => void;
  /** Hand a column back to the width its own stylesheet gives it. */
  resetWidth: (side: PanelSide) => void;
}

const widthsOf = (state: PanelWidthsState): StoredWidths => ({
  left: state.left,
  right: state.right,
});

export const usePanelWidths = create<PanelWidthsState>()((set, get) => {
  const write = (next: StoredWidths) => {
    keep(next);
    set(next);
  };
  return {
    ...read(),
    setWidth: (side, width) =>
      write({
        ...widthsOf(get()),
        [side]: clampPanelWidth(width, panelCeiling()),
      }),
    resetWidth: (side) => write({ ...widthsOf(get()), [side]: null }),
  };
});
