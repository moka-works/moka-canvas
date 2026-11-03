import { create } from "zustand";
import type { CanvasId, MokaFile } from "../../../shared/domain";
import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";

/**
 * Which boards are open, kept in the interface preferences beside the project
 * rather than inside it.
 *
 * A project holds every canvas it has, and the strip across the top holds the
 * ones being looked at: opening a board from the tree puts a tab up, and closing
 * a tab puts the board down without touching it. What was open is remembered per
 * project, so a project opens onto the work it was left on rather than onto
 * whichever board happens to be first — but the remembering is about this reader
 * and this machine, so a package handed to somebody else carries none of it and
 * opens onto the first board like any other.
 */
function read(projectId: string): CanvasId[] {
  const kept: unknown = currentUiPrefs().openCanvases[projectId];
  if (!Array.isArray(kept)) return [];
  return kept.filter((id): id is CanvasId => typeof id === "string");
}

function keep(projectId: string, ids: CanvasId[]) {
  rememberUiPrefs({ openCanvases: { [projectId]: ids } });
}

interface OpenCanvasesState {
  /** The project the list belongs to; another project opens another list. */
  projectId: string | null;
  /** Open boards, in the order they were opened. */
  ids: CanvasId[];
  /**
   * Takes up the list a project was left with, and says which board to open
   * onto.
   *
   * Ids the document no longer has are dropped rather than kept as tabs that
   * would show nothing, and a project left with none open opens onto the board
   * it would have opened onto anyway.
   */
  adopt: (moka: MokaFile) => CanvasId | null;
  open: (canvasId: CanvasId) => void;
  /**
   * Puts a board down, and says which board to look at instead when the one put
   * down was the one being looked at — or null when it was not, since nothing
   * has moved. The last tab open is not closable: an editor with no board in it
   * has nothing to show and nowhere to put what is asked of it.
   *
   * Told which board is being looked at rather than reading it, since what is
   * open is kept here and what is on screen is kept by the project, and a store
   * that reads the other to answer a question is two stores that cannot be
   * loaded in either order.
   */
  close: (
    canvasId: CanvasId,
    activeCanvasId: CanvasId | null,
  ) => CanvasId | null;
  /**
   * Drops the tabs whose boards the document no longer has, and says which board
   * to look at when the one being looked at went — or when nothing is left open,
   * since a strip with no tab on it is an editor showing nothing.
   *
   * What a board is deleted by does not matter: a tree, an undo, or a document
   * rewritten by a run all leave the same question, and asking the list to agree
   * with the document answers it once.
   */
  prune: (
    canvasIds: CanvasId[],
    activeCanvasId: CanvasId | null,
  ) => CanvasId | null;
  forget: () => void;
}

export const useOpenCanvases = create<OpenCanvasesState>()((set, get) => ({
  projectId: null,
  ids: [],

  adopt(moka) {
    const projectId = moka.metadata.id;
    const has = new Set(moka.canvas.map((canvas) => canvas.id));
    const kept = read(projectId).filter((id) => has.has(id));
    const first = moka.canvas[0]?.id ?? null;
    const ids = kept.length > 0 ? kept : first ? [first] : [];
    set({ projectId, ids });
    keep(projectId, ids);
    // The board the work was left on, which is the one opened last.
    return ids.at(-1) ?? first;
  },

  open(canvasId) {
    const { ids, projectId } = get();
    if (ids.includes(canvasId)) return;
    const next = [...ids, canvasId];
    set({ ids: next });
    if (projectId) keep(projectId, next);
  },

  close(canvasId, activeCanvasId) {
    const { ids, projectId } = get();
    if (!ids.includes(canvasId) || ids.length <= 1) return null;
    const wasAt = ids.indexOf(canvasId);
    const next = ids.filter((id) => id !== canvasId);
    set({ ids: next });
    if (projectId) keep(projectId, next);
    if (activeCanvasId !== canvasId) return null;
    // The board being looked at, put down, is looked away from: the one opened
    // before it takes its place, and the one after it when it was the first.
    return next[Math.min(wasAt, next.length - 1)] ?? next[0] ?? null;
  },

  prune(canvasIds, activeCanvasId) {
    const { ids, projectId } = get();
    const has = new Set(canvasIds);
    const next = ids.filter((id) => has.has(id));
    const changed = next.length !== ids.length;
    if (changed) {
      const kept = next.length > 0 ? next : canvasIds.slice(0, 1);
      set({ ids: kept });
      if (projectId) keep(projectId, kept);
      // Only a board that was named and is now gone moves the view: nothing
      // named means nothing was being looked at as far as the caller knows, and
      // a deletion elsewhere on the strip is not a reason to switch boards.
      if (activeCanvasId !== null && !has.has(activeCanvasId)) {
        const wasAt = ids.indexOf(activeCanvasId);
        return kept[Math.max(0, Math.min(wasAt, kept.length - 1))] ?? null;
      }
      return null;
    }
    if (ids.length === 0 && canvasIds.length > 0) {
      const first = canvasIds[0];
      set({ ids: [first] });
      if (projectId) keep(projectId, [first]);
      return first;
    }
    return null;
  },

  forget() {
    set({ projectId: null, ids: [] });
  },
}));
