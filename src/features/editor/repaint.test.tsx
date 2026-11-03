// @vitest-environment jsdom
import { resetUiPrefs } from "../../shared/prefs/prefsData";
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
import type { SelfCheckReport } from "../../shared/domain";
import { CASCADE_DROP_OFFSET, DEFAULT_NODE_WIDTH } from "../../shared/domain";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { useModelStore } from "../settings/modelStore";
import {
  closesOutline,
  drawMarks,
  drawn,
  maskName,
  marksAnything,
  newMark,
  SOFTEST_PIXELS,
  traceMask,
  type Mark,
} from "./canvas/repaint";
import { useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";
import { BAR_ENTRIES, useToolPrefs } from "./stores/toolPrefs";

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
  capabilities: { mode: "web", executors: ["noop"], assetCategories: [] },
};

const RECENTS = [
  {
    id: "recent-1",
    name: "Golden Fixture",
    path: "/tmp/golden",
    lastOpened: "2026-01-01T00:00:00.000Z",
  },
];

/** Every mask the dialog handed over, by the name and type it was handed as. */
const filed: { name: string; type: string; bytes: number }[] = [];

const fetchMock = vi.fn<typeof fetch>();

/**
 * The converter registry as the server reports it: what each image protocol
 * declares about itself, which is what the dialog reads to word its note.
 */
const REGISTRY = {
  image: {
    openaiImages: {
      script: "image/openai-images.lua",
      displayName: "OpenAI-compatible · Images API",
      urlExample: "https://api.example.com/v1/images/generations",
      order: 10,
      features: { mask: true },
    },
    bailianImage: {
      script: "image/bailian-image.lua",
      displayName: "Alibaba Cloud · Bailian Image (Wan)",
      urlExample: "https://example.com/bailian",
      order: 20,
    },
  },
};

/** Which protocol the image model answers with, so a test can pick the degrade. */
let protocol: string | null = "openaiImages";

