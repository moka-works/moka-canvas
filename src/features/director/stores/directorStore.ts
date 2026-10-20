import { create } from "zustand";
import type { DirectorRenderMode, DirectorScene } from "../../../shared/domain";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import type { DirectorView } from "../stage/viewModes";
import type {
  DirectorMode,
  DirectorSelection,
  DirectorTransformMode,
} from "../types";

/** How many scene snapshots the room keeps for its own undo. */
const HISTORY_LIMIT = 50;
/** How much those snapshots may weigh before the oldest are let go. */
const HISTORY_BYTES = 64 * 1024 * 1024;

export interface DirectorRoom {
  /** The card whose scene is open; null when the room is closed. */
  nodeId: string | null;
  /** The edit in progress. The document is written from this on every commit. */
  draft: DirectorScene | null;
  past: DirectorScene[];
  future: DirectorScene[];
  /** The scene as it was when a drag began, restored by cancel. */
  gesture: DirectorScene | null;
  mode: DirectorMode;
  view: DirectorView;
  renderMode: DirectorRenderMode;
  transformMode: DirectorTransformMode;
  selection: DirectorSelection | null;
  autoKey: boolean;
  playhead: number;
  playing: boolean;
  /** Why the last write to the document failed, when it did. */
  saveError: string | null;

  open: (nodeId: string, scene: DirectorScene) => void;
  close: () => void;
  sync: (scene: DirectorScene) => void;
  edit: (recipe: (scene: DirectorScene) => DirectorScene) => boolean;
  update: (recipe: (scene: DirectorScene) => DirectorScene) => void;
  beginGesture: () => void;
  commitGesture: () => void;
  cancelGesture: () => void;
  undo: () => void;
  redo: () => void;
  setMode: (mode: DirectorMode) => void;
  setView: (view: DirectorView) => void;
  setRenderMode: (mode: DirectorRenderMode) => void;
  setTransformMode: (mode: DirectorTransformMode) => void;
  setSelection: (selection: DirectorSelection | null) => void;
  setAutoKey: (on: boolean) => void;
  setPlayhead: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setSaveError: (error: string | null) => void;
}

function cloneScene(scene: DirectorScene): DirectorScene {
  return structuredClone(scene);
}

/**
 * Writes a scene to the document, without entering the canvas's own history.
 *
 * Staging is a document of its own and its undo lives in this room; putting
 * every drag on the canvas history would make the board's undo mean two
 * different things depending on where it was pressed. Delivering an output
 * is the one action that does enter that history, and it is issued by the
 * room's output step rather than here.
 */
