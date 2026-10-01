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
import { MAX_OPERATED_PIXELS, type SelfCheckReport } from "../../shared/domain";
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

/** Every ask the dialog sent, so a test can read back what was really asked. */
const asks: {
  tool: string;
  assetId: string;
  params: Record<string, unknown>;
}[] = [];

const fetchMock = vi.fn<typeof fetch>();

/**
 * What one tool answers with: a piece per division, and for a turn the words the
 * plate was made from, which is the part of the answer worth announcing.
 *
 * Each piece carries the mark of what made it, which is the tool and the picture
 * it worked on and nothing else: no run was started and no node asked for it.
 */
function reportFor(ask: (typeof asks)[number]) {
  const pieces =
    ask.tool === "split"
      ? Number(ask.params.rows) * Number(ask.params.cols)
      : 1;
  const entries = Array.from({ length: pieces }, (_, index) => ({
    id: `made-${index + 1}`,
    name: pieces === 1 ? "lake-cut.png" : `lake-piece-${index + 1}.png`,
    path: `assets/images/made-${index + 1}.png`,
    mime: "image/png",
    bytes: 512,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    provenance: {
      inputAssetIds: [ask.assetId],
      parameterSnapshot: {
        tool: ask.tool,
        sourceAssetId: ask.assetId,
        ...ask.params,
      },
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  }));
  return {
    entries,
    ...(ask.tool === "tilt"
      ? { prompt: "A lake seen from a low angle, the far shore tipped up" }
      : {}),
    revision: 4,
    updatedAt: "2026-01-01T00:00:02.000Z",
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
    if (url === "/api/v1/projects/current/tools" && init?.method === "POST") {
      const ask = JSON.parse(String(init.body)) as (typeof asks)[number];
      asks.push(ask);
      return json(reportFor(ask), 201);
    }
    return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
  };
}

beforeEach(() => {
  asks.length = 0;
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
  localStorage.clear();
  useToolPrefs.setState({
    shown: [...BAR_ENTRIES],
    cropRatio: null,
    grid: null,
  });
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    pictureTool: null,
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
  // A project with something wrong in it is stopped at a gate first, and the
  // editor is only reached by going through it.
  if (!selfCheck.ok) {
    await screen.findByRole("alertdialog");
    fireEvent.click(
      screen.getByRole("button", { name: "Open with missing assets" }),
    );
  }
  await screen.findByTestId("canvas-tab-Canvas 1");
}

async function selectPicture() {
  const ids = goldenNodeIds();
  await openGolden();
  act(() => {
    useEditorStore
      .getState()
      .setSelection({ nodeIds: [ids.image], edgeIds: [] });
  });
  // The bar was seen missing the instant after this on a loaded machine, so it
  // is waited for rather than read the same turn: what the tests are about is
  // the bar that arrives with the selection, not its exact commit.
  await screen.findByTestId("node-action-bar");
}

/**
 * Tells the dialog how big the picture is.
 *
 * A browser knows this from the file; nothing here is loading one, so the two
 * numbers are put where the dialog reads them and the load is announced.
 */
async function showPicture(dialog: HTMLElement, width: number, height: number) {
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
}

function openTool(label: string): HTMLElement {
  const bar = screen.getByTestId("node-action-bar");
  fireEvent.click(within(bar).getByRole("button", { name: label }));
  return screen.getByTestId("picture-tool-dialog");
}

function confirmOn(dialog: HTMLElement) {
  return within(dialog).getByRole("button", {
    name: /^(Crop|Split|Resample|Tilt)$/,
  });
}

describe("the tools offered on a picture node", () => {
  it("offers them on a picture and on nothing else", async () => {
    const ids = goldenNodeIds();
    await selectPicture();
    const bar = screen.getByTestId("node-action-bar");
    expect(bar.getAttribute("aria-label")).toBe(
      "Picture tools for Reference image",
    );
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Crop", "Split", "Resample", "Tilt", "Repaint", "Describe"]);

    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.text], edgeIds: [] });
    });
    expect(screen.queryByTestId("node-action-bar")).toBeNull();

    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.image, ids.text], edgeIds: [] });
    });
    expect(screen.queryByTestId("node-action-bar")).toBeNull();
  });

  it("says why a picture cannot be worked on instead of offering", async () => {
    const ids = goldenNodeIds();
    await openGolden({
      ok: false,
      issues: [
        {
          assetId: ids.assetImage,
          name: "lake.png",
          expectedPath: "assets/images/lake-00000000.png",
          reason: "missing",
          referencingNodes: [
            {
              canvasId: ids.canvasMain,
              nodeId: ids.image,
              title: "Reference image",
            },
          ],
        },
      ],
    });
    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.image], edgeIds: [] });
    });
    const bar = screen.getByTestId("node-action-bar");
    expect(bar.textContent).toContain(
      "The file is not in the project any more",
    );
    expect(within(bar).queryAllByRole("button")).toHaveLength(0);
  });

  it("offers only what the reader left switched on", async () => {
    await selectPicture();
    act(() => {
      useToolPrefs.getState().toggleShown("tilt");
      useToolPrefs.getState().toggleShown("resize");
    });
    const bar = screen.getByTestId("node-action-bar");
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Crop", "Split", "Repaint", "Describe"]);
    // Kept here rather than in the document: a bar somebody tidied stays tidied
    // without the tidying travelling with the project.
    expect(
      JSON.parse(localStorage.getItem("moka-canvas:picture-tools")!).shown,
    ).toEqual(["crop", "split", "repaint", "describe"]);
  });
});

