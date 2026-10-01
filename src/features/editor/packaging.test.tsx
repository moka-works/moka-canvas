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
import type { MokaFile, SelfCheckReport } from "../../shared/domain";
import { editTextContent } from "./interactions/actions";
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

/** What the export endpoint is told, as the server reads it. */
interface ExportBody {
  destination?: string;
  allowIncomplete?: boolean;
  includePersonalHistory?: boolean;
  onlyReferencedAssets?: boolean;
}

interface RouteOptions {
  selfCheck?: SelfCheckReport;
  /** When set, the first export fails with this problem body. */
  exportFailure?: { code: string; message: string; status: number };
  /** A document other than the shared fixture, for cases it cannot describe. */
  moka?: MokaFile;
}

function route(options: RouteOptions = {}) {
  let exportAttempts = 0;
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
        moka: options.moka ?? buildGoldenMokaFile(),
        selfCheck: options.selfCheck ?? { ok: true, issues: [] },
      });
    }
    if (url === "/api/v1/projects/current/runs") return json([]);
    if (url === "/api/v1/projects/current/commands") {
      return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
    }
    // The save question the browser has to draw for itself: the folder asked
    // for, holding nothing but the folders, resolved where it was asked.
    if (url.startsWith("/api/v1/filesystem?")) {
      const asked = new URL(`http://localhost${url}`);
      const where = asked.searchParams.get("path") ?? "";
      return json({
        path: where,
        parent: "/tmp",
        entries: [],
        truncated: false,
      });
    }
    if (url.includes("/content") && init?.method === "PUT") {
      return json(
        {
          entry: {
            id: url.split("/assets/")[1].split("/")[0],
            name: "lake.png",
            path: "assets/images/lake-00000000.png",
            mime: "image/png",
            bytes: 128,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
          revision: 7,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        200,
      );
    }
    if (url === "/api/v1/projects/current/export" && init?.method === "POST") {
      exportAttempts += 1;
      if (options.exportFailure && exportAttempts === 1) {
        return json(options.exportFailure, options.exportFailure.status);
      }
      const body = JSON.parse(String(init.body ?? "{}")) as ExportBody;
      return json({
        destination: "/tmp/golden/pack.zip",
        entries: 5,
        bytes: 4096,
        incomplete: body.allowIncomplete === true,
      });
    }
    return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
  };
}

async function openGolden(options: RouteOptions = {}) {
  const handler = route(options);
  fetchMock.mockImplementation((input, init) =>
    Promise.resolve(handler(String(input), init as RequestInit)),
  );
  render(<App />);
  const recent = await screen.findByText("Golden Fixture");
  fireEvent.click(recent);
  fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
}

function missingImageCheck(): SelfCheckReport {
  const ids = goldenNodeIds();
  return {
    ok: false,
    issues: [
      {
        assetId: ids.assetImage,
        name: "lake.png",
        expectedPath: "assets/images/lake-00000000.png",
        reason: "missing",
        referencingNodes: [
          {
            canvasId: ids.canvasMain,
            nodeId: ids.image,
            title: "Reference image",
          },
        ],
      },
    ],
  };
}

function exportCalls(): { body: ExportBody }[] {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url) === "/api/v1/projects/current/export" &&
        (init as RequestInit)?.method === "POST",
    )
    .map(([, init]) => ({
      body: JSON.parse(
        String((init as RequestInit).body ?? "{}"),
      ) as ExportBody,
    }));
}

/**
 * The fixture's registry holds only what its nodes point at, so it cannot ask
 * the question this one is for: what would ticking "only the placed assets"
 * leave on the shelf. The shared fixture stays as it is — the Rust contract
 * reads the same bytes — and the case is built beside it instead.
 */
