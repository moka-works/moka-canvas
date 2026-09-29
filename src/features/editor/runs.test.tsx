// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import App from "../../App";
import {
  batchNodeIds,
  buildBatchMokaFile,
  buildGenerationMokaFile,
  buildGoldenMokaFile,
  generationNodeIds,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import type {
  AssetCategory,
  GenerationSpec,
  MokaFile,
  ResourceEntry,
  RunRecord,
  RunStatus,
} from "../../shared/domain";
import { PROVIDER_EXECUTOR_KEY, findNode } from "../../shared/domain";
import { i18n } from "../../shared/i18n";
import { UnsavedWorkDialog } from "./components/UnsavedWorkDialog";
import { generationUnavailable, useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";
import {
  nodeRunViews,
  useLatestRunForNode,
  useNodeRunProgress,
  useNodeRunStatus,
  useNodeStreamText,
  useRunStore,
} from "./stores/runStore";

const ids = goldenNodeIds();
const generated = generationNodeIds();

const CONFIG = {
  productName: "Moka Canvas",
  maxUploadBytes: 104857600,
  allowedMediaTypes: ["image/png"],
  limits: {
    maxNodesPerCanvas: 500,
    maxEdgesPerCanvas: 800,
    maxCanvasesPerProject: 12,
    maxPackageBytes: 536870912,
    maxPackageEntries: 20000,
  },
  capabilities: {
    mode: "web",
    assetCategories: [],
  },
};

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: ids.project,
    canvasId: ids.canvasMain,
    requestedNodeIds: [ids.operation],
    status: "queued",
    executorKey: "deterministic",
    graphHash: "abc123",
    parameters: {},
    steps: [
      { nodeId: ids.text, status: "queued" },
      { nodeId: ids.operation, status: "queued" },
    ],
    cancelRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function withStepStatus(run: RunRecord, status: RunStatus): RunRecord {
  return {
    ...run,
    steps: run.steps.map((step) => ({ ...step, status })),
  };
}

/**
 * A document with one asset filed on each of the given shelves by one run.
 *
 * A run counts what it made but does not say where it went, and only the
 * registry's own note of where an asset came from does, so this is the one place
 * the two can be read together.
 */
function withFiledRun(runId: string, shelves: AssetCategory[]): MokaFile {
  const moka = buildGoldenMokaFile();
  for (const shelf of shelves) {
    const entry: ResourceEntry = {
      id: `asset-${shelf}`,
      name: `made-${shelf}.bin`,
      path: `assets/${shelf}/made-00000000.bin`,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
      provenance: {
        runId,
        operationNodeId: ids.operation,
        createdAt: "2026-01-01T00:00:04.000Z",
      },
    };
    moka.resources[shelf] = [...moka.resources[shelf], entry];
  }
  return moka;
}

interface MockApi {
  runs: RunRecord[];
  startResponse: () => { body: unknown; status: number };
  calls: { url: string; method: string; body?: unknown }[];
  /** The executors the deployment publishes, which is what gates a generation. */
  executors: string[];
  /** The document the project endpoints serve. */
  moka: () => MokaFile;
}

const api: MockApi = {
  runs: [],
  startResponse: () => ({ body: makeRun(), status: 201 }),
  calls: [],
  executors: ["deterministic"],
  moka: () => buildGoldenMokaFile(),
};

/**
 * The platform's way of holding a stream open, which jsdom does not have.
 *
 * A test says a frame through `say` and breaks the stream through `break`,
 * which are the two things a real one does that a caller has to cope with.
 */
class FakeEventSource {
  static opened: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly heard = new Map<string, (event: { data: string }) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }

  addEventListener(kind: string, handler: (event: { data: string }) => void) {
    this.heard.set(kind, handler);
  }

  close() {
    this.closed = true;
  }

  say(kind: string, body: unknown) {
    this.heard.get(kind)?.({ data: JSON.stringify(body) });
  }

  break() {
    this.onerror?.();
  }
}

function streamFor(runId: string): FakeEventSource {
  const source = FakeEventSource.opened.find((opened) =>
    opened.url.includes(`runId=${runId}`),
  );
  if (!source) throw new Error(`no stream was opened for run ${runId}`);
  return source;
}

/** Lets the promises a store action started finish; they are several deep. */
async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

function route(url: string, method: string, body: unknown): Response {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  api.calls.push({ url, method, body });
  if (url === "/api/v1/config") {
    return json({
      ...CONFIG,
      capabilities: { ...CONFIG.capabilities, executors: api.executors },
    });
  }
  if (url === "/api/health") return json({ status: "ok" });
  if (url === "/api/v1/recent-projects") return json([]);
  if (url === "/api/v1/projects/open") {
    return json({
      root: "/tmp/golden",
      moka: api.moka(),
      selfCheck: { ok: true, issues: [] },
    });
  }
  if (url === "/api/v1/projects/current") {
    return json({
      root: "/tmp/golden",
      moka: api.moka(),
      selfCheck: { ok: true, issues: [] },
    });
  }
  if (url === "/api/v1/projects/current/commands") {
    return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
  }
  if (url === "/api/v1/projects/current/runs" && method === "GET") {
    return json(api.runs);
  }
  if (url === "/api/v1/projects/current/runs" && method === "POST") {
    const { body: payload, status } = api.startResponse();
    return json(payload, status);
  }
  const oneMatch = url.match(/\/runs\/([^/]+)$/);
  if (oneMatch && method === "GET") {
    const run = api.runs.find((entry) => entry.id === oneMatch[1]);
    return run
      ? json(run)
      : json({ code: "RUN_NOT_FOUND", message: url, status: 404 }, 404);
  }
  const cancelMatch = url.match(/\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    const run = api.runs.find((entry) => entry.id === cancelMatch[1]);
    return run ? json({ ...run, cancelRequested: true }) : json({}, 404);
  }
  const retryMatch = url.match(/\/runs\/([^/]+)\/retry$/);
  if (retryMatch && method === "POST") {
    const run = api.runs.find((entry) => entry.id === retryMatch[1]);
    if (!run) return json({}, 404);
    return json(
      makeRun({ id: "run-2", retryOfRunId: run.id, status: "queued" }),
      201,
    );
  }
  return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
}

function selectNode(nodeId: string) {
  act(() => {
    useEditorStore.getState().setSelection({ nodeIds: [nodeId], edgeIds: [] });
  });
}

function selectOperationNode() {
  selectNode(ids.operation);
}

async function openEditor() {
  render(<App />);
  // No recents: open through the store, then flip into the editor phase.
  await act(async () => {
    await useProjectStore.getState().open("/tmp/golden");
    useAppStore.getState().setPhase("editing");
  });
  await screen.findByTestId("canvas-tab-Canvas 1");
}

beforeEach(() => {
  api.runs = [];
  api.startResponse = () => ({ body: makeRun(), status: 201 });
  api.calls = [];
  api.executors = ["deterministic"];
  api.moka = () => buildGoldenMokaFile();
  FakeEventSource.opened = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        route(
          String(input),
          init?.method ?? "GET",
          init?.body ? JSON.parse(String(init.body)) : undefined,
        ),
      ),
    ),
  );
  useRunStore.getState().reset();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({
    phase: "booting",
    config: null,
    bootError: null,
    toasts: [],
  });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    inputPick: null,
    announcement: "",
    sidePanelTab: "inspector",
    leftPanelTab: "project",
    focusedAssetId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runStore", () => {
  it("loads run history and selects the latest run", async () => {
    api.runs = [makeRun({ status: "succeeded" })];
    await useRunStore.getState().load();
    const state = useRunStore.getState();
    expect(state.runs).toHaveLength(1);
    expect(state.selectedRunId).toBe("run-1");
  });

  it("starts a run and folds the created record in", async () => {
    api.startResponse = () => ({
      body: makeRun({ status: "succeeded" }),
      status: 201,
    });
    const run = await useRunStore
      .getState()
      .start(ids.canvasMain, [ids.operation]);
    expect(run.status).toBe("succeeded");
    expect(useRunStore.getState().runs[0]?.id).toBe("run-1");
    const startCall = api.calls.find(
      (call) => call.url.endsWith("/runs") && call.method === "POST",
    );
    expect(startCall?.body).toEqual({
      canvasId: ids.canvasMain,
      nodeIds: [ids.operation],
    });
  });

  it("captures validation issues from a rejected start", async () => {
    api.startResponse = () => ({
      status: 422,
      body: {
        code: "RUN_VALIDATION_FAILED",
        message: "The run is not valid",
        status: 422,
        details: {
          issues: [
            {
              code: "PORT_UNRESOLVED",
              message: "Required input text has no value",
              nodeId: ids.operation,
              portId: "text",
            },
          ],
        },
      },
    });
    await expect(
      useRunStore.getState().start(ids.canvasMain, [ids.operation]),
    ).rejects.toThrow("The run is not valid");
    expect(useRunStore.getState().lastIssues).toHaveLength(1);
    expect(useRunStore.getState().lastIssues[0]?.code).toBe("PORT_UNRESOLVED");
  });

  it("adopts server state when a run reaches a terminal status", async () => {
    useProjectStore.getState().hydrate({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
    });
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);
    expect(useRunStore.getState().runs[0]?.status).toBe("queued");

    api.runs = [withStepStatus(makeRun({ status: "succeeded" }), "succeeded")];
    await act(async () => {
      await useRunStore.getState().load();
    });
    expect(useRunStore.getState().runs[0]?.status).toBe("succeeded");
    // Terminal transition reloaded the project and announced completion.
    expect(
      api.calls.some(
        (call) =>
          call.url === "/api/v1/projects/current" && call.method === "GET",
      ),
    ).toBe(true);
    expect(
      useAppStore.getState().toasts.some((toast) => toast.kind === "success"),
    ).toBe(true);
  });

  it("says where a run that finished put what it made", async () => {
    api.moka = () => withFiledRun("run-1", ["images", "texts"]);
    useProjectStore.getState().hydrate({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
    });
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);

    api.runs = [withStepStatus(makeRun({ status: "succeeded" }), "succeeded")];
    await act(async () => {
      await useRunStore.getState().load();
      await settle();
    });
    const said = useAppStore
      .getState()
      .toasts.find((toast) => toast.kind === "success");
    expect(said?.message).toBe("Filed under Images (1), Texts (1)");

    // A toast is read and gone in a few seconds, so the place it named is one
    // choice away rather than something to remember and find.
    useEditorStore.setState({ leftPanelTab: "project" });
    act(() => {
      said?.choice?.go();
    });
    expect(useEditorStore.getState().leftPanelTab).toBe("assets");
  });

  it("says a run that filed nothing finished, and nothing more", async () => {
    api.moka = () => buildGoldenMokaFile();
    useProjectStore.getState().hydrate({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
    });
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);

    api.runs = [withStepStatus(makeRun({ status: "succeeded" }), "succeeded")];
    await act(async () => {
      await useRunStore.getState().load();
      await settle();
    });
    const said = useAppStore
      .getState()
      .toasts.find((toast) => toast.kind === "success");
    // A written answer lands in its node rather than among the assets, and
    // naming a shelf it was not put on would send a reader looking.
    expect(said?.message).toBe("Run finished");
    expect(said?.choice).toBeUndefined();
  });

  it("defers the post-run resync while local edits are pending", async () => {
    const project = useProjectStore.getState();
    project.hydrate({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
    });
    // Park a local edit in the pending queue without flushing.
    useProjectStore.setState({
      pending: [{ type: "renameCanvas", canvasId: ids.canvasMain, name: "X" }],
    });
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);
    api.calls = [];
    api.runs = [withStepStatus(makeRun({ status: "succeeded" }), "succeeded")];
    await act(async () => {
      await useRunStore.getState().load();
    });
    expect(
      api.calls.some((call) => call.url === "/api/v1/projects/current"),
    ).toBe(false);

    // Once the queue drains, the deferred resync fires.
    act(() => {
      useProjectStore.setState({ pending: [] });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      api.calls.some((call) => call.url === "/api/v1/projects/current"),
    ).toBe(true);
  });

  it("cancels an active run and retries a failed one", async () => {
    api.runs = [makeRun({ status: "running" })];
    await useRunStore.getState().load();
    await useRunStore.getState().cancel("run-1");
    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-1/cancel")),
    ).toBe(true);
    expect(useRunStore.getState().runs[0]?.cancelRequested).toBe(true);

    api.runs = [makeRun({ status: "failed", error: "boom" })];
    await useRunStore.getState().load();
    const retried = await useRunStore.getState().retry("run-1");
    expect(retried.retryOfRunId).toBe("run-1");
    expect(useRunStore.getState().runs[0]?.id).toBe("run-2");
    expect(useRunStore.getState().selectedRunId).toBe("run-2");
  });
});