describe("asking a tool what to do", () => {
  it("measures a cut in the picture's own pixels", async () => {
    await selectPicture();
    const dialog = openTool("Crop");
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Crop — lake.png",
    );
    await showPicture(dialog, 64, 64);
    expect(dialog.textContent).toContain("64 × 64 pixels");
    expect(dialog.textContent).toContain(
      "not in the size the node is drawn at",
    );

    // The region offered is the largest of the proportion showing, already
    // written out, rather than four empty fields to guess into.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "An exact region" }),
    );
    expect(
      within(dialog).getByRole("textbox", { name: "How far in" }),
    ).toHaveProperty("value", "0");
    expect(
      within(dialog).getByRole("textbox", { name: "How wide" }),
    ).toHaveProperty("value", "64");
    expect(
      within(dialog).getByRole("textbox", { name: "How tall" }),
    ).toHaveProperty("value", "64");
  });

  it("refuses a region that does not fit the picture", async () => {
    await selectPicture();
    const dialog = openTool("Crop");
    await showPicture(dialog, 64, 64);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "An exact region" }),
    );
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "How wide" }),
      {
        target: { value: "100" },
      },
    );
    expect(dialog.textContent).toContain(
      "A region is four whole numbers inside the picture, which is 64 by 64",
    );
    expect(confirmOn(dialog)).toHaveProperty("disabled", true);

    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "How wide" }),
      {
        target: { value: "" },
      },
    );
    expect(confirmOn(dialog)).toHaveProperty("disabled", true);
  });

  it("refuses a picture too big to work on", async () => {
    await selectPicture();
    const dialog = openTool("Crop");
    await showPicture(dialog, 7000, 7000);
    expect(dialog.textContent).toContain(MAX_OPERATED_PIXELS.toLocaleString());
    expect(dialog.textContent).toContain("make it smaller first");
    expect(confirmOn(dialog)).toHaveProperty("disabled", true);
  });

  it("refuses a turn that has not been turned, and takes one that has", async () => {
    const ids = goldenNodeIds();
    await selectPicture();
    const dialog = openTool("Tilt");
    expect(dialog.textContent).toContain("Nothing to turn yet");
    expect(confirmOn(dialog)).toHaveProperty("disabled", true);

    await showPicture(dialog, 64, 64);
    fireEvent.change(within(dialog).getByRole("slider", { name: "Turn" }), {
      target: { value: "12" },
    });
    expect(dialog.textContent).not.toContain("Nothing to turn yet");
    expect(confirmOn(dialog)).toHaveProperty("disabled", false);

    await act(async () => {
      fireEvent.submit(dialog);
    });
    expect(asks).toEqual([
      { tool: "tilt", assetId: ids.assetImage, params: { yaw: 12, pitch: 0 } },
    ]);
    // The words a turn reports are worth more than a count: they are what the
    // next ask made out of the plate is written against.
    expect(useEditorStore.getState().announcement).toContain("low angle");
  });

  it("closes on Escape and leaves the node alone", async () => {
    const ids = goldenNodeIds();
    await selectPicture();
    const dialog = openTool("Split");
    expect(dialog.textContent).toContain("Divides the picture into pieces");
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => {});
    expect(screen.queryByTestId("picture-tool-dialog")).toBeNull();
    expect(useProjectStore.getState().moka!.canvas[0].nodes).toHaveLength(4);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.image]);
  });
});