function persist(scene: DirectorScene): string | null {
  const project = useProjectStore.getState();
  if (!project.moka) return "No project is open";
  try {
    project.applyLocal([
      {
        type: "replaceDirectorScene",
        sceneId: scene.id,
        scene: cloneScene(scene),
      },
    ]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function trimHistory(past: DirectorScene[]): DirectorScene[] {
  let kept = past.slice(-HISTORY_LIMIT);
  let bytes = kept.reduce(
    (total, scene) => total + JSON.stringify(scene).length,
    0,
  );
  while (bytes > HISTORY_BYTES && kept.length > 1) {
    bytes -= JSON.stringify(kept[0]).length;
    kept = kept.slice(1);
  }
  return kept;
}

export const useDirectorStore = create<DirectorRoom>()((set, get) => ({
  nodeId: null,
  draft: null,
  past: [],
  future: [],
  gesture: null,
  mode: "stage",
  view: "free",
  renderMode: "lit",
  transformMode: "translate",
  selection: null,
  autoKey: false,
  playhead: 0,
  playing: false,
  saveError: null,

  open: (nodeId, scene) =>
    set({
      nodeId,
      draft: cloneScene(scene),
      past: [],
      future: [],
      gesture: null,
      mode: "stage",
      view: "free",
      renderMode: "lit",
      transformMode: "translate",
      selection: null,
      autoKey: false,
      playhead: 0,
      playing: false,
      saveError: null,
    }),

  close: () =>
    set({
      nodeId: null,
      draft: null,
      past: [],
      future: [],
      gesture: null,
      selection: null,
      playing: false,
      autoKey: false,
      saveError: null,
    }),

  sync: (scene) => {
    const { draft } = get();
    if (draft?.id === scene.id && draft.updatedAt === scene.updatedAt) return;
    set({
      draft: cloneScene(scene),
      past: [],
      future: [],
      gesture: null,
      saveError: null,
    });
  },

  edit: (recipe) => {
    const { draft, past } = get();
    if (!draft) return false;
    if (useProjectStore.getState().saveStatus === "conflicted") {
      set({
        saveError: "The project changed elsewhere; reload before editing.",
      });
      return false;
    }
    const next = recipe(draft);
    if (next === draft) return false;
    const error = persist(next);
    set({
      draft: next,
      past: trimHistory([...past, draft]),
      future: [],
      gesture: null,
      saveError: error,
    });
    return error === null;
  },

  update: (recipe) => {
    const { draft } = get();
    if (!draft) return;
    const next = recipe(draft);
    if (next === draft) return;
    set({ draft: next });
  },

  beginGesture: () => {
    const { draft, gesture } = get();
    if (!draft || gesture) return;
    set({ gesture: cloneScene(draft) });
  },

  commitGesture: () => {
    const { draft, gesture, past } = get();
    if (!draft) return;
    if (!gesture) {
      persist(draft);
      return;
    }
    const changed = gesture.updatedAt !== draft.updatedAt || gesture !== draft;
    const error = persist(draft);
    set({
      gesture: null,
      past: changed ? trimHistory([...past, gesture]) : past,
      future: changed ? [] : get().future,
      saveError: error,
    });
  },

  cancelGesture: () => {
    const { gesture } = get();
    if (!gesture) return;
    set({ draft: gesture, gesture: null });
  },

  undo: () => {
    const { draft, past, future } = get();
    if (!draft || past.length === 0) return;
    const previous = past[past.length - 1];
    const error = persist(previous);
    set({
      draft: previous,
      past: past.slice(0, -1),
      future: [draft, ...future].slice(0, HISTORY_LIMIT),
      selection: null,
      saveError: error,
    });
  },

  redo: () => {
    const { draft, past, future } = get();
    if (!draft || future.length === 0) return;
    const next = future[0];
    const error = persist(next);
    set({
      draft: next,
      past: trimHistory([...past, draft]),
      future: future.slice(1),
      selection: null,
      saveError: error,
    });
  },

  setMode: (mode) =>
    set((state) => ({
      mode,
      // Leaving motion stops the clock and the recorder of every edit: a
      // keyframe written from a mode that no longer shows the timeline would
      // be a change nobody watched.
      ...(mode === "motion" ? {} : { playing: false, autoKey: false }),
      view: mode === "lens" && state.view === "free" ? "camera" : state.view,
      renderMode:
        (mode === "stage" && !["lit", "blockout"].includes(state.renderMode)) ||
        (mode === "perform" && state.renderMode === "depth") ||
        (mode === "motion" && ["depth", "normal"].includes(state.renderMode))
          ? "lit"
          : state.renderMode,
    })),
  setView: (view) => set({ view }),
  setRenderMode: (renderMode) => set({ renderMode }),
  setTransformMode: (transformMode) => set({ transformMode }),
  setSelection: (selection) => set({ selection }),
  setAutoKey: (autoKey) => set({ autoKey }),
  setPlayhead: (playhead) =>
    set({ playhead: Math.max(0, Number.isFinite(playhead) ? playhead : 0) }),
  setPlaying: (playing) => set({ playing }),
  setSaveError: (saveError) => set({ saveError }),
}));

/** Opens a director card's scene as a page of its own. */
export function openDirector(nodeId: string): void {
  useAppStore.getState().setPhase("director");
  useDirectorStore.setState({ nodeId });
}

/** Leaves the room for the board the card sits on. */
export function closeDirector(): void {
  useDirectorStore.getState().close();
  useAppStore.getState().setPhase("editing");
}
