import { create } from "zustand";
import {
  fetchHealth,
  fetchPublicConfig,
  type PublicConfig,
} from "../../../api";
import { PROVIDER_EXECUTOR_KEY } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";

export type AppPhase =
  | "booting"
  | "launcher"
  | "opening"
  | "editing"
  | "clip"
  | "story"
  | "assets"
  | "director"
  | "error";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  /** The one line that is always read, in the reader's language. */
  message: string;
  /**
   * The rest of what there was to say, when there was more than fits a line:
   * the whole of a provider's complaint rather than its first sentence. Kept
   * rather than cut, and shown when the reader chooses the toast.
   */
  detail?: string;
  /**
   * Where choosing the toast goes, for a report of something that has a place.
   * A toast is read and gone in a few seconds, so a reader who wants to see the
   * thing it named should not have to remember where it was put; the label is
   * what tells them choosing it leads somewhere rather than only away.
   */
  choice?: { label: string; go: () => void };
}

/** How long a one-line toast may run before the rest is kept for the click. */
const TOAST_SUMMARY_CHARS = 120;

/** The earliest a summary may be cut: less than this reads as a truncated word. */
const TOAST_EARLIEST_CUT = 24;

/** Where one sentence ends and the next begins, in either language. */
const SENTENCE_END = /[\n。！？!?]|\.\s/g;

/**
 * A message too long for one line, cut where a sentence ends.
 *
 * Only a sentence end is a place to cut: what a toast says is read out whole —
 * out of the live region, and in one suite off the element itself — so a
 * message cut mid-clause is read, and read back, wrong. A message with no
 * sentence end within reach is left whole and wraps.
 */
export function splitToastMessage(message: string): {
  message: string;
  detail?: string;
} {
  if (message.length <= TOAST_SUMMARY_CHARS) return { message };
  let cut = -1;
  for (const match of message.matchAll(SENTENCE_END)) {
    const at = (match.index ?? 0) + match[0].length;
    if (at > TOAST_SUMMARY_CHARS) break;
    if (at >= TOAST_EARLIEST_CUT) cut = at;
  }
  if (cut === -1) return { message };
  const detail = message.slice(cut).trim();
  if (detail === "") return { message };
  return { message: message.slice(0, cut).trim(), detail };
}

interface AppState {
  phase: AppPhase;
  config: PublicConfig | null;
  bootError: string | null;
  toasts: Toast[];
  boot: () => Promise<void>;
  setPhase: (phase: AppPhase) => void;
  pushToast: (
    kind: Toast["kind"],
    message: string,
    choice?: Toast["choice"],
    detail?: string,
  ) => void;
  dismissToast: (id: number) => void;
}

let nextToastId = 1;

export const useAppStore = create<AppState>()((set) => ({
  phase: "booting",
  config: null,
  bootError: null,
  toasts: [],

  async boot() {
    set({ phase: "booting", bootError: null });
    try {
      const [config] = await Promise.all([fetchPublicConfig(), fetchHealth()]);
      set({ config, phase: "launcher" });
    } catch (error) {
      set({
        phase: "error",
        bootError:
          error instanceof Error
            ? error.message
            : i18n.t("editor:stores.localProcessUnreachable"),
      });
    }
  },

  setPhase(phase) {
    set({ phase });
  },

  pushToast(kind, message, choice, detail) {
    const id = nextToastId++;
    // The line is the reader's own whatever else is carried, so it is cut —
    // where a sentence ends — even when a caller handed over the rest: what is
    // under the toast is everything there was to say, in order.
    const said = splitToastMessage(message);
    const under = [said.detail, detail]
      .filter((part): part is string => part !== undefined && part !== "")
      .join("\n");
    set((state) => ({
      toasts: [
        ...state.toasts,
        {
          id,
          kind,
          message: said.message,
          ...(under === "" ? {} : { detail: under }),
          choice,
        },
      ],
    }));
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

/**
 * Whether this deployment will drive a generation node at all.
 *
 * Read from the executor list the server publishes rather than from an offline
 * switch of the client's own: the server validates a run against that same list,
 * so a control offered here and refused there is a click whose only product is
 * an error. Nothing known yet reads as available, because a control that is dead
 * until the config arrives fails for no reason a user can see.
 */
export function useGenerationAvailable(): boolean {
  return useAppStore(
    (state) =>
      state.config === null ||
      state.config.capabilities.executors.includes(PROVIDER_EXECUTOR_KEY),
  );
}

/**
 * Why a generation control is dead where nothing can reach a provider.
 *
 * Read at each use rather than once, so a reader who switches the interface
 * language hears the new one without a reload.
 */
export function generationUnavailable(): string {
  return i18n.t("editor:stores.generationUnavailable");
}