describe("what a tool leaves on the canvas", () => {
  it("files a cut to the right of its source and wires it up", async () => {
    const ids = goldenNodeIds();
    await selectPicture();
    const dialog = openTool("Crop");
    await showPicture(dialog, 64, 64);
    fireEvent.click(within(dialog).getByRole("button", { name: "16:9" }));

    await act(async () => {
      fireEvent.submit(dialog);
    });

    expect(asks).toEqual([
      { tool: "crop", assetId: ids.assetImage, params: { ratio: "16:9" } },
    ]);
    expect(screen.queryByTestId("picture-tool-dialog")).toBeNull();

    const canvas = useProjectStore.getState().moka!.canvas[0];
    const made = canvas.nodes.filter((node) => node.id !== ids.image);
    const fresh = made.find((node) => node.title === "lake-cut.png");
    expect(fresh).toBeTruthy();
    // Beside its source with room for the wire, and not on top of it.
    expect(fresh!.bounds).toMatchObject({ x: 40, y: 160 });
    expect(
      useProjectStore.getState().moka!.resources.images.map((e) => e.id),
    ).toEqual([ids.assetImage, "made-1"]);

    const wire = canvas.edges.find((edge) => edge.target.nodeId === fresh!.id);
    expect(wire?.source).toEqual({ nodeId: ids.image, portId: "out" });
    expect(wire?.target.portId).toBe("images");

    expect(useEditorStore.getState().selection.nodeIds).toEqual([fresh!.id]);
    expect(useEditorStore.getState().announcement).toContain("lake-cut.png");
    // The source is what it was: a tool files a new picture and never rewrites
    // the one it was given.
    expect(canvas.nodes.find((node) => node.id === ids.image)?.data).toEqual({
      assetId: ids.assetImage,
    });
  });

  it("says what made the cut, and which picture it was made from", async () => {
    await selectPicture();
    const dialog = openTool("Crop");
    await showPicture(dialog, 64, 64);

    await act(async () => {
      fireEvent.submit(dialog);
    });

    // The cut is what is left selected, so its own account of where it came from
    // is the one showing. It names the tool as the bar does and the picture it
    // worked on by name, and it does not call itself generated: nothing was asked
    // of anybody, so there is no run to point at.
    const inspector = screen.getByRole("complementary", { name: "Inspector" });
    const rows = [...inspector.querySelectorAll(".inspector-row")].map(
      (row) => [
        row.firstElementChild?.textContent ?? "",
        row.lastElementChild?.textContent ?? "",
      ],
    );
    expect(rows).toContainEqual(["Made by", "Crop"]);
    expect(rows).toContainEqual(["From", "lake.png"]);
    expect(inspector.textContent).not.toContain("Generated by workflow");
    expect(
      rows.map(([label]) => label),
      "no run was started, so none is offered as an explanation",
    ).not.toContain("Run");
  });

  it("makes a node for every piece of a division and selects them together", async () => {
    await selectPicture();
    const dialog = openTool("Split");
    await showPicture(dialog, 64, 64);
    fireEvent.click(within(dialog).getByRole("button", { name: "3 × 3" }));
    expect(dialog.textContent).toContain("9 pieces");

    await act(async () => {
      fireEvent.submit(dialog);
    });

    expect(asks).toEqual([
      {
        tool: "split",
        assetId: goldenNodeIds().assetImage,
        params: { rows: 3, cols: 3 },
      },
    ]);
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const pieces = canvas.nodes.filter((node) =>
      node.title.startsWith("lake-piece-"),
    );
    expect(pieces).toHaveLength(9);
    expect(pieces[4].bounds).toMatchObject({ x: 40 + 4 * 40, y: 160 + 4 * 40 });
    expect(
      canvas.edges.filter(
        (edge) => edge.source.nodeId === goldenNodeIds().image,
      ),
    ).toHaveLength(9);
    expect(useEditorStore.getState().selection.nodeIds).toHaveLength(9);
    // One undo step for the whole division, so it can be let go of at once.
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    // And the division is what the dialog comes up with next time.
    expect(useToolPrefs.getState().grid).toEqual({ rows: 3, cols: 3 });
  });
});
