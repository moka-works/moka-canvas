// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import App from "../../App";
import { buildGoldenMokaFile } from "../../shared/domain/fixtures";
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

function route(): (url: string, init?: RequestInit) => Response {
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
        selfCheck: { ok: true, issues: [] },
        selfCheckVerified: true,
      });
    }
    if (url === "/api/v1/projects/current/runs") return json([]);
    if (url === "/api/v1/projects/current/commands") {
      return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
    }
    if (url === "/api/v1/projects/current/assets" && init?.method === "POST") {
      return json({
        entry: {
          id: "dropped-asset",
          name: "drop.png",
          path: "assets/images/drop-1.png",
          mime: "image/png",
          bytes: 12,
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        revision: 6,
        updatedAt: "2026-01-01T00:00:04.000Z",
      });
    }
    return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
  };
}

async function openGolden() {
  const handler = route();
  fetchMock.mockImplementation((input, init) =>
    Promise.resolve(handler(String(input), init as RequestInit)),
  );
  render(<App />);
  const recent = await screen.findByText("Golden Fixture");
  fireEvent.click(recent);
  fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
  await screen.findByTestId("canvas-tab-Canvas 1");
}

beforeEach(() => {
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
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    nodeMenu: null,
    contextMenu: null,
    assetDeletePrompt: null,
    previewAssetId: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("top bar", () => {
  it("keeps the whole project name on the tooltip the bar wears it with", async () => {
    await openGolden();

    // The name is held to a share of the bar and wears an ellipsis when it
    // outgrows it, so the whole of it stands on the tooltip.
    const name = within(screen.getByRole("banner")).getByText("Golden Fixture");
    expect(name.classList.contains("editor-project-name")).toBe(true);
    expect(name.getAttribute("title")).toBe("Golden Fixture");
  });

  it("offers the two exports under one button", async () => {
    await openGolden();

    // The bar carries the things that act on the whole document and none of
    // the things that act on a node: those live on the node and its menus.
    const topbar = screen.getByRole("banner");
    for (const gone of ["Add node", "Group", "Ungroup", "Import…"]) {
      expect(within(topbar).queryByRole("button", { name: gone })).toBeNull();
    }

    fireEvent.click(within(topbar).getByRole("button", { name: "Export" }));
    const menu = await screen.findByRole("menu", { name: "Export" });
    expect(
      within(menu).getByRole("menuitem", { name: "Export project" }),
    ).toBeTruthy();
    expect(
      within(menu).getByRole("menuitem", { name: "Export as image" }),
    ).toHaveProperty("disabled", false);

    // Choosing the project export asks what should travel with it.
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Export project" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Export package" }),
    ).toBeTruthy();
  });

  it("leaves the image export alone on a canvas with nothing on it", async () => {
    await openGolden();
    fireEvent.click(screen.getByRole("button", { name: "Canvas 2" }));
    await screen.findByTestId("canvas-tab-Canvas 2");

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const menu = await screen.findByRole("menu", { name: "Export" });
    expect(
      within(menu).getByRole("menuitem", { name: "Export as image" }),
    ).toHaveProperty("disabled", true);
  });
});
