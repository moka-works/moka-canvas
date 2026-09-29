import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import { HISTORY_LIMIT, type MokaFile } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { execute, historyBoundary, redo, undo } from "../commands/execute";
import { useAppStore } from "./appStore";
import { useHistoryStore, isBoundary } from "./historyStore";
import { useProjectStore } from "./projectStore";

function hydrate(moka?: MokaFile) {
  const document = moka ?? buildGoldenMokaFile();
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka: document,
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  return document;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("command pipeline", () => {
  it("applies commands optimistically and records an undoable entry", () => {
    const moka = hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    const inverse = execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);

    const state = useProjectStore.getState();
    expect(state.moka?.canvas[0].name).toBe("Storyboard");
    expect(state.pending).toHaveLength(1);
    expect(inverse).toEqual([
      { type: "renameCanvas", canvasId, name: moka.canvas[0].name },
    ]);
    const { undoStack } = useHistoryStore.getState();
    expect(undoStack).toHaveLength(1);
    expect(isBoundary(undoStack[0])).toBe(false);
  });

  it("flushes pending commands with the current revision", async () => {
    const moka = hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    fetchMock.mockResolvedValue(
      jsonResponse(200, { revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" }),
    );

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    await useProjectStore.getState().flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/projects/current/commands");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedRevision: moka.metadata.revision,
      commands: [{ type: "renameCanvas", canvasId, name: "Storyboard" }],
    });

    const state = useProjectStore.getState();
    expect(state.pending).toHaveLength(0);
    expect(state.saveStatus).toBe("saved");
    expect(state.moka?.metadata.revision).toBe(4);
  });

  it("shares one in-flight flush so concurrent saves cannot double-send", async () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    let resolveSave: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveSave = resolve;
        }),
    );

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    // The autosave debounce and an explicit save race here; both callers
    // must resolve from a single request, never a duplicate second POST.
    const first = useProjectStore.getState().flush();
    const second = useProjectStore.getState().flush();
    resolveSave(
      jsonResponse(200, { revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" }),
    );
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().saveStatus).toBe("saved");
    expect(useProjectStore.getState().pending).toHaveLength(0);
  });

  it("freezes autosave on a revision conflict and rejects further edits", async () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        code: "REVISION_CONFLICT",
        message: "The project changed on disk",
        status: 409,
      }),
    );

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    await useProjectStore.getState().flush();

    expect(useProjectStore.getState().saveStatus).toBe("conflicted");

    const result = execute("Rename again", [
      { type: "renameCanvas", canvasId, name: "Nope" },
    ]);
    expect(result).toBeNull();
    expect(useProjectStore.getState().moka?.canvas[0].name).toBe("Storyboard");
    expect(useAppStore.getState().toasts).toHaveLength(1);
  });

  it("undo and redo re-apply inverse and forward commands", () => {
    const moka = hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    const original = moka.canvas[0].name;

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    expect(undo()).toBe(true);
    expect(useProjectStore.getState().moka?.canvas[0].name).toBe(original);
    expect(redo()).toBe(true);
    expect(useProjectStore.getState().moka?.canvas[0].name).toBe("Storyboard");

    // Undo and redo changes are persisted like any other edit.
    expect(useProjectStore.getState().pending).toHaveLength(3);
  });

  it("refuses to undo across a boundary", () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    historyBoundary("Switch canvas");

    expect(undo()).toBe(false);
    expect(useProjectStore.getState().moka?.canvas[0].name).toBe("Storyboard");
    expect(redo()).toBe(false);
  });

  it("caps history and keeps boundary markers while evicting old entries", () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;

    historyBoundary("Open project");
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
      execute(`Rename ${i}`, [
        { type: "renameCanvas", canvasId, name: `Canvas ${i}` },
      ]);
    }

    const { undoStack } = useHistoryStore.getState();
    expect(undoStack.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(undoStack.some(isBoundary)).toBe(true);
  });
});

describe("reading the stored document back in", () => {
  const opened = (moka: MokaFile) => ({
    root: "/tmp/moka-test",
    moka,
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });

  it("lands what is waiting before the stored document replaces it", async () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/commands")) {
        return jsonResponse(200, {
          revision: 9,
          updatedAt: "2026-01-01T00:00:03.000Z",
        });
      }
      const stored = buildGoldenMokaFile();
      stored.canvas[0].name = "Storyboard";
      stored.metadata.revision = 9;
      return jsonResponse(200, opened(stored));
    });

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    const adopted = await useProjectStore.getState().reload();

    // The waiting rename went out first: were the stored document read over
    // it, the reader's change would be gone without their asking.
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/projects/current/commands",
      "/api/v1/projects/current",
    ]);
    expect(adopted).toBe(true);
    const state = useProjectStore.getState();
    expect(state.pending).toHaveLength(0);
    expect(state.moka?.canvas[0].name).toBe("Storyboard");
    expect(state.moka?.metadata.revision).toBe(9);
  });

  it("keeps the held document when waiting work cannot land", async () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        code: "INTERNAL",
        message: "io error: disk full",
        status: 500,
      }),
    );

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    const adopted = await useProjectStore.getState().reload();

    expect(adopted).toBe(false);
    const state = useProjectStore.getState();
    expect(state.pending).toHaveLength(1);
    expect(state.moka?.canvas[0].name).toBe("Storyboard");
    // The document that was not read in was not even asked for.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a change made while the document was being read", async () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/current")) {
        // The reader types in the moment the read is on its way back.
        execute("Rename during read", [
          { type: "renameCanvas", canvasId, name: "Later" },
        ]);
        return jsonResponse(200, opened(buildGoldenMokaFile()));
      }
      return jsonResponse(200, {
        revision: 3,
        updatedAt: "2026-01-01T00:00:03.000Z",
      });
    });

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    const adopted = await useProjectStore.getState().reload();

    expect(adopted).toBe(false);
    const state = useProjectStore.getState();
    expect(state.pending).toHaveLength(1);
    expect(state.moka?.canvas[0].name).toBe("Later");
  });

  it("takes the stored document when the reader gives their changes up", async () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        code: "REVISION_CONFLICT",
        message: "The project changed on disk",
        status: 409,
      }),
    );
    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    await useProjectStore.getState().flush();
    expect(useProjectStore.getState().saveStatus).toBe("conflicted");

    const stored = buildGoldenMokaFile();
    stored.metadata.revision = 7;
    fetchMock.mockResolvedValueOnce(jsonResponse(200, opened(stored)));
    const adopted = await useProjectStore
      .getState()
      .reload({ discardPending: true });

    // The way out of a conflict: the change the server will never take is
    // given up, which is what the reader pressed the button to do.
    expect(adopted).toBe(true);
    const state = useProjectStore.getState();
    expect(state.pending).toHaveLength(0);
    expect(state.saveStatus).toBe("saved");
    expect(state.moka?.metadata.revision).toBe(7);
    expect(state.moka?.canvas[0].name).toBe(stored.canvas[0].name);
  });
});