function goldenWithShelfAsset(bytes: number): MokaFile {
  const moka = buildGoldenMokaFile();
  return {
    ...moka,
    resources: {
      ...moka.resources,
      images: [
        ...moka.resources.images,
        {
          id: "shelf-asset",
          name: "unused-plate.png",
          path: "assets/images/unused-plate.png",
          mime: "image/png",
          bytes,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  };
}

/** Ask to export, and return the question that answers back first. */
async function askToExport(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const menu = await screen.findByRole("menu", { name: "Export" });
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Export project" }),
  );
  return screen.findByRole("dialog");
}

/** The name a package is offered under, in the project's own output folder. */
const PACKAGE_PATH = "/tmp/golden/output/Golden Fixture.mokapkg.zip";

/**
 * Answers the save question the browser draws for itself: the folder the
 * dialog opens at is accepted under the name it offers.
 */
async function chooseSavePath(): Promise<void> {
  const choose = await screen.findByTestId("path-browser-choose");
  await vi.waitFor(() => expect(choose).toHaveProperty("disabled", false));
  expect(screen.getByTestId("path-browser-name")).toHaveProperty(
    "value",
    "Golden Fixture.mokapkg.zip",
  );
  fireEvent.click(choose);
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
    inputPick: null,
    assetDeletePrompt: null,
    previewAssetId: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("missing-asset recovery", () => {
  it("locating a replacement resolves the issue and opens the project", async () => {
    const ids = goldenNodeIds();
    await openGolden({ selfCheck: missingImageCheck() });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("lake.png");

    fireEvent.click(screen.getByRole("button", { name: "Locate…" }));
    const input = dialog.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, {
      target: { files: [new File(["x"], "lake.png", { type: "image/png" })] },
    });

    await screen.findByText("All referenced assets are accounted for");
    const putCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes(`/assets/${ids.assetImage}/content`) &&
        (init as RequestInit)?.method === "PUT",
    );
    expect(putCall).toBeTruthy();
    expect((putCall![1] as RequestInit).body).toBeInstanceOf(FormData);
    expect(useProjectStore.getState().selfCheck?.ok).toBe(true);
    expect(dialog.textContent).toContain("Restored");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open project" }),
    );
    expect(useAppStore.getState().phase).toBe("editing");
    // The restored asset is no longer flagged broken on the shelf, which is
    // behind the assets face of the left column. The board is a chunk that has
    // only just arrived and the column turns over with it, so turning it over
    // is waited for rather than done and read the same instant: under a loaded
    // machine the commit that shows the face can land after the next line, and
    // a click can land on a node React is replacing on the way. The wait is
    // longer than the suite's usual patience because the whole board chunk is
    // being compiled and let in while the other workers hammer the machine.
    await vi.waitFor(
      () => {
        fireEvent.click(screen.getByTestId("left-tab-assets"));
        expect(screen.queryByText("lake.png")).not.toBeNull();
      },
      { timeout: 5_000 },
    );
    const row = screen.getByText("lake.png").closest(".resource-row");
    expect(row?.textContent).not.toContain("broken");
  });

  it("keeps the issue and reports the error when replacement fails", async () => {
    await openGolden({ selfCheck: missingImageCheck() });
    const dialog = await screen.findByRole("alertdialog");
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/content") && (init as RequestInit)?.method === "PUT") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: "UNSUPPORTED_MEDIA_TYPE",
              message: "Unsupported media type",
              status: 415,
            }),
            { status: 415, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        route({ selfCheck: missingImageCheck() })(url, init as RequestInit),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Locate…" }));
    const input = dialog.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "lake.txt", { type: "text/plain" })] },
    });

    await screen.findByRole("alert");
    expect(dialog.textContent).toContain("Unsupported media type");
    expect(dialog.textContent).toContain("Open with missing assets");
    expect(useProjectStore.getState().selfCheck?.ok).toBe(false);
  });
});

