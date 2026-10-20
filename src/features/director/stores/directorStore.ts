import { create } from "zustand";
import { useAppStore } from "../../editor/stores/appStore";

/**
 * Which scene the room has open.
 *
 * Only the reader's place is kept here, never the scene itself: the document
 * is the one authority on what is staged, and a draft that outlived a reload
 * would be a second one. A refresh forgets which desk was open, which is the
 * honest reading of a page reload.
 */
export interface DirectorPlace {
  /** The card whose scene is open; null when the room is closed. */
  nodeId: string | null;
  open: (nodeId: string) => void;
  close: () => void;
}

export const useDirectorStore = create<DirectorPlace>()((set) => ({
  nodeId: null,
  open: (nodeId) => set({ nodeId }),
  close: () => set({ nodeId: null }),
}));

/** Opens a director card's scene as a page of its own. */
export function openDirector(nodeId: string): void {
  useDirectorStore.getState().open(nodeId);
  useAppStore.getState().setPhase("director");
}

/** Leaves the room for the board the card sits on. */
export function closeDirector(): void {
  useDirectorStore.getState().close();
  useAppStore.getState().setPhase("editing");
}
