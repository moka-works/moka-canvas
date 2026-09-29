// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { MokaFile } from "../../../shared/domain";
import {
  buildConversationMokaFile,
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import { useAppStore } from "../../editor/stores/appStore";
import {
  EMPTY_SELECTION,
  useEditorStore,
} from "../../editor/stores/editorStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useAssetsStore } from "../stores/assetsStore";
import { AssetsInspector } from "./AssetsInspector";

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The server answering a shelf write the way it does: the entry as it now
 * stands, and the revision the document moved to.
 */
function answerShelfWrites(moka: MokaFile) {
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    if (
      url.startsWith("/api/v1/projects/current/assets/") &&
      init?.method === "PATCH"
    ) {
      const asked = JSON.parse(String(init.body)) as {
        tags?: string[];
        note?: string;
        keyword?: string;
      };
      const entry = { ...moka.resources.images[0], ...asked };
      return Promise.resolve(
        json({ entry, revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" }),
      );
    }
    return Promise.resolve(
      json({ code: "NOT_FOUND", message: url, status: 404 }, 404),
    );
  });
}

/** The column with a project open and a file chosen in it. */
function show(moka: MokaFile, assetId: string) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-assets-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useAssetsStore.getState().select(assetId);
  render(<AssetsInspector />);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useEditorStore.setState({
    selection: EMPTY_SELECTION,
    announcement: "",
    inspectedAssetId: null,
  });
  useAppStore.setState({ phase: "assets", toasts: [] });
  useAssetsStore.setState({
    inspectedAssetId: null,
    view: "all",
    kind: "image",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what the right column says about a file", () => {
  it("reads the facts, and says nothing while nothing is chosen", () => {
    const moka = buildGoldenMokaFile();
    useProjectStore.getState().hydrate({
      moka,
      root: "/tmp/moka-assets-test",
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
    render(<AssetsInspector />);
    expect(
      screen.getByText(
        "What a file is, and what was said about it, is read here",
      ),
    ).toBeTruthy();

    cleanup();
    useAssetsStore.getState().select(goldenNodeIds().assetImage);
    render(<AssetsInspector />);

    const said = screen.getByTestId("assets-inspector-file");
    expect(said.textContent).toContain("lake.png");
    expect(said.textContent).toContain("Images · Image");
    expect(said.textContent).toContain("64×64");
    expect(said.textContent).toContain("2.0 KB");
    expect(said.textContent).toContain("assets/images/lake-00000000.png");
    expect(said.textContent).toContain("Brought in");
  });

  it("writes a word a reader adds, and drops one they drop", async () => {
    const moka = buildGoldenMokaFile();
    answerShelfWrites(moka);
    const lake = moka.resources.images[0];
    lake.tags = ["lake"];
    show(moka, lake.id);

    const add = screen.getByLabelText("Add a word");
    fireEvent.change(add, { target: { value: "night" } });
    await act(async () => {
      fireEvent.keyDown(add, { key: "Enter" });
    });

    const asked = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith(`/assets/${lake.id}`) &&
        (init as RequestInit)?.method === "PATCH",
    );
    expect(asked).toBeTruthy();
    expect(JSON.parse(String((asked![1] as RequestInit).body))).toEqual({
      tags: ["lake", "night"],
    });
    expect(useProjectStore.getState().moka?.resources.images[0].tags).toEqual([
      "lake",
      "night",
    ]);

    // A chip's own cross takes the word out, and the write says the rest stay.
    fireEvent.click(screen.getByLabelText("Remove lake"));
    await act(async () => {});
    expect(useProjectStore.getState().moka?.resources.images[0].tags).toEqual([
      "night",
    ]);
  });

  it("goes to the card that made the file", () => {
    show(buildConversationMokaFile(), goldenNodeIds().assetImage);

    fireEvent.click(screen.getByTestId("asset-open-maker"));

    expect(useAppStore.getState().phase).toBe("editing");
    expect(useProjectStore.getState().activeCanvasId).toBe(
      goldenNodeIds().canvasMain,
    );
    expect(useEditorStore.getState().selection.nodeIds).toEqual([
      goldenNodeIds().image,
    ]);
  });
});
