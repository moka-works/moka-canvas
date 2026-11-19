/**
 * The picture edits still being handed to the server, and what a place's last
 * one said when it was refused, held beside the dialogs rather than in them.
 *
 * An edit is asked for from a dialog, but the ask belongs to the place: closing
 * the dialog while the batch is on its way does not take the ask back, so a
 * dialog opened again on the same place reads from here that it is still being
 * sent. A refusal is kept the same way — the reader who stepped away comes back
 * to the reason rather than to a form that looks untouched. Taking a hand-over
 * back is its own act, said with the cancel button: the hand-over is let go of
 * before the batch exists, and the place is open to being asked again.
 *
 * Once the batch exists, the room's own records are what say a place is being
 * made; this only covers the moment before there is a record to read.
 */

import { create } from "zustand";

/** The hand-outs still on their way, by place key. */
const handovers = new Map<string, AbortController>();

interface EditStartsState {
  /** Places whose edit is being handed to the server just now. */
  starting: Record<string, true>;
  /** What a place's last edit said when it could not be sent. */
  refused: Record<string, string>;
  /** Marks a hand-over as on its way, and names what can take it back. */
  begin: (key: string) => AbortController;
  /**
   * Settles a hand-over — but only the one it was begun with: a hand-over let
   * go of and begun again is not settled by the first one's late ending.
   */
  settle: (key: string, controller: AbortController) => void;
  /** Takes back a hand-over still on its way, before the batch exists. */
  cancel: (key: string) => void;
  refuse: (key: string, reason: string) => void;
  clear: (key: string) => void;
  reset: () => void;
}

export const useEditStarts = create<EditStartsState>()((set) => ({
  starting: {},
  refused: {},

  begin(key) {
    const controller = new AbortController();
    handovers.set(key, controller);
    set((state) => ({
      starting: { ...state.starting, [key]: true },
    }));
    return controller;
  },

  settle(key, controller) {
    if (handovers.get(key) !== controller) return;
    handovers.delete(key);
    set((state) => {
      const starting = { ...state.starting };
      delete starting[key];
      return { starting };
    });
  },

  cancel(key) {
    const controller = handovers.get(key);
    if (controller === undefined) return;
    // The hand-over's own ending no longer belongs to this place, so the
    // starting is said to be over here rather than by the ask let go of.
    handovers.delete(key);
    controller.abort();
    set((state) => {
      const starting = { ...state.starting };
      delete starting[key];
      return { starting };
    });
  },

  refuse(key, reason) {
    set((state) => ({
      refused: { ...state.refused, [key]: reason },
    }));
  },

  clear(key) {
    set((state) => {
      const refused = { ...state.refused };
      delete refused[key];
      return { refused };
    });
  },

  reset() {
    for (const controller of handovers.values()) controller.abort();
    handovers.clear();
    set({ starting: {}, refused: {} });
  },
}));
