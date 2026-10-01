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
  buildShelfMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { useAppStore } from "./stores/appStore";
import { useEditorStore, EMPTY_SELECTION } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { usePanelFolds } from "./stores/panelFolds";
import { useProjectStore } from "./stores/projectStore";

const CONFIG = {
  productName: "Moka Canvas",
  maxUploadBytes: 104857600,
  allowedMediaTypes: ["image/png", "text/markdown"],
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
    name: "Shelf Fixture",
    path: "/tmp/shelf",
    lastOpened: "2026-01-01T00:00:00.000Z",
  },
];

/** What the file itself holds, for a preview read out of the file. */
const TEXT_BODY = "A lantern floats over a quiet lake at dusk.";

const fetchMock = vi.fn<typeof fetch>();

function route(url: string, init?: RequestInit): Response {
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
      root: "/tmp/shelf",
      moka: buildShelfMokaFile(),
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
  }
  if (url === "/api/v1/projects/current/runs") return json([]);
  if (url === "/api/v1/projects/current/commands") {
    return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
  }
  if (url.includes("/reveal") && init?.method === "POST") {
    return new Response(null, { status: 204 });
  }
  // The file itself, which is what a preview of a file of words reads.
  if (url.startsWith("/api/v1/projects/current/assets/")) {
    return new Response(TEXT_BODY, {
      status: 200,
      headers: { "Content-Type": "text/markdown" },
    });
  }
  return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
}

/** The editor with a project open and the shelf turned towards the reader. */
async function openShelf(overrides: { asset?: () => Response } = {}) {
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    if (
      overrides.asset !== undefined &&
      url.startsWith("/api/v1/projects/current/assets/")
    ) {
      return Promise.resolve(overrides.asset());
    }
    return Promise.resolve(route(url, init as RequestInit));
  });
  render(<App />);
  fireEvent.click(await screen.findByText("Shelf Fixture"));
  fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
  await screen.findByTestId("canvas-tab-Canvas 1");
  fireEvent.click(screen.getByTestId("left-tab-assets"));
}

/** The row a file has on the shelf, which is what a reader clicks. */
function rowOf(assetId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `.resource-row[data-asset-id="${assetId}"]`,
  );
  if (!row) throw new Error(`no shelf row for ${assetId}`);
  return row;
}

function clickRow(assetId: string) {
  fireEvent.click(within(rowOf(assetId)).getByTestId("resource-main"));
}

function inspector(): HTMLElement {
  return screen.getByRole("complementary", { name: "Inspector" });
}

