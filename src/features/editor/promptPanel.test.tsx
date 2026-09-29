// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import App from "../../App";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import {
  MAX_IMAGES_PER_RUN,
  MAX_PROMPT_LENGTH,
  createNode,
  defaultGenerationSpec,
} from "../../shared/domain";
import type { GenerationSpec, MokaFile, RunRecord } from "../../shared/domain";
import { PROVIDER_EXECUTOR_KEY } from "../../shared/domain";
import type { GenerationPreview, ModelsView } from "../../api";
import { generationUnavailable, useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";
import { useRunStore } from "./stores/runStore";
import { useModelStore } from "../settings/modelStore";
import { undo } from "./commands/execute";
import { enterIntent } from "./interactions/keyboard";

const ids = goldenNodeIds();

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
  capabilities: { mode: "web", assetCategories: [] },
};

/** One model per capability, as the server would send them. */
function models(models: ModelsView["models"]): ModelsView {
  return {
    version: 1,
    revision: 7,
    models,
    defaults: {
      text: null,
      image: null,
      speech: null,
      music: null,
      video: null,
      asr: null,
    },
    preferences: {
      systemPrompt: "",
      reasoningEffort: "auto",
      image: { size: "1:1", quality: "auto", background: "auto", count: 1 },
      video: {
        seconds: 8,
        resolution: "1080",
        generateAudio: true,
        watermark: false,
        mode: "auto",
        ratio: "16:9",
      },
      speech: {
        voice: "alloy",
        format: "mp3",
        speed: 1,
        instructions: "",
        sampleRate: 22050,
        volume: 50,
        rate: 1,
        pitch: 1,
      },
      music: { format: "mp3", watermark: false },
      story: { splitChars: 12_000, readChars: 8_000 },
    },
    secretStorage: "unset",
  };
}

const DEMO_MODELS: ModelsView["models"] = [
  {
    id: "painter",
    category: "image",
    protocol: "openaiImages",
    url: "https://demo.test/v1/images/generations",
    model: "painter-1",
    displayName: "Painter",
    enabled: true,
    apiKey: { set: true, masked: "sk-…abcd" },
  },
  {
    id: "writer",
    category: "text",
    protocol: "openaiChat",
    url: "https://demo.test/v1/chat/completions",
    model: "writer-1",
    displayName: "Writer",
    enabled: true,
    apiKey: { set: true, masked: "sk-…abcd" },
  },
];

interface MockApi {
  calls: { url: string; method: string; body?: unknown }[];
  executors: string[];
  models: ModelsView;
  /** The runs the server is holding, which the editor reads when it opens. */
  runs: RunRecord[];
  /** What a node will send, or null for a node the server has no ask for yet. */
  preview: GenerationPreview | null;
  moka: () => MokaFile;
}

const api: MockApi = {
  calls: [],
  executors: [PROVIDER_EXECUTOR_KEY],
  models: models(DEMO_MODELS),
  runs: [],
  preview: null,
  moka: () => buildGoldenMokaFile(),
};

