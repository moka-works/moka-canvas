/**
 * The places a bulk film press left with several takes to choose between.
 *
 * A press that asked for more than one take has not chosen: the newest take is
 * the one in use only because it came home last. The card it belongs to says
 * so, and opening the choice from there settles it. Held for the session
 * rather than in the document: which take came home first is a reading of the
 * moment, not a fact the telling keeps, and the newest take stands if nobody
 * chooses.
 */
import { create } from "zustand";

/** The video places a bulk press can leave waiting on a choice. */
export type ClipChoicePlace = {
  kind: "actVideo" | "keyframeVideo";
  chapterId: string;
  actId: string;
  keyframeId?: string;
};

/** The name a place is known by, counted with the story it stands in. */
export function clipChoiceKey(storyId: string, place: ClipChoicePlace): string {
  return place.kind === "actVideo"
    ? `${storyId}:actVideo:${place.chapterId}:${place.actId}`
    : `${storyId}:keyframeVideo:${place.chapterId}:${place.actId}:${place.keyframeId ?? ""}`;
}

interface ClipChoiceState {
  /** The places waiting on a choice, by the name above. */
  pending: string[];
  mark: (keys: string[]) => void;
  clear: (key: string) => void;
}

export const useClipChoiceStore = create<ClipChoiceState>()((set) => ({
  pending: [],

  mark(keys) {
    if (keys.length === 0) return;
    set((state) => ({
      pending: [
        ...state.pending,
        ...keys.filter((key) => !state.pending.includes(key)),
      ],
    }));
  },

  clear(key) {
    set((state) => ({
      pending: state.pending.filter((held) => held !== key),
    }));
  },
}));