describe("run stream", () => {
  it("shows a run's words as they arrive and reads the record when it ends", async () => {
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);
    const source = streamFor("run-1");
    expect(source.url).toBe("/api/v1/generate/stream?runId=run-1");

    act(() => {
      source.say("delta", {
        runId: "run-1",
        nodeId: ids.text,
        slotId: "result",
        text: "A lantern ",
      });
      source.say("delta", {
        runId: "run-1",
        nodeId: ids.text,
        slotId: "result",
        text: "floats.",
      });
    });
    expect(useRunStore.getState().streamText["run-1"]?.[ids.text]).toBe(
      "A lantern floats.",
    );

    api.runs = [withStepStatus(makeRun({ status: "succeeded" }), "succeeded")];
    api.calls = [];
    act(() => {
      source.say("done", { runId: "run-1", status: "succeeded" });
    });
    await settle();

    // The record is what the store ends up believing, asked for the moment the
    // run said it was over rather than at the next poll's convenience.
    expect(
      api.calls.some(
        (call) => call.url === "/api/v1/projects/current/runs/run-1",
      ),
    ).toBe(true);
    expect(useRunStore.getState().runs[0]?.status).toBe("succeeded");
    // And the words it was shown on the way are gone: the run has an answer of
    // its own now, and keeping both would leave a display to choose.
    expect(useRunStore.getState().streamText["run-1"]).toBeUndefined();
    expect(source.closed).toBe(true);
  });

  it("keeps the words of two nodes in one run apart", async () => {
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);
    const source = streamFor("run-1");

    act(() => {
      source.say("delta", {
        runId: "run-1",
        nodeId: ids.text,
        slotId: "result",
        text: "the first",
      });
      source.say("delta", {
        runId: "run-1",
        nodeId: ids.operation,
        slotId: "result",
        text: "the second",
      });
    });

    // Typed into one place they would read as an answer neither node gave.
    const said = useRunStore.getState().streamText["run-1"];
    expect(said?.[ids.text]).toBe("the first");
    expect(said?.[ids.operation]).toBe("the second");
  });

  it("falls back to asking for the record when the stream breaks", async () => {
    // Timers faked before the run is started, so the poll it sets up is one a
    // test can move along.
    vi.useFakeTimers();
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);
    const source = streamFor("run-1");
    api.runs = [makeRun({ status: "running" })];
    api.calls = [];

    act(() => {
      source.break();
    });
    await settle();

    expect(source.closed, "a broken stream is not left to reopen itself").toBe(
      true,
    );
    expect(
      api.calls.some(
        (call) => call.url === "/api/v1/projects/current/runs/run-1",
      ),
      "the record was asked for at once",
    ).toBe(true);

    // And on a schedule from here, which is how a run was followed before
    // there was a stream to hurry the display along.
    api.calls = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(
      api.calls.some((call) => call.url === "/api/v1/projects/current/runs"),
      "the run was asked for again on the poll",
    ).toBe(true);
  });
});