/** What the server says a node will send, once it has folded the graph. */
function makePreview(
  overrides: Partial<GenerationPreview> = {},
): GenerationPreview {
  return {
    prompt: "[Text 1]\nA lantern floats over a quiet lake at dusk.",
    inputs: [
      {
        role: "reference",
        nodeId: ids.text,
        assetId: ids.assetImage,
        name: "lantern.png",
        mime: "image/png",
        bytes: 20480,
        width: 512,
        height: 512,
        durationMs: null,
        missing: false,
      },
    ],
    truncatedChars: 0,
    unresolved: [],
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: ids.project,
    canvasId: ids.canvasMain,
    requestedNodeIds: [ids.image],
    status: "queued",
    executorKey: PROVIDER_EXECUTOR_KEY,
    graphHash: "abc123",
    parameters: {},
    steps: [{ nodeId: ids.image, status: "queued" }],
    cancelRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** jsdom has no stream; a run only needs one that can be opened and closed. */
class FakeEventSource {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener() {}
  close() {}
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
  if (url === "/api/v1/models") return json(api.models);
  if (url === "/api/v1/recent-projects") return json([]);
  if (
    url === "/api/v1/projects/open" ||
    url === "/api/v1/projects/current" ||
    url === "/api/v1/projects/current/commands"
  ) {
    if (url.endsWith("/commands") && method === "GET") {
      return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
    }
    if (url.endsWith("/commands")) {
      return json({ revision: 5, updatedAt: "2026-01-01T00:00:03.000Z" });
    }
    return json({
      root: "/tmp/golden",
      moka: api.moka(),
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
  }
  if (url === "/api/v1/projects/current/runs" && method === "GET") {
    return json(api.runs);
  }
  if (url === "/api/v1/projects/current/runs" && method === "POST") {
    return json(makeRun(), 201);
  }
  if (url === "/api/v1/projects/current/runs/run-1/cancel") {
    return json(makeRun({ status: "running", cancelRequested: true }));
  }
  if (url === "/api/v1/projects/current/runs/run-1/retry") {
    return json(makeRun({ id: "run-2", retryOfRunId: "run-1" }));
  }
  if (
    url === "/api/v1/projects/current/generate/preview" &&
    method === "POST"
  ) {
    if (!api.preview) {
      return json(
        {
          code: "GENERATION_SPEC_MISSING",
          message: "This node has not been asked for anything yet",
          status: 422,
        },
        422,
      );
    }
    return json(api.preview);
  }
  return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
}

/** Lets a frame and the promises behind it finish. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function openEditor() {
  render(<App />);
  await act(async () => {
    await useProjectStore.getState().open("/tmp/golden");
    useAppStore.getState().setPhase("editing");
  });
  await screen.findByTestId("canvas-tab-Canvas 1");
  await settle();
}

function selectNode(nodeId: string) {
  act(() => {
    useEditorStore.getState().setSelection({ nodeIds: [nodeId], edgeIds: [] });
  });
}

function panel() {
  return screen.getByTestId("prompt-panel");
}

/** The generation spec the document holds for a node, as it stands now. */
function specOf(nodeId: string): GenerationSpec | undefined {
  const moka = useProjectStore.getState().moka;
  const canvas = moka?.canvas.find((entry) => entry.id === ids.canvasMain);
  const node = canvas?.nodes.find((entry) => entry.id === nodeId);
  return (node?.data as { generation?: GenerationSpec } | undefined)
    ?.generation;
}

beforeEach(() => {
  api.calls = [];
  api.executors = [PROVIDER_EXECUTOR_KEY];
  api.models = models(DEMO_MODELS);
  api.runs = [];
  api.preview = makePreview();
  api.moka = () => buildGoldenMokaFile();
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
  useModelStore.getState().reset();
  useAppStore.setState({
    phase: "booting",
    config: null,
    bootError: null,
    toasts: [],
  });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    promptPanel: null,
    contextMenu: null,
    renaming: null,
    textEditing: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  // A run left going keeps a poll going with it, and the stub it reads through
  // is gone by then.
  useRunStore.getState().reset();
  vi.unstubAllGlobals();
});

describe("what Enter asks for", () => {
  it("edits a text node that already has words in it", () => {
    const node = createNode("text", { x: 0, y: 0 });
    node.data = { content: "A lantern floats." };
    expect(enterIntent(node)).toBe("edit");
  });

  it("asks a text node that has nothing yet", () => {
    const node = createNode("text", { x: 0, y: 0 });
    node.data = { content: "   " };
    expect(enterIntent(node)).toBe("ask");
  });

  it("asks a node a provider can answer", () => {
    expect(enterIntent(createNode("image", { x: 0, y: 0 }))).toBe("ask");
    expect(enterIntent(createNode("audio", { x: 0, y: 0 }))).toBe("ask");
    expect(enterIntent(createNode("video", { x: 0, y: 0 }))).toBe("ask");
  });

  it("renames what no provider could make, and a selection gone stale", () => {
    expect(enterIntent(createNode("operation", { x: 0, y: 0 }))).toBe("rename");
    expect(enterIntent(createNode("group", { x: 0, y: 0 }))).toBe("rename");
    expect(enterIntent(createNode("export", { x: 0, y: 0 }))).toBe("rename");
    expect(enterIntent(undefined)).toBe("rename");
  });
});

describe("the generation panel", () => {
  it("comes up under a selected node, without taking the keyboard", async () => {
    await openEditor();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();

    selectNode(ids.image);
    await settle();
    expect(panel()).toBeTruthy();
    // Coming up because a node was selected must not take the keyboard, or
    // words would land in the prompt and Delete would stop deleting the node.
    expect(document.activeElement).not.toBe(
      within(panel()).getByRole("textbox", {
        name: "Prompt for Reference image",
      }),
    );
  });

  it("does not come up for a node nothing can generate", async () => {
    await openEditor();
    selectNode(ids.operation);
    await settle();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();
  });

  it("puts the control that sends the ask in the field's own corner", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    // Where the words are written is where the control that sends them is, so
    // the hand does not have to travel to the far corner of the panel.
    const corner = panel().querySelector(".mention-field-corner");
    expect(corner?.querySelector("button")).toHaveProperty(
      "textContent",
      "Run",
    );

    // A page holding no field keeps the control in the head, since a button
    // the reader cannot reach from where they are is one they must look for.
    fireEvent.click(within(panel()).getByRole("tab", { name: "Parameter" }));
    await settle();
    expect(panel().querySelector(".mention-field-corner")).toBeNull();
    expect(
      panel().querySelector(".prompt-panel-head button.primary"),
    ).toHaveProperty("textContent", "Run");
  });

  it("opens from Enter with the keyboard in the prompt", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    // The selection brings the panel up, but the keyboard stays where it was.
    expect(panel()).toBeTruthy();
    expect(document.activeElement).not.toBe(
      within(panel()).getByRole("textbox", {
        name: "Prompt for Reference image",
      }),
    );

    fireEvent.keyDown(window, { key: "Enter" });
    await settle();
    const prompt = within(panel()).getByRole("textbox", {
      name: "Prompt for Reference image",
    });
    expect(document.activeElement).toBe(prompt);
  });

  it("opens from the right-click menu, and is not offered where it cannot run", async () => {
    await openEditor();
    act(() => {
      useEditorStore.getState().closePromptPanel();
      useEditorStore.getState().openContextMenu({
        x: 40,
        y: 40,
        target: { kind: "node", nodeId: ids.image },
      });
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Generate…" }));
    await settle();
    expect(panel()).toBeTruthy();
    expect(useEditorStore.getState().contextMenu).toBeNull();

    act(() => {
      useEditorStore.getState().closePromptPanel();
      useEditorStore.getState().openContextMenu({
        x: 40,
        y: 40,
        target: { kind: "node", nodeId: ids.operation },
      });
    });
    expect(screen.queryByRole("menuitem", { name: "Generate…" })).toBeNull();
  });

  it("offers no mode to choose, only the words themselves", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(within(panel()).queryByRole("group", { name: "Mode" })).toBeNull();
    // The field is out and empty from the start, and there is no fold to put
    // it away: what the ask takes its inputs from follows the words, not a
    // control beside them.
    const prompt = within(panel()).getByRole("textbox", {
      name: "Prompt for Reference image",
    });
    expect(prompt.textContent).toBe("");
    expect(
      within(panel()).queryByRole("button", { name: "Prompt" }),
    ).toBeNull();
  });

  it("takes what the wiring feeds it until the words name a card", async () => {
    const fed = withFedNode();
    await openEditor();
    selectNode(fed);
    await settle();
    // A node the wiring feeds comes up with its words empty and out, the same
    // as any other: nothing is folded away to be unfolded.
    expect(
      within(panel()).getByRole("textbox", { name: /Prompt for/ }).textContent,
    ).toBe("");

    // Nothing written, so the ask is what arrives on the wiring.
    fireEvent.click(within(panel()).getByRole("tab", { name: "Preview" }));
    await settle();
    expect(specOf(fed)?.inputMode).toBe("upstream");

    // A mention in the words turns the ask to what the prompt points at.
    fireEvent.click(within(panel()).getByRole("tab", { name: "Prompt" }));
    await settle();
    type(`Paint over @[node:${ids.text}]`);
    fireEvent.blur(
      within(panel()).getByRole("textbox", { name: /Prompt for/ }),
    );
    await settle();
    expect(specOf(fed)?.inputMode).toBe("mentions");
  });

  it("asks an image node to change what arrives when a picture arrives", async () => {
    const fed = withPictureFedNode();
    await openEditor();
    selectNode(fed);
    await settle();
    fireEvent.click(within(panel()).getByRole("tab", { name: "Preview" }));
    await settle();
    // A picture among the inputs, so the ask is to change it rather than to
    // start over; and nothing is offered as a choice anywhere.
    expect(specOf(fed)?.mode).toBe("edit");
  });

  it("writes the prompt when the field loses focus", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    const prompt = within(panel()).getByRole("textbox", {
      name: "Prompt for Reference image",
    });
    expect(specOf(ids.image)).toBeUndefined();

    write(prompt, "A poster of the lake");
    fireEvent.blur(prompt);
    await settle();
    const spec = specOf(ids.image);
    expect(spec?.prompt).toBe("A poster of the lake");
    // Nothing arrives at this node, so the ask starts over and the words are
    // kept beside a list by hand rather than taken from a wiring.
    expect(spec?.mode).toBe("generate");
    expect(spec?.inputMode).toBe("manual");
  });

  it("writes nothing when it came up on its own and nothing was typed", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    const prompt = within(panel()).getByRole("textbox", {
      name: "Prompt for Reference image",
    });
    fireEvent.focus(prompt);
    fireEvent.blur(prompt);
    await settle();
    expect(specOf(ids.image)).toBeUndefined();
  });

  it("points the node at the model chosen for it", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    const picker = within(panel()).getByRole("combobox", { name: "Image" });
    expect(picker).toHaveProperty("value", "");

    fireEvent.change(picker, { target: { value: "painter" } });
    await settle();
    expect(specOf(ids.image)?.model).toBe("painter");
  });

  it("offers the way to configure models when there are none", async () => {
    api.models = models([]);
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(
      within(panel()).queryByRole("combobox", { name: "Image" }),
    ).toBeNull();

    fireEvent.click(
      within(panel()).getByRole("button", { name: "Configure models" }),
    );
    await settle();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    // With no model at all the answer is "add one", on the category's own tab
    // rather than in a list to search.
    expect(
      screen.getByRole("button", { name: "New image model" }),
    ).toBeTruthy();
  });

  it("goes to the category that would serve the node, not to a list of them", async () => {
    // Only an image model exists: an image node is fine, a text node has
    // nothing to be pointed at, and the way out leads to the text tab.
    api.models = models(
      DEMO_MODELS.filter((model) => model.category === "image"),
    );
    await openEditor();
    selectNode(ids.text);
    await settle();

    fireEvent.click(
      within(panel()).getByRole("button", { name: "Configure models" }),
    );
    await settle();
    expect(
      screen.getByRole("tab", { name: "Text" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("text-empty")).toBeTruthy();
  });

  it("saves what was typed before asking for the run", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    const prompt = within(panel()).getByRole("textbox", {
      name: "Prompt for Reference image",
    });
    write(prompt, "A poster of the lake");
    fireEvent.click(within(panel()).getByRole("button", { name: "Run" }));
    await settle();

    const saved = api.calls.findIndex(
      (call) => call.url.endsWith("/commands") && call.method === "POST",
    );
    const started = api.calls.findIndex(
      (call) => call.url.endsWith("/runs") && call.method === "POST",
    );
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(saved);
    expect(api.calls[started]?.body).toEqual({
      canvasId: ids.canvasMain,
      nodeIds: [ids.image],
    });
    expect(specOf(ids.image)?.prompt).toBe("A poster of the lake");
  });

  it("says on the button when this deployment cannot generate", async () => {
    api.executors = ["deterministic"];
    await openEditor();
    selectNode(ids.image);
    await settle();
    const run = within(panel()).getByRole("button", { name: "Run" });
    expect(run).toHaveProperty("disabled", true);
    expect(run).toHaveProperty("title", generationUnavailable());
  });

  it("goes away on Escape, and stays away while that node is selected", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(panel()).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.image]);

    // Selecting it again is a new question, so the panel comes back.
    selectNode(ids.text);
    await settle();
    selectNode(ids.image);
    await settle();
    expect(panel()).toBeTruthy();
  });

  it("goes away when the selection lets go of its node", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(panel()).toBeTruthy();

    act(() => {
      useEditorStore.getState().clearSelection();
    });
    await settle();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();
  });
});

