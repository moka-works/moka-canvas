import { create } from "zustand";
import {
  applyCommands as applyToDocument,
  CommandError,
  nextCanvasName,
  type AssetCategory,
  type AssetId,
  type CanvasId,
  type DocumentCommand,
  type MokaFile,
  type ResourceEntry,
  type SelfCheckReport,
} from "../../../shared/domain";
import {
  projectsApi,
  type OpenProjectResult,
  type SaveResult,
} from "../../../api/projects";
import { isApiError } from "../../../api/client";
import { i18n } from "../../../shared/i18n";
import { useAppStore } from "./appStore";
import { useOpenCanvases } from "./openCanvases";

export type SaveStatus = "saved" | "saving" | "conflicted" | "error";

interface ProjectState {
  root: string | null;
  moka: MokaFile | null;
  activeCanvasId: CanvasId | null;
  selfCheck: SelfCheckReport | null;
  /** Whether the server has finished reading the files it could not speak for
      by their sizes; false means `selfCheck` may still grow. */
  selfCheckVerified: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  /** Optimistically applied commands not yet acknowledged by the server. */
  pending: DocumentCommand[];

  hydrate: (opened: OpenProjectResult) => SelfCheckReport;
  open: (path: string) => Promise<SelfCheckReport>;
  create: (
    directory: string,
    name: string,
    useSubdirectory?: boolean,
  ) => Promise<SelfCheckReport>;
  importFromPath: (
    archivePath: string,
    directory: string,
    name?: string,
  ) => Promise<SelfCheckReport>;
  importUpload: (
    file: File,
    directory: string,
    name?: string,
    onProgress?: (fraction: number) => void,
  ) => Promise<SelfCheckReport>;
  /**
   * Reads the stored document back in, in place of what this window holds.
   *
   * Work still waiting goes out first: the stored document takes the place of
   * the held one whole, and a change that was never sent would be replaced
   * with it — gone, though nobody asked to give it up. So the answer is
   * whether the stored document was taken: what cannot land keeps its place,
   * and the caller says why nothing was read in. `discardPending` is the one
   * reader who did ask to give waiting work up — the way out of a conflict,
   * where the server will never take the change.
   */
  reload: (options?: { discardPending?: boolean }) => Promise<boolean>;
  /**
   * Settles once a read of the document that has started has landed.
   *
   * What a run made arrives by the server rewriting the document, and the
   * record says the run is over a moment before that rewrite does — so a line
   * written from what the record said has to wait for it, or it is written onto
   * a document that is on its way to being replaced.
   */
  untilAdopted: () => Promise<void>;
  close: () => void;

  switchCanvas: (canvasId: CanvasId) => void;
  applyLocal: (commands: DocumentCommand[]) => DocumentCommand[];
  flush: () => Promise<void>;
  integrateSaveResult: (result: SaveResult) => void;
  /** Replaces the open-time self-check report (e.g. after a located replacement). */
  setSelfCheck: (report: SelfCheckReport) => void;
  /** Folds a server-side asset upload/replace into the local registry. */
  integrateAssetEntry: (entry: ResourceEntry, result: SaveResult) => void;
  /** Folds a server-side asset removal into the local registry. */
  removeAssetEntry: (assetId: AssetId, result: SaveResult) => void;
}

const FLUSH_DEBOUNCE_MS = 400;
const SELF_CHECK_POLL_MS = 1500;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// The watch on the file check that is still going, if one is: a project is
// opened on what the sizes said, and the files whose contents could not be
// spoken for by a size are read by the server meanwhile. Bumped whenever a
// watch is replaced or a project is put down, so an answer to a question nobody
// is asking any more is dropped rather than written down.
let selfCheckTimer: ReturnType<typeof setTimeout> | null = null;
let selfCheckWatch = 0;
// A flush in flight shares its promise: concurrent callers (the autosave
// debounce racing an explicit save) must not send the same batch twice —
// the duplicate would arrive with a stale expected revision and surface a
// spurious conflict after the first request already saved it.
let flushInFlight: Promise<void> | null = null;
// The read of the document that is on its way, if one is. Held so that what a
// record says about a run that just ended can be written after the document it
// is about to describe has landed, rather than on the one being replaced.
let readInFlight: Promise<boolean> | null = null;