describe("reading one node's run", () => {
  it("indexes the runs each node was asked in, newest first", async () => {
    api.runs = [
      makeRun({
        id: "run-2",
        status: "succeeded",
        steps: [{ nodeId: ids.image, status: "succeeded" }],
      }),
      makeRun({
        id: "run-1",
        status: "failed",
        steps: [
          { nodeId: ids.text, status: "failed" },
          { nodeId: ids.image, status: "failed" },
        ],
      }),
    ];
    await useRunStore.getState().load();

    const asked = useRunStore.getState().byNode;
    expect(asked.get(ids.image)?.map((entry) => entry.run.id)).toEqual([
      "run-2",
      "run-1",
    ]);
    expect(asked.get(ids.text)?.map((entry) => entry.run.id)).toEqual([
      "run-1",
    ]);
    // A node no run mentioned is absent rather than listed against nothing.
    expect(asked.has(ids.export)).toBe(false);
  });

  it("reads a node through the run still going, not the newest one", async () => {
    api.runs = [
      makeRun({
        id: "run-2",
        status: "succeeded",
        steps: [{ nodeId: ids.text, status: "succeeded" }],
      }),
      makeRun({
        id: "run-1",
        status: "running",
        steps: [{ nodeId: ids.text, status: "running", progress: 0.5 }],
      }),
    ];
    await useRunStore.getState().load();

    const { result } = renderHook(() => ({
      run: useLatestRunForNode(ids.text),
      status: useNodeRunStatus(ids.text),
      progress: useNodeRunProgress(ids.text),
    }));
    expect(result.current.run?.id).toBe("run-1");
    expect(result.current.status).toBe("running");
    expect(result.current.progress).toBe(0.5);
  });

  it("says what every node is doing at once, by the same rule", async () => {
    api.runs = [
      makeRun({
        id: "run-2",
        status: "succeeded",
        steps: [
          { nodeId: ids.text, status: "succeeded" },
          { nodeId: ids.operation, status: "succeeded" },
        ],
      }),
      makeRun({
        id: "run-1",
        status: "running",
        steps: [{ nodeId: ids.text, status: "running" }],
      }),
    ];
    await useRunStore.getState().load();

    const views = nodeRunViews();
    // Still going, so it keeps the node even past a newer finished run.
    expect(views.get(ids.text)?.status).toBe("running");
    expect(views.get(ids.operation)?.status).toBe("succeeded");
    expect(views.has(ids.export)).toBe(false);
  });

  it("says how far a run has got, and nothing where nobody measured it", async () => {
    api.runs = [
      makeRun({
        id: "run-1",
        status: "running",
        steps: [
          { nodeId: ids.text, status: "running", progress: 0.25 },
          { nodeId: ids.operation, status: "running" },
        ],
      }),
    ];
    await useRunStore.getState().load();

    const views = nodeRunViews();
    expect(views.get(ids.text)?.progress).toBe(0.25);
    // A step that has said nothing about how far it got is not at the start:
    // the card draws a stripe the length of itself rather than an empty bar.
    expect(views.get(ids.operation)?.progress).toBeNull();
  });

  it("carries why a run gave up, for the card to be asked about", async () => {
    api.runs = [
      makeRun({
        id: "run-1",
        status: "failed",
        steps: [
          {
            nodeId: ids.image,
            status: "failed",
            error: "The provider would not say what it made.",
          },
        ],
      }),
    ];
    await useRunStore.getState().load();

    const view = nodeRunViews().get(ids.image);
    expect(view?.status).toBe("failed");
    expect(view?.error).toBe("The provider would not say what it made.");
    // Nothing is on its way any more, so there are no words on the card.
    expect(view?.said).toBe("");
  });

  it("reads a node the words on their way to it, and drops them at the end", async () => {
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);
    const source = streamFor("run-1");

    act(() => {
      source.say("delta", {
        runId: "run-1",
        nodeId: ids.text,
        slotId: "result",
        text: "A lantern ",
      });
    });
    expect(nodeRunViews().get(ids.text)?.said).toBe("A lantern ");

    api.runs = [withStepStatus(makeRun({ status: "succeeded" }), "succeeded")];
    act(() => {
      source.say("done", { runId: "run-1", status: "succeeded" });
    });
    await settle();
    // The answer belongs to the document now; the words on the way are not kept.
    expect(nodeRunViews().get(ids.text)?.said).toBe("");
  });

  it("says nothing about a node no run has asked", () => {
    const { result } = renderHook(() => ({
      run: useLatestRunForNode(ids.export),
      status: useNodeRunStatus(ids.export),
      progress: useNodeRunProgress(ids.export),
    }));
    expect(result.current.run).toBeNull();
    expect(result.current.status).toBeNull();
    expect(result.current.progress).toBeNull();
  });

  it("reads the words a run has said for one node so far", async () => {
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);
    const source = streamFor("run-1");
    const { result } = renderHook(() => ({
      text: useNodeStreamText(ids.text),
      operation: useNodeStreamText(ids.operation),
    }));
    expect(result.current.text).toBe("");

    act(() => {
      source.say("delta", {
        runId: "run-1",
        nodeId: ids.text,
        slotId: "result",
        text: "A lantern ",
      });
      source.say("delta", {
        runId: "run-1",
        nodeId: ids.text,
        slotId: "result",
        text: "floats.",
      });
    });
    expect(result.current.text).toBe("A lantern floats.");
    // Said to one node, it is not read out as an answer the other gave.
    expect(result.current.operation).toBe("");

    api.runs = [withStepStatus(makeRun({ status: "succeeded" }), "succeeded")];
    act(() => {
      source.say("done", { runId: "run-1", status: "succeeded" });
    });
    await settle();
    // The record has an answer of its own now, so the words on the way go.
    expect(result.current.text).toBe("");
  });

  it("forgets every node's run when the store is reset", async () => {
    api.runs = [makeRun({ status: "succeeded" })];
    await useRunStore.getState().load();
    expect(useRunStore.getState().byNode.size).toBeGreaterThan(0);

    useRunStore.getState().reset();
    expect(useRunStore.getState().byNode.size).toBe(0);
  });
});