describe("export package", () => {
  it("says what is going into the package before one is written", async () => {
    await openGolden({ moka: goldenWithShelfAsset(3145728) });
    await screen.findByTestId("canvas-tab-Canvas 1");
    const asked = await askToExport();

    // What is never in a project package at all is said here rather than left
    // to be discovered by whoever opens it.
    expect(asked.textContent).toContain("never exported");
    // The cost of the second choice is known before the choice is made.
    expect(asked.textContent).toContain(
      "Leaves out 1 unreferenced asset (3.0 MB)",
    );
    expect(exportCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Export package" }));
    await chooseSavePath();
    await vi.waitFor(() => {
      expect(exportCalls()).toHaveLength(1);
    });
    // Nothing ticked is the work package: the work, and no record of the
    // machine that made it — and it lands where the save dialog said.
    expect(exportCalls()[0].body.destination).toBe(PACKAGE_PATH);
    expect(exportCalls()[0].body.includePersonalHistory).toBeUndefined();
    expect(exportCalls()[0].body.onlyReferencedAssets).toBeUndefined();
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("offers nothing to leave out when every asset is placed", async () => {
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    const asked = await askToExport();

    expect(asked.textContent).toContain(
      "Every asset in this project is placed",
    );
    // A choice that would change nothing is not a choice to make.
    expect(
      screen.getByRole("checkbox", {
        name: /Only the assets a node points at/,
      }),
    ).toHaveProperty("disabled", true);
  });

  it("carries both choices in the request that makes the package", async () => {
    await openGolden({ moka: goldenWithShelfAsset(3145728) });
    await screen.findByTestId("canvas-tab-Canvas 1");
    await askToExport();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Include my run history/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Only the assets a node points at/,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Export package" }));
    await chooseSavePath();
    await vi.waitFor(() => {
      expect(exportCalls()).toHaveLength(1);
    });
    expect(exportCalls()[0].body).toEqual({
      destination: PACKAGE_PATH,
      includePersonalHistory: true,
      onlyReferencedAssets: true,
    });
  });

  it("backing out of the question writes nothing", async () => {
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    await askToExport();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(exportCalls()).toHaveLength(0);
    expect(useAppStore.getState().phase).toBe("editing");
  });

  it("offers an incomplete export when assets are missing", async () => {
    await openGolden({
      exportFailure: {
        code: "ASSET_MISSING",
        message: "Export blocked: 1 referenced asset(s) are missing",
        status: 404,
      },
    });
    await screen.findByTestId("canvas-tab-Canvas 1");
    await askToExport();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Include my run history/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export package" }));
    await chooseSavePath();

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("1 referenced asset");
    expect(exportCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
    await vi.waitFor(() => {
      expect(exportCalls()).toHaveLength(2);
    });
    expect(exportCalls()[1].body.allowIncomplete).toBe(true);
    // A retry after a refusal is the same export, not a fresh one with the
    // questions asked again from scratch — the chosen path least of all.
    expect(exportCalls()[1].body.includePersonalHistory).toBe(true);
    expect(exportCalls()[1].body.destination).toBe(
      exportCalls()[0].body.destination,
    );
    await vi.waitFor(() => {
      expect(
        useAppStore
          .getState()
          .toasts.some(
            (toast) =>
              toast.kind === "success" &&
              toast.message.includes("flagged incomplete"),
          ),
      ).toBe(true);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cancel leaves the project untouched", async () => {
    await openGolden({
      exportFailure: {
        code: "ASSET_MISSING",
        message: "Export blocked: 1 referenced asset(s) are missing",
        status: 404,
      },
    });
    await screen.findByTestId("canvas-tab-Canvas 1");
    await askToExport();
    fireEvent.click(screen.getByRole("button", { name: "Export package" }));
    await chooseSavePath();
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(exportCalls()).toHaveLength(1);
    expect(useAppStore.getState().phase).toBe("editing");
  });

  it("backing out of the save question writes nothing", async () => {
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    await askToExport();

    fireEvent.click(screen.getByRole("button", { name: "Export package" }));
    const choose = await screen.findByTestId("path-browser-choose");
    await vi.waitFor(() => expect(choose).toHaveProperty("disabled", false));
    fireEvent.click(
      within(screen.getByTestId("path-browser")).getByRole("button", {
        name: "Cancel",
      }),
    );

    expect(screen.queryByTestId("path-browser")).toBeNull();
    expect(exportCalls()).toHaveLength(0);
    // The question before it still stands, since nothing was answered.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useAppStore.getState().phase).toBe("editing");
  });
});

describe("unsaved-work guard", () => {
  function makeUnsavedEdit() {
    const ids = goldenNodeIds();
    act(() => {
      editTextContent(ids.text, "A changed brief");
    });
    expect(useProjectStore.getState().pending.length).toBeGreaterThan(0);
  }

  it("asks before leaving and discard drops the changes", async () => {
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    makeUnsavedEdit();

    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Projects" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Unsaved changes");
    expect(useAppStore.getState().phase).toBe("editing");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(useAppStore.getState().phase).toBe("editing");

    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Projects" }));
    await screen.findByRole("alertdialog");
    // The debounced write can go out while the question is on screen — the
    // guard itself says so — and what discard promises is that closing sends
    // nothing of what is left. So the reading is taken at the door.
    const sentBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/projects/current/commands"),
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
    expect(useAppStore.getState().phase).toBe("launcher");
    expect(useProjectStore.getState().moka).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/projects/current/commands"),
      ),
    ).toHaveLength(sentBefore);
  });

  it("save and close flushes the pending changes first", async () => {
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    makeUnsavedEdit();

    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Projects" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Save and close" }));

    await vi.waitFor(() => {
      expect(useAppStore.getState().phase).toBe("launcher");
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes("/projects/current/commands") &&
          (init as RequestInit)?.method === "POST",
      ),
    ).toBe(true);
  });

  it("keeps every way out where the work saved itself while it was open", async () => {
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    makeUnsavedEdit();

    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Projects" }));
    const raised = await screen.findByRole("alertdialog");
    expect(raised.textContent).toContain("will be lost");

    // Saving is debounced, so what the guard was raised for can be written
    // while the question is still on screen.
    act(() => {
      useProjectStore.setState({ pending: [], saveStatus: "saved" });
    });

    const asked = screen.getByRole("alertdialog");
    expect(asked.textContent).toContain("saved while this was open");
    expect(asked.textContent).not.toContain("will be lost");
    // A way out that moves is one the reader has to look for again.
    expect(screen.getByRole("button", { name: "Save and close" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Discard and close" }),
    ).toBeTruthy();
  });

  it("conflicted state blocks saving but keeps the export escape hatch", async () => {
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    makeUnsavedEdit();
    act(() => {
      useProjectStore.setState({ saveStatus: "conflicted" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Projects" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("revision conflict");
    expect(
      screen.getByRole("button", { name: "Save and close" }),
    ).toHaveProperty("disabled", true);

    fireEvent.click(
      screen.getByRole("button", { name: "Export copy and close" }),
    );
    // The guard hands over to the same question an export from the topbar
    // asks, and the project closes once the answer has been written.
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Export package" }));
    await chooseSavePath();
    await vi.waitFor(() => {
      expect(useAppStore.getState().phase).toBe("launcher");
    });
    expect(exportCalls()).toHaveLength(1);
    // A conflicted project cannot flush; the export ships the saved revision.
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/projects/current/commands"),
      ),
    ).toBe(false);
  });
});
