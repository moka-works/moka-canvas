/**
 * The picture edits still being handed to the server, and what a place's last
 * one said when it was refused, held beside the dialogs rather than in them.
 *
 * An edit is asked for from a dialog, but the ask belongs to the place: closing
 * the dialog while the batch is on its way does not take the ask back, so a
 * dialog opened again on the same place reads from here that it is still being
 * sent. A refusal is kept the same way — the reader who stepped away comes back
 * to the reason rather than to a form that looks untouched.
 *
 * Once the batch exists, the room's own records are what say a place is being
 * made; this only covers the moment before there is a record to read.
 */

import { create } from "zustand";

interface EditStartsState {
  /** Places whose edit is being handed to the server just now. */
  starting: Record<string, true>;
  /** What a place's last edit said when it could not be sent. */
  refused: Record<string, string>;
  begin: (key: string) => void;
  settle: (key: string) => void;
  refuse: (key: string, reason: string) => void;
  clear: (key: string) => void;
  reset: () => void;
}

export const useEditStarts = create<EditStartsState>()((set) => ({
  starting: {},
  refused: {},

  begin(key) {
    set((state) => ({
      starting: { ...state.starting, [key]: true },
    }));
  },

  settle(key) {
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
    set({ starting: {}, refused: {} });
  },
}));