/** The bounds the document holds for a node, as they stand now. */
function boundsOf(nodeId: string) {
  const moka = useProjectStore.getState().moka;
  const canvas = moka?.canvas.find((entry) => entry.id === ids.canvasMain);
  return canvas?.nodes.find((entry) => entry.id === nodeId)?.bounds;
}

/**
 * A document with one empty node of each kind that has a shape or a yes-and-no
 * to offer, built once so their ids stay the same across every read of it.
 */
function withEmptyNodes() {
  const moka = buildGoldenMokaFile();
  const image = createNode("image", { x: 800, y: 0 });
  const video = createNode("video", { x: 1200, y: 0 });
  const audio = createNode("audio", { x: 1600, y: 0 });
  moka.canvas[0].nodes.push(image, video, audio);
  api.moka = () => moka;
  return { image: image.id, video: video.id, audio: audio.id };
}

function openParams() {
  fireEvent.click(within(panel()).getByRole("tab", { name: "Parameter" }));
}

describe("the parameters a node carries", () => {
  it("offers the ones its kind of node has, and no others", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    openParams();
    await settle();
    for (const name of ["Shape", "Quality", "Background"]) {
      expect(within(panel()).queryByRole("combobox", { name })).toBeTruthy();
    }
    expect(
      within(panel()).queryByRole("spinbutton", { name: "Images" }),
    ).toBeTruthy();
    expect(
      within(panel()).queryByRole("spinbutton", { name: "Temperature" }),
    ).toBeNull();

    // The disclosure belongs to the panel rather than to one node, so a
    // selection that moves on finds it still open.
    selectNode(ids.text);
    await settle();
    for (const name of ["Temperature", "Max tokens"]) {
      expect(within(panel()).queryByRole("spinbutton", { name })).toBeTruthy();
    }
    expect(
      within(panel()).queryByRole("combobox", { name: "Reasoning effort" }),
    ).toBeTruthy();
    expect(
      within(panel()).queryByRole("textbox", { name: "System prompt" }),
    ).toBeTruthy();
    expect(
      within(panel()).queryByRole("combobox", { name: "Shape" }),
    ).toBeNull();
  });

  it("says on the choice that leaves a parameter out what the default is", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    openParams();
    await settle();
    const shape = within(panel()).getByRole("combobox", { name: "Shape" });
    expect(shape).toHaveProperty("value", "");
    expect(
      Array.from((shape as HTMLSelectElement).options).map(
        (option) => option.textContent,
      ),
    ).toEqual(["Default · 1:1", "1:1", "3:4", "4:3", "16:9", "9:16", "21:9"]);
  });

  it("writes the parameter and takes it back out again", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    openParams();
    await settle();
    const shape = within(panel()).getByRole("combobox", { name: "Shape" });

    fireEvent.change(shape, { target: { value: "16:9" } });
    await settle();
    expect(specOf(ids.image)?.params.size).toBe("16:9");

    fireEvent.change(shape, { target: { value: "" } });
    await settle();
    expect(specOf(ids.image)?.params).toEqual({});
  });

  it("gives an empty node the shape it was asked for", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.image);
    await settle();
    openParams();
    await settle();
    expect(boundsOf(empty.image)).toEqual({
      x: 800,
      y: 0,
      width: 280,
      height: 200,
    });

    fireEvent.change(within(panel()).getByRole("combobox", { name: "Shape" }), {
      target: { value: "16:9" },
    });
    await settle();
    expect(boundsOf(empty.image)).toEqual({
      x: 800,
      y: 21,
      width: 280,
      height: 158,
    });

    // Taking the parameter back out leaves the node the size the shape gave it:
    // the size is the user's to change by hand, and the ask no longer names one.
    fireEvent.change(within(panel()).getByRole("combobox", { name: "Shape" }), {
      target: { value: "" },
    });
    await settle();
    expect(boundsOf(empty.image)?.height).toBe(158);
  });

  it("leaves the size of a node that already holds something alone", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    openParams();
    await settle();
    fireEvent.change(within(panel()).getByRole("combobox", { name: "Shape" }), {
      target: { value: "21:9" },
    });
    await settle();
    expect(boundsOf(ids.image)).toEqual({
      x: -320,
      y: 160,
      width: 280,
      height: 220,
    });
  });

  it("shows on a yes-and-no the answer that will be sent", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.video);
    await settle();
    openParams();
    await settle();
    const audio = within(panel()).getByRole("checkbox", {
      name: "Generate audio",
    });
    const watermark = within(panel()).getByRole("checkbox", {
      name: "Watermark",
    });
    // Neither is the node's own yet: each shows what the defaults would send.
    expect(specOf(empty.video)).toBeUndefined();
    expect(audio).toHaveProperty("checked", true);
    expect(watermark).toHaveProperty("checked", false);

    fireEvent.click(audio);
    fireEvent.click(watermark);
    await settle();
    expect(specOf(empty.video)?.params).toEqual({
      generateAudio: false,
      watermark: true,
    });
  });

  it("takes an audio node's voice by hand, since models name their own", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.audio);
    await settle();
    openParams();
    await settle();
    // No list to choose from: what a model answers to is its own, so the field
    // is typed into rather than picked.
    expect(
      within(panel()).queryByRole("combobox", { name: "Voice" }),
    ).toBeNull();
    const voice = within(panel()).getByRole("textbox", { name: "Voice" });

    fireEvent.change(voice, { target: { value: "some-model-voice" } });
    expect(specOf(empty.audio)?.params.voice).toBeUndefined();
    fireEvent.blur(voice);
    await settle();
    expect(specOf(empty.audio)?.params.voice).toBe("some-model-voice");
  });

  it("moves a sound ask between the two capabilities it may be made in", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.audio);
    await settle();
    openParams();
    await settle();

    // A fresh sound ask is a read-aloud one, and its fields are the voice's.
    expect(
      within(panel())
        .getByRole("radio", { name: "Speech" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const voice = within(panel()).getByRole("textbox", { name: "Voice" });
    fireEvent.change(voice, { target: { value: "some-model-voice" } });
    fireEvent.blur(voice);
    await settle();
    expect(specOf(empty.audio)?.capability).toBe("speech");
    expect(specOf(empty.audio)?.params.voice).toBe("some-model-voice");

    // Asking for a score instead moves the ask, and the voice's parameters do
    // not come along: each capability reads a vocabulary of its own.
    fireEvent.click(within(panel()).getByRole("radio", { name: "Music" }));
    await settle();
    expect(specOf(empty.audio)?.capability).toBe("music");
    expect(specOf(empty.audio)?.params.voice).toBeUndefined();
    expect(
      within(panel()).queryByRole("textbox", { name: "Voice" }),
    ).toBeNull();
    expect(
      within(panel()).getByRole("textbox", { name: "Lyrics" }),
    ).toBeTruthy();
  });

  it("lets one text node frame its own answer", async () => {
    await openEditor();
    selectNode(ids.text);
    await settle();
    openParams();
    await settle();
    const system = within(panel()).getByRole("textbox", {
      name: "System prompt",
    });
    fireEvent.change(system, { target: { value: "Answer in one sentence." } });
    // A keystroke is not a choice, so nothing is written until the field is left.
    expect(specOf(ids.text)?.params.instructions).toBeUndefined();
    fireEvent.blur(system);
    await settle();
    expect(specOf(ids.text)?.params.instructions).toBe(
      "Answer in one sentence.",
    );

    fireEvent.change(
      within(panel()).getByRole("combobox", {
        name: "Reasoning effort",
      }),
      { target: { value: "high" } },
    );
    await settle();
    expect(specOf(ids.text)?.params.reasoningEffort).toBe("high");
  });

  it("holds a number to the bounds an ask is made within", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.image);
    await settle();
    openParams();
    await settle();
    const images = within(panel()).getByRole("spinbutton", { name: "Images" });

    fireEvent.change(images, { target: { value: "99" } });
    // Nothing is written while the field still has the keyboard.
    expect(specOf(empty.image)).toBeUndefined();
    fireEvent.blur(images);
    await settle();
    expect(specOf(empty.image)?.params.count).toBe(MAX_IMAGES_PER_RUN);
    expect(images).toHaveProperty("value", `${MAX_IMAGES_PER_RUN}`);

    // Emptying it hands the choice back to the default.
    fireEvent.change(images, { target: { value: "" } });
    fireEvent.blur(images);
    await settle();
    expect(specOf(empty.image)?.params.count).toBeUndefined();
    expect(images).toHaveProperty("value", "");
  });
});

