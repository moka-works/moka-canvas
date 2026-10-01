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
import type { ModelsView } from "../../api";
import {
  CASCADE_DROP_OFFSET,
  DEFAULT_NODE_WIDTH,
  MAX_TEXT_CONTENT_LENGTH,
} from "../../shared/domain";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { useModelStore } from "../settings/modelStore";
import { useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";
import { BAR_ENTRIES, useToolPrefs } from "./stores/toolPrefs";

/** Whether this deployment can reach a provider at all. */
let executors: string[] = ["provider"];
/** What is configured, so a test can take the text model away. */
let offersText = true;

function config() {
  return {
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
    capabilities: { mode: "web", executors, assetCategories: [] },
  };
}

function providers(): ModelsView {
  const models: ModelsView["models"] = [
    ...(offersText
      ? [
          {
            id: "reader",
            category: "text" as const,
            protocol: "openaiChat" as const,
            url: "https://api.example.com/v1/chat/completions",
            model: "reader-1",
            displayName: "Example Reader",
            enabled: true,
            apiKey: { set: true, masked: "sk-…abcd" },
          },
        ]
      : []),
    {
      id: "painter",
      category: "image" as const,
      protocol: "openaiImages" as const,
      url: "https://api.example.com/v1/images/generations",
      model: "painter-1",
      displayName: "Example Painter",
      enabled: true,
      apiKey: { set: true, masked: "sk-…abcd" },
    },
  ];
  return {
    version: 1,
    revision: 7,
    models,
    defaults: {
      text: offersText ? "reader" : null,
      image: "painter",
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

/** Every ask the dialog sent, in the order it sent them. */
const asks: Record<string, unknown>[] = [];

/**
 * What an answer arrives as.
 *
 * `closing` is the frame that ends the stream, which is where the whole answer
 * and any failure both travel; the pieces before it are what gets shown while it
 * is still coming.
 */
let answer: { pieces: string[]; closing: Record<string, unknown> } = {
  pieces: [],
  closing: {},
};
/** Set when an ask should never finish, the way a slow answer does not. */
let hangs = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A frame of the kind a stream is made of. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streaming(signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of answer.pieces) {
        controller.enqueue(encoder.encode(frame("delta", { text: piece })));
      }
      if (hangs) {
        // Let go of the way a connection is: the reader sees the stream fail
        // rather than end, which is what an abort looks like from inside it.
        signal?.addEventListener("abort", () => {
          controller.error(
            Object.assign(new Error("let go of"), { name: "AbortError" }),
          );
        });
        return;
      }
      controller.enqueue(
        encoder.encode(
          frame("done", {
            status: "succeeded",
            outputs: [],
            ...answer.closing,
          }),
        ),
      );
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function route(url: string, init?: RequestInit): Response {
  if (url === "/api/v1/config") return json(config());
  if (url === "/api/health") return json({ status: "ok" });
  if (url === "/api/v1/recent-projects") {
    return json([
      {
        id: "recent-1",
        name: "Golden Fixture",
        path: "/tmp/golden",
        lastOpened: "2026-01-01T00:00:00.000Z",
      },
    ]);
  }
  if (url === "/api/v1/models") return json(providers());
  if (url === "/api/v1/projects/open") {
    return json({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
  }
  if (url === "/api/v1/projects/current/commands") {
    return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
  }
  if (url === "/api/v1/generate/text" && init?.method === "POST") {
    asks.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return streaming(init.signal);
  }
  return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  asks.length = 0;
  answer = { pieces: [], closing: {} };
  hangs = false;
  executors = ["provider"];
  offersText = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((input, init) =>
    Promise.resolve(route(String(input), init as RequestInit)),
  );
  localStorage.clear();
  useToolPrefs.setState({
    shown: [...BAR_ENTRIES],
    cropRatio: null,
    grid: null,
  });
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [], config: null });
  useModelStore.setState({ view: null, error: null });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    pictureTool: null,
    promptPanel: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Opens the reading-back dialog over the picture the fixture holds. */
async function openDescribe(): Promise<HTMLElement> {
  const ids = goldenNodeIds();
  render(<App />);
  fireEvent.click(await screen.findByText("Golden Fixture"));
  fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
  await screen.findByTestId("canvas-tab-Canvas 1");
  act(() => {
    useEditorStore
      .getState()
      .setSelection({ nodeIds: [ids.image], edgeIds: [] });
  });
  fireEvent.click(
    within(await screen.findByTestId("node-action-bar")).getByRole("button", {
      name: "Describe",
    }),
  );
  return screen.getByTestId("describe-dialog");
}

/** Lets whatever a submit started finish arriving. */
async function settle() {
  await act(async () => {});
  await act(async () => {});
}

function askButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: /Ask|Reading/ });
}

/** Rewrites the question the dialog came up with. */
function rewrite(dialog: HTMLElement, words: string) {
  fireEvent.change(
    within(dialog).getByRole("textbox", {
      name: "What to ask about the picture",
    }),
    { target: { value: words } },
  );
}

function errorsIn(dialog: HTMLElement): string {
  return [...dialog.querySelectorAll(".dialog-error")]
    .map((node) => node.textContent ?? "")
    .join(" ");
}

/** The words filed on the canvas, and the node they were filed on. */
function filedWords() {
  const canvas = useProjectStore.getState().moka!.canvas[0];
  return canvas.nodes.filter((node) => node.title === "Words for lake.png");
}

function contentOf(node: { data: unknown }): string {
  return (node.data as { content?: string }).content ?? "";
}

describe("reading a picture back as words", () => {
  it("opens over the picture with a question ready and spends nothing yet", async () => {
    const dialog = await openDescribe();
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Describe — lake.png",
    );
    expect(
      within(dialog).getByRole("textbox", {
        name: "What to ask about the picture",
      }),
    ).toHaveProperty(
      "value",
      "Describe this picture as the prompt that would make it.",
    );
    expect(dialog.textContent).toContain("it costs what an ask costs");
    expect(dialog.textContent).toContain(
      "Asked through Example Reader as reader-1",
    );
    expect(askButton(dialog)).toHaveProperty("disabled", false);
    // Nothing has been spent by opening it, and it is not the dialog that asks
    // for numbers: what this one asks for is a question.
    expect(asks).toEqual([]);
    expect(screen.queryByTestId("picture-tool-dialog")).toBeNull();
  });

  it("sends the picture beside the question, framed as a description", async () => {
    const ids = goldenNodeIds();
    answer = {
      pieces: ["A stone jetty ", "running out into the water"],
      closing: { text: "A stone jetty running out into the water" },
    };
    const dialog = await openDescribe();
    rewrite(dialog, "What would have made this picture?");

    await act(async () => {
      fireEvent.submit(dialog);
    });
    await settle();

    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      capability: "text",
      model: "reader",
      prompt: "What would have made this picture?",
      // The picture travels as a reference rather than as the thing to be
      // edited: nothing here is asking for a new one.
      inputs: [{ role: "reference", assetId: ids.assetImage }],
      params: { stream: true },
    });
    // Framed rather than left to the standing instruction for written answers,
    // which is about how to answer and not about what this ask wants.
    expect(String(asks[0].system)).toContain(
      "description of the picture alone",
    );
  });

  it("files the answer as a text node wired into the picture's prompt", async () => {
    const ids = goldenNodeIds();
    answer = {
      pieces: ["A stone jetty at dusk"],
      closing: { text: "A stone jetty at dusk" },
    };
    const dialog = await openDescribe();

    await act(async () => {
      fireEvent.submit(dialog);
    });
    await settle();

    expect(screen.queryByTestId("describe-dialog")).toBeNull();
    const [words] = filedWords();
    expect(words.kind).toBe("text");
    // The whole of the acceptance: something was said, and it is on the canvas.
    expect(contentOf(words)).toBe("A stone jetty at dusk");
    // Where an input comes from, beside the picture it describes.
    expect(words.bounds).toMatchObject({
      x: -320 - 80 - DEFAULT_NODE_WIDTH,
      y: 160,
    });

    const canvas = useProjectStore.getState().moka!.canvas[0];
    const wire = canvas.edges.find((edge) => edge.source.nodeId === words.id);
    expect(wire?.source.portId).toBe("out");
    expect(wire?.target).toEqual({ nodeId: ids.image, portId: "prompt" });
    // The picture itself is left as it was: what a model guessed is beside it,
    // not inside it.
    expect(canvas.nodes.find((node) => node.id === ids.image)?.data).toEqual({
      assetId: ids.assetImage,
    });

    // The words are what a reader wants next, so they are what is selected.
    expect(useEditorStore.getState().selection.nodeIds).toEqual([words.id]);
    expect(useEditorStore.getState().announcement).toContain("lake.png");
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    // Nothing was uploaded to make it: the answer is words and the words are in
    // the document.
    expect(useProjectStore.getState().moka!.resources.images).toHaveLength(1);
  });

  it("puts a second reading below the first and leaves the first wired", async () => {
    answer = {
      pieces: ["A first reading"],
      closing: { text: "A first reading" },
    };
    const first = await openDescribe();
    await act(async () => {
      fireEvent.submit(first);
    });
    await settle();

    answer = {
      pieces: ["A second reading"],
      closing: { text: "A second reading" },
    };
    const ids = goldenNodeIds();
    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.image], edgeIds: [] });
    });
    fireEvent.click(
      within(await screen.findByTestId("node-action-bar")).getByRole("button", {
        name: "Describe",
      }),
    );
    const second = screen.getByTestId("describe-dialog");
    await act(async () => {
      fireEvent.submit(second);
    });
    await settle();

    const [one, two] = filedWords();
    expect(contentOf(one)).toBe("A first reading");
    expect(contentOf(two)).toBe("A second reading");
    // Below the first rather than on top of it, so the order reads.
    expect(two.bounds.y - one.bounds.y).toBe(CASCADE_DROP_OFFSET);
    expect(two.bounds.x).toBe(one.bounds.x);

    // A prompt takes as many wires as it is given, so both readings are still
    // feeding it and neither took the other over.
    const canvas = useProjectStore.getState().moka!.canvas[0];
    expect(
      canvas.edges
        .filter(
          (edge) =>
            edge.target.nodeId === ids.image && edge.target.portId === "prompt",
        )
        .map((edge) => edge.source.nodeId)
        .sort(),
    ).toEqual([one.id, two.id].sort());
  });

  it("files the whole answer rather than the pieces it was shown as", async () => {
    // A stream that ends without an aggregate is one the pieces have to stand
    // in for: what was shown is what was said.
    answer = { pieces: ["A jetty", " at dusk"], closing: {} };
    const dialog = await openDescribe();
    await act(async () => {
      fireEvent.submit(dialog);
    });
    await settle();

    expect(contentOf(filedWords()[0])).toBe("A jetty at dusk");
  });

  it("keeps a long answer inside what a text node may hold", async () => {
    const long = "a".repeat(MAX_TEXT_CONTENT_LENGTH + 500);
    answer = { pieces: [long], closing: { text: long } };
    const dialog = await openDescribe();
    await act(async () => {
      fireEvent.submit(dialog);
    });
    await settle();

    // Cut rather than refused: the answer is still the answer, and a document
    // that would not take it would leave nothing filed at all.
    expect(contentOf(filedWords()[0])).toHaveLength(MAX_TEXT_CONTENT_LENGTH);
  });

  it("says so and files nothing when the answer comes back empty", async () => {
    answer = { pieces: [], closing: { text: "   " } };
    const dialog = await openDescribe();
    await act(async () => {
      fireEvent.submit(dialog);
    });
    await settle();

    expect(errorsIn(dialog)).toContain("Nothing came back to file");
    expect(screen.getByTestId("describe-dialog")).toBeTruthy();
    expect(filedWords()).toEqual([]);
    expect(useProjectStore.getState().moka!.canvas[0].nodes).toHaveLength(4);
  });

  it("says what a model refused, in its own words", async () => {
    answer = {
      pieces: [],
      closing: {
        error: {
          code: "PROVIDER_BAD_REQUEST",
          message: "this model cannot see a picture",
          retryable: false,
        },
      },
    };
    const dialog = await openDescribe();
    await act(async () => {
      fireEvent.submit(dialog);
    });
    await settle();

    expect(errorsIn(dialog)).toContain("this model cannot see a picture");
    expect(filedWords()).toEqual([]);
    expect(askButton(dialog)).toHaveProperty("disabled", false);
  });

  it("shows an answer while it arrives, and lets go of it on Escape", async () => {
    hangs = true;
    answer = { pieces: ["A stone jetty"], closing: {} };
    const dialog = await openDescribe();

    await act(async () => {
      fireEvent.submit(dialog);
    });
    await settle();
    expect(screen.getByTestId("describe-answer").textContent).toBe(
      "A stone jetty",
    );

    // Still arriving, so Escape lets go of the answer and keeps the words that
    // got that far on screen rather than closing over them.
    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(screen.getByTestId("describe-dialog")).toBeTruthy();
    expect(screen.getByTestId("describe-answer").textContent).toBe(
      "A stone jetty",
    );
    expect(askButton(dialog)).toHaveProperty("disabled", false);
    expect(filedWords()).toEqual([]);

    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => {});
    expect(screen.queryByTestId("describe-dialog")).toBeNull();
  });

  it("refuses an empty question rather than asking one", async () => {
    const dialog = await openDescribe();
    rewrite(dialog, "   ");
    expect(errorsIn(dialog)).toContain("Say what to ask about the picture");
    expect(askButton(dialog)).toHaveProperty("disabled", true);
    await act(async () => {
      fireEvent.submit(dialog);
    });
    expect(asks).toEqual([]);
  });
});

describe("saying when there is nothing to ask through", () => {
  it("refuses where no model is chosen for written answers", async () => {
    offersText = false;
    const dialog = await openDescribe();
    expect(errorsIn(dialog)).toContain("No text model is configured yet");
    expect(askButton(dialog)).toHaveProperty("disabled", true);
    await act(async () => {
      fireEvent.submit(dialog);
    });
    expect(asks).toEqual([]);
  });

  it("refuses where the deployment cannot reach a provider at all", async () => {
    executors = ["noop"];
    const dialog = await openDescribe();
    expect(errorsIn(dialog)).toContain(
      "This deployment is offline, so nothing can be generated",
    );
    expect(askButton(dialog)).toHaveProperty("disabled", true);
  });
});