describe("run UI", () => {
  it("runs the selected operation node from the inspector", async () => {
    await openEditor();
    // Nothing is offered until the board is pointed at something runnable.
    expect(
      screen.queryByRole("button", { name: "▶ Run this node" }),
    ).toBeNull();

    selectOperationNode();
    await screen.findByRole("button", { name: "▶ Run this node" });
    api.startResponse = () => ({
      body: withStepStatus(makeRun({ status: "succeeded" }), "succeeded"),
      status: 201,
    });
    fireEvent.click(screen.getByRole("button", { name: "▶ Run this node" }));

    await act(async () => {
      await Promise.resolve();
    });
    const startCall = api.calls.find(
      (call) => call.url.endsWith("/runs") && call.method === "POST",
    );
    expect(startCall?.body).toEqual({
      canvasId: ids.canvasMain,
      nodeIds: [ids.operation],
    });
  });

  it("says why a run's ask was refused, rather than dropping it", async () => {
    await openEditor();
    selectOperationNode();
    const button = await screen.findByRole("button", {
      name: "▶ Run this node",
    });
    act(() => {
      useAppStore.setState({ toasts: [] });
    });
    // A capability with nothing behind it: the refusal is not a validation
    // issue, so nothing else on the screen would say it.
    api.startResponse = () => ({
      body: {
        code: "PROVIDER_NOT_CONFIGURED",
        message: "a::b is not configured",
      },
      status: 422,
    });

    // In Chinese, which is the case the catalogue is for: the reason is said
    // in the reader's own words, with the server's sentence kept under it so
    // the configuration it named is not lost.
    await act(async () => {
      await i18n.changeLanguage("zh");
    });
    fireEvent.click(button);
    await settle();

    const said = useAppStore.getState().toasts.at(-1);
    expect(said?.kind).toBe("error");
    expect(said?.message).toBe("尚未配置该能力可用的模型或密钥");
    expect(said?.detail).toBe("a::b is not configured");

    await act(async () => {
      await i18n.changeLanguage("en");
    });
  });
  it("says why a run did not finish, and not only that it did not", async () => {
    useProjectStore.getState().hydrate({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
    });
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);

    api.runs = [
      makeRun({
        status: "failed",
        error: '"Run this node": The provider would not say what it made.',
        steps: [
          { nodeId: ids.text, status: "succeeded" },
          {
            nodeId: ids.operation,
            status: "failed",
            error: "The provider would not say what it made.",
          },
        ],
      }),
    ];
    act(() => {
      useAppStore.setState({ toasts: [] });
    });
    await act(async () => {
      await useRunStore.getState().load();
    });

    const said = useAppStore.getState().toasts.at(-1);
    expect(said?.kind).toBe("error");
    // The step's own words, which is where the trouble was classified: the
    // run's line is a title glued to the same message.
    expect(said?.message).toBe(
      "Run did not finish: The provider would not say what it made.",
    );
  });

  it("says why an ask did not finish beside the card that shows it", async () => {
    api.runs = [
      makeRun({
        id: "run-1",
        status: "failed",
        steps: [
          {
            nodeId: ids.image,
            status: "failed",
            error: "The provider would not say what it made.",
          },
          { nodeId: ids.text, status: "succeeded" },
        ],
      }),
    ];
    await openEditor();

    // Nothing is being pointed at yet, so nothing is said.
    expect(screen.queryByTestId("run-note")).toBeNull();

    act(() => {
      useEditorStore.getState().setHoveredNode(ids.image);
    });
    const note = await screen.findByTestId("run-note");
    expect(note.getAttribute("role")).toBe("tooltip");
    expect(note.textContent).toContain(
      "The provider would not say what it made.",
    );

    // A card whose ask went through carries no mark, so it needs no note.
    act(() => {
      useEditorStore.getState().setHoveredNode(ids.text);
    });
    expect(screen.queryByTestId("run-note")).toBeNull();
  });

  it("shows validation issues in the inspector after a rejected start", async () => {
    await openEditor();
    selectOperationNode();
    api.startResponse = () => ({
      status: 422,
      body: {
        code: "RUN_VALIDATION_FAILED",
        message: "The run is not valid",
        status: 422,
        details: {
          issues: [
            {
              code: "PORT_UNRESOLVED",
              message: "Required input text has no value",
              nodeId: ids.operation,
              portId: "text",
            },
          ],
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "▶ Run this node" }));

    const issues = await screen.findByRole("alert");
    expect(issues.textContent).toContain("PORT_UNRESOLVED");
    expect(issues.textContent).toContain("Required input text has no value");
  });

  it("shows the latest run status with retry for the selected node", async () => {
    api.runs = [
      makeRun({
        status: "failed",
        error: "deterministic failure",
        steps: [
          { nodeId: ids.text, status: "succeeded" },
          { nodeId: ids.operation, status: "failed", error: "boom" },
        ],
      }),
    ];
    await openEditor();
    selectOperationNode();

    const chip = await screen.findByText("Failed");
    expect(chip.className).toContain("run-chip-failed");
    expect(await screen.findByText("boom")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-1/retry")),
    ).toBe(true);
  });
});

