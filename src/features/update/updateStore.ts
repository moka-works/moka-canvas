import { create } from "zustand";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { i18n } from "../../shared/i18n";
import { useAppStore } from "../editor/stores/appStore";

export type UpdateStatus =
  "idle" | "checking" | "up-to-date" | "available" | "downloading" | "error";

export interface AvailableUpdate {
  version: string;
  date?: string;
  body?: string;
}

interface UpdateState {
  status: UpdateStatus;
  supported: boolean | null;
  available: AvailableUpdate | null;
  downloaded: number;
  total: number;
  error: string | null;

  support: () => Promise<boolean>;
  check: () => Promise<AvailableUpdate | null>;
  install: () => Promise<void>;
  reset: () => void;
}

// The plugin's Update carries methods and a Rust-side resource, so it stays
// outside the store; only what the interface draws is kept in state.
let pending: Update | null = null;
// A check awaits the support answer before it can mark the state, so the state
// alone would let a second click start a second request in that gap.
let checking = false;

const INITIAL = {
  status: "idle" as UpdateStatus,
  supported: null,
  available: null,
  downloaded: 0,
  total: 0,
  error: null,
};

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function askToInstall(): boolean {
  const ask = (globalThis as { confirm?: (message: string) => boolean })
    .confirm;
  // A runtime without a confirm has no way to ask, and installing without
  // asking is not an option: the app is about to restart.
  return ask === undefined
    ? false
    : ask(i18n.t("settings:update.confirmInstall"));
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  ...INITIAL,

  /**
   * Whether this runtime and installation can update themselves.
   *
   * The server says which runtime this is; the desktop command knows whether
   * the installation behind it can be replaced. A web runtime never asks the
   * command, and a development build answers false.
   */
  async support() {
    const known = get().supported;
    if (known !== null) return known;
    if (useAppStore.getState().config?.capabilities.mode !== "tauri") {
      set({ supported: false });
      return false;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const supported = await invoke<boolean>("updater_supported");
      set({ supported });
      return supported;
    } catch (error) {
      set({ supported: false, error: failureText(error) });
      return false;
    }
  },

  async check() {
    if (checking || get().status === "downloading") return null;
    checking = true;
    try {
      if (!(await get().support())) return null;

      const stale = pending;
      pending = null;
      await stale?.close().catch(() => {});
      set({
        status: "checking",
        available: null,
        downloaded: 0,
        total: 0,
        error: null,
      });
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        pending = update;
        if (update === null) {
          set({ status: "up-to-date" });
          return null;
        }
        const available: AvailableUpdate = {
          version: update.version,
          ...(update.date === undefined ? {} : { date: update.date }),
          ...(update.body === undefined ? {} : { body: update.body }),
        };
        set({ status: "available", available });
        return available;
      } catch (error) {
        set({ status: "error", error: failureText(error) });
        return null;
      }
    } finally {
      checking = false;
    }
  },

  async install() {
    const update = pending;
    if (update === null) {
      set({ status: "error", error: i18n.t("settings:update.noUpdate") });
      return;
    }
    if (get().status === "downloading") return;
    if (!askToInstall()) return;

    set({ status: "downloading", downloaded: 0, total: 0, error: null });
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (get().status !== "downloading") return;
        if (event.event === "Started") {
          set({ total: event.data.contentLength ?? 0 });
        } else if (event.event === "Progress") {
          set((state) => ({
            downloaded: state.downloaded + event.data.chunkLength,
          }));
        }
      });
      // Windows hands over to the installer and exits; macOS and Linux have
      // replaced the bundle and need the app started again from here.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      set({ status: "error", error: failureText(error) });
    }
  },

  reset() {
    pending = null;
    checking = false;
    set(INITIAL);
  },
}));