function providers(): ModelsView {
  return {
    version: 1,
    revision: 7,
    models:
      protocol === null
        ? []
        : [
            {
              id: "painter",
              category: "image",
              protocol,
              url: "https://api.example.com/v1/images/generations",
              model: "painter-1",
              displayName: "Example Painter",
              enabled: true,
              apiKey: { set: true, masked: "sk-…abcd" },
            },
          ],
    defaults: {
      text: null,
      image: protocol === null ? null : "painter",
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

function route(selfCheck: SelfCheckReport) {
  return (url: string, init?: RequestInit): Response => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url === "/api/v1/config") return json(CONFIG);
    if (url === "/api/health") return json({ status: "ok" });
    if (url === "/api/v1/recent-projects") return json(RECENTS);
    if (url === "/api/v1/models") return json(providers());
    if (url === "/api/v1/converter/protocols") {
      return json({ protocols: REGISTRY });
    }
    if (url === "/api/v1/projects/open") {
      return json({
        root: "/tmp/golden",
        moka: buildGoldenMokaFile(),
        selfCheck,
      });
    }
    if (url === "/api/v1/projects/current/commands") {
      return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
    }
    if (url === "/api/v1/projects/current/assets" && init?.method === "POST") {
      const file = (init.body as FormData).get("file") as File;
      filed.push({ name: file.name, type: file.type, bytes: file.size });
      const id = `mask-${filed.length}`;
      return json(
        {
          entry: {
            id,
            name: file.name,
            path: `assets/images/${id}.png`,
            mime: "image/png",
            bytes: file.size,
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
          revision: 4,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        201,
      );
    }
    return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
  };
}

/** One thing a drawing was asked to do, with the state it was asked under. */
interface Call {
  name: string;
  args: unknown[];
  alpha: number;
  width: number;
  mode: string;
  fill: string;
}

/**
 * A sheet that writes down what was asked of it instead of drawing.
 *
 * Nothing here has pixels to look at, and what a mark is is the calls it makes
 * rather than the smudge they leave, so the calls are kept and read back.
 */
function makeSheet(pixels: () => Uint8ClampedArray) {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "",
    strokeStyle: "",
    lineJoin: "",
    lineCap: "",
    lineWidth: 1,
  };
  const note =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({
        name,
        args,
        alpha: state.globalAlpha as number,
        width: state.lineWidth as number,
        mode: state.globalCompositeOperation as string,
        fill: state.fillStyle as string,
      });
    };
  for (const name of [
    "arc",
    "beginPath",
    "clearRect",
    "closePath",
    "fill",
    "fillRect",
    "lineTo",
    "moveTo",
    "rect",
    "restore",
    "save",
    "stroke",
  ]) {
    state[name] = note(name);
  }
  state.getImageData = () => ({ data: pixels(), width: 1, height: 1 });
  return { calls, context: state as unknown as CanvasRenderingContext2D };
}

/** The pixels an export is asked about, which is what decides whether it goes. */
let exported = new Uint8ClampedArray([255, 255, 255, 255]);
/** What the export was written out as, if it got that far. */
const written: string[] = [];
const shared = makeSheet(() => exported);

beforeEach(() => {
  filed.length = 0;
  written.length = 0;
  protocol = "openaiImages";
  exported = new Uint8ClampedArray([255, 255, 255, 255]);
  shared.calls.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ revision: 9, updatedAt: "2026-01-02" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  // A window with no raster in it still has to answer, or the dialog can neither
  // show the marking nor write one out.
  HTMLCanvasElement.prototype.getContext = (() =>
    shared.context) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toBlob = function (done, type) {
    written.push(String(type));
    done?.call(
      this,
      new Blob([new Uint8Array([9, 8, 7])], { type: String(type) }),
    );
  };
  HTMLCanvasElement.prototype.setPointerCapture = () => {};
  resetUiPrefs();
  useToolPrefs.setState({
    shown: [...BAR_ENTRIES],
    cropRatio: null,
    grid: null,
  });
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
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

async function openGolden(
  selfCheck: SelfCheckReport = { ok: true, issues: [] },
) {
  fetchMock.mockImplementation((input, init) =>
    Promise.resolve(route(selfCheck)(String(input), init as RequestInit)),
  );
  render(<App />);
  fireEvent.click(await screen.findByText("Golden Fixture"));
  fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
  await screen.findByTestId("canvas-tab-Canvas 1");
}

/**
 * Opens the marking dialog over the picture the fixture holds, with the picture
 * already read: a browser learns its size from the file, and nothing here is
 * loading one.
 */
async function openRepaint(width = 64, height = 64) {
  const ids = goldenNodeIds();
  await openGolden();
  act(() => {
    useEditorStore
      .getState()
      .setSelection({ nodeIds: [ids.image], edgeIds: [] });
  });
  // The bar arrives with the board, which is a chunk that may still be on its
  // way in even though the tab strip is up, so it is waited for rather than
  // read the instant it is asked about.
  fireEvent.click(
    within(await screen.findByTestId("node-action-bar")).getByRole("button", {
      name: "Repaint",
    }),
  );
  const dialog = screen.getByTestId("repaint-dialog");
  const picture = dialog.querySelector("img");
  if (!picture) throw new Error("the dialog is not showing a picture");
  Object.defineProperty(picture, "naturalWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(picture, "naturalHeight", {
    value: height,
    configurable: true,
  });
  await act(async () => {
    fireEvent.load(picture);
  });
  return dialog;
}

/**
 * The sheet a region is marked on, told where it is.
 *
 * Nothing here is laid out, so the box the pointer is mapped through would be
 * empty and every mark would be refused. It is given instead: a hundred wide and
 * fifty tall, which is not the picture's own shape, so a mark that came out in
 * the picture's pixels could only have been mapped.
 */
function sheetOf(dialog: HTMLElement): HTMLElement {
  const sheet = dialog.querySelector("canvas");
  if (!sheet) throw new Error("the dialog is not showing a sheet");
  sheet.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 50,
      width: 100,
      height: 50,
      toJSON: () => ({}),
    }) as DOMRect;
  return sheet;
}

/** Drags across the sheet, in the client positions a real drag reports. */
async function paint(sheet: HTMLElement, across: [number, number][]) {
  for (const [index, [x, y]] of across.entries()) {
    const move = index === 0 ? fireEvent.pointerDown : fireEvent.pointerMove;
    await act(async () => {
      move(sheet, { clientX: x, clientY: y, pointerId: 1 });
    });
  }
  await act(async () => {
    fireEvent.pointerUp(sheet, { pointerId: 1 });
  });
}

/** Clicks round a shape and back to where it started. */
async function click(sheet: HTMLElement, x: number, y: number) {
  await act(async () => {
    fireEvent.pointerDown(sheet, { clientX: x, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: x, clientY: y, pointerId: 1 });
  });
}

function say(dialog: HTMLElement, words: string) {
  fireEvent.change(
    within(dialog).getByRole("textbox", {
      name: "What the marked part should become",
    }),
    { target: { value: words } },
  );
}

function fileButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: /File the mask|Filing/ });
}

function saidIn(dialog: HTMLElement, kind: string): string {
  return [...dialog.querySelectorAll(`.${kind}`)]
    .map((node) => node.textContent ?? "")
    .join(" ");
}

/** A brush stroke across the middle, which is the least a mark can be. */
function stroke(radius = 10, softness = 0, closed = false): Mark {
  return {
    ...newMark("brush", radius, softness),
    points: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ],
    closed,
  };
}

describe("what a mark is", () => {
  it("counts an empty drag as nothing drawn", () => {
    expect(drawn(newMark("brush", 10, 0))).toBe(false);
    // A click is a dot, and a dot is something.
    expect(
      drawn({ ...newMark("brush", 10, 0), points: [{ x: 1, y: 1 }] }),
    ).toBe(true);
    // A box is two corners, and two corners in the same place are no box.
    const corners = { x: 4, y: 4 };
    expect(
      drawn({ ...newMark("box", 10, 0), points: [corners, corners] }),
    ).toBe(false);
    expect(
      drawn({
        ...newMark("box", 10, 0),
        points: [corners, { x: 5, y: 4 }],
      }),
    ).toBe(true);
    // An outline is a shape once it is closed, and only a way of going until then.
    const round = {
      ...newMark("outline", 10, 0),
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    };
    expect(drawn(round)).toBe(false);
    expect(drawn({ ...round, closed: true })).toBe(true);
  });

  it("draws a soft edge as passes that widen and faint", () => {
    const { context, calls } = makeSheet(() => exported);
    drawMarks(context, [stroke(10, 100)]);
    const strokes = calls.filter((call) => call.name === "stroke");
    // A fade is several drawings of the same mark rather than a blur of one, so
    // the middle stays white and only the rim gives way.
    expect(strokes.map((call) => call.alpha)).toEqual([
      1,
      0.25,
      1 / 6,
      0.125,
      0.1,
    ]);
    expect(strokes.map((call) => call.width)).toEqual([20, 25, 30, 35, 40]);
    expect(strokes.every((call) => call.mode === "source-over")).toBe(true);
  });

  it("draws a hard edge once", () => {
    const { context, calls } = makeSheet(() => exported);
    drawMarks(context, [stroke(10, 0)]);
    const strokes = calls.filter((call) => call.name === "stroke");
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({ alpha: 1, width: 20 });
  });

  it("takes the destination with it when erasing", () => {
    const { context, calls } = makeSheet(() => exported);
    drawMarks(context, [
      stroke(),
      {
        ...newMark("erase", 10, 0),
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
        ],
      },
    ]);
    const strokes = calls.filter((call) => call.name === "stroke");
    // An erase that painted grey over white would leave a smear where the mark
    // was, so it lets the destination go instead of drawing over it.
    expect(strokes.map((call) => call.mode)).toEqual([
      "source-over",
      "destination-out",
    ]);
  });

  it("fills a lone click rather than stroking a line of no length", () => {
    const { context, calls } = makeSheet(() => exported);
    drawMarks(context, [
      { ...newMark("brush", 8, 0), points: [{ x: 4, y: 4 }] },
    ]);
    expect(calls.map((call) => call.name)).toEqual([
      "save",
      "beginPath",
      "arc",
      "fill",
      "restore",
    ]);
  });

  it("keeps a rectangle's edges and fades outside them", () => {
    const { context, calls } = makeSheet(() => exported);
    drawMarks(context, [
      {
        ...newMark("box", 10, 100),
        points: [
          { x: 30, y: 20 },
          { x: 0, y: 0 },
        ],
      },
    ]);
    // Held by its two corners in either order, and drawn from the near one.
    expect(calls.find((call) => call.name === "rect")?.args).toEqual([
      0, 0, 30, 20,
    ]);
    const shapes = calls.filter(
      (call) => call.name === "fill" || call.name === "stroke",
    );
    // Filled where it was drawn, then stroked around itself ever wider, so the
    // shape stays a shape and only its rim gives way.
    expect(shapes.map((call) => call.name)).toEqual([
      "fill",
      "stroke",
      "stroke",
      "stroke",
      "stroke",
    ]);
    expect(shapes[0].width).toBe(0);
    expect(shapes[1].width).toBe(2 * 0.25 * SOFTEST_PIXELS);
  });

  it("strokes an outline until it is closed, then fills it", () => {
    const round = {
      ...newMark("outline", 10, 0),
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    };
    const open = makeSheet(() => exported);
    drawMarks(open.context, [round]);
    expect(open.calls.map((call) => call.name)).toEqual([
      "save",
      "beginPath",
      "moveTo",
      "lineTo",
      "lineTo",
      "stroke",
      "restore",
    ]);

    const shut = makeSheet(() => exported);
    drawMarks(shut.context, [{ ...round, closed: true }]);
    expect(shut.calls.map((call) => call.name)).toEqual([
      "save",
      "beginPath",
      "moveTo",
      "lineTo",
      "lineTo",
      "closePath",
      "fill",
      "restore",
    ]);
  });

  it("lays the ground black before drawing anything white on it", () => {
    const { context, calls } = makeSheet(() => exported);
    traceMask(context, [stroke(4)], { width: 8, height: 6 });
    const ground = calls.find((call) => call.name === "fillRect");
    expect(ground?.args).toEqual([0, 0, 8, 6]);
    expect(ground).toMatchObject({ fill: "#000000", mode: "source-over" });
    // At the picture's own size, and before the marks rather than after them.
    expect(calls.findIndex((call) => call.name === "fillRect")).toBeLessThan(
      calls.findIndex((call) => call.name === "stroke"),
    );
  });

  it("asks the pixels whether anything is marked, not the list", () => {
    const blank = { data: new Uint8ClampedArray(8) } as unknown as ImageData;
    expect(marksAnything(blank)).toBe(false);
    const marked = {
      data: new Uint8ClampedArray([0, 0, 0, 255, 200, 200, 200, 255]),
    } as unknown as ImageData;
    expect(marksAnything(marked)).toBe(true);
    // White that nothing can see marks nothing.
    const hidden = {
      data: new Uint8ClampedArray([255, 255, 255, 0]),
    } as unknown as ImageData;
    expect(marksAnything(hidden)).toBe(false);
  });

  it("names a mask after the picture it covers", () => {
    expect(maskName("lake.png")).toBe("lake-mask.png");
    expect(maskName("a.long.name.jpg")).toBe("a.long.name-mask.png");
    expect(maskName("no-extension")).toBe("no-extension-mask.png");
  });

  it("closes an outline on a click near where it started", () => {
    const round = {
      ...newMark("outline", 4, 0),
      points: [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
      ],
    };
    // Two clicks are a line rather than a shape, so there is nothing to close.
    expect(
      closesOutline(
        { ...round, points: round.points.slice(0, 2) },
        { x: 0, y: 0 },
      ),
    ).toBe(false);
    expect(closesOutline(round, { x: 40, y: 40 })).toBe(false);
    expect(closesOutline(round, { x: 6, y: -6 })).toBe(true);
    // The reach never falls below a click, however narrow the brush is.
    expect(closesOutline(round, { x: 9, y: 9 })).toBe(false);
  });
});