describe("asset registry integration", () => {
  const entry = {
    id: "asset-1",
    name: "clip.png",
    path: "assets/images/clip.png",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("folds uploads and removals into the registry with the new revision", () => {
    hydrate();

    useProjectStore
      .getState()
      .integrateAssetEntry(entry, { revision: 4, updatedAt: entry.updatedAt });
    let state = useProjectStore.getState();
    expect(state.moka?.resources.images.map((item) => item.id)).toContain(
      "asset-1",
    );
    expect(state.moka?.metadata.revision).toBe(4);

    useProjectStore
      .getState()
      .removeAssetEntry("asset-1", { revision: 5, updatedAt: entry.updatedAt });
    state = useProjectStore.getState();
    expect(state.moka?.resources.images.map((item) => item.id)).not.toContain(
      "asset-1",
    );
    expect(state.moka?.metadata.revision).toBe(5);
  });
});

describe("project creation", () => {
  it("asks for the first canvas under the name the interface speaks", async () => {
    await i18n.changeLanguage("zh");
    try {
      const opened = buildGoldenMokaFile();
      opened.canvas[0].name = "画布 1";
      fetchMock.mockResolvedValue(
        jsonResponse(201, {
          root: "/tmp/moka-test",
          moka: opened,
          selfCheck: { ok: true, issues: [] },
          selfCheckVerified: true,
        }),
      );

      await useProjectStore.getState().create("/tmp/projects", "Spoken");

      const [path, init] = fetchMock.mock.calls[0];
      expect(path).toBe("/api/v1/projects");
      expect(JSON.parse(String(init?.body))).toEqual({
        directory: "/tmp/projects",
        name: "Spoken",
        firstCanvasName: "画布 1",
        useSubdirectory: false,
      });
      expect(useProjectStore.getState().moka?.canvas[0].name).toBe("画布 1");
    } finally {
      // The catalogue is shared with the cases after this one.
      await i18n.changeLanguage("en");
    }
  });

  it("carries the consent a folder that already holds something was given", async () => {
    const opened = buildGoldenMokaFile();
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        root: "/tmp/projects/nested",
        moka: opened,
        selfCheck: { ok: true, issues: [] },
        selfCheckVerified: true,
      }),
    );

    await useProjectStore.getState().create("/tmp/projects", "Nested", true);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body)).useSubdirectory).toBe(true);
  });
});

describe("the file check behind the open", () => {
  const issue = {
    assetId: "asset-1",
    name: "still.png",
    expectedPath: "assets/images/still.png",
    reason: "changed" as const,
    referencingNodes: [],
  };

  const opened = (selfCheckVerified: boolean) => ({
    root: "/tmp/moka-test",
    moka: buildGoldenMokaFile(),
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified,
  });

  it("follows a check that is not finished, and stops when it is", async () => {
    let asked = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/self-check")) {
        asked += 1;
        return jsonResponse(200, {
          report: { ok: true, issues: [] },
          verified: true,
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    useProjectStore.getState().hydrate(opened(false));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toBe(1);
    expect(useProjectStore.getState().selfCheckVerified).toBe(true);

    // The answer said it was finished, so nothing more is asked.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toBe(1);
  });

  it("says a change the open had not named, once", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/self-check")) {
        return jsonResponse(200, {
          report: { ok: false, issues: [issue] },
          verified: false,
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    useProjectStore.getState().hydrate(opened(false));
    await vi.advanceTimersByTimeAsync(0);

    const state = useProjectStore.getState();
    expect(state.selfCheck?.issues).toHaveLength(1);
    expect(state.saveStatus).toBe("saved");
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain("1 file changed on disk");

    // The same finding on the next poll is not said a second time.
    await vi.advanceTimersByTimeAsync(1500);
    expect(useAppStore.getState().toasts).toHaveLength(1);
  });

  it("drops an answer for a project that was put down meanwhile", async () => {
    let release: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/self-check")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected call: ${url}`));
    });

    useProjectStore.getState().hydrate(opened(false));
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toBeDefined();

    useProjectStore.getState().close();
    release?.(
      jsonResponse(200, {
        report: { ok: false, issues: [issue] },
        verified: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(useProjectStore.getState().selfCheck).toBeNull();
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });

  it("asks nothing when the open was already finished", async () => {
    hydrate();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