describe("history panel", () => {
  async function openHistory() {
    await openEditor();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    return screen.findByTestId("history-panel");
  }

  it("lists each run with the nodes it asked and what they were asked with", async () => {
    api.runs = [
      makeRun({
        id: "run-1",
        status: "succeeded",
        parameters: { [ids.operation]: { style: "storyboard" } },
        steps: [
          { nodeId: ids.text, status: "succeeded" },
          { nodeId: ids.operation, status: "succeeded" },
        ],
      }),
    ];
    const panel = await openHistory();

    expect(panel.textContent).toContain("Succeeded");
    expect(panel.textContent).toContain("Brief");
    expect(panel.textContent).toContain("Generate frame");
    // The snapshot is the run's own record of the parameters, not the node's
    // current ones.
    expect(panel.textContent).toContain("style");
    expect(panel.textContent).toContain("storyboard");
    expect(screen.getByLabelText("Filter by node")).toBeTruthy();
  });

  it("says nothing has been asked yet when nothing has", async () => {
    const panel = await openHistory();
    expect(panel.textContent).toContain("Nothing has been asked here yet");
    expect(screen.queryByLabelText("Filter by node")).toBeNull();
  });

  it("asks a run that finished again, as a run of its own", async () => {
    api.runs = [
      makeRun({
        id: "run-1",
        status: "succeeded",
        steps: [{ nodeId: ids.operation, status: "succeeded" }],
      }),
    ];
    api.startResponse = () => ({
      body: makeRun({ id: "run-2", status: "queued" }),
      status: 201,
    });
    await openHistory();

    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await settle();

    const startCall = api.calls.find(
      (call) => call.url.endsWith("/runs") && call.method === "POST",
    );
    expect(startCall?.body).toEqual({
      canvasId: ids.canvasMain,
      nodeIds: [ids.operation],
    });
  });

  it("retries a run that gave up rather than asking a new one", async () => {
    api.runs = [
      makeRun({
        id: "run-1",
        status: "failed",
        error: "deterministic failure",
        steps: [{ nodeId: ids.operation, status: "failed", error: "boom" }],
      }),
    ];
    const panel = await openHistory();
    expect(panel.textContent).toContain("boom");

    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await settle();

    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-1/retry")),
    ).toBe(true);
    expect(
      api.calls.some(
        (call) => call.url.endsWith("/runs") && call.method === "POST",
      ),
    ).toBe(false);
  });

  it("narrows the list to one node's asks", async () => {
    api.runs = [
      makeRun({
        id: "run-1",
        status: "succeeded",
        steps: [{ nodeId: ids.operation, status: "succeeded" }],
      }),
      makeRun({
        id: "run-2",
        status: "succeeded",
        steps: [{ nodeId: ids.image, status: "succeeded" }],
      }),
    ];
    await openHistory();
    expect(screen.getByTestId("history-run-run-1")).toBeTruthy();
    expect(screen.getByTestId("history-run-run-2")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter by node"), {
      target: { value: ids.image },
    });

    expect(screen.queryByTestId("history-run-run-1")).toBeNull();
    expect(screen.getByTestId("history-run-run-2")).toBeTruthy();
  });
});

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";
const PLATE_ID = "00000000-0000-7000-8000-0000000000a1";
const POSTER_ID = "00000000-0000-7000-8000-0000000000a2";