describe("marking a region of a picture", () => {
  it("opens over the picture and asks for a mark before anything else", async () => {
    const dialog = await openRepaint();
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Repaint — lake.png",
    );
    expect(
      within(
        within(dialog).getByRole("group", { name: "How the region is marked" }),
      )
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Brush", "Erase", "Rectangle", "Outline"]);
    expect(dialog.textContent).toContain(
      "The mask will be 64 × 64 pixels — the size of the picture itself",
    );
    expect(dialog.textContent).toContain("lake-mask.png");
    expect(saidIn(dialog, "dialog-error")).toContain(
      "Mark the part of the picture that may change",
    );
    expect(fileButton(dialog)).toHaveProperty("disabled", true);
    // It is not the parameter dialog: a region here is drawn rather than typed.
    expect(screen.queryByTestId("picture-tool-dialog")).toBeNull();
  });

  it("marks in the picture's pixels and asks for words once something is marked", async () => {
    const dialog = await openRepaint();
    const sheet = sheetOf(dialog);
    await paint(sheet, [
      [10, 10],
      [60, 20],
      [80, 40],
    ]);
    // The pointer was mapped into the picture's own pixels: a hundred across and
    // fifty down on screen is sixty-four either way in the file.
    expect(shared.calls.some((call) => call.name === "lineTo")).toBe(true);
    const moved = shared.calls.filter((call) => call.name === "lineTo");
    expect(moved.at(-1)?.args).toEqual([51.2, 51.2]);
    expect(saidIn(dialog, "dialog-error")).toContain(
      "Say what the marked part should become",
    );
    expect(fileButton(dialog)).toHaveProperty("disabled", true);

    say(dialog, "A stone jetty running out into the water");
    expect(saidIn(dialog, "dialog-error")).toBe("");
    expect(fileButton(dialog)).toHaveProperty("disabled", false);
  });

  it("files the mask to the left and wires it into the mask port", async () => {
    const ids = goldenNodeIds();
    const dialog = await openRepaint();
    await paint(sheetOf(dialog), [
      [10, 10],
      [60, 40],
    ]);
    say(dialog, "A stone jetty running out into the water");

    await act(async () => {
      fireEvent.submit(dialog);
    });

    expect(filed).toEqual([
      { name: "lake-mask.png", type: "image/png", bytes: 3 },
    ]);
    expect(written).toEqual(["image/png"]);
    expect(screen.queryByTestId("repaint-dialog")).toBeNull();

    const canvas = useProjectStore.getState().moka!.canvas[0];
    const mask = canvas.nodes.find((node) => node.title === "lake-mask.png");
    expect(mask).toBeTruthy();
    // Where an input comes from, and stepped down past the masks already worn.
    expect(mask!.bounds).toMatchObject({
      x: -320 - 80 - DEFAULT_NODE_WIDTH,
      y: 160,
    });
    expect(
      useProjectStore
        .getState()
        .moka!.resources.images.map((entry) => entry.id),
    ).toEqual([ids.assetImage, "mask-1"]);

    const wire = canvas.edges.find((edge) => edge.target.nodeId === ids.image);
    expect(wire?.source).toEqual({ nodeId: mask!.id, portId: "out" });
    // The port is the whole of what makes it a mask: the same picture arriving
    // anywhere else is just another reference.
    expect(wire?.target.portId).toBe("mask");

    const held = canvas.nodes.find((node) => node.id === ids.image)?.data as {
      generation?: Record<string, unknown>;
    };
    expect(held.generation).toMatchObject({
      capability: "image",
      mode: "edit",
      prompt: "A stone jetty running out into the water",
      // Along a wire, or the mask arrives as an ordinary picture and the region
      // marked on it means nothing.
      inputMode: "upstream",
    });

    // The ask is prepared and the reader is put where the run can be seen, rather
    // than spent from a dialog they have already left.
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.image]);
    expect(useEditorStore.getState().promptPanel?.nodeId).toBe(ids.image);
    expect(useEditorStore.getState().announcement).toContain("lake.png");
    // One undo step for the mask, its wire and the ask it went with.
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });

  it("takes the mask port over when a region is marked again", async () => {
    const ids = goldenNodeIds();
    const dialog = await openRepaint();
    await paint(sheetOf(dialog), [
      [10, 10],
      [60, 40],
    ]);
    say(dialog, "A first try");
    await act(async () => {
      fireEvent.submit(dialog);
    });

    const second = await openRepaintAgain();
    await paint(sheetOf(second), [
      [10, 40],
      [60, 10],
    ]);
    say(second, "A second try");
    await act(async () => {
      fireEvent.submit(second);
    });

    const canvas = useProjectStore.getState().moka!.canvas[0];
    const masks = canvas.nodes.filter((node) => node.title === "lake-mask.png");
    expect(masks).toHaveLength(2);
    // Below the one it replaces rather than on top of it, so the order reads.
    expect(masks[1].bounds.y - masks[0].bounds.y).toBe(CASCADE_DROP_OFFSET);

    // A picture wears one mask: the port takes a single wire, so the second
    // attempt took it over and the first mask is left as the picture it is.
    const wires = canvas.edges.filter(
      (edge) =>
        edge.target.nodeId === ids.image && edge.target.portId === "mask",
    );
    expect(wires).toHaveLength(1);
    expect(wires[0].source.nodeId).toBe(masks[1].id);
    expect(
      useProjectStore
        .getState()
        .moka!.resources.images.map((entry) => entry.id),
    ).toEqual([ids.assetImage, "mask-1", "mask-2"]);
    const held = canvas.nodes.find((node) => node.id === ids.image)?.data as {
      generation?: { prompt: string };
    };
    expect(held.generation?.prompt).toBe("A second try");
  });

  it("refuses a marking that leaves nothing white", async () => {
    const dialog = await openRepaint();
    await paint(sheetOf(dialog), [
      [10, 10],
      [60, 40],
    ]);
    say(dialog, "A stone jetty");
    // A region painted and then erased all over leaves a list with something in
    // it and a picture with nothing, and it is the picture that gets sent.
    exported = new Uint8ClampedArray(4);

    await act(async () => {
      fireEvent.submit(dialog);
    });

    expect(filed).toEqual([]);
    expect(screen.getByTestId("repaint-dialog").textContent).toContain(
      "Nothing is left marked",
    );
  });

  it("takes marks back one at a time, and all at once", async () => {
    const dialog = await openRepaint();
    const sheet = sheetOf(dialog);
    const undo = within(dialog).getByRole("button", {
      name: "Undo the last mark",
    });
    expect(undo).toHaveProperty("disabled", true);

    await paint(sheet, [
      [10, 10],
      [60, 20],
    ]);
    say(dialog, "A stone jetty");
    expect(fileButton(dialog)).toHaveProperty("disabled", false);

    await paint(sheet, [
      [20, 40],
      [70, 45],
    ]);
    await act(async () => {
      fireEvent.click(undo);
    });
    // The second mark is gone and the first still carries the ask.
    expect(fileButton(dialog)).toHaveProperty("disabled", false);

    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Clear the marking" }),
      );
    });
    expect(saidIn(dialog, "dialog-error")).toContain(
      "Mark the part of the picture that may change",
    );
    expect(undo).toHaveProperty("disabled", true);
  });

  it("closes on Escape, and lets go of an outline first", async () => {
    const ids = goldenNodeIds();
    const dialog = await openRepaint();
    const sheet = sheetOf(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Outline" }));
    await click(sheet, 10, 10);
    await click(sheet, 60, 10);
    await click(sheet, 60, 40);

    // Still being clicked round, so Escape lets go of the shape and stays.
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => {});
    expect(screen.getByTestId("repaint-dialog")).toBeTruthy();
    expect(saidIn(dialog, "dialog-error")).toContain(
      "Mark the part of the picture that may change",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => {});
    expect(screen.queryByTestId("repaint-dialog")).toBeNull();
    expect(useProjectStore.getState().moka!.canvas[0].nodes).toHaveLength(4);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.image]);
  });

  it("closes an outline by clicking where it started, and by Enter", async () => {
    const dialog = await openRepaint();
    const sheet = sheetOf(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Outline" }));
    await click(sheet, 10, 10);
    await click(sheet, 60, 10);
    await click(sheet, 60, 40);
    say(dialog, "A stone jetty");
    // An outline still open is not a region yet.
    expect(saidIn(dialog, "dialog-error")).toContain(
      "Mark the part of the picture that may change",
    );

    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => {});
    expect(saidIn(dialog, "dialog-error")).toBe("");
    expect(fileButton(dialog)).toHaveProperty("disabled", false);
  });
});

