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
import { registerController } from "./canvas/canvasControl";
import type { LeaferEditorController } from "./canvas/controller";
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

/**
 * Stands in for the mounted canvas, which jsdom cannot build. Only the camera
 * entry points the footer reaches are real; the rest answer harmlessly so the
 * floating bars can ask where things are.
 */
function stubCamera() {
  const camera = {
    worldToClient: () => ({ x: 0, y: 0 }),
    clientToWorld: () => ({ x: 0, y: 0 }),
    viewCenterWorld: () => ({ x: 0, y: 0 }),
    cancelGesture: () => {},
    zoomByAtCenter: () => {},
    zoomToAtCenter: vi.fn(),
    fitBoundsAnimated: vi.fn(),
    focusNode: () => {},
  };
  registerController(camera as unknown as LeaferEditorController);
  return camera;
}

function zoomGroup() {
  return within(screen.getByRole("group", { name: "Zoom" }));
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
  registerController(null);
  vi.unstubAllGlobals();
});

describe("the zoom controls under the canvas", () => {
  it("frames the selection, and waits until there is one", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    const camera = stubCamera();

    const toSelection = zoomGroup().getByRole("button", {
      name: "Zoom to selection",
    });
    expect(toSelection).toHaveProperty("disabled", true);

    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.text, ids.operation], edgeIds: [] });
    });
    expect(toSelection).toHaveProperty("disabled", false);
    fireEvent.click(toSelection);

    // The room the two nodes take up together, from the brief's left edge to
    // the operation's right one.
    expect(camera.fitBoundsAnimated).toHaveBeenCalledWith({
      x: -320,
      y: -120,
      width: 660,
      height: 220,
    });
  });

  it("returns the canvas to actual size", async () => {
    await openGolden();
    const camera = stubCamera();

    fireEvent.click(
      zoomGroup().getByRole("button", { name: "Zoom to 100 percent" }),
    );

    expect(camera.zoomToAtCenter).toHaveBeenCalledWith(1);
  });
});