/** A run driving the generation fixture's image node. */
function generationRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return makeRun({
    id: "run-gen",
    projectId: generated.project,
    canvasId: generated.canvas,
    requestedNodeIds: [generated.image],
    executorKey: PROVIDER_EXECUTOR_KEY,
    steps: [{ nodeId: generated.image, status: "queued" }],
    ...overrides,
  });
}

/**
 * The generation document as an exported package would carry it: the poster its
 * image node made, with what was asked for recorded on the asset and no run id
 * left to point back at.
 */
function buildGeneratedMokaFile(): MokaFile {
  const moka = buildGenerationMokaFile();
  const card = moka.canvas[0]?.nodes.find(
    (node) => node.id === generated.image,
  );
  const asked = (card?.data as { generation?: GenerationSpec } | undefined)
    ?.generation;
  moka.resources.images = [
    {
      id: PLATE_ID,
      name: "plate.png",
      path: "assets/images/plate.png",
      mime: "image/png",
      bytes: 1024,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: POSTER_ID,
      name: "poster.png",
      path: "assets/images/poster.png",
      mime: "image/png",
      bytes: 8192,
      createdAt: T0,
      updatedAt: T0,
      provenance: {
        canvasId: generated.canvas,
        operationNodeId: generated.image,
        inputAssetIds: [PLATE_ID],
        parameterSnapshot: {
          ...asked,
          // Not the prompt the node carries now: asking again has to ask for
          // what the asset says was asked for, which is the whole point of it.
          prompt: "Paint the lake at night as a poster.",
        },
        createdAt: T1,
      },
    },
  ];
  // The answer landed on the card that asked for it, which is what a finished
  // run does — and what makes the file the board's own material on the shelf.
  if (card) card.data = { ...card.data, assetId: POSTER_ID };
  return moka;
}

/** The value the inspector shows beside a label, or "" when it shows none. */
function inspected(label: string): string {
  const row = [...document.querySelectorAll(".inspector-row")].find(
    (entry) => entry.firstElementChild?.textContent === label,
  );
  return row?.lastElementChild?.textContent ?? "";
}

/** What a write of one node's data looks like on the wire. */
interface NodeWrite {
  commands: {
    type: string;
    nodeId: string;
    patch: { data: { generation: GenerationSpec } };
  }[];
}

