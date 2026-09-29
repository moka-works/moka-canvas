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
import { createFolder, type MokaFile } from "../../../shared/domain";
import {
  buildGoldenMokaFile,
  buildShelfMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import { SidePanel } from "./SidePanel";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { undo } from "../commands/execute";
import { useHistoryStore } from "../stores/historyStore";
import { useOpenCanvases } from "../stores/openCanvases";
import { useProjectStore } from "../stores/projectStore";

const fetchMock = vi.fn<typeof fetch>();

/** The tree as a reader reaches it: the left column on its project face. */
function openTree(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-tree-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  render(<SidePanel />);
  return moka;
}

/** A project with two folders, one holding a board and a folder of its own. */
function buildTree(): MokaFile {
  const moka = buildGoldenMokaFile();
  const drafts = createFolder("Drafts");
  const kept = createFolder("Kept");
  const inside = createFolder("Inside", drafts.id);
  moka.folders = [drafts, kept, inside];
  const [first, second] = moka.canvas;
  moka.canvas = [
    { ...second, folderId: kept.id },
    { ...first, folderId: drafts.id },
  ];
  return moka;
}

/** The names the tree shows, in the order it shows them. */
function rows(): string[] {
  return [...document.querySelectorAll(".tree-label")].map(
    (row) => row.textContent ?? "",
  );
}

function rowNamed(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function menuOn(name: string) {
  fireEvent.contextMenu(rowNamed(name));
  return screen.getByRole("menu", { name: "Canvas tree menu" });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ revision: 2, updatedAt: "2026-01-02T00:00:00.000Z" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [], config: null });
  useEditorStore.setState({
    leftPanelTab: "project",
    focusedAssetId: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the canvas tree", () => {
  it("reads folders before the boards they hold", () => {
    openTree(buildTree());
    // Folders first at every level, then the boards they hold. The project
    // opens onto the board in Kept, so the folder holding it is already open —
    // a board just chosen is one a reader should be able to see in the tree.
    expect(rows()).toEqual(["Drafts", "Kept", "Canvas 2"]);
    fireEvent.click(screen.getByRole("button", { name: "Open Drafts" }));
    expect(rows()).toEqual([
      "Drafts",
      "Inside",
      "Canvas 1",
      "Kept",
      "Canvas 2",
    ]);
  });

  it("opens a board onto the four kinds of thing it uses", () => {
    const ids = goldenNodeIds();
    openTree(buildShelfMokaFile());
    fireEvent.click(screen.getByRole("button", { name: "Open Canvas 1" }));
    expect(rows()).toEqual([
      "Canvas 1",
      "Text",
      "Image",
      "Audio",
      "Video",
      "Canvas 2",
    ]);
    fireEvent.click(rowNamed("Image"));
    expect(rows()).toContain("lake.png");
    // A kind with nothing under it still says so, rather than going missing.
    fireEvent.click(rowNamed("Audio"));
    expect(screen.getByText("No audio on this board")).toBeTruthy();
    expect(ids.assetImage).toBeTruthy();
  });

  it("puts a tab up for a board opened from the tree", () => {
    const moka = openTree(buildTree());
    const drafts = moka.canvas.find((canvas) => canvas.name === "Canvas 1");
    fireEvent.click(screen.getByRole("button", { name: "Open Drafts" }));
    expect(useProjectStore.getState().activeCanvasId).not.toBe(drafts?.id);
    expect(useOpenCanvases.getState().ids).not.toContain(drafts?.id);

    fireEvent.click(rowNamed("Canvas 1"));
    expect(useProjectStore.getState().activeCanvasId).toBe(drafts?.id);
    expect(useOpenCanvases.getState().ids).toContain(drafts?.id);
  });

  it("marks the board being looked at in its words rather than in its place", () => {
    const moka = openTree(buildTree());
    const kept = moka.canvas.find((canvas) => canvas.name === "Canvas 2");
    const drafts = moka.canvas.find((canvas) => canvas.name === "Canvas 1");
    const rowOf = (canvas: typeof kept) =>
      document.querySelector(`[data-row="canvas:${canvas?.id}"]`);

    // Both names on the row and a space between them: a row dressed in
    // "tree-rowis-active" wears neither name, so it loses the shape every
    // other row has, and with it the place its words start.
    expect(rowOf(kept)?.className).toBe("tree-row is-active");
    expect(rowOf(kept)?.classList.contains("tree-row")).toBe(true);

    // Opening another board moves the mark to it, and takes it off the first.
    fireEvent.click(screen.getByRole("button", { name: "Open Drafts" }));
    fireEvent.click(rowNamed("Canvas 1"));
    expect(rowOf(drafts)?.className).toBe("tree-row is-active");
    expect(rowOf(kept)?.className).toBe("tree-row");
  });

  it("makes a board and a folder where the row asked for them", () => {
    const moka = openTree(buildTree());
    const drafts = (moka.folders ?? []).find((f) => f.name === "Drafts");
    fireEvent.click(screen.getByRole("button", { name: "Open Drafts" }));

    const menu = menuOn("Drafts");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New canvas" }));
    const made = useProjectStore.getState().moka;
    const added = made?.canvas.find((canvas) => canvas.name === "Canvas 3");
    expect(added?.folderId).toBe(drafts?.id);
    // A new board is a board being looked at, so it goes up on the strip.
    expect(useOpenCanvases.getState().ids).toContain(added?.id);

    const second = menuOn("Drafts");
    fireEvent.click(
      within(second).getByRole("menuitem", { name: "New folder" }),
    );
    const folders = useProjectStore.getState().moka?.folders ?? [];
    // Named after the folders already beside it: Drafts holds Inside, so this
    // one is the second rather than the first.
    expect(
      folders.some((f) => f.name === "Folder 2" && f.parentId === drafts?.id),
    ).toBe(true);
  });

  it("files a board where it is let go", () => {
    const moka = openTree(buildTree());
    const kept = (moka.folders ?? []).find((held) => held.name === "Kept");
    fireEvent.click(screen.getByRole("button", { name: "Open Drafts" }));

    const dragged = document.querySelector(
      `[data-row="canvas:${
        moka.canvas.find((canvas) => canvas.name === "Canvas 1")?.id
      }"]`,
    )!;
    const onto = document.querySelector(`[data-row="folder:${kept?.id}"]`)!;
    const transfer = { setData: () => {}, dropEffect: "", effectAllowed: "" };
    fireEvent.dragStart(dragged, { dataTransfer: transfer });
    fireEvent.dragOver(onto, { dataTransfer: transfer });
    // Where a row is dragged over is marked before anything is let go, so the
    // reader is told where the thing would land rather than left to guess.
    expect(onto.className).toContain("is-drop-inside");
    fireEvent.drop(onto, { dataTransfer: transfer });

    const moved = useProjectStore
      .getState()
      .moka?.canvas.find((canvas) => canvas.name === "Canvas 1");
    expect(moved?.folderId).toBe(kept?.id);
    expect(undo()).toBeTruthy();
    expect(
      useProjectStore
        .getState()
        .moka?.canvas.find((canvas) => canvas.name === "Canvas 1")?.folderId,
    ).not.toBe(kept?.id);
  });

  it("stops offering a board where a deployment allows no more", () => {
    const moka = openTree(buildTree());
    act(() => {
      useAppStore.setState({
        config: {
          productName: "Moka Canvas",
          maxUploadBytes: 1,
          allowedMediaTypes: [],
          limits: {
            maxNodesPerCanvas: 1,
            maxEdgesPerCanvas: 1,
            maxCanvasesPerProject: moka.canvas.length,
            maxPackageBytes: 1,
            maxPackageEntries: 1,
          },
          capabilities: { mode: "web", executors: [], assetCategories: [] },
        },
      });
    });
    // The offer is left out rather than greyed: a choice that cannot be taken
    // says something untrue about what the project can still hold.
    const offer = screen.getByRole("button", {
      name: /New canvas/,
    }) as HTMLButtonElement;
    expect(offer.disabled).toBe(true);
    const menu = menuOn("Drafts");
    expect(
      within(menu).queryByRole("menuitem", { name: "New canvas" }),
    ).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "New folder" }),
    ).toBeTruthy();
  });

  it("renames what a row is called, and lets go of a rename unfinished", () => {
    openTree(buildTree());
    fireEvent.doubleClick(rowNamed("Drafts"));
    const field = screen.getByLabelText("Rename Drafts");
    fireEvent.change(field, { target: { value: "Rough" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(rows()).toContain("Rough");
    expect(
      useProjectStore.getState().moka?.folders?.some((f) => f.name === "Rough"),
    ).toBe(true);

    fireEvent.doubleClick(rowNamed("Kept"));
    const letGo = screen.getByLabelText("Rename Kept");
    fireEvent.change(letGo, { target: { value: "Gone" } });
    fireEvent.keyDown(letGo, { key: "Escape" });
    expect(rows()).not.toContain("Gone");
    expect(
      useProjectStore.getState().moka?.folders?.some((f) => f.name === "Kept"),
    ).toBe(true);
  });

  it("takes a board out and says it is one undo away", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const moka = openTree(buildTree());
    const drafts = (moka.folders ?? []).find((held) => held.name === "Drafts");
    fireEvent.click(screen.getByRole("button", { name: "Open Drafts" }));
    const menu = menuOn("Canvas 1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Delete/ }));
    // A board with cards on it is asked about first, by name and by count.
    expect(confirm.mock.calls[0][0]).toContain("Canvas 1");
    expect(confirm.mock.calls[0][0]).toContain("4 nodes");
    expect(rows()).not.toContain("Canvas 1");
    // One step of history, so letting go of it gives the board back where it was.
    let undone = false;
    act(() => {
      undone = undo();
    });
    expect(undone).toBe(true);
    expect(rows()).toContain("Canvas 1");
    expect(
      useProjectStore
        .getState()
        .moka?.canvas.find((canvas) => canvas.name === "Canvas 1")?.folderId,
    ).toBe(drafts?.id);
  });

  it("leaves a board alone when the question about it is answered no", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    openTree(buildTree());
    fireEvent.click(screen.getByRole("button", { name: "Open Drafts" }));
    const menu = menuOn("Canvas 1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Delete/ }));
    expect(rows()).toContain("Canvas 1");
  });

  it("moves what a folder held up rather than taking it away", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    openTree(buildTree());
    const menu = menuOn("Drafts");
    // The question says what deleting a drawer does to what is in it.
    expect(
      within(menu).getByRole("menuitem", { name: /moves 1 canvas up/ }),
    ).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Delete/ }));
    const moka = useProjectStore.getState().moka;
    const folders = moka?.folders ?? [];
    expect(folders.some((held) => held.name === "Drafts")).toBe(false);
    // What it held is still reachable: the folder inside it and the board.
    expect(folders.some((held) => held.name === "Inside")).toBe(true);
    expect(moka?.canvas.some((canvas) => canvas.name === "Canvas 1")).toBe(
      true,
    );
    expect(confirm).toHaveBeenCalled();
  });

  it("follows a file from the tree to the shelf it is filed on", () => {
    const ids = goldenNodeIds();
    openTree(buildShelfMokaFile());
    fireEvent.click(screen.getByRole("button", { name: "Open Canvas 1" }));
    fireEvent.click(rowNamed("Image"));

    const menu = menuOn("lake.png");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Show in assets" }),
    );

    // The column turned over to its assets face, on the kind the file is filed
    // under, with that one row marked rather than the reader left to find it.
    expect(useEditorStore.getState().leftPanelTab).toBe("assets");
    expect(useEditorStore.getState().assetKind).toBe("image");
    expect(useEditorStore.getState().focusedAssetId).toBe(ids.assetImage);
    expect(
      document
        .querySelector(".resource-row.is-focused")
        ?.getAttribute("data-asset-id"),
    ).toBe(ids.assetImage);
  });

  it("follows a file to the board that holds it, not the one being looked at", () => {
    const ids = goldenNodeIds();
    openTree(buildShelfMokaFile());
    // Canvas 1 is read in the tree while Canvas 2 is the board on screen, so
    // its rows are about a board the reader is not standing on.
    fireEvent.click(screen.getByRole("button", { name: "Open Canvas 1" }));
    fireEvent.click(rowNamed("Image"));
    fireEvent.click(rowNamed("Canvas 2"));
    expect(useProjectStore.getState().activeCanvasId).toBe(ids.canvasSecond);

    const menu = menuOn("lake.png");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Show in assets" }),
    );

    // The column reads one board, so the file is followed to the board that
    // holds it: the board switches back and the row is marked where it shows.
    expect(useProjectStore.getState().activeCanvasId).toBe(ids.canvasMain);
    expect(useEditorStore.getState().leftPanelTab).toBe("assets");
    expect(useEditorStore.getState().assetKind).toBe("image");
    expect(useEditorStore.getState().focusedAssetId).toBe(ids.assetImage);
    expect(
      document
        .querySelector(".resource-row.is-focused")
        ?.getAttribute("data-asset-id"),
    ).toBe(ids.assetImage);
  });

  it("selects the cards a file is on, from the tree that listed it", () => {
    openTree(buildShelfMokaFile());
    fireEvent.click(screen.getByRole("button", { name: "Open Canvas 1" }));
    fireEvent.click(rowNamed("Image"));
    fireEvent.click(rowNamed("lake.png"));
    expect(useEditorStore.getState().selection.nodeIds).toEqual([
      goldenNodeIds().image,
    ]);
  });

  it("offers the top level to the space under the last row", () => {
    openTree(buildTree());
    // A reader who points at nothing in particular is pointing at the project
    // itself, which is a place a board and a folder can be filed.
    fireEvent.contextMenu(document.querySelector(".side-tree-scroll")!);
    const menu = screen.getByRole("menu", { name: "Canvas tree menu" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New canvas" }));
    const made = useProjectStore.getState().moka;
    const added = made?.canvas.find((canvas) => canvas.name === "Canvas 3");
    expect(added?.folderId).toBeUndefined();
  });
});
