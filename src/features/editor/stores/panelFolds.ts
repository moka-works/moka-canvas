import { create } from "zustand";
import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";
import type { PanelSide } from "./panelWidths";

/**
 * Whether each column beside the canvas is folded away.
 *
 * A column folded is a column out of the way rather than a column gone: what
 * it showed is still there and one click brings it back, so the canvas can be
 * given the whole window for as long as it is worth doing. Which columns are
 * folded is about the reader and their window rather than about the work, so
 * it is kept in the interface preferences beside the widths they dragged and
 * never inside a project.
 */
interface StoredFolds {
  left: boolean;
  right: boolean;
}

function read(): StoredFolds {
  const kept = currentUiPrefs().panelFolds;
  return {
    left: kept.left === true,
    right: kept.right === true,
  };
}

function keep(folds: StoredFolds) {
  rememberUiPrefs({ panelFolds: folds });
}

export interface PanelFoldsState extends StoredFolds {
  /** Fold a column away, or bring the one that was folded back. */
  setFolded: (side: PanelSide, folded: boolean) => void;
  /** What the corner triangle does: the column goes the other way round. */
  toggle: (side: PanelSide) => void;
}

const foldsOf = (state: PanelFoldsState): StoredFolds => ({
  left: state.left,
  right: state.right,
});

export const usePanelFolds = create<PanelFoldsState>()((set, get) => {
  const write = (next: StoredFolds) => {
    keep(next);
    set(next);
  };
  return {
    ...read(),
    setFolded: (side, folded) => write({ ...foldsOf(get()), [side]: folded }),
    toggle: (side) => write({ ...foldsOf(get()), [side]: !get()[side] }),
  };
});
