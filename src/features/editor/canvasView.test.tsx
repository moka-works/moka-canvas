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
import { useAppearance } from "./stores/appearance";
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

function canvas() {
  return useProjectStore.getState().moka!.canvas[0];
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useAppearance.setState({ theme: "graphite" });
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

describe("the canvas's own view settings", () => {
  it("writes the background into the document, once per change", async () => {
    await openGolden();
    // The inspector is open on an empty selection, so the canvas itself is
    // what it has to describe.
    const background = screen.getByRole("group", { name: "Canvas background" });
    expect(
      within(background)
        .getByRole("button", { name: "Dots" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    const before = useHistoryStore.getState().undoStack.length;
    fireEvent.click(within(background).getByRole("button", { name: "Blank" }));
    expect(canvas().settings.background).toBe("blank");
    expect(useHistoryStore.getState().undoStack.length).toBe(before + 1);
    expect(
      within(background)
        .getByRole("button", { name: "Blank" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // Asking again for what is already drawn writes nothing.
    fireEvent.click(within(background).getByRole("button", { name: "Blank" }));
    expect(useHistoryStore.getState().undoStack.length).toBe(before + 1);
  });

  it("takes the minimap down and puts it back", async () => {
    await openGolden();
    const toggle = screen.getByRole("button", { name: "Show minimap" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toggle);
    expect(canvas().settings.showMinimap).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(canvas().settings.showMinimap).toBe(true);
  });
});

describe("choosing the palette a canvas is drawn in", () => {
  it("keeps the choice on this machine rather than in the document", async () => {
    await openGolden();
    const group = within(screen.getByRole("group", { name: "Theme" }));

    fireEvent.click(group.getByRole("button", { name: "Paper" }));

    expect(useAppearance.getState().theme).toBe("paper");
    expect(localStorage.getItem("moka-canvas:canvas-theme")).toBe("paper");
    expect(
      group.getByRole("button", { name: "Paper" }).getAttribute("aria-pressed"),
    ).toBe("true");
    // Nothing about it reaches the project, so nobody else opens it in paper.
    expect(canvas().settings).toEqual({
      background: "dots",
      showMinimap: true,
      snapToGrid: true,
    });
  });
});