/**
 * A document with one empty image node that words arrive at, which is a node
 * with nothing of its own to ask for and still something to be asked for.
 */
function withFedNode() {
  const moka = buildGoldenMokaFile();
  const source = createNode("text", { x: 800, y: 0 });
  const target = createNode("image", { x: 1200, y: 0 });
  source.data = { content: "A heron stands in the shallows." };
  moka.canvas[0].nodes.push(source, target);
  moka.canvas[0].edges.push({
    id: "edge-fed",
    source: { nodeId: source.id, portId: "out" },
    target: { nodeId: target.id, portId: "prompt" },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  api.moka = () => moka;
  return target.id;
}

/**
 * A document with one empty image node that words and a picture arrive at,
 * which is a node asked to change what arrives rather than to start over.
 */
function withPictureFedNode() {
  const moka = buildGoldenMokaFile();
  const words = createNode("text", { x: 800, y: 400 });
  const source = createNode("image", { x: 800, y: 0 });
  const target = createNode("image", { x: 1200, y: 0 });
  words.data = { content: "Paint it over at dusk." };
  source.data = { assetId: ids.assetImage };
  moka.canvas[0].nodes.push(words, source, target);
  moka.canvas[0].edges.push(
    {
      id: "edge-picture",
      source: { nodeId: source.id, portId: "out" },
      target: { nodeId: target.id, portId: "images" },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "edge-words",
      source: { nodeId: words.id, portId: "out" },
      target: { nodeId: target.id, portId: "prompt" },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  );
  api.moka = () => moka;
  return target.id;
}

/** Opens the editor on a run the server is already holding for the image node. */
async function openWithRun(run: RunRecord) {
  api.runs = [run];
  await openEditor();
  selectNode(ids.image);
  await settle();
}

/**
 * Puts words into the prompt field the way typing would: the field is a rich
 * one, so the words are laid into it and the field is told, rather than a
 * value being set on it.
 */
function write(area: HTMLElement, value: string) {
  area.textContent = value;
  fireEvent.input(area);
}

function type(value: string) {
  write(within(panel()).getByRole("textbox"), value);
}

/** The control that sends an ask, whatever it reads as at the moment. */
function ask() {
  return within(panel()).getByRole("button", {
    name: /^(Run|Stop|Stopping…|Starting…)$/,
  });
}

describe("driving one node's run", () => {
  it("says on the button why there is nothing to ask for yet", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.image);
    await settle();
    expect(ask()).toHaveProperty("disabled", true);
    expect(ask()).toHaveProperty(
      "title",
      "Nothing to ask for yet: write a prompt, or connect one",
    );

    // Words are one way out of it, and the reason goes with the refusal.
    type("A heron at dawn");
    await settle();
    expect(ask()).toHaveProperty("disabled", false);
    expect(ask()).toHaveProperty("title", "");
  });

  it("asks a node that is fed from upstream without words of its own", async () => {
    const fed = withFedNode();
    await openEditor();
    selectNode(fed);
    await settle();
    expect(ask()).toHaveProperty("disabled", false);
    expect(specOf(fed)).toBeUndefined();
  });

  it("says on the button when this kind of node has no model", async () => {
    api.models = models([]);
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(ask()).toHaveProperty("disabled", true);
    expect(ask()).toHaveProperty("title", "No image model is configured yet");
  });

  it("counts a prompt out loud as it nears the limit", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    const limit = MAX_PROMPT_LENGTH.toLocaleString();

    // A short ask is most of them, and a count beside each would be noise.
    type("A heron at dawn");
    await settle();
    expect(panel().querySelector(".prompt-panel-count")).toBeNull();

    type("a".repeat(MAX_PROMPT_LENGTH));
    await settle();
    expect(panel().textContent).toContain(`${limit} of ${limit} characters`);
    // At the limit rather than past it, so the ask still stands.
    expect(ask()).toHaveProperty("disabled", false);

    type("a".repeat(MAX_PROMPT_LENGTH + 5));
    await settle();
    expect(panel().querySelector(".prompt-panel-count.is-over")).toBeTruthy();
    expect(ask()).toHaveProperty("disabled", true);
    expect(ask()).toHaveProperty(
      "title",
      `The prompt is 5 characters past the ${limit} it may be`,
    );
  });

  it("becomes the way to stop a run while that run is going", async () => {
    await openWithRun(
      makeRun({
        status: "running",
        steps: [{ nodeId: ids.image, status: "running", progress: 0.4 }],
      }),
    );
    expect(ask()).toHaveProperty("textContent", "Stop");

    fireEvent.click(ask());
    // Said at once: a run takes a moment to notice, and until it does a control
    // still reading as one that can be asked would be asked again.
    expect(ask()).toHaveProperty("textContent", "Stopping…");
    expect(ask()).toHaveProperty("disabled", true);
    await settle();
    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-1/cancel")),
    ).toBe(true);
  });

  it("offers a run of its own once this node's part has landed", async () => {
    // One run drove two nodes and this one has finished its part: the run is
    // still going, but there is nothing left of it for this node to stop. What
    // it offers is another run of its own, and that is what a click asks for.
    await openWithRun(
      makeRun({
        status: "running",
        requestedNodeIds: [ids.image, ids.text],
        steps: [
          { nodeId: ids.image, status: "succeeded" },
          { nodeId: ids.text, status: "running", progress: 0.4 },
        ],
      }),
    );
    expect(ask()).toHaveProperty("textContent", "Run");

    type("A heron at dawn, painted");
    await settle();
    fireEvent.click(ask());
    await settle();
    // What a finished node asks for is a run of its own, not the stopping of
    // the one it has already finished its part of.
    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-1/cancel")),
    ).toBe(false);
    expect(
      api.calls.filter(
        (call) => call.url.endsWith("/runs") && call.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("asks a run that gave up again as a follower of itself", async () => {
    await openWithRun(
      makeRun({
        status: "failed",
        steps: [{ nodeId: ids.image, status: "failed", error: "Refused" }],
      }),
    );
    expect(ask()).toHaveProperty("textContent", "Run");

    // A retry is asked against the document as it now stands, so what is typed
    // since the run gave up still counts.
    type("A heron at dawn, painted");
    await settle();
    fireEvent.click(ask());
    await settle();
    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-1/retry")),
    ).toBe(true);
    // Followed rather than started over, so the two stay one question asked
    // twice; and the run that follows is going, so the control stops it.
    expect(
      api.calls.filter(
        (call) => call.url.endsWith("/runs") && call.method === "POST",
      ),
    ).toHaveLength(0);
    expect(ask()).toHaveProperty("textContent", "Stop");
  });

  it("does not offer a run of several nodes again from one of their panels", async () => {
    await openWithRun(
      makeRun({
        status: "failed",
        requestedNodeIds: [ids.image, ids.text],
        steps: [
          { nodeId: ids.image, status: "failed", error: "Refused" },
          { nodeId: ids.text, status: "cancelled" },
        ],
      }),
    );
    expect(ask()).toHaveProperty("textContent", "Run");
  });
});

describe("what a node will send", () => {
  function disclosure() {
    return screen.getByTestId("input-preview");
  }

  function unfold() {
    return within(panel()).getByRole("tab", { name: "Preview" });
  }

  /** Opens the panel on the image node and unfolds the disclosure. */
  async function opened() {
    await openEditor();
    selectNode(ids.image);
    await settle();
    fireEvent.click(unfold());
    await settle();
  }

  it("is folded away until it is asked for", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(screen.queryByTestId("input-preview")).toBeNull();
    // Nothing is asked of the server on behalf of a page nobody opened.
    expect(
      api.calls.some((call) => call.url.endsWith("/generate/preview")),
    ).toBe(false);
    expect(unfold()).toHaveProperty("ariaSelected", "false");
  });

  it("shows the words and the references the server folded together", async () => {
    await opened();
    const shown = disclosure();
    expect(shown.textContent).toContain(
      "[Text 1]\nA lantern floats over a quiet lake at dusk.",
    );
    expect(shown.textContent).toContain("1 reference will be sent");
    expect(shown.textContent).toContain("lantern.png");
    expect(shown.textContent).toContain("Reference");
    expect(shown.textContent).toContain("image/png");
    expect(shown.textContent).toContain("512×512");
    expect(shown.textContent).toContain("20.0 KB");
    // Named by the card it came from, which is the way back to the canvas.
    expect(shown.textContent).toContain("from Brief");
    expect(unfold()).toHaveProperty("ariaSelected", "true");

    const asked = api.calls.find((call) =>
      call.url.endsWith("/generate/preview"),
    );
    expect(asked?.body).toEqual({
      canvasId: ids.canvasMain,
      nodeId: ids.image,
    });
  });

  it("saves what is typed before reading what will be sent", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    type("A heron at dawn");
    fireEvent.click(unfold());
    await settle();
    // The disclosure is read off the document on disk, so what is typed has to
    // be in it first or the answer is about the ask before this one.
    expect(specOf(ids.image)?.prompt).toBe("A heron at dawn");
    expect(disclosure()).toBeTruthy();
  });

  it("writes the ask of a node fed from upstream before reading it", async () => {
    const fed = withFedNode();
    await openEditor();
    selectNode(fed);
    await settle();
    expect(specOf(fed), "a node nobody has asked yet holds no ask").toBe(
      undefined,
    );

    fireEvent.click(unfold());
    await settle();

    // Its words arrive on a wire rather than being typed here, so saving only
    // what is typed would leave the document holding nothing for the server to
    // read, and the disclosure would answer that there is nothing to show from
    // inside the thing that had just offered to show it.
    expect(specOf(fed), "the ask is written whole").toBeTruthy();
    expect(specOf(fed)?.prompt, "the words are not the panel's to invent").toBe(
      "",
    );
    expect(disclosure().textContent).toContain("[Text 1]");
  });

  it("says what will not travel with the ask", async () => {
    const [reference] = makePreview().inputs;
    api.preview = makePreview({
      inputs: [{ ...reference, name: "gone.png", missing: true }],
      truncatedChars: 320,
      unresolved: ["n-deleted"],
    });
    await opened();
    const shown = disclosure();
    expect(shown.textContent).toContain("A mention names a node");
    expect(shown.textContent).toContain("gone.png is not there any more");
    expect(shown.textContent).toContain("cut by 320 characters");
    // A reference that will not be sent is not counted as one that will.
    expect(shown.textContent).toContain("No references will be sent");
  });

  it("goes away again when another page is asked for", async () => {
    await opened();
    fireEvent.click(within(panel()).getByRole("tab", { name: "Prompt" }));
    await settle();
    expect(screen.queryByTestId("input-preview")).toBeNull();
    expect(unfold()).toHaveProperty("ariaSelected", "false");
  });

  it("shows a refusal from the server as words rather than as nothing", async () => {
    api.preview = null;
    await opened();
    expect(disclosure().textContent).toContain(
      "This node has not been asked for anything yet",
    );
    // A node with nothing to ask for gains no ask from opening the disclosure:
    // the refusal is the answer to it, not something to write around.
    expect(specOf(ids.image)).toBe(undefined);
  });
});