describe("generation UI", () => {
  beforeEach(() => {
    api.executors = ["deterministic", PROVIDER_EXECUTOR_KEY];
    api.moka = () => buildGenerationMokaFile();
  });

  it("offers a run for a generation node and shows what it would ask for", async () => {
    await openEditor();
    selectNode(generated.image);

    await screen.findByRole("button", { name: "▶ Run this node" });
    expect(inspected("Capability")).toBe("Image");
    expect(inspected("Mode")).toBe("generate");
    expect(inspected("Model")).toBe("painter");
    expect(inspected("Inputs from")).toBe("mentions");
    // The panel under the node carries the same words, so the excerpt is read
    // from the inspector's own row rather than from anywhere on screen.
    const excerpt =
      document.querySelector(".inspector-text-excerpt")?.textContent ?? "";
    expect(excerpt).toMatch(/as a poster\./);
    // The node's own JSON carries these parameters too, so the snippet is read
    // from the generation section rather than from anywhere in the panel.
    const params =
      [...document.querySelectorAll(".inspector-json")].find(
        (entry) => !entry.closest(".inspector-json-section"),
      )?.textContent ?? "";
    expect(params).toMatch(/"count": 2/);
  });

  it("offers no cancel for a node whose own part of a run has landed", async () => {
    api.runs = [
      generationRun({
        status: "running",
        requestedNodeIds: [generated.image, generated.text],
        steps: [
          { nodeId: generated.image, status: "succeeded" },
          { nodeId: generated.text, status: "running", progress: 0.4 },
        ],
      }),
    ];
    await openEditor();
    selectNode(generated.image);

    await screen.findByRole("button", { name: "▶ Run this node" });
    // The run this node was asked in is still going, but not for this node: the
    // inspector says where its own part landed, and the only control on offer is
    // another run of its own.
    expect(inspected("Status")).toBe("Succeeded");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(
      screen.queryByRole("progressbar", {
        name: "How far this node's run has got",
      }),
    ).toBeNull();
  });

  it("says why nothing can be generated where no provider is published", async () => {
    api.executors = ["deterministic"];
    await openEditor();
    selectNode(generated.image);

    const inInspector = await screen.findByRole("button", {
      name: "▶ Run this node",
    });
    expect(inInspector).toHaveProperty("disabled", true);
    expect(inInspector).toHaveProperty("title", generationUnavailable());
    expect(screen.getByText(generationUnavailable())).toBeTruthy();
  });

  it("asks again under what an asset recorded, as a new run", async () => {
    api.moka = () => buildGeneratedMokaFile();
    await openEditor();
    selectNode(generated.image);

    const again = await screen.findByRole("button", {
      name: "Run again with the parameters of the last generation",
    });
    expect(inspected("Inputs")).toBe("plate.png");
    // The record of the run that answered is not in this document, and the gap
    // is explained rather than left for the reader to find.
    expect(screen.getByText(/did not come with the project/)).toBeTruthy();

    api.calls = [];
    api.startResponse = () => ({
      body: generationRun({ status: "running" }),
      status: 201,
    });
    fireEvent.click(again);
    await settle();

    const wroteAt = api.calls.findIndex(
      (call) => call.url.endsWith("/commands") && call.method === "POST",
    );
    const startedAt = api.calls.findIndex(
      (call) => call.url.endsWith("/runs") && call.method === "POST",
    );
    expect(wroteAt, "the recorded spec went back first").toBeGreaterThanOrEqual(
      0,
    );
    // A run is served from the document on disk, so what it is to ask for has
    // to be there before the run is asked for.
    expect(startedAt).toBeGreaterThan(wroteAt);

    const written = api.calls[wroteAt]?.body as NodeWrite | undefined;
    const patch = written?.commands[0];
    expect(patch?.type).toBe("updateNode");
    expect(patch?.nodeId).toBe(generated.image);
    expect(patch?.patch.data.generation.prompt).toBe(
      "Paint the lake at night as a poster.",
    );
    expect(patch?.patch.data.generation.model).toBe("painter");
    expect(api.calls[startedAt]?.body).toEqual({
      canvasId: generated.canvas,
      nodeIds: [generated.image],
    });
    // Never a retry: the package this came from carries no run to retry.
    expect(api.calls.some((call) => call.url.includes("/retry"))).toBe(false);
  });

  it("says nothing about a missing record where the run is still here", async () => {
    const moka = buildGeneratedMokaFile();
    const poster = moka.resources.images[1]!;
    poster.provenance = { ...poster.provenance!, runId: "run-made-here" };
    api.moka = () => moka;
    await openEditor();
    selectNode(generated.image);

    await screen.findByRole("button", {
      name: "Run again with the parameters of the last generation",
    });
    expect(screen.queryByText(/did not come with the project/)).toBeNull();
  });

  it("shows how far a generation has got and what it has said so far", async () => {
    api.startResponse = () => ({
      body: generationRun({
        status: "running",
        steps: [{ nodeId: generated.image, status: "running", progress: 0.4 }],
      }),
      status: 201,
    });
    await openEditor();
    selectNode(generated.image);
    fireEvent.click(
      await screen.findByRole("button", { name: "▶ Run this node" }),
    );
    await settle();

    const bar = await screen.findByRole("progressbar", {
      name: "How far this node's run has got",
    });
    expect(bar).toHaveProperty("value", 0.4);

    act(() => {
      streamFor("run-gen").say("delta", {
        runId: "run-gen",
        nodeId: generated.image,
        slotId: "result",
        text: "A lake at night.",
      });
    });
    await settle();
    expect(document.querySelector(".inspector-run-output")?.textContent).toBe(
      "A lake at night.",
    );
  });

  it("shows which node made an asset and selects it", async () => {
    api.moka = () => buildGeneratedMokaFile();
    await openEditor();
    // The shelf is behind the assets face of the left column.
    useEditorStore.setState({ leftPanelTab: "assets" });

    const badge = await screen.findByRole("button", {
      name: "Go to Poster, which made poster.png",
    });
    fireEvent.click(badge);
    await settle();

    expect(useEditorStore.getState().selection.nodeIds).toEqual([
      generated.image,
    ]);
    expect(useEditorStore.getState().announcement).toBe(
      "Selected the node that made this asset",
    );
  });
});

