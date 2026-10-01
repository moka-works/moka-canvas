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
import { moveNodes } from "./interactions/actions";
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

function boundsOf(nodeId: string) {
  const canvas = useProjectStore.getState().moka!.canvas[0];
  return findNode(canvas, nodeId)!.bounds;
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

describe("selection action bar", () => {
  it("stays away until there is more than one node to arrange", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    expect(screen.queryByTestId("selection-action-bar")).toBeNull();

    select([ids.text]);
    expect(screen.queryByTestId("selection-action-bar")).toBeNull();

    select([ids.text, ids.operation]);
    // The bar's commit can trail the selection on a loaded machine, so it is
    // waited for; the absence checks above stay instant, since a bar that
    // lingers would be the bug they are for.
    const bar = await screen.findByTestId("selection-action-bar");
    expect(
      within(bar).getByRole("button", { name: "Distribute horizontally" }),
    ).toBeTruthy();
  });

  it("lines the selection up on an edge from the bar", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    select([ids.text, ids.operation]);

    const bar = await screen.findByTestId("selection-action-bar");
    fireEvent.click(within(bar).getByRole("button", { name: "Align right" }));

    // Both take the right edge of the room they took up together, which ran
    // from -320 to 340: the wider node was already there.
    expect(boundsOf(ids.text).x).toBe(60);
    expect(boundsOf(ids.operation).x).toBe(40);
    expect(useEditorStore.getState().announcement).toBe("Aligned 2 nodes");
  });

  it("waits for a third node before it will spread them out", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    act(() => {
      moveNodes({ [ids.export]: { x: 700, y: -120 } });
    });
    select([ids.text, ids.operation]);

    const bar = await screen.findByTestId("selection-action-bar");
    expect(
      within(bar).getByRole("button", { name: "Distribute horizontally" }),
    ).toHaveProperty("disabled", true);

    act(() => {
      useEditorStore.getState().setSelection({
        nodeIds: [ids.text, ids.operation, ids.export],
        edgeIds: [],
      });
    });
    expect(
      within(bar).getByRole("button", { name: "Distribute horizontally" }),
    ).toHaveProperty("disabled", false);
    fireEvent.click(
      within(bar).getByRole("button", { name: "Distribute horizontally" }),
    );
    // Three in a staggered row: the ends stay and the middle one takes the
    // middle it leaves — 220 pixels of room either side of it.
    expect(boundsOf(ids.text).x).toBe(-320);
    expect(boundsOf(ids.operation).x).toBe(180);
    expect(boundsOf(ids.export).x).toBe(700);
  });

  it("groups and deletes the selection from the bar", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    select([ids.text, ids.operation]);

    fireEvent.click(
      within(await screen.findByTestId("selection-action-bar")).getByRole(
        "button",
        {
          name: "Group",
        },
      ),
    );
    let canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.groups).toHaveLength(1);

    // Grouping leaves the frame and its members selected, so Delete takes the
    // whole lot.
    fireEvent.click(
      within(await screen.findByTestId("selection-action-bar")).getByRole(
        "button",
        {
          name: "Delete",
        },
      ),
    );
    canvas = useProjectStore.getState().moka!.canvas[0];
    // The group and its members went together, and the edges that touched them.
    expect(canvas.groups).toHaveLength(0);
    expect(canvas.nodes.some((node) => node.id === ids.text)).toBe(false);
    expect(canvas.nodes.some((node) => node.id === ids.operation)).toBe(false);
    expect(
      canvas.edges.some(
        (edge) => edge.id === ids.edgeTextOp || edge.id === ids.edgeOpExport,
      ),
    ).toBe(false);
  });
});
