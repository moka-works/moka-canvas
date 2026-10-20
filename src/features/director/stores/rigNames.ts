import { create } from "zustand";

/**
 * The bone names each loaded model turned out to carry.
 *
 * This is a reading of a file, not a decision: it is kept in memory so the
 * mapping UI can offer the names while the model is open, and the document
 * keeps only the mapping the reader settled on. A reload re-reads the file.
 */
export interface RigNamesState {
  boneNames: Record<string, string[]>;
  setBoneNames: (objectId: string, names: string[]) => void;
  forget: (objectId: string) => void;
}

export const useRigNames = create<RigNamesState>()((set) => ({
  boneNames: {},
  setBoneNames: (objectId, names) =>
    set((state) => ({
      boneNames: { ...state.boneNames, [objectId]: names },
    })),
  forget: (objectId) =>
    set((state) => {
      if (!(objectId in state.boneNames)) return state;
      const next = { ...state.boneNames };
      delete next[objectId];
      return { boneNames: next };
    }),
}));
