// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PublicConfig } from "../../api";
import { useAppStore } from "../editor/stores/appStore";
import {
  lastUpdateCheck,
  markUpdateChecked,
  updateCheckDue,
} from "./updateCheck";
import { UpdateStartupCheck } from "./UpdateStartupCheck";
import { useUpdateStore } from "./updateStore";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  check: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
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

function announce() {
  return {
    version: "0.3.2",
    date: "2026-10-24T12:00:00Z",
    body: "A new cut is here.",
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useUpdateStore.getState().reset();
  useAppStore.setState({
    config: CONFIG,
    phase: "launcher",
    pushToast: vi.fn(),
  });
  mocks.invoke.mockReset().mockResolvedValue(true);
  mocks.check.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("when a startup check is due", () => {
  it("runs without a remembered check", () => {
    expect(updateCheckDue(1_000, null)).toBe(true);
  });

  it("waits a day after one", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(updateCheckDue(day - 1_000, 1_000)).toBe(false);
    expect(updateCheckDue(1_000 + day, 1_000)).toBe(true);
  });

  it("ignores a timestamp from the future", () => {
    expect(updateCheckDue(1_000, 2_000)).toBe(false);
  });
});

describe("the startup check", () => {
  it("says nothing in a web runtime", async () => {
    useAppStore.setState({
      config: {
        ...CONFIG,
        capabilities: { ...CONFIG.capabilities, mode: "web" },
      },
    });

    render(<UpdateStartupCheck />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("asks once and offers to open the update", async () => {
    mocks.check.mockResolvedValue(announce());
    const pushToast = vi.fn();
    useAppStore.setState({ pushToast });

    render(<UpdateStartupCheck />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0][0]).toBe("info");
    expect(pushToast.mock.calls[0][1]).toBe("Moka Canvas 0.3.2 is available.");
    expect(lastUpdateCheck()).not.toBeNull();
  });

  it("does not ask again within the day", async () => {
    markUpdateChecked(Date.now());

    render(<UpdateStartupCheck />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("leaves a failed silent check out of the toast", async () => {
    mocks.check.mockRejectedValue(new Error("offline"));
    const pushToast = vi.fn();
    useAppStore.setState({ pushToast });

    render(<UpdateStartupCheck />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(pushToast).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().error).toBe("offline");
    expect(lastUpdateCheck()).not.toBeNull();
  });
});
