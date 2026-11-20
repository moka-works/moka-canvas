import { create } from "zustand";
import {
  applyCommands as applyToDocument,
  CommandError,
  nextCanvasName,
  PROJECT_ASSET_CATEGORIES,
  type AssetCategory,
  type AssetId,
  type CanvasId,
  type DocumentCommand,
  type MokaFile,
  type ResourceEntry,
  type ResourceRegistry,
  type SelfCheckReport,
} from "../../../shared/domain";
import {
  projectsApi,
  type OpenProjectResult,
  type SaveResult,
} from "../../../api/projects";
import { isApiError, nameProject } from "../../../api/client";
import { i18n } from "../../../shared/i18n";
import { useHistoryStore } from "./historyStore";
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
  /** Folds a server-side sweep of unused files into the local registry. */
  removeAssetEntries: (assetIds: AssetId[], result: SaveResult) => void;
  /**
   * Adopts commands a server tool already committed.
   *
   * The server has applied them, so they are not queued for saving; they go
   * into the local document, the revision moves to the one the tool returned,
   * and the inverse becomes one step of the reader's own undo history.
   */
  adoptAgentCommands: (
    commands: DocumentCommand[],
    revision: number,
    updatedAt: string,
    changeSetId: string,
    label: string,
  ) => void;
  /**
   * Holds automatic saving for one short tool call.
   *
   * Pending work is flushed first, so the tool plans from what the reader
   * sees. Edits made while the lease is held stay pending and go out when it
   * ends. The returned function releases it; the lease expires on its own
   * after thirty seconds so a loop that dies cannot leave saving stopped.
   */
  holdWrites: () => Promise<() => void>;
  /** Moves the local revision to what a server-side effect returned. */
  setRevision: (revision: number, updatedAt: string) => void;
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
// Tool calls that committed on the server and whose commands this window has
// already folded in. A retried response must not insert the same work twice.
const appliedChangeSets = new Set<string>();
// How many short tool calls are holding automatic saving. A count rather than
// a flag because two windows' loops never share a store, but two overlapping
// calls in one turn can.
let writesHeld = 0;
// The last server document lets a conflict ignore the reader's optimistic edits.
let syncedMoka: MokaFile | null = null;

function sameValue(one: unknown, other: unknown): boolean {
  if (Object.is(one, other)) return true;
  if (
    typeof one !== "object" ||
    one === null ||
    typeof other !== "object" ||
    other === null ||
    Array.isArray(one) !== Array.isArray(other)
  ) {
    return false;
  }
  if (Array.isArray(one) && Array.isArray(other)) {
    return (
      one.length === other.length &&
      one.every((entry, at) => sameValue(entry, other[at]))
    );
  }
  const left = one as Record<string, unknown>;
  const right = other as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => sameValue(left[key], right[key]));
}

// Only asset registrations are safe to merge into optimistic local commands.
function assetAdditions(
  before: MokaFile,
  latest: MokaFile,
): Partial<ResourceRegistry> | null {
  if (latest.metadata.revision <= before.metadata.revision) return null;
  const beforeBody = {
    ...before,
    metadata: { ...before.metadata, revision: 0, updatedAt: "" },
    resources: null,
  };
  const latestBody = {
    ...latest,
    metadata: { ...latest.metadata, revision: 0, updatedAt: "" },
    resources: null,
  };
  if (!sameValue(beforeBody, latestBody)) return null;

  const additions: Partial<ResourceRegistry> = {};
  for (const category of PROJECT_ASSET_CATEGORIES) {
    const oldEntries = before.resources[category] ?? [];
    const newEntries = latest.resources[category] ?? [];
    const latestById = new Map(newEntries.map((entry) => [entry.id, entry]));
    if (
      oldEntries.some((entry) => !sameValue(entry, latestById.get(entry.id)))
    ) {
      return null;
    }
    const oldIds = new Set(oldEntries.map((entry) => entry.id));
    const added = newEntries.filter((entry) => !oldIds.has(entry.id));
    if (added.length > 0) additions[category] = added;
  }
  return additions;
}

function withAssetAdditions(
  moka: MokaFile,
  additions: Partial<ResourceRegistry>,
): ResourceRegistry {
  const resources = { ...moka.resources };
  for (const [category, added] of Object.entries(additions) as [
    AssetCategory,
    ResourceEntry[],
  ][]) {
    const held = resources[category] ?? [];
    const known = new Set(held.map((entry) => entry.id));
    resources[category] = [
      ...held,
      ...added.filter((entry) => !known.has(entry.id)),
    ];
  }
  return resources;
}

function withAssetEntry(
  moka: MokaFile,
  entry: ResourceEntry,
  result: SaveResult,
): MokaFile {
  const category = entry.path.split("/")[1] as AssetCategory | undefined;
  if (category === undefined) return moka;
  const list = moka.resources[category] ?? [];
  const index = list.findIndex((item) => item.id === entry.id);
  const nextList =
    index === -1
      ? [...list, entry]
      : list.map((item) => (item.id === entry.id ? entry : item));
  return {
    ...moka,
    metadata: {
      ...moka.metadata,
      revision: result.revision,
      updatedAt: result.updatedAt,
    },
    resources: { ...moka.resources, [category]: nextList },
  };
}

