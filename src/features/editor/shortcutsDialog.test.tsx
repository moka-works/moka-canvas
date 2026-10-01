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
import { findNode } from "../../shared/domain";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";

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

const fetchMock = vi.fn<typeof fetch>();

async function openGolden() {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url === "/api/v1/config") return Promise.resolve(json(CONFIG));
    if (url === "/api/health") return Promise.resolve(json({ status: "ok" }));
    if (url === "/api/v1/recent-projects")
      return Promise.resolve(json(RECENTS));
    if (url === "/api/v1/projects/open") {
      return Promise.resolve(
        json({
          root: "/tmp/golden",
          moka: buildGoldenMokaFile(),
          selfCheck: { ok: true, issues: [] },
          selfCheckVerified: true,
        }),
      );
    }
    if (url === "/api/v1/projects/current/runs")
      return Promise.resolve(json([]));
    if (url === "/api/v1/projects/current/commands") {
      return Promise.resolve(
        json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" }),
      );
    }
    return Promise.resolve(
      json({ code: "NOT_FOUND", message: url, status: 404 }, 404),
    );
  });
  render(<App />);
  const recent = await screen.findByText("Golden Fixture");
  fireEvent.click(recent);
  fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
  await screen.findByTestId("canvas-tab-Canvas 1");
}

function select(nodeIds: string[]) {
  act(() => {
    useEditorStore.getState().setSelection({ nodeIds, edgeIds: [] });
  });
}

function canvas() {
  return useProjectStore.getState().moka!.canvas[0];
}

async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    nodeMenu: null,
    contextMenu: null,
    shortcutsOpen: false,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the keyboard help", () => {
  it("opens with ? and lists the keys the editor draws from", async () => {
    await openGolden();

    fireEvent.keyDown(window, { key: "?" });

    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Editing")).toBeTruthy();
    expect(within(dialog).getByText("Undo")).toBeTruthy();
    // Away from a Mac the command key is spelled out beside the others.
    expect(within(dialog).getByText("Ctrl+Z")).toBeTruthy();
    expect(within(dialog).getByText("Ctrl+Shift+Z")).toBeTruthy();
    expect(within(dialog).getByText("Ctrl+Y")).toBeTruthy();
  });

  it("stays away while the question mark is being typed into a field", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    select([ids.text]);

    const field = await screen.findByRole("textbox", { name: "Node title" });
    fireEvent.keyDown(field, { key: "?" });

    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeNull();
  });

  it("holds the canvas keys until it is closed", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    select([ids.text]);

    fireEvent.keyDown(window, { key: "?" });
    fireEvent.keyDown(window, { key: "Delete" });
    // The dialog answers for the editor while it is up, so the node stands.
    expect(findNode(canvas(), ids.text)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeNull();

    fireEvent.keyDown(window, { key: "Delete" });
    await settle();
    expect(findNode(canvas(), ids.text)).toBeUndefined();
  });
});