describe("a mention that points at nothing", () => {
  it("stops the ask and says why beside the prompt", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    type("Paint this over");
    await settle();
    expect(ask()).toHaveProperty("disabled", false);

    type("Paint this over @[node:n-gone]");
    await settle();
    expect(ask()).toHaveProperty("disabled", true);
    expect(ask()).toHaveProperty(
      "title",
      "A mention names a node that is not on this canvas",
    );
    // Said where it can be read, not only on a control that stopped working.
    expect(panel().textContent).toContain(
      "A mention names a node that is not on this canvas",
    );

    // A mention of a node that is there is not a reason to refuse.
    type(`Paint this over @[node:${ids.text}]`);
    await settle();
    expect(ask()).toHaveProperty("disabled", false);
  });
});

describe("a prompt that points at other nodes", () => {
  function prompt() {
    return within(panel()).getByRole("textbox");
  }

  it("takes the ask out of the by-hand list when a mention is written into it", async () => {
    await openEditor();
    // Nothing is wired into this node, so with the words out it starts as a
    // list kept by hand.
    selectNode(ids.image);
    await settle();
    type("A heron at dawn");
    fireEvent.blur(prompt());
    await settle();
    expect(specOf(ids.image)?.inputMode).toBe("manual");

    // A mention reaches a provider only where the ask takes its context from
    // the prompt, so writing one carries the node into that mode with it. The
    // mode is read off the words rather than chosen, so it follows them.
    type(`Paint over @[node:${ids.text}]`);
    fireEvent.blur(prompt());
    await settle();
    expect(specOf(ids.image)?.inputMode).toBe("mentions");
    expect(specOf(ids.image)?.prompt).toContain(`@[node:${ids.text}]`);

    // Taking the mention back out takes the ask back to the list by hand,
    // since there is no longer a pointing in the words to send by.
    type("Paint over the lake");
    fireEvent.blur(prompt());
    await settle();
    expect(specOf(ids.image)?.inputMode).toBe("manual");
  });

  it("lifts what the words name into a strip under the field", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(document.querySelector(".mention-strip")).toBeNull();

    type(`Paint over @[node:${ids.text}]`);
    await settle();
    // Under the words and inside the field's own box, which is the part of the
    // panel that grows: a list after the field would be pushed out of sight.
    const field = panel().querySelector(".mention-field");
    const strip = field?.querySelector(".mention-strip");
    expect(strip).toBeTruthy();
    expect(
      [...strip!.querySelectorAll(".mention-strip-item")].map((item) =>
        item.getAttribute("data-node-id"),
      ),
    ).toEqual([ids.text]);

    type("Paint over the lake");
    await settle();
    expect(field?.querySelector(".mention-strip")).toBeNull();
  });
});

