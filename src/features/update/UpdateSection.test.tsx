// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PublicConfig } from "../../api";
import { useAppStore } from "../editor/stores/appStore";
import { UpdateSection } from "./UpdateSection";
import { useUpdateStore } from "./updateStore";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const CONFIG: PublicConfig = {
  productName: "Moka Canvas",
  maxUploadBytes: 1,
  allowedMediaTypes: [],
  limits: {
    maxNodesPerCanvas: 1,
    maxEdgesPerCanvas: 1,
    maxCanvasesPerProject: 1,
    maxPackageBytes: 1,
    maxPackageEntries: 1,
  },
  capabilities: { mode: "tauri", executors: [], assetCategories: [] },
};

beforeEach(() => {
  useUpdateStore.getState().reset();
  useAppStore.setState({ config: CONFIG });
  mocks.invoke.mockReset().mockResolvedValue(true);
  mocks.getVersion.mockReset().mockResolvedValue("0.3.1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the update row", () => {
  it("is absent in a web runtime", async () => {
    useAppStore.setState({
      config: {
        ...CONFIG,
        capabilities: { ...CONFIG.capabilities, mode: "web" },
      },
    });

    render(<UpdateSection />);

    await vi.waitFor(() =>
      expect(useUpdateStore.getState().supported).toBe(false),
    );
    expect(screen.queryByRole("region", { name: "Application updates" })).toBe(
      null,
    );
  });

  it("is absent where the installation cannot update itself", async () => {
    mocks.invoke.mockResolvedValue(false);

    render(<UpdateSection />);

    await vi.waitFor(() =>
      expect(useUpdateStore.getState().supported).toBe(false),
    );
    expect(screen.queryByText("Check for updates")).toBeNull();
  });

  it("draws the installed version once the installation can update", async () => {
    render(<UpdateSection />);

    expect(await screen.findByText("Version 0.3.1")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeTruthy();
  });

  it("draws an available version and its notes as text", async () => {
    useUpdateStore.setState({
      supported: true,
      status: "available",
      available: {
        version: "0.3.2",
        date: "2026-10-24T12:00:00Z",
        body: "A new cut is here.\n<b>Not markup</b>",
      },
    });

    render(<UpdateSection />);

    expect(await screen.findByText("Version 0.3.2 is available.")).toBeTruthy();
    expect(screen.getByText("Released Oct 24, 2026")).toBeTruthy();
    expect(screen.getByText(/Not markup/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Download and install" }),
    ).toBeTruthy();
  });

  it("shows download progress", async () => {
    useUpdateStore.setState({
      supported: true,
      status: "downloading",
      downloaded: 4,
      total: 10,
    });

    render(<UpdateSection />);

    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByText("Downloading 40%")).toBeTruthy();
  });

  it("keeps a failure's own words", async () => {
    useUpdateStore.setState({
      supported: true,
      status: "error",
      error: "network unreachable",
    });

    render(<UpdateSection />);

    expect(
      await screen.findByText(
        "The update could not be completed: network unreachable",
      ),
    ).toBeTruthy();
  });

  it("says why the installed version could not be read", async () => {
    mocks.getVersion.mockRejectedValue(new Error("permission denied"));

    render(<UpdateSection />);

    expect(
      await screen.findByText(
        "The installed version could not be read: permission denied",
      ),
    ).toBeTruthy();
  });
});
