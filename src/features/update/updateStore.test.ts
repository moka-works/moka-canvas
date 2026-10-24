import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicConfig } from "../../api";
import { useAppStore } from "../editor/stores/appStore";
import { useUpdateStore } from "./updateStore";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

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

function announce(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.3.2",
    date: "2026-10-24T12:00:00Z",
    body: "A new cut is here.",
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function setMode(mode: "web" | "tauri") {
  useAppStore.setState({
    config: { ...CONFIG, capabilities: { ...CONFIG.capabilities, mode } },
  });
}

beforeEach(() => {
  useUpdateStore.getState().reset();
  useAppStore.setState({ config: CONFIG });
  mocks.invoke.mockReset().mockResolvedValue(true);
  mocks.check.mockReset();
  mocks.relaunch.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});

describe("the update store", () => {
  it("never asks in a web runtime", async () => {
    setMode("web");

    await expect(useUpdateStore.getState().support()).resolves.toBe(false);
    await expect(useUpdateStore.getState().check()).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("does not check where the installation cannot update itself", async () => {
    mocks.invoke.mockResolvedValue(false);

    await expect(useUpdateStore.getState().check()).resolves.toBeNull();
    expect(mocks.check).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().supported).toBe(false);
  });

  it("settles on being up to date", async () => {
    mocks.check.mockResolvedValue(null);

    await expect(useUpdateStore.getState().check()).resolves.toBeNull();
    expect(useUpdateStore.getState().status).toBe("up-to-date");
    expect(useUpdateStore.getState().available).toBeNull();
  });

  it("keeps the version, date and notes of an available update", async () => {
    mocks.check.mockResolvedValue(announce());

    await expect(useUpdateStore.getState().check()).resolves.toEqual({
      version: "0.3.2",
      date: "2026-10-24T12:00:00Z",
      body: "A new cut is here.",
    });
    expect(useUpdateStore.getState().status).toBe("available");
    expect(useUpdateStore.getState().available?.version).toBe("0.3.2");
  });

  it("keeps the reason a failed check gave", async () => {
    mocks.check.mockRejectedValue(new Error("network unreachable"));

    await expect(useUpdateStore.getState().check()).resolves.toBeNull();
    expect(useUpdateStore.getState().status).toBe("error");
    expect(useUpdateStore.getState().error).toBe("network unreachable");
  });

  it("starts one request for two checks in flight", async () => {
    let answer: (value: unknown) => void = () => {};
    mocks.check.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    const first = useUpdateStore.getState().check();
    await expect(useUpdateStore.getState().check()).resolves.toBeNull();
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));
    answer(null);
    await expect(first).resolves.toBeNull();
  });

  it("reports download progress and relaunches when the package is in", async () => {
    const update = announce();
    update.downloadAndInstall.mockImplementation(
      async (onEvent: (event: unknown) => void) => {
        onEvent({ event: "Started", data: { contentLength: 10 } });
        onEvent({ event: "Progress", data: { chunkLength: 4 } });
        onEvent({ event: "Progress", data: { chunkLength: 6 } });
        onEvent({ event: "Finished" });
      },
    );
    mocks.check.mockResolvedValue(update);

    await useUpdateStore.getState().check();
    await useUpdateStore.getState().install();

    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().downloaded).toBe(10);
    expect(useUpdateStore.getState().total).toBe(10);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not download when the restart is declined", async () => {
    const update = announce();
    mocks.check.mockResolvedValue(update);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );

    await useUpdateStore.getState().check();
    await useUpdateStore.getState().install();

    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toBe("available");
  });

  it("keeps the reason an installation failed", async () => {
    const update = announce();
    update.downloadAndInstall.mockRejectedValue(new Error("read-only volume"));
    mocks.check.mockResolvedValue(update);

    await useUpdateStore.getState().check();
    await useUpdateStore.getState().install();

    expect(useUpdateStore.getState().status).toBe("error");
    expect(useUpdateStore.getState().error).toBe("read-only volume");
  });
});