/**
 * Opens the marking dialog a second time over the same picture, the way a reader
 * who was not happy with the first mask would.
 */
async function openRepaintAgain() {
  const ids = goldenNodeIds();
  act(() => {
    useEditorStore
      .getState()
      .setSelection({ nodeIds: [ids.image], edgeIds: [] });
  });
  fireEvent.click(
    within(await screen.findByTestId("node-action-bar")).getByRole("button", {
      name: "Repaint",
    }),
  );
  const dialog = screen.getByTestId("repaint-dialog");
  const picture = dialog.querySelector("img");
  if (!picture) throw new Error("the dialog is not showing a picture");
  Object.defineProperty(picture, "naturalWidth", {
    value: 64,
    configurable: true,
  });
  Object.defineProperty(picture, "naturalHeight", {
    value: 64,
    configurable: true,
  });
  await act(async () => {
    fireEvent.load(picture);
  });
  return dialog;
}

describe("saying whether the region can be held to", () => {
  it.each<[string | null, string, string]>([
    [
      "openaiImages",
      "dialog-note",
      "This model has a field of its own for a mask",
    ],
    // A protocol whose document declares no mask of its own, whichever
    // platform it belongs to.
    [
      "bailianImage",
      "dialog-error",
      "This model has no field of its own for a mask",
    ],
    // A shape no converter on this machine stands behind any more: what it
    // takes is unknown, so the cautious wording is the honest one.
    [
      "wanImageDraft",
      "dialog-error",
      "It travels as a second picture beside the words",
    ],
  ])("says it for the model that will be asked", async (which, kind, said) => {
    protocol = which;
    const dialog = await openRepaint();
    expect(saidIn(dialog, kind)).toContain(said);
  });

  it("says so when no model has been chosen at all", async () => {
    protocol = null;
    const dialog = await openRepaint();
    expect(saidIn(dialog, "dialog-note")).toContain("No model is chosen yet");
    expect(saidIn(dialog, "dialog-error")).not.toContain("second picture");
  });
});