function withoutAssetEntries(
  moka: MokaFile,
  assetIds: Set<string>,
  result: SaveResult,
): MokaFile {
  const resources = { ...moka.resources };
  for (const category of PROJECT_ASSET_CATEGORIES) {
    resources[category] = (resources[category] ?? []).filter(
      (entry) => !assetIds.has(entry.id),
    );
  }
  return {
    ...moka,
    metadata: {
      ...moka.metadata,
      revision: result.revision,
      updatedAt: result.updatedAt,
    },
    resources,
  };
}

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
    if (writesHeld > 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (writesHeld > 0) return;
      void get().flush();
    }, FLUSH_DEBOUNCE_MS);
  };

  const adoptAssetOnlyConflict = async (): Promise<number | null> => {
    const before = syncedMoka;
    if (before === null) return null;
    try {
      const opened = await projectsApi.current();
      if (get().moka?.metadata.id !== before.metadata.id) return null;
      const additions = assetAdditions(before, opened.moka);
      if (additions === null) return null;
      syncedMoka = opened.moka;
      set((state) => ({
        moka: state.moka
          ? {
              ...state.moka,
              metadata: {
                ...state.moka.metadata,
                revision: opened.moka.metadata.revision,
                updatedAt: opened.moka.metadata.updatedAt,
              },
              resources: withAssetAdditions(state.moka, additions),
            }
          : null,
      }));
      return opened.moka.metadata.revision;
    } catch {
      return null;
    }
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
      syncedMoka = opened.moka;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      appliedChangeSets.clear();
      writesHeld = 0;
      // A flush from the previously open project must not be awaited here.
      flushInFlight = null;
      // Every request from this window is about what the window is looking
      // at, from here on: two windows on one server are two readers, and one
      // opening a project must not move the other off its own.
      nameProject(opened.moka.metadata.id);
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
      const begin = () =>
        (async () => {
          const mayAdopt = () =>
            options?.discardPending === true || get().pending.length === 0;
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
      const previous = readInFlight;
      const reading = previous === null ? begin() : previous.then(begin, begin);
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
      syncedMoka = null;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      flushInFlight = null;
      readInFlight = null;
      stopSelfCheckWatch();
      useOpenCanvases.getState().forget();
      // The window is about nothing now, and says so, rather than going on
      // naming a project nobody is looking at.
      nameProject(null);
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
      if (writesHeld > 0) return;
      if (!moka || pending.length === 0 || saveStatus === "conflicted") return;
      if (flushInFlight) return flushInFlight;
      const batch = pending;
      let expectedRevision = moka.metadata.revision;
      set({ saveStatus: "saving", saveError: null });
      const attempt = (async () => {
        for (;;) {
          try {
            const result = await projectsApi.applyCommands(
              expectedRevision,
              batch,
            );
            if (syncedMoka !== null) {
              try {
                const saved = applyToDocument(syncedMoka, batch).next;
                syncedMoka = {
                  ...saved,
                  metadata: {
                    ...saved.metadata,
                    revision: result.revision,
                    updatedAt: result.updatedAt,
                  },
                };
              } catch {
                syncedMoka = null;
              }
            }
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
            return;
          } catch (error) {
            if (isApiError(error, "REVISION_CONFLICT")) {
              const revision = await adoptAssetOnlyConflict();
              if (revision !== null) {
                expectedRevision = revision;
                continue;
              }
              // Content changes are still the reader's to resolve, never to overwrite.
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
            return;
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
      if (syncedMoka !== null) {
        syncedMoka = {
          ...syncedMoka,
          metadata: {
            ...syncedMoka.metadata,
            revision: result.revision,
            updatedAt: result.updatedAt,
          },
        };
      }
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
      if (syncedMoka !== null) {
        syncedMoka = withAssetEntry(syncedMoka, entry, result);
      }
      set((state) => ({
        moka: state.moka ? withAssetEntry(state.moka, entry, result) : null,
      }));
    },

    adoptAgentCommands(commands, revision, updatedAt, changeSetId, label) {
      if (appliedChangeSets.has(changeSetId)) return;
      const { moka } = get();
      if (!moka) return;
      const { next, inverse } = applyToDocument(moka, commands);
      if (syncedMoka !== null) {
        const adopted = applyToDocument(syncedMoka, commands).next;
        syncedMoka = {
          ...adopted,
          metadata: { ...adopted.metadata, revision, updatedAt },
        };
      }
      appliedChangeSets.add(changeSetId);
      set({
        moka: {
          ...next,
          metadata: {
            ...next.metadata,
            revision,
            updatedAt,
          },
        },
      });
      useHistoryStore.getState().record({
        id: changeSetId,
        label,
        forwardCommands: commands,
        inverseCommands: inverse,
      });
    },

    async holdWrites() {
      await get().flush();
      writesHeld += 1;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        writesHeld = Math.max(0, writesHeld - 1);
        if (writesHeld === 0 && get().pending.length > 0) scheduleFlush();
      };
      const expiry = setTimeout(release, 30_000);
      if (typeof expiry === "object" && expiry !== null && "unref" in expiry) {
        (expiry as { unref?: () => void }).unref?.();
      }
      return release;
    },

    setRevision(revision, updatedAt) {
      const { moka } = get();
      if (!moka) return;
      if (revision < moka.metadata.revision) return;
      if (syncedMoka !== null) {
        syncedMoka = {
          ...syncedMoka,
          metadata: { ...syncedMoka.metadata, revision, updatedAt },
        };
      }
      set({
        moka: {
          ...moka,
          metadata: { ...moka.metadata, revision, updatedAt },
        },
      });
    },

    removeAssetEntry(assetId, result) {
      get().removeAssetEntries([assetId], result);
    },

    removeAssetEntries(assetIds, result) {
      const going = new Set(assetIds);
      if (syncedMoka !== null) {
        syncedMoka = withoutAssetEntries(syncedMoka, going, result);
      }
      set((state) => ({
        moka: state.moka
          ? withoutAssetEntries(state.moka, going, result)
          : null,
      }));
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