describe("what a node is given", () => {
  function given() {
    return screen.getByTestId("reference-bar");
  }

  /** How many steps of history the document is holding, as it stands now. */
  function steps() {
    return useHistoryStore.getState().undoStack.length;
  }

  it("takes a listed node out by hand, in one step of history", async () => {
    // A list kept by hand, holding one node: what the bar shows when the fold
    // beside the prompt says the ask takes its context from the list.
    const moka = buildGoldenMokaFile();
    const target = moka.canvas[0].nodes.find((node) => node.id === ids.image);
    if (!target) throw new Error("the golden file holds the image node");
    const spec = defaultGenerationSpec("image");
    if (!spec) throw new Error("an image node can be asked");
    target.data = {
      ...target.data,
      generation: {
        ...spec,
        inputMode: "manual",
        referenceNodeIds: [ids.text],
      },
    };
    api.moka = () => moka;
    await openEditor();
    selectNode(ids.image);
    await settle();
    const [chip] = within(given()).getAllByRole("listitem");
    expect(chip.textContent).toContain("Brief");

    const before = steps();
    fireEvent.click(
      within(chip).getByRole("button", {
        name: "Take Brief out of the list",
      }),
    );
    await settle();
    expect(specOf(ids.image)?.inputMode).toBe("manual");
    expect(specOf(ids.image)?.referenceNodeIds).toEqual([]);
    // One step, so one undo takes the list back whole rather than halfway.
    expect(steps()).toBe(before + 1);
  });

  it("takes out what is wired in, edge and all", async () => {
    const fed = withFedNode();
    await openEditor();
    selectNode(fed);
    await settle();
    const [chip] = within(given()).getAllByRole("listitem");
    expect(chip.textContent).toContain("Prompt");

    fireEvent.click(within(chip).getByRole("button", { name: /Disconnect/ }));
    await settle();
    const canvas = useProjectStore.getState().moka?.canvas[0];
    expect(canvas?.edges.map((edge) => edge.id)).not.toContain("edge-fed");
  });
});

