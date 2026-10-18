import { create } from "zustand";
import { listExtensionNodes } from "../../../api";
import type {
  ExtensionCatalog,
  ExtensionDefinition,
} from "../../../shared/domain";

interface ExtensionStoreState {
  catalog: ExtensionCatalog | null;
  loading: boolean;
  error: string | null;
  /**
   * The installed definitions, newest reading. `load` is called when a menu or
   * a panel opens rather than kept in step by a watcher: the directory is a
   * machine-level thing a reader edits outside the app, and a read is cheap.
   */
  load: (force?: boolean) => Promise<void>;
  definition: (id: string) => ExtensionDefinition | undefined;
  reset: () => void;
}

let inFlight: Promise<void> | null = null;

export const useExtensionStore = create<ExtensionStoreState>()((set, get) => ({
  catalog: null,
  loading: false,
  error: null,

  async load(force = false) {
    if (inFlight) return inFlight;
    if (!force && get().catalog) return;
    set({ loading: true, error: null });
    inFlight = listExtensionNodes()
      .then((catalog) => set({ catalog, loading: false, error: null }))
      .catch((error: unknown) => {
        set({
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "The extension node directory could not be read",
        });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  },

  definition(id) {
    return get().catalog?.nodes.find((node) => node.id === id);
  },

  reset() {
    inFlight = null;
    set({ catalog: null, loading: false, error: null });
  },
}));