function activeCanvasOf(moka: MokaFile, activeCanvasId: CanvasId | null) {
  return (
    moka.canvas.find((canvas) => canvas.id === activeCanvasId) ??
    moka.canvas[0] ??
    null
  );
}

export const useProjectStore = create<ProjectState>()((set, get) => {
  const scheduleFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void get().flush();
    }, FLUSH_DEBOUNCE_MS);
  };

  /** Stops watching the file check, if a watch is on. */
  const stopSelfCheckWatch = () => {
    selfCheckWatch += 1;
    if (selfCheckTimer) clearTimeout(selfCheckTimer);
    selfCheckTimer = null;
  };

  /**
   * Follows the file check the server is still making.
   *
   * A project is opened on what the sizes said, so the room draws at once; the
   * files whose contents a size cannot speak for are read behind it. The answer
   * is asked for until it is finished, and what it adds is said once — a file
   * the open already named is not named again — and kept in the report the
   * rooms read their badges from. A check that cannot be read is not a room
   * that cannot be used: the watch simply stops, and what the open said stands.
   */
  const watchSelfCheck = () => {
    stopSelfCheckWatch();
    const generation = selfCheckWatch;
    const projectId = get().moka?.metadata.id ?? null;
    const said = new Set(
      (get().selfCheck?.issues ?? []).map(
        (issue) => `${issue.assetId}:${issue.reason}`,
      ),
    );
    const tick = async (): Promise<void> => {
      const state = get();
      if (generation !== selfCheckWatch) return;
      if (!state.moka || state.selfCheckVerified) return;
      if (projectId !== null && state.moka.metadata.id !== projectId) return;
      try {
        const status = await projectsApi.selfCheck();
        if (generation !== selfCheckWatch) return;
        if (get().moka?.metadata.id !== projectId) return;
        const fresh = status.report.issues.filter(
          (issue) => !said.has(`${issue.assetId}:${issue.reason}`),
        );
        for (const issue of fresh) {
          said.add(`${issue.assetId}:${issue.reason}`);
        }
        set({ selfCheck: status.report, selfCheckVerified: status.verified });
        if (fresh.length > 0) {
          useAppStore
            .getState()
            .pushToast(
              "error",
              i18n.t(
                fresh.length === 1
                  ? "app:missingAssets.checkedLaterOne"
                  : "app:missingAssets.checkedLaterMany",
                { count: fresh.length },
              ),
            );
        }
        if (!status.verified) {
          selfCheckTimer = setTimeout(() => void tick(), SELF_CHECK_POLL_MS);
        }
      } catch {
        // The report the open gave is what the badges keep.
      }
    };
    void tick();
  };

  return {
    root: null,
    moka: null,
    activeCanvasId: null,
    selfCheck: null,
    selfCheckVerified: true,
    saveStatus: "saved",
    saveError: null,
    pending: [],

    hydrate(opened) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      // A flush from the previously open project must not be awaited here.
      flushInFlight = null;
      // Which boards this machine was left looking at is kept beside the
      // project rather than in it, so taking up the document takes up that list
      // too and opens onto the board the work was left on.
      const openedOnto = useOpenCanvases.getState().adopt(opened.moka);
      // A read of a document that is already open is not a reopening: a run
      // files what it made by rewriting the document, and a reader who was
      // looking at one board when that happened has not asked to be moved to
      // another. So the board being looked at is kept where it still exists, and
      // only a project opened for the first time lands where it was left.
      const before = get();
      const sameProject = before.moka?.metadata.id === opened.moka.metadata.id;
      const staying =
        sameProject &&
        before.activeCanvasId !== null &&
        opened.moka.canvas.some((canvas) => canvas.id === before.activeCanvasId)
          ? before.activeCanvasId
          : null;
      set({
        root: opened.root,
        moka: opened.moka,
        activeCanvasId:
          staying ?? openedOnto ?? opened.moka.canvas[0]?.id ?? null,
        selfCheck: opened.selfCheck,
        selfCheckVerified: opened.selfCheckVerified,
        saveStatus: "saved",
        saveError: null,
        pending: [],
      });
      // A check that is still going is followed from here, where the project
      // it belongs to is known.
      if (opened.selfCheckVerified) {
        stopSelfCheckWatch();
      } else {
        watchSelfCheck();
      }
      return opened.selfCheck;
    },

    async open(path) {
      return get().hydrate(await projectsApi.open(path));
    },

    async create(directory, name, useSubdirectory = false) {
      // The scaffold makes the first canvas, but its name is the interface's
      // to give, so a project made in Chinese says 画布 1.
      return get().hydrate(
        await projectsApi.create(
          directory,
          name,
          i18n.t("domain:canvas.defaultName", { n: 1 }),
          useSubdirectory,
        ),
      );
    },

    async importFromPath(archivePath, directory, name) {
      return get().hydrate(
        await projectsApi.importFromPath(archivePath, directory, name),
      );
    },

    async importUpload(file, directory, name, onProgress) {
      return get().hydrate(
        await projectsApi.importUpload(file, directory, name, onProgress),
      );
    },

    async reload(options) {
      const mayAdopt = () =>
        options?.discardPending === true || get().pending.length === 0;
      const reading = (async () => {
        await get().flush();
        if (!mayAdopt()) return false;
        const opened = await projectsApi.current();
        // A change made while the document was being read is waiting too, and
        // is newer than what came back: read in over it, it would be lost the
        // same way as one that never went out.
        if (!mayAdopt()) return false;
        get().hydrate(opened);
        return true;
      })();
      readInFlight = reading;
      try {
        return await reading;
      } finally {
        if (readInFlight === reading) readInFlight = null;
      }
    },

    untilAdopted() {
      // A read that came to nothing has still replaced the display as far as
      // anything waiting on it is concerned, so the trouble is not passed on.
      return readInFlight
        ? readInFlight.then(() => {}).catch(() => {})
        : Promise.resolve();
    },

    close() {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      flushInFlight = null;
      readInFlight = null;
      stopSelfCheckWatch();
      useOpenCanvases.getState().forget();
      set({
        root: null,
        moka: null,
        activeCanvasId: null,
        selfCheck: null,
        selfCheckVerified: true,
        saveStatus: "saved",
        saveError: null,
        pending: [],
      });
    },

    switchCanvas(canvasId) {
      const { moka } = get();
      if (!moka || !moka.canvas.some((canvas) => canvas.id === canvasId))
        return;
      set({ activeCanvasId: canvasId });
    },

    applyLocal(commands) {
      const { moka, saveStatus } = get();
      if (!moka) {
        throw new CommandError(
          "PROJECT_NOT_OPEN",
          i18n.t("editor:stores.noProjectOpen"),
        );
      }
      if (saveStatus === "conflicted") {
        throw new CommandError(
          "REVISION_CONFLICT",
          i18n.t("editor:stores.resolveConflictFirst"),
        );
      }
      const { next, inverse } = applyToDocument(moka, commands);
      set((state) => ({
        moka: next,
        pending: [...state.pending, ...commands],
      }));
      scheduleFlush();
      return inverse;
    },

    async flush() {
      const { moka, pending, saveStatus } = get();
      if (!moka || pending.length === 0 || saveStatus === "conflicted") return;
      if (flushInFlight) return flushInFlight;
      const batch = pending;
      set({ saveStatus: "saving", saveError: null });
      const attempt = (async () => {
        try {
          const result = await projectsApi.applyCommands(
            moka.metadata.revision,
            batch,
          );
          set((state) => {
            const remaining = state.pending.slice(batch.length);
            return {
              saveStatus: "saved",
              pending: remaining,
              moka: state.moka
                ? {
                    ...state.moka,
                    metadata: {
                      ...state.moka.metadata,
                      revision: result.revision,
                      updatedAt: result.updatedAt,
                    },
                  }
                : null,
            };
          });
          if (get().pending.length > 0) scheduleFlush();
        } catch (error) {
          if (isApiError(error, "REVISION_CONFLICT")) {
            // Stop autosave; the user chooses reload or export-local-copy.
            set({ saveStatus: "conflicted" });
          } else {
            set({
              saveStatus: "error",
              saveError:
                error instanceof Error
                  ? error.message
                  : i18n.t("editor:stores.savingFailed"),
            });
            // Transient failures retry on the next change; keep the batch queued.
          }
        }
      })();
      const tracked = attempt.finally(() => {
        if (flushInFlight === tracked) flushInFlight = null;
      });
      flushInFlight = tracked;
      return flushInFlight;
    },

    setSelfCheck(report) {
      set({ selfCheck: report });
    },

    integrateSaveResult(result) {
      set((state) => ({
        moka: state.moka
          ? {
              ...state.moka,
              metadata: {
                ...state.moka.metadata,
                revision: result.revision,
                updatedAt: result.updatedAt,
              },
            }
          : null,
      }));
    },

    integrateAssetEntry(entry, result) {
      const category = entry.path.split("/")[1] as AssetCategory | undefined;
      set((state) => {
        if (!state.moka || !category || !(category in state.moka.resources)) {
          return state;
        }
        const list = state.moka.resources[category];
        const index = list.findIndex((item) => item.id === entry.id);
        const nextList =
          index === -1
            ? [...list, entry]
            : list.map((item) => (item.id === entry.id ? entry : item));
        return {
          moka: {
            ...state.moka,
            metadata: {
              ...state.moka.metadata,
              revision: result.revision,
              updatedAt: result.updatedAt,
            },
            resources: { ...state.moka.resources, [category]: nextList },
          },
        };
      });
    },

    removeAssetEntry(assetId, result) {
      set((state) => {
        if (!state.moka) return state;
        const resources = { ...state.moka.resources };
        for (const category of Object.keys(resources) as AssetCategory[]) {
          resources[category] = resources[category].filter(
            (entry) => entry.id !== assetId,
          );
        }
        return {
          moka: {
            ...state.moka,
            metadata: {
              ...state.moka.metadata,
              revision: result.revision,
              updatedAt: result.updatedAt,
            },
            resources,
          },
        };
      });
    },
  };
});

