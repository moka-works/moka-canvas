/**
 * The picture descriptions being read back, by the picture they are about.
 *
 * A description is one streaming ask of a text model, shown as it arrives and
 * filed as a text node when it is whole. The ask belongs to the picture rather
 * than to the dialog: a reader who closes the dialog has stopped reading, not
 * stopped the answer they paid for, so the stream goes on writing here and the
 * dialog opened again on the same picture shows it — still arriving, or whole
 * and already filed. Letting go is a thing of its own, said with Escape or by
 * asking again.
 */

import { create } from "zustand";

import { generateApi } from "../../../api/generate";
import {
  describeDefaultPrompt,
  describeFramingPrompt,
} from "../../../shared/prompts";
import { i18n } from "../../../shared/i18n";
import { fileDescription } from "../interactions/actions";
import { useEditorStore } from "./editorStore";

/** What is asked before anybody has said otherwise. */
export const START_QUESTION = describeDefaultPrompt();

/**
 * How the answer is framed: words a picture could be made from and nothing
 * around them, rather than the standing instruction's answer shape.
 */
const FRAMING = describeFramingPrompt();

/** What one picture's dialog is holding. */
export interface DescribeSession {
  question: string;
  said: string;
  failed: string | null;
  busy: boolean;
}

interface DescribeSessionsState {
  sessions: Record<string, DescribeSession>;
  /** Opens the words about one picture: those already held, or a fresh start. */
  open: (nodeId: string, assetId: string) => string;
  patch: (key: string, patch: Partial<DescribeSession>) => void;
  /** Reads the picture back as words, filing what comes home. */
  ask: (
    key: string,
    request: {
      nodeId: string;
      assetId: string;
      /** What the plate is called, for the node the words are filed in. */
      sourceName: string;
      /** The text model that answers; none is an ask that cannot be made. */
      model: string | null;
    },
  ) => void;
  /** Lets go of an answer still arriving, keeping the words that got that far. */
  abort: (key: string) => void;
  drop: (key: string) => void;
  reset: () => void;
}

/** The answers still arriving, by session key. */
const asks = new Map<string, AbortController>();

export function describeKey(nodeId: string, assetId: string): string {
  return `${nodeId}:${assetId}`;
}

export const useDescribeSessions = create<DescribeSessionsState>()(
  (set, get) => ({
    sessions: {},

    open(nodeId, assetId) {
      const key = describeKey(nodeId, assetId);
      if (get().sessions[key] !== undefined) return key;
      set((state) => ({
        sessions: {
          ...state.sessions,
          [key]: {
            question: START_QUESTION,
            said: "",
            failed: null,
            busy: false,
          },
        },
      }));
      return key;
    },

    patch(key, patch) {
      const held = get().sessions[key];
      if (held === undefined) return;
      set((state) => ({
        sessions: { ...state.sessions, [key]: { ...held, ...patch } },
      }));
    },

    ask(key, request) {
      const session = get().sessions[key];
      if (session === undefined || session.busy) return;
      const stop = new AbortController();
      asks.set(key, stop);
      set((state) => ({
        sessions: {
          ...state.sessions,
          [key]: { ...session, said: "", failed: null, busy: true },
        },
      }));
      const ours = () => asks.get(key) === stop;
      // Gathered beside the store rather than read out of it: an answer
      // arrives in pieces, and each piece is shown as it lands.
      let gathered = "";
      void (async () => {
        try {
          const answer = await generateApi.textStream(
            {
              capability: "text",
              ...(request.model === null ? {} : { model: request.model }),
              prompt: session.question.trim(),
              system: FRAMING,
              inputs: [{ role: "reference", assetId: request.assetId }],
            },
            (piece) => {
              gathered += piece;
              if (ours()) get().patch(key, { said: gathered });
            },
            stop.signal,
          );
          // The whole answer rather than the pieces shown: what gets filed is
          // what the server settled on, which is the aggregate of the stream.
          const words = (answer.text ?? gathered).trim();
          if (words === "") {
            if (ours()) {
              get().patch(key, {
                failed: i18n.t("editor:describe.nothingCameBack"),
              });
            }
            return;
          }
          const filed = fileDescription({
            nodeId: request.nodeId,
            sourceName: request.sourceName,
            words,
          });
          if (!ours()) return;
          if (filed) {
            // The words are in the project now, so there is nothing left for
            // this session to hold — and a dialog still open on this picture
            // has been answered and may close.
            get().drop(key);
            const current = useEditorStore.getState().pictureTool;
            if (
              current?.tool === "describe" &&
              current.nodeId === request.nodeId &&
              current.assetId === request.assetId
            ) {
              useEditorStore.getState().closePictureTool();
            }
          } else {
            get().patch(key, {
              failed: i18n.t("editor:describe.wordsNotFiled"),
            });
          }
        } catch (problem) {
          // Let go of on purpose: nothing to report, and the words that
          // arrived stay to be read.
          if ((problem as Error).name === "AbortError") return;
          if (ours()) {
            get().patch(key, {
              failed:
                problem instanceof Error
                  ? problem.message
                  : i18n.t("editor:describe.pictureNotRead"),
            });
          }
        } finally {
          if (ours()) {
            asks.delete(key);
            get().patch(key, { busy: false });
          }
        }
      })();
    },

    abort(key) {
      const stop = asks.get(key);
      if (stop === undefined) return;
      asks.delete(key);
      stop.abort();
      // The stream's own ending no longer belongs to this session, so it is
      // said here that the reading has stopped.
      get().patch(key, { busy: false });
    },

    drop(key) {
      get().abort(key);
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[key];
        return { sessions };
      });
    },

    reset() {
      for (const stop of asks.values()) stop.abort();
      asks.clear();
      set({ sessions: {} });
    },
  }),
);
