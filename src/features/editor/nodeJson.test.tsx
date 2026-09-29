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
import { renameNode } from "./interactions/actions";
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

function jsonShown(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId("node-json").textContent ?? "");
}

async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

function clipboardThat(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
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
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the node JSON view", () => {
  it("holds the node exactly as the document has it", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    select([ids.text]);

    // Folded away until asked for: it is for comparing against, not for
    // reading past.
    const details = screen.getByTestId("node-json").closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(within(details).getByText("JSON"));
    expect(details.open).toBe(true);

    expect(jsonShown()).toEqual(findNode(canvas(), ids.text));
  });

  it("follows an edit to the node it is showing", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    select([ids.text]);

    act(() => renameNode(ids.text, "Renamed brief"));

    expect(jsonShown()).toEqual(findNode(canvas(), ids.text));
    expect(jsonShown().title).toBe("Renamed brief");
  });

  it("copies the JSON and says so", async () => {
    const ids = goldenNodeIds();
    const writeText = vi.fn(async () => {});
    clipboardThat(writeText);
    await openGolden();
    select([ids.text]);

    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    await settle();

    expect(writeText).toHaveBeenCalledWith(
      screen.getByTestId("node-json").textContent,
    );
    expect(useEditorStore.getState().announcement).toBe("Node JSON copied");
  });

  it("says so when the clipboard refuses rather than implying it was copied", async () => {
    const ids = goldenNodeIds();
    clipboardThat(() => Promise.reject(new Error("denied")));
    await openGolden();
    select([ids.text]);

    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    await settle();

    expect(useAppStore.getState().toasts).toMatchObject([
      { kind: "error", message: "The clipboard is not available" },
    ]);
    expect(useEditorStore.getState().announcement).toBe("");
  });
});
