// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "../../App";
import { buildGoldenMokaFile } from "../../shared/domain/fixtures";
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
    // The save question the browser draws for itself, answered where asked.
    if (url.startsWith("/api/v1/filesystem?")) {
      const asked = new URL(`http://localhost${url}`);
      return Promise.resolve(
        json({
          path: asked.searchParams.get("path") ?? "",
          parent: "/tmp",
          entries: [],
          truncated: false,
        }),
      );
    }
    if (url.startsWith("/api/v1/filesystem/file?")) {
      return Promise.resolve(json({ path: "saved", bytes: 3 }));
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

/** Opens the export menu and asks for the picture. */
function exportAsImage(): void {
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  fireEvent.click(
    within(screen.getByRole("menu", { name: "Export" })).getByRole("menuitem", {
      name: "Export as image",
    }),
  );
}

/** Answers the save dialog where it opens, under the name it offers. */
async function chooseSavePath(): Promise<void> {
  const choose = await screen.findByTestId("path-browser-choose");
  await waitFor(() => expect(choose).toHaveProperty("disabled", false));
  fireEvent.click(choose);
}

/** The write the picture became, as the server was told it. */
function writes(): { url: string; body: BodyInit | null | undefined }[] {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url).startsWith("/api/v1/filesystem/file?") &&
        (init as RequestInit)?.method === "PUT",
    )
    .map(([url, init]) => ({
      url: String(url),
      body: (init as RequestInit).body,
    }));
}

/**
 * Stands in for the mounted canvas, which jsdom cannot build. Only the
 * snapshot the export reaches for is real; the rest answers harmlessly.
 */
function stubCanvas(snapshot: () => Promise<Blob>) {
  registerController({
    renderSnapshot: snapshot,
  } as unknown as LeaferEditorController);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("exporting the canvas as an image", () => {
  it("asks where the picture goes, and writes it there", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const snapshot = vi.fn(async () => blob);
    await openGolden();
    stubCanvas(snapshot);

    exportAsImage();
    await chooseSavePath();

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(snapshot).toHaveBeenCalledTimes(1);
    const [written] = writes();
    const asked = new URL(`http://localhost${written.url}`);
    expect(asked.searchParams.get("path")).toBe(
      "/tmp/golden/output/Canvas 1.png",
    );
    expect(written.body).toBe(blob);
    // The file is on the machine the server runs on, so the notice says where
    // rather than pretending a download happened.
    await waitFor(() =>
      expect(useAppStore.getState().toasts).toMatchObject([
        {
          kind: "success",
          message: "Canvas image saved to /tmp/golden/output/Canvas 1.png",
        },
      ]),
    );
  });

  it("writes nothing when the save question is backed out of", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    await openGolden();
    stubCanvas(vi.fn(async () => blob));

    exportAsImage();
    const choose = await screen.findByTestId("path-browser-choose");
    await waitFor(() => expect(choose).toHaveProperty("disabled", false));
    fireEvent.click(
      within(screen.getByTestId("path-browser")).getByRole("button", {
        name: "Cancel",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("path-browser")).toBeNull(),
    );
    expect(writes()).toHaveLength(0);
    expect(useAppStore.getState().toasts).toEqual([]);
  });

  it("shows why when the canvas cannot draw the picture", async () => {
    const snapshot = vi.fn(async () => {
      throw new Error("There is nothing to export yet");
    });
    await openGolden();
    stubCanvas(snapshot);

    exportAsImage();
    await waitFor(() =>
      expect(useAppStore.getState().toasts).toMatchObject([
        { kind: "error", message: "There is nothing to export yet" },
      ]),
    );
    // The picture never came back, so nothing was ever asked.
    expect(screen.queryByTestId("path-browser")).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it("says the canvas is not ready while none is mounted", async () => {
    await openGolden();

    exportAsImage();
    await waitFor(() =>
      expect(useAppStore.getState().toasts).toMatchObject([
        { kind: "error", message: "The canvas is not ready" },
      ]),
    );
    expect(screen.queryByTestId("path-browser")).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});