describe("reaching a generation from the menu", () => {
  const batch = batchNodeIds();

  beforeEach(() => {
    api.executors = ["deterministic", PROVIDER_EXECUTOR_KEY];
    api.moka = () => buildGenerationMokaFile();
  });

  /** Points the menu at a node the way the canvas does when one is clicked. */
  function menuOn(nodeId: string) {
    act(() => {
      useEditorStore.getState().openContextMenu({
        x: 40,
        y: 40,
        target: { kind: "node", nodeId },
      });
    });
  }

  function nodeData(nodeId: string) {
    const canvas = useProjectStore.getState().moka!.canvas[0];
    return findNode(canvas, nodeId)!.data as {
      assetId?: string;
      resultSlots?: { id: string; isPrimary: boolean }[];
    };
  }

  it("offers to stop a run still going, and stops it", async () => {
    api.runs = [
      generationRun({
        status: "running",
        steps: [{ nodeId: generated.image, status: "running" }],
      }),
    ];
    await openEditor();
    menuOn(generated.image);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop" }));
    await settle();

    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-gen/cancel")),
    ).toBe(true);
    // Optimistic, so the card stops offering a control that was just used.
    expect(useRunStore.getState().runs[0]?.cancelRequested).toBe(true);
  });

  it("offers no stop for a node whose own part of a run has landed", async () => {
    api.runs = [
      generationRun({
        status: "running",
        requestedNodeIds: [generated.image, generated.text],
        steps: [
          { nodeId: generated.image, status: "succeeded" },
          { nodeId: generated.text, status: "running", progress: 0.4 },
        ],
      }),
    ];
    await openEditor();
    menuOn(generated.image);

    await screen.findByRole("menu", { name: "Context menu" });
    // The run is still going, but for the other node it drove. This one has
    // landed, so there is nothing of its own to stop, and nothing to retry.
    expect(screen.queryByRole("menuitem", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Retry" })).toBeNull();
  });

  it("offers to ask again for a run that gave up", async () => {
    api.runs = [
      generationRun({
        status: "failed",
        error: "The provider went away.",
        steps: [
          {
            nodeId: generated.image,
            status: "failed",
            error: "The provider went away.",
          },
        ],
      }),
    ];
    await openEditor();
    menuOn(generated.image);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Retry" }));
    await settle();

    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-gen/retry")),
    ).toBe(true);
    // A choice closes the menu rather than leaving it to be asked twice.
    expect(screen.queryByRole("menu", { name: "Context menu" })).toBeNull();
  });

  it("copies what a node asks for", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await openEditor();
    menuOn(generated.image);

    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy prompt" }),
    );
    await settle();

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("as a poster."),
    );
    expect(useEditorStore.getState().announcement).toBe("Prompt copied");
  });

  it("offers another of a batch's results from the card holding it", async () => {
    api.moka = () => buildBatchMokaFile();
    await openEditor();
    menuOn(batch.second);

    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Show this result on Poster",
      }),
    );
    await settle();

    // The node that asked for the batch is what ends up showing the answer.
    expect(nodeData(batch.poster).assetId).toBe("asset-two");
    expect(
      nodeData(batch.poster).resultSlots?.map((slot) => slot.isPrimary),
    ).toEqual([false, true, false]);
    expect(useEditorStore.getState().announcement).toBe(
      "Showing result 2 of 3",
    );
  });

  it("offers the results a node holds itself, by their place in the batch", async () => {
    api.moka = () => buildBatchMokaFile();
    await openEditor();
    menuOn(batch.poster);

    const menu = await screen.findByRole("menu", { name: "Context menu" });
    expect(
      [...menu.querySelectorAll("button")].map((item) => item.textContent),
    ).toEqual(expect.arrayContaining(["Show result 2", "Show result 3"]));
  });
});

describe("leaving with a generation going", () => {
  beforeEach(() => {
    api.executors = ["deterministic", PROVIDER_EXECUTOR_KEY];
    api.moka = () => buildGenerationMokaFile();
  });

  it("says a run carries on, and stops nothing on the way out", async () => {
    api.runs = [
      generationRun({
        status: "running",
        steps: [{ nodeId: generated.image, status: "running" }],
      }),
    ];
    await openEditor();

    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Projects" }));

    const guard = await screen.findByRole("alertdialog");
    expect(guard.textContent).toContain("A generation is still running");
    expect(guard.textContent).toContain("Leaving does not stop it");
    // Nothing was unsaved, so there is no work to throw away or to package up.
    expect(guard.textContent).not.toContain("will be lost");
    expect(
      screen.queryByRole("button", { name: "Discard and close" }),
    ).toBeNull();
    expect(useAppStore.getState().phase).toBe("editing");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await settle();

    expect(useAppStore.getState().phase).toBe("launcher");
    expect(api.calls.some((call) => call.url.includes("/cancel"))).toBe(false);
  });

  it("keeps every way out it had where there is work to lose", () => {
    render(
      <UnsavedWorkDialog
        busy={null}
        error={null}
        inFlight={2}
        onAction={() => {}}
        onCancel={() => {}}
        pendingCount={3}
        saveStatus="saved"
      />,
    );

    const guard = screen.getByRole("alertdialog");
    expect(guard.textContent).toContain("3 unsaved changes will be lost");
    expect(guard.textContent).toContain("2 generations are still running");
    expect(screen.getByRole("button", { name: "Save and close" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Discard and close" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export copy and close" }),
    ).toBeTruthy();
  });

  it("says what is still running on a canvas being left", async () => {
    api.moka = () => buildGoldenMokaFile();
    api.runs = [makeRun({ status: "running" })];
    await openEditor();

    fireEvent.click(await screen.findByRole("button", { name: "Canvas 2" }));
    await settle();

    const said = useAppStore
      .getState()
      .toasts.some((toast) =>
        toast.message.includes("still running on Canvas 1"),
      );
    expect(said).toBe(true);
    // The run was left alone: it belongs to the project, not to the canvas.
    expect(api.calls.some((call) => call.url.includes("/cancel"))).toBe(false);
  });
});

describe("a node asked twice over", () => {
  beforeEach(() => {
    api.executors = ["deterministic", PROVIDER_EXECUTOR_KEY];
    api.moka = () => buildGenerationMokaFile();
  });

  it("shows both asks rather than only the one being read", async () => {
    api.runs = [
      generationRun({
        id: "run-later",
        status: "succeeded",
        createdAt: "2026-01-01T00:00:09.000Z",
        steps: [{ nodeId: generated.image, status: "succeeded" }],
      }),
      generationRun({
        id: "run-earlier",
        status: "failed",
        error: "The provider went away.",
        createdAt: "2026-01-01T00:00:05.000Z",
        steps: [
          {
            nodeId: generated.image,
            status: "failed",
            error: "The provider went away.",
          },
        ],
      }),
    ];
    await openEditor();
    selectNode(generated.image);

    const list = await screen.findByText("Asked in");
    expect(list.parentElement?.textContent).toContain("Succeeded");
    expect(list.parentElement?.textContent).toContain("Failed");
    expect(
      document.querySelectorAll(".inspector-run-list .run-chip"),
    ).toHaveLength(2);
  });
});