beforeEach(() => {
  // Which boards were left open is kept on the machine rather than in the
  // project, so a test that turned to another board must not open the next
  // test onto it.
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  usePanelFolds.setState({ left: false, right: false });
  useEditorStore.setState({
    selection: EMPTY_SELECTION,
    leftPanelTab: "project",
    sidePanelTab: "inspector",
    assetKind: "image",
    focusedAssetId: null,
    inspectedAssetId: null,
    previewAssetId: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the file the shelf was asked about", () => {
  it("is read in the column beside the canvas", async () => {
    const ids = goldenNodeIds();
    await openShelf();
    clickRow(ids.assetImage);

    // The click asked about the file, and the column turned to the face that
    // answers rather than leaving the answer on a face it is not showing.
    expect(useEditorStore.getState().inspectedAssetId).toBe(ids.assetImage);
    expect(useEditorStore.getState().sidePanelTab).toBe("inspector");
    // The row says it is the one being read, so the two columns can be seen to
    // be about one file.
    expect(rowOf(ids.assetImage).className).toContain("is-inspected");

    const said = inspector();
    expect(said.textContent).toContain("lake.png");
    expect(said.textContent).toContain("image/png");
    expect(said.textContent).toContain("64×64");
    expect(said.textContent).toContain("2.0 KB");
    expect(said.textContent).toContain("assets/images/lake-00000000.png");
    expect(said.textContent).toContain("Images · Image");
    // What a reader said about the file on the shelf travels with it here.
    expect(said.textContent).toContain("lake, dusk");
    expect(said.textContent).toContain("Kept for the opening shot.");
    expect(said.textContent).toContain(
      "A lantern floats over a quiet lake at dusk.",
    );
    expect(said.textContent).toContain("Brought in");
    expect(said.textContent).toContain("1 card");
    // And the picture itself: a file that looks like something is worth looking
    // at where it is being read, not only in a dialog asked for separately.
    expect(within(said).getByTestId("asset-preview-image")).toBeTruthy();
    expect(within(said).getByRole("link", { name: "Download" })).toBeTruthy();
  });

  it("is read ahead of a card that happens to be chosen, until one is chosen", async () => {
    const ids = goldenNodeIds();
    await openShelf();

    // A card already chosen is not a question about a file, so the column
    // reads the card: what it holds, where it sits, and what it can be asked.
    act(() => {
      useEditorStore.getState().selectOnly(ids.image);
    });
    expect(
      (await screen.findByLabelText<HTMLInputElement>("Node title")).value,
    ).toBe("Reference image");

    // Asking about the file is the later question, so it is the one answered —
    // a reader who clicked a file on the shelf is not told about a card they
    // chose a moment ago and have not looked at since.
    clickRow(ids.assetImage);
    expect(inspector().textContent).toContain("lake.png");
    expect(screen.queryByLabelText("Node title")).toBeNull();
    // The card is still chosen on the canvas; only the reading of it moved.
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.image]);

    // Choosing on the canvas puts the file down, so the column never reads a
    // file asked about before the thing just clicked on.
    act(() => {
      useEditorStore.getState().selectOnly(ids.image);
    });
    expect(useEditorStore.getState().inspectedAssetId).toBeNull();
    expect(
      (await screen.findByLabelText<HTMLInputElement>("Node title")).value,
    ).toBe("Reference image");
    expect(rowOf(ids.assetImage).className).not.toContain("is-inspected");
  });

  it("offers the cards using it where this board holds one, and drops the row where it does not", async () => {
    const ids = goldenNodeIds();
    await openShelf();

    const focus = within(rowOf(ids.assetImage)).getByRole("button", {
      name: /Focus the cards on this canvas/,
    });
    expect(focus).toHaveProperty("disabled", false);
    expect(focus.getAttribute("title")).toBe(
      "Select the 1 card on this canvas using it",
    );

    // Going to the cards is a move on the canvas rather than a reading of the
    // file, so the column follows the reader there.
    fireEvent.click(focus);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.image]);
    expect(useEditorStore.getState().inspectedAssetId).toBeNull();
    expect(useEditorStore.getState().announcement).toBe(
      "Selected 1 card on this canvas using this asset",
    );

    // A board that holds no card for a file does not list the file at all: the
    // column reads one board, so there is no row here to offer "nothing" from
    // — the project's own shelf is the files room's question.
    fireEvent.click(screen.getByTestId("left-tab-project"));
    fireEvent.click(screen.getByRole("button", { name: "Canvas 2" }));
    await screen.findByTestId("canvas-tab-Canvas 2");
    fireEvent.click(screen.getByTestId("left-tab-assets"));
    expect(
      document.querySelector(
        `.resource-row[data-asset-id="${ids.assetImage}"]`,
      ),
    ).toBeNull();
  });

  it("stands the column back up to answer where it was folded away", async () => {
    const ids = goldenNodeIds();
    await openShelf();

    // A column folded away is a column that cannot answer, and a click that
    // goes nowhere reads as a click that was not taken at all.
    act(() => {
      usePanelFolds.getState().setFolded("right", true);
    });
    expect(document.getElementById("panel-right")).toBeNull();

    clickRow(ids.assetImage);
    expect(usePanelFolds.getState().right).toBe(false);
    expect(document.getElementById("panel-right")).toBeTruthy();
    expect(inspector().textContent).toContain("lake.png");
  });

  it("reads a file of words out of the file itself", async () => {
    await openShelf();
    fireEvent.click(screen.getByTestId("asset-kind-text"));

    const row = document.querySelector<HTMLElement>(".resource-row");
    expect(row?.textContent).toContain("opening-lines.md");
    fireEvent.click(within(row!).getByTestId("resource-main"));

    // The entry says what a file is about in a word or two; what is in it is
    // asked of the file, since that is what a reader clicking it wants.
    const excerpt = await screen.findByTestId("asset-text");
    expect(excerpt.textContent).toBe(TEXT_BODY);
    const asked = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith("/api/v1/projects/current/assets/"),
    );
    expect(asked).toBeTruthy();
    expect(inspector().textContent).toContain("opening-lines.md");
    expect(inspector().textContent).toContain("text/markdown");
  });

  it("says what the file's read answered when the words cannot be read", async () => {
    await openShelf({
      asset: () =>
        new Response("nope", {
          status: 503,
          statusText: "Service Unavailable",
        }),
    });
    fireEvent.click(screen.getByTestId("asset-kind-text"));

    const row = document.querySelector<HTMLElement>(".resource-row");
    fireEvent.click(within(row!).getByTestId("resource-main"));

    // "Could not be read" says what happened; the answer the read gave is the
    // half a reader can act on.
    const failed = await screen.findByTestId("asset-text-failed");
    expect(failed.textContent).toContain("503 Service Unavailable");
  });
});
