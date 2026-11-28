import { create } from "zustand";
import type { MokaFile, TimelineId } from "../../../shared/domain";
import {
  currentUiPrefs,
  rememberUiPrefs,
} from "../../../shared/prefs/prefsData";

/**
 * Which cuts are open, kept in the interface preferences beside the project.
 *
 * As with the boards' own strip, a tab is a way of looking at a cut and not
 * the cut itself: closing one puts it down without touching the document, and
 * a project opens onto the tabs it was left with. A project this machine has
 * never opened here shows every cut it holds, which is what the strip did
 * before tabs could be put down.
 */
function read(projectId: string): TimelineId[] {
  const kept: unknown = currentUiPrefs().clipOpenTimelines[projectId];
  if (!Array.isArray(kept)) return [];
  return kept.filter((id): id is TimelineId => typeof id === "string");
}

function keep(projectId: string, ids: TimelineId[]) {
  rememberUiPrefs({ clipOpenTimelines: { [projectId]: ids } });
}

interface OpenTimelinesState {
  /** The project the list belongs to; another project opens another list. */
  projectId: string | null;
  /** Open cuts, read in the document's own order wherever it matters. */
  ids: TimelineId[];
  /**
   * Takes up the list a project was left with, and says which cuts are open.
   *
   * Ids the document no longer has are dropped, and the list comes back in the
   * document's order because that is the order the strip draws. A project left
   * with nothing remembered opens every cut it has.
   */
  adopt: (moka: MokaFile) => TimelineId[];
  /**
   * Puts a cut up on the strip. Nothing happens before a project has been
   * adopted: what belongs to which project is not known yet.
   */
  open: (timelineId: TimelineId) => void;
  /**
   * Puts a cut down without touching it, saying whether it was put down. The
   * last tab is not closable: a room with no cut in it has nothing to show.
   */
  close: (timelineId: TimelineId) => boolean;
  /**
   * Drops the tabs whose cuts the document no longer has — a deletion here, an
   * undo of the add that made one, or a document rewritten by a run. Says which
   * cut to look at when the open one went, or when nothing is left open beside
   * a document that still has cuts.
   */
  prune: (
    timelineIds: TimelineId[],
    activeTimelineId: TimelineId | null,
  ) => TimelineId | null;
  forget: () => void;
}

export const useOpenTimelines = create<OpenTimelinesState>()((set, get) => ({
  projectId: null,
  ids: [],

  adopt(moka) {
    const projectId = moka.metadata.id;
    const order = (moka.timelines ?? []).map((timeline) => timeline.id);
    const held = new Set(order);
    const kept = new Set(read(projectId).filter((id) => held.has(id)));
    const ids = kept.size > 0 ? order.filter((id) => kept.has(id)) : [...order];
    set({ projectId, ids });
    keep(projectId, ids);
    return ids;
  },

  open(timelineId) {
    const { ids, projectId } = get();
    if (projectId === null || ids.includes(timelineId)) return;
    const next = [...ids, timelineId];
    set({ ids: next });
    keep(projectId, next);
  },

  close(timelineId) {
    const { ids, projectId } = get();
    if (!ids.includes(timelineId) || ids.length <= 1) return false;
    const next = ids.filter((id) => id !== timelineId);
    set({ ids: next });
    if (projectId) keep(projectId, next);
    return true;
  },

  prune(timelineIds, activeTimelineId) {
    const { ids, projectId } = get();
    const held = new Set(timelineIds);
    const kept = ids.filter((id) => held.has(id));
    if (kept.length !== ids.length) {
      const next = kept.length > 0 ? kept : timelineIds.slice(0, 1);
      set({ ids: next });
      if (projectId) keep(projectId, next);
      if (activeTimelineId !== null && !held.has(activeTimelineId)) {
        // The strip draws in the document's order, so the cut that takes over
        // is the first one still up in that order.
        const open = timelineIds.filter((id) => next.includes(id));
        return open[0] ?? null;
      }
      return null;
    }
    if (ids.length === 0 && timelineIds.length > 0) {
      const first = timelineIds[0];
      set({ ids: [first] });
      if (projectId) keep(projectId, [first]);
      return first;
    }
    return null;
  },

  forget() {
    set({ projectId: null, ids: [] });
  },
}));