export function useActiveCanvas() {
  return useProjectStore((state) =>
    state.moka ? activeCanvasOf(state.moka, state.activeCanvasId) : null,
  );
}

/**
 * Why a change is not landing, as a report of it should say it.
 *
 * A save held up by a document that moved under this window is not a save to
 * wait out: a reader told only "it is still saving" waits for something that
 * is never coming, when the fix is to reload or to give the change up. The
 * conflict is named as such; anything else is the store's own words for what
 * went wrong, and only a save that is genuinely still on its way is said that
 * way.
 */
export function saveTrouble(): { message: string; detail?: string } {
  const { saveStatus, saveError } = useProjectStore.getState();
  if (saveStatus === "conflicted") {
    return { message: i18n.t("editor:stores.saveConflict") };
  }
  if (saveError !== null) {
    return { message: saveError, detail: i18n.t("editor:stores.stillSaving") };
  }
  return {
    message:
      saveStatus === "saving"
        ? i18n.t("editor:stores.stillSaving")
        : i18n.t("editor:stores.savingFailed"),
  };
}

/**
 * Settles the document before a call that writes it from the server's side.
 *
 * Filing a file — an upload, a replace, a node saved to the shelf — writes an
 * entry into the stored document and moves its revision. A change of the
 * reader's still on its way would then be refused for resting on the revision
 * the upload has replaced: a conflict the room made for itself, and one that
 * stops every later edit until the reader deals with it. Everything waiting
 * goes out first, and the answer is whether the document settled. What to say
 * when it did not is the caller's, since only the caller knows what was asked
 * for.
 */
export async function settleBeforeFiling(): Promise<boolean> {
  await useProjectStore.getState().flush();
  return useProjectStore.getState().pending.length === 0;
}

export { nextCanvasName };
