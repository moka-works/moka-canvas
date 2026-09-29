// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "../../App";
import { buildGoldenMokaFile } from "../../shared/domain/fixtures";
import { useAppStore } from "./stores/appStore";
import { useHistoryStore } from "./stores/historyStore";
import { usePanelFolds } from "./stores/panelFolds";
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

function route(url: string): Response {
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
  return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
}

async function openGolden() {
  fetchMock.mockImplementation((input) =>
    Promise.resolve(route(String(input))),
  );
  render(<App />);
  fireEvent.click(await screen.findByText("Golden Fixture"));
  fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
  await screen.findByTestId("canvas-tab-Canvas 1");
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  usePanelFolds.setState({ left: false, right: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the corners that fold the columns away", () => {
  it("gives each column a corner of its own", async () => {
    await openGolden();

    // Each column carries its fold in the corner it stands in, and says which
    // column it would fold away to a reader who cannot see the triangle.
    const left = screen.getByTestId("panel-fold-left");
    const right = screen.getByTestId("panel-fold-right");
    expect(left.getAttribute("aria-label")).toBe("Fold the project column");
    expect(right.getAttribute("aria-label")).toBe(
      "Fold the column beside the canvas",
    );
    expect(left.getAttribute("aria-expanded")).toBe("true");
    expect(left.getAttribute("aria-controls")).toBe("panel-left");
    expect(right.getAttribute("aria-controls")).toBe("panel-right");
    expect(document.getElementById("panel-left")).toBeTruthy();
    expect(document.getElementById("panel-right")).toBeTruthy();
  });

  it("takes a column away and leaves its corner behind to bring it back", async () => {
    await openGolden();

    fireEvent.click(screen.getByTestId("panel-fold-left"));
    expect(usePanelFolds.getState().left).toBe(true);
    // The column and the edge it was dragged by are both gone, and the corner
    // of the window it stood in now offers the way back.
    expect(document.getElementById("panel-left")).toBeNull();
    expect(screen.queryByTestId("panel-resizer-left")).toBeNull();
    expect(screen.queryByTestId("panel-fold-left")).toBeNull();
    const unfold = screen.getByTestId("panel-unfold-left");
    expect(unfold.getAttribute("aria-label")).toBe("Open the project column");
    expect(unfold.getAttribute("aria-expanded")).toBe("false");
    // The column on the other side was not asked about, so it still stands.
    expect(document.getElementById("panel-right")).toBeTruthy();

    fireEvent.click(unfold);
    expect(usePanelFolds.getState().left).toBe(false);
    expect(document.getElementById("panel-left")).toBeTruthy();
    expect(screen.getByTestId("panel-resizer-left")).toBeTruthy();
    expect(screen.queryByTestId("panel-unfold-left")).toBeNull();
  });

  it("folds the column beside the canvas the same way round", async () => {
    await openGolden();

    fireEvent.click(screen.getByTestId("panel-fold-right"));
    expect(usePanelFolds.getState().right).toBe(true);
    expect(document.getElementById("panel-right")).toBeNull();
    expect(screen.queryByTestId("panel-resizer-right")).toBeNull();
    expect(
      screen.getByTestId("panel-unfold-right").getAttribute("aria-label"),
    ).toBe("Open the column beside the canvas");

    fireEvent.click(screen.getByTestId("panel-unfold-right"));
    expect(document.getElementById("panel-right")).toBeTruthy();
    expect(screen.getByTestId("panel-resizer-right")).toBeTruthy();
  });

  it("gives the canvas the whole row when both columns are away", async () => {
    await openGolden();

    fireEvent.click(screen.getByTestId("panel-fold-left"));
    fireEvent.click(screen.getByTestId("panel-fold-right"));

    // Nothing is left standing beside the canvas but the two corners that
    // would bring the columns back, and what was folded is written down for
    // the next time the editor is opened on this machine.
    expect(document.getElementById("panel-left")).toBeNull();
    expect(document.getElementById("panel-right")).toBeNull();
    expect(screen.queryByTestId("panel-resizer-left")).toBeNull();
    expect(screen.queryByTestId("panel-resizer-right")).toBeNull();
    expect(screen.getByTestId("panel-unfold-left")).toBeTruthy();
    expect(screen.getByTestId("panel-unfold-right")).toBeTruthy();
    expect(screen.getByTestId("canvas-host")).toBeTruthy();
    expect(
      JSON.parse(localStorage.getItem("moka-canvas:panel-folds")!),
    ).toEqual({ left: true, right: true });
  });
});
