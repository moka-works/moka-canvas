// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { MokaFile, ResourceEntry } from "../../../shared/domain";
import { createNode } from "../../../shared/domain/factories";
import {
  buildShelfMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import { SidePanel } from "./SidePanel";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The shelf as a reader reaches it: the left column, turned over to its assets
 * face. Rendered through the column rather than on its own, since which face a
 * reader gets is part of what is being tested.
 */
function openShelf(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-shelf-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  render(<SidePanel />);
  fireEvent.click(screen.getByTestId("left-tab-assets"));
  return moka;
}

/** The kind being read, which is one tab of four. */
function showKind(kind: "text" | "image" | "audio" | "video") {
  fireEvent.click(screen.getByTestId(`asset-kind-${kind}`));
}

/** Every row a reader can see, the tray's own included. */
function rowsShown(): string[] {
  return [...document.querySelectorAll(".resource-main strong")].map(
    (name) => name.textContent ?? "",
  );
}

/** The board's own list, with the waiting tray left out of it. */
function listed(): string[] {
  return [
    ...document.querySelectorAll(
      ".side-resource-group:not(.side-resource-tray) .resource-main strong",
    ),
  ].map((name) => name.textContent ?? "");
}

/** A second picture, waiting for a place rather than on the board. */
function withSecondPicture(moka: MokaFile): MokaFile {
  moka.resources.images.push({
    id: "image-dawn",
    name: "dawn.png",
    path: "assets/images/dawn-00000000.png",
    mime: "image/png",
    bytes: 2048,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tags: ["dusk"],
    origin: "brought",
  });
  return moka;
}

/** A picture the board's own cards hold, so a list can be longer than a page. */
function withPictures(moka: MokaFile, count: number): MokaFile {
  const canvas = moka.canvas[0];
  for (let index = 0; index < count; index += 1) {
    const id = `image-look-${index}`;
    moka.resources.images.push({
      id,
      name: `look-${index}.png`,
      path: `assets/images/look-${index}.png`,
      mime: "image/png",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const node = createNode("image", { x: index * 40, y: 0 });
    node.data = { assetId: id };
    canvas.nodes.push(node);
  }
  return moka;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() => Promise.resolve(json({})));
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    announcement: "",
    previewAssetId: null,
    leftPanelTab: "project",
    assetKind: "image",
    focusedAssetId: null,
    assetPicker: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the board's shelf, one kind at a time", () => {
  it("lists what this board holds, and keeps the rest out of the way", () => {
    openShelf(buildShelfMokaFile());
    expect(listed()).toEqual(["lake.png"]);

    // A file no card holds is not this board's material: the text waits in the
    // tray for a place rather than standing in the list.
    showKind("text");
    expect(listed()).toEqual([]);
    expect(screen.getByTestId("shelf-tray").textContent).toContain(
      "opening-lines.md",
    );

    showKind("audio");
    expect(listed()).toEqual([]);
    expect(rowsShown()).toEqual([]);
    expect(screen.queryByTestId("shelf-no-match")).toBeNull();
    expect(screen.getByText(/This board uses no audio files yet/)).toBeTruthy();
  });

  it("switches its list with the board being looked at", () => {
    openShelf(buildShelfMokaFile());
    expect(listed()).toEqual(["lake.png"]);

    // The second board holds nothing, so nothing is listed on it — and the
    // file the first board holds is not "waiting" either: it has a place.
    act(() => {
      useProjectStore.getState().switchCanvas(goldenNodeIds().canvasSecond);
    });
    expect(rowsShown()).toEqual([]);
    expect(listed()).toEqual([]);
  });

  it("puts a waiting file on this board from the tray", async () => {
    const moka = withSecondPicture(buildShelfMokaFile());
    openShelf(moka);
    const tray = screen.getByTestId("shelf-tray");
    expect(tray.textContent).toContain("dawn.png");
    expect(listed()).toEqual(["lake.png"]);

    fireEvent.click(tray.querySelector('[data-testid="shelf-add-to-canvas"]')!);
    await waitFor(() => {
      const canvas = useProjectStore.getState().moka?.canvas[0];
      expect(
        canvas?.nodes.some(
          (node) =>
            (node.data as { assetId?: string }).assetId === "image-dawn",
        ),
      ).toBe(true);
    });
    // It is the board's material now: out of the tray, in the list.
    expect(screen.queryByTestId("shelf-tray")).toBeNull();
    expect(listed()).toEqual(["lake.png", "dawn.png"]);
  });

  it("reaches the whole project through the picker", () => {
    openShelf(buildShelfMokaFile());

    fireEvent.click(screen.getByTestId("shelf-from-project"));

    expect(useEditorStore.getState().assetPicker).toEqual({
      mode: "nodes",
      at: null,
    });
  });

  it("follows a file to the board that holds it", () => {
    openShelf(buildShelfMokaFile());
    act(() => {
      useProjectStore.getState().switchCanvas(goldenNodeIds().canvasSecond);
    });
    fireEvent.click(screen.getByTestId("left-tab-project"));

    act(() => {
      useEditorStore
        .getState()
        .showAssetOnShelf(
          goldenNodeIds().assetImage,
          "image",
          goldenNodeIds().canvasMain,
        );
    });

    // The column reads one board, so the file's board is the one opened: the
    // row is marked where it can be seen rather than where it is not.
    expect(useProjectStore.getState().activeCanvasId).toBe(
      goldenNodeIds().canvasMain,
    );
    expect(
      screen.getByTestId("left-tab-assets").getAttribute("aria-selected"),
    ).toBe("true");
    expect(listed()).toEqual(["lake.png"]);
    const marked = document.querySelector(".resource-row.is-focused");
    expect(marked?.getAttribute("data-asset-id")).toBe(
      goldenNodeIds().assetImage,
    );
  });

  it("leaves the board alone when no board is named", () => {
    openShelf(buildShelfMokaFile());
    act(() => {
      useProjectStore.getState().switchCanvas(goldenNodeIds().canvasSecond);
    });

    act(() => {
      useEditorStore
        .getState()
        .showAssetOnShelf(goldenNodeIds().assetImage, "image");
    });

    expect(useProjectStore.getState().activeCanvasId).toBe(
      goldenNodeIds().canvasSecond,
    );
    expect(screen.getByTestId("left-tab-assets")).toBeTruthy();
  });

  it("shows what a reader said about each file", () => {
    openShelf(buildShelfMokaFile());
    expect(screen.getByText("lake.png")).toBeTruthy();
    expect(screen.getByText("dusk")).toBeTruthy();
    expect(
      screen.getAllByTestId("resource-where").map((mark) => mark.textContent),
    ).toEqual(["Brought in"]);
    expect(
      screen.getByTestId("shelf-tag-lake").textContent?.replace(/\s+/g, " "),
    ).toBe("lake · 1");
  });

  it("narrows the shelf to a word in what was said", () => {
    openShelf(buildShelfMokaFile());
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "lantern" },
    });
    expect(listed()).toEqual(["lake.png"]);
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "opening" },
    });
    // The note is searched too, and this one says "Kept for the opening shot",
    // so the picture is still the one found.
    expect(listed()).toEqual(["lake.png"]);
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "opening-lines" },
    });
    // What a file says about itself is read within the kind being looked at, so
    // the name of a text finds nothing among the pictures.
    expect(screen.getByTestId("shelf-no-match")).toBeTruthy();
  });

  it("asks for every word chosen on the shelf", () => {
    openShelf(withSecondPicture(buildShelfMokaFile()));
    fireEvent.click(screen.getByTestId("shelf-tag-dusk"));
    // The waiting file answers the word as the list does — and waits above it.
    expect(rowsShown()).toEqual(["dawn.png", "lake.png"]);
    fireEvent.click(screen.getByTestId("shelf-tag-lake"));
    expect(rowsShown()).toEqual(["lake.png"]);
    fireEvent.click(screen.getByTestId("shelf-clear"));
    expect(rowsShown()).toEqual(["dawn.png", "lake.png"]);
  });

  it("keeps only the files marked to hand", () => {
    openShelf(withSecondPicture(buildShelfMokaFile()));
    fireEvent.click(screen.getByTestId("shelf-keepers"));
    expect(rowsShown()).toEqual(["lake.png"]);
  });

  it("separates what the project made from what it was handed", () => {
    openShelf(buildShelfMokaFile());
    fireEvent.change(screen.getByTestId("shelf-where"), {
      target: { value: "made" },
    });
    expect(screen.getByTestId("shelf-no-match")).toBeTruthy();
    fireEvent.change(screen.getByTestId("shelf-where"), {
      target: { value: "brought" },
    });
    expect(listed()).toEqual(["lake.png"]);
  });

  it("tells two shelves of one kind apart, and asks nothing of a kind with one", () => {
    const moka = buildShelfMokaFile();
    moka.resources.voice.push({
      id: "voice-one",
      name: "reading.wav",
      path: "assets/voice/reading-00000000.wav",
      mime: "audio/wav",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    openShelf(moka);
    showKind("audio");
    expect(rowsShown()).toEqual(["reading.wav"]);
    // A sound is filed as either music or a voice, so the audio tab is two
    // shelves and offers the choice between them.
    fireEvent.change(screen.getByTestId("shelf-category"), {
      target: { value: "music" },
    });
    expect(rowsShown()).toEqual([]);
    showKind("image");
    expect(screen.queryByTestId("shelf-category")).toBeNull();
  });

  it("carries on a shelf longer than one page", () => {
    openShelf(withPictures(buildShelfMokaFile(), 60));
    expect(screen.getByTestId("shelf-shown").textContent).toBe("60 of 61");
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }));
    expect(screen.queryByTestId("shelf-shown")).toBeNull();
    expect(listed()).toHaveLength(61);
  });

  it("writes a keeper mark onto the shelf and keeps the list in step", async () => {
    const moka = openShelf(buildShelfMokaFile());
    const text = moka.resources.texts[0] as ResourceEntry;
    showKind("text");
    fetchMock.mockImplementation((_input, init) => {
      const edit = JSON.parse(String(init?.body)) as Partial<ResourceEntry>;
      return Promise.resolve(
        json({
          entry: { ...text, ...edit },
          revision: 12,
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      );
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Keep opening-lines.md to hand" }),
    );
    await waitFor(() => {
      expect(useProjectStore.getState().moka?.resources.texts[0].favorite).toBe(
        true,
      );
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/v1/projects/current/assets/${text.id}`);
    expect(options?.method).toBe("PATCH");
    expect(JSON.parse(String(options?.body))).toEqual({ favorite: true });
    expect(useProjectStore.getState().moka?.metadata.revision).toBe(12);
  });

  it("refiles an entry with the words and note written on its row", async () => {
    const moka = openShelf(buildShelfMokaFile());
    const text = moka.resources.texts[0] as ResourceEntry;
    showKind("text");
    fetchMock.mockImplementation((_input, init) => {
      const edit = JSON.parse(String(init?.body)) as Partial<ResourceEntry>;
      return Promise.resolve(
        json({
          entry: { ...text, ...edit },
          revision: 13,
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      );
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Tag opening-lines.md" }),
    );
    fireEvent.change(
      screen.getByLabelText("Words to file opening-lines.md under"),
      { target: { value: "openers, dusk, openers" } },
    );
    fireEvent.change(screen.getByLabelText("Note about opening-lines.md"), {
      target: { value: "Worth an opening." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(useProjectStore.getState().moka?.resources.texts[0].note).toBe(
        "Worth an opening.",
      );
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/v1/projects/current/assets/${text.id}`);
    expect(options?.method).toBe("PATCH");
    expect(JSON.parse(String(options?.body))).toEqual({
      tags: ["openers", "dusk"],
      note: "Worth an opening.",
    });
    expect(useProjectStore.getState().moka?.resources.texts[0].tags).toEqual([
      "openers",
      "dusk",
    ]);
  });
});