describe("making something out of a node's words", () => {
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

  function nodes() {
    return useProjectStore.getState().moka?.canvas[0].nodes ?? [];
  }

  it("makes a node beside the words, fed by them, and asks for nothing", async () => {
    await openEditor();
    const before = nodes().map((node) => node.id);
    menuOn(ids.text);

    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Image from these words" }),
    );
    await settle();

    const made = nodes().find((node) => !before.includes(node.id));
    const words = nodes().find((node) => node.id === ids.text);
    if (!made || !words) throw new Error("the menu made a node");
    expect(made.kind).toBe("image");
    // Beside the words rather than over them, so the wire between the two can
    // be seen to be why the new node has anything to ask for.
    expect(made.bounds.x).toBeGreaterThan(words.bounds.x + words.bounds.width);
    expect(
      useProjectStore
        .getState()
        .moka?.canvas[0].edges.some(
          (edge) =>
            edge.source.nodeId === ids.text &&
            edge.source.portId === "out" &&
            edge.target.nodeId === made.id &&
            edge.target.portId === "prompt",
        ),
    ).toBe(true);

    // The panel comes up on its own, since the ask is what was meant; the ask
    // itself waits for one more press, so a menu cannot spend anything.
    expect(useEditorStore.getState().promptPanel).toEqual({
      nodeId: made.id,
      focus: true,
    });
    expect(
      api.calls.some(
        (call) => call.url.endsWith("/runs") && call.method === "POST",
      ),
    ).toBe(false);

    // One step of history: the node and the wire feeding it go back together.
    undo();
    await settle();
    expect(nodes().map((node) => node.id)).toEqual(before);
  });

  it("offers nothing to make out of words that are not there", async () => {
    const empty = buildGoldenMokaFile();
    const brief = empty.canvas[0].nodes.find((node) => node.id === ids.text);
    (brief?.data as { content: string }).content = "   ";
    api.moka = () => empty;
    await openEditor();
    menuOn(ids.text);

    await screen.findByRole("menu", { name: "Context menu" });
    expect(
      screen.queryByRole("menuitem", { name: /from these words/ }),
    ).toBeNull();
    // The node's own ask is still on offer; it is the making that needs words.
    expect(screen.queryByRole("menuitem", { name: "Generate…" })).toBeTruthy();
  });
});
