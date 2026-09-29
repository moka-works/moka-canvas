import { create } from "zustand";
import type {
  AssetId,
  ClipAdjust,
  ClipId,
  MokaFile,
  TextClipData,
  TextClipStyle,
  TimelineDocument,
  TimelineId,
  TrackId,
  TransitionId,
} from "../../../shared/domain";
import { useProjectStore } from "../../editor/stores/projectStore";
import { clampAdjust } from "../inspector/clipFieldMath";
import {
  DEFAULT_PX_PER_SEC,
  MIN_CONTENT_MS,
  TAIL_MS,
  clampPxPerSec,
  contentMs,
  cutEndMs,
  viewAfterZoom,
  xAt,
  zoomAnchorMs,
  type TimelineView,
} from "../timeline/geometry";

/**
 * The four faces the left column turns over between: the cut's own material,
 * and the three tools that work on it.
 */
export type ClipFace = "cut" | "text" | "filters" | "adjust";

/**
 * Which timeline a project was last left looking at, kept on this machine
 * beside the project rather than inside it.
 *
 * Which cut somebody was working on is about them and their afternoon, not
 * about the work: a package handed to somebody else opens onto the first
 * timeline like any other, and closing a project does not forget what was on
 * screen — the memory is the machine's, beside the board tabs' own.
 */
const STORED_UNDER = "moka-canvas:clip-timeline";

function keyFor(projectId: string): string {
  return `${STORED_UNDER}:${projectId}`;
}

/** The timeline this machine remembers for a project, or null. */
export function rememberedTimelineId(projectId: string): TimelineId | null {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return null;
  try {
    const kept = localStorage.getItem(keyFor(projectId));
    if (!kept) return null;
    const parsed: unknown = JSON.parse(kept);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    // A store this cannot read is one that has nothing in it.
    return null;
  }
}

/** Writes the timeline a project was left on; null forgets it. */
export function rememberTimelineId(
  projectId: string,
  timelineId: TimelineId | null,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (timelineId === null) {
      localStorage.removeItem(keyFor(projectId));
    } else {
      localStorage.setItem(keyFor(projectId), JSON.stringify(timelineId));
    }
  } catch {
    // A store that will not take it costs the remembering, not the cut.
  }
}

/**
 * Which timeline a project opens onto.
 *
 * The one it was left on, when the document still has it — a timeline deleted
 * while nobody was looking is not a timeline to open onto — and otherwise the
 * first the document does have.
 */
export function initialTimelineId(moka: MokaFile): TimelineId | null {
  const timelines = moka.timelines ?? [];
  const remembered = rememberedTimelineId(moka.metadata.id);
  if (remembered !== null && timelines.some((t) => t.id === remembered)) {
    return remembered;
  }
  return timelines[0]?.id ?? null;
}

/** The zoom and the playhead one timeline was last left with. */
export interface RememberedView {
  view: TimelineView;
  playheadMs: number;
}

const VIEW_STORED_UNDER = "moka-canvas:clip-view";

function viewKeyFor(timelineId: TimelineId): string {
  return `${VIEW_STORED_UNDER}:${timelineId}`;
}

/**
 * What a timeline was last read at, or null for one never opened.
 *
 * Zooming is a way of looking at one cut, not a fact about it: the scale and
 * where the view sat are kept per timeline, on this machine, so stepping back
 * onto a cut hands the reader the frame they left it in. A timeline seen for
 * the first time starts at the default scale, unscrolled, with its playhead
 * at the head.
 */
export function rememberedView(timelineId: TimelineId): RememberedView | null {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return null;
  try {
    const kept = localStorage.getItem(viewKeyFor(timelineId));
    if (!kept) return null;
    const parsed: unknown = JSON.parse(kept);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const pxPerSec =
      typeof record.pxPerSec === "number"
        ? clampPxPerSec(record.pxPerSec)
        : DEFAULT_PX_PER_SEC;
    const scrollLeftPx =
      typeof record.scrollLeftPx === "number" && record.scrollLeftPx >= 0
        ? record.scrollLeftPx
        : 0;
    const playheadMs =
      typeof record.playheadMs === "number" && record.playheadMs >= 0
        ? record.playheadMs
        : 0;
    return { view: { pxPerSec, scrollLeftPx }, playheadMs };
  } catch {
    // A store this cannot read is one that has nothing in it.
    return null;
  }
}

/** Writes down where a timeline was left; a store that will not take it costs the remembering. */
export function rememberView(
  timelineId: TimelineId,
  view: TimelineView,
  playheadMs: number,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      viewKeyFor(timelineId),
      JSON.stringify({
        pxPerSec: view.pxPerSec,
        scrollLeftPx: view.scrollLeftPx,
        playheadMs,
      }),
    );
  } catch {
    // A store that will not take it costs the remembering, not the cut.
  }
}

/** What is chosen on the timeline: some clips, and at most one seam. */
export interface ClipSelection {
  clipIds: ClipId[];
  transitionId: TransitionId | null;
}

/** How much of the pane stays around a revealed moment before the view moves. */
const REVEAL_MARGIN_PX = 24;
/** Where a revealed moment lands: the same sixth of the pane the clock pages to. */
const REVEAL_AT = 0.15;

/**
 * A grade a reader is dragging, before it is a change to the cut.
 *
 * The Adjust page writes one of these while a slider is held: the compositor
 * reads it in place of the document's own grade, so the picture answers the
 * hand at once and no command is sent until the release. It is a reading
 * rather than a fact about a cut, so it lives here and never reaches the
 * document — the same shape package 11's text-style sliders will reuse.
 */
export interface AdjustDraft {
  /** The clips the draft stands in for. */
  clipIds: ClipId[];
  adjust: ClipAdjust;
}

/**
 * Words a reader is typing, before they are a change to the cut.
 *
 * The inspector writes one of these while the textarea or a style control is
 * being used: the compositor reads it in place of the document's own text, so
 * the picture answers the keyboard at once and no command is sent until the
 * commit point — a blur, a release, or a click on a discrete switch. Like a
 * grade, it is a reading rather than a fact about a cut: it lives here and
 * never reaches the document.
 */
export interface TextDraft {
  /** The clips the draft stands in for. */
  clipIds: ClipId[];
  text: TextClipData;
}

/**
 * The cue a reader is writing in place on the timeline, or null when none is.
 *
 * A session is a reading rather than a fact about a cut, like the drafts
 * beside it: while it stands the words live in the editor — and, for a cue
 * the document holds, in the text draft the preview reads — and no command is
 * sent until the commit point. The seed is the clip's own words when the
 * session opened; a clip whose words have drifted from it since was changed
 * from under the session, which then closes rather than overwrite the change.
 */
export type CueEditorSession =
  | {
      kind: "clip";
      /** The cue being rewritten. */
      clipId: ClipId;
      /** The words the session opened on. */
      seed: string;
    }
  | {
      /** A cue not written yet: the editor is the only place it exists. */
      kind: "new";
      trackId: TrackId;
      startMs: number;
      durationMs: number;
      /** The look it lands with: the row's nearest words, or the default. */
      style: TextClipStyle;
    };

/**
 * How finely the preview composes: its own size, or a fraction of it.
 *
 * The tiers cap the backing store the frame is drawn into — 1920, 960, 480 —
 * and nothing else. They are a way of looking at a cut on this machine, so
 * they are remembered beside the panel folds rather than inside a project,
 * and the export side never reads them: what leaves is always full size.
 */
export type PreviewQuality = "full" | "half" | "quarter";

const QUALITY_STORED_UNDER = "moka-canvas:clip-quality";
const VOLUME_STORED_UNDER = "moka-canvas:clip-volume";
const SNAP_STORED_UNDER = "moka-canvas:clip-snap";

/** The preview tier this machine was last left on. */
export function rememberedQuality(): PreviewQuality {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return "full";
  try {
    const kept = localStorage.getItem(QUALITY_STORED_UNDER);
    return kept === "half" || kept === "quarter" ? kept : "full";
  } catch {
    // A store this cannot read is one that has nothing in it.
    return "full";
  }
}

/** The master level this machine was last left at, 0..1. */
export function rememberedMasterVolume(): number {
  if (typeof localStorage === "undefined") return 1;
  try {
    const kept = localStorage.getItem(VOLUME_STORED_UNDER);
    const parsed = kept === null ? Number.NaN : Number(kept);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
  } catch {
    // A store this cannot read is one that has nothing in it.
    return 1;
  }
}

/**
 * Whether this machine works with the magnet on, which is the default: a
 * cut's blocks are almost always meant to butt against each other, and the
 * ones that are not are dragged with Shift held.
 */
export function rememberedSnapEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(SNAP_STORED_UNDER) !== "off";
  } catch {
    // A store this cannot read is one that has nothing in it.
    return true;
  }
}

function remember(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // A store that will not take it costs the remembering, not the cut.
  }
}

interface ClipState {
  /** The timeline being looked at; null = the document has none (or they all went). */
  activeTimelineId: TimelineId | null;
  /** The face the left column is turned to: the material and its tools share one column. */
  face: ClipFace;
  /** What is chosen on the timeline, which the inspector reads. */
  selection: ClipSelection;
  /**
   * The grade being dragged on the Adjust page, or null when nothing is.
   *
   * Held here rather than in the page so the compositor can read it from the
   * same store the rest of the room reads, and so a draft outliving its own
   * panel is dropped by the store rather than drawn forever.
   */
  adjustDraft: AdjustDraft | null;
  /**
   * The words being edited on the inspector's text form, or null when none are.
   *
   * Held here for the same reason a grade is: the compositor reads the store
   * the rest of the room reads, and a draft that outlives its own form is
   * dropped by the store rather than drawn forever.
   */
  textDraft: TextDraft | null;
  /**
   * The cue being written in place on the timeline, or null when none is.
   *
   * Held here for the same reason the drafts are: the canvas draws under it,
   * the shortcuts and the menus open it, and a session outliving the cut it
   * was opened on is dropped by the store rather than left floating.
   */
  cueEditor: CueEditorSession | null;
  /**
   * The file chosen on the media shelf, which the inspector reads as material.
   *
   * Kept apart from the timeline's own choice: the two columns each hold their
   * own highlight, and clearing one is not an answer about the other — the
   * inspector decides what to show when both are held.
   */
  mediaSelection: AssetId | null;
  /** Whether the new-timeline question is up. */
  newTimelineOpen: boolean;
  /** Where the timeline is scrolled and how tightly it is drawn, remembered per timeline. */
  view: TimelineView;
  /** The reader's place on the cut, in milliseconds from the head. */
  playheadMs: number;
  /** Whether the clock is running; the transport's own state, never a document's. */
  playing: boolean;
  /** How finely the preview composes, remembered on this machine. */
  quality: PreviewQuality;
  /** The master level the whole cut is heard at, 0..1, remembered on this machine. */
  masterVolume: number;
  /**
   * Whether edges catch on each other while they are dragged.
   *
   * A way of working on this machine rather than a fact about a cut, so it is
   * remembered beside the quality and the level; Shift suspends it for one
   * drag, which is the gesture's own business and never written down.
   */
  snapEnabled: boolean;
  /**
   * Whether the end of the cut comes back round to its head.
   *
   * A session's own arrangement — "this pass is easier to hear on repeat" —
   * rather than a preference, so it is never written down.
   */
  loop: boolean;
  /**
   * How wide the canvas is, reported by the canvas itself.
   *
   * Zooming holds the playhead (or the screen's middle) still, and that is
   * arithmetic the store cannot do without knowing what a screen is; the
   * window's size is about the window rather than the cut, so it is never
   * written down where a view is.
   */
  viewportPx: number;
  setActiveTimeline: (id: TimelineId | null) => void;
  setFace: (face: ClipFace) => void;
  select: (patch: Partial<ClipSelection>) => void;
  /** Writes the grade being dragged, clamped to what a grade may be; null lets it go. */
  setAdjustDraft: (draft: AdjustDraft | null) => void;
  /** Writes the words being edited; null lets the document's own text show again. */
  setTextDraft: (draft: TextDraft | null) => void;
  /** Opens the in-place cue editor, or closes it with null. */
  setCueEditor: (session: CueEditorSession | null) => void;
  /** Brings a moment into view, moving the view only when it stands outside it. */
  revealMs: (ms: number) => void;
  selectMedia: (id: AssetId | null) => void;
  setNewTimelineOpen: (open: boolean) => void;
  setView: (patch: Partial<TimelineView>) => void;
  /** One step of the toolbar buttons, ×1.5 in or out, held around the playhead. */
  zoomBy: (factor: number, anchorMs?: number) => void;
  /** The slider's scale, held around the playhead. */
  zoomTo: (pxPerSec: number, anchorMs?: number) => void;
  /** The whole cut on screen at once. */
  fit: (viewportPx: number, contentMs: number) => void;
  /**
   * A hand moving the playhead — the ruler, a key, the transport's skip
   * buttons. Placing the playhead is a pause: the reader is looking for a
   * moment rather than watching one go by.
   */
  setPlayhead: (ms: number) => void;
  /** The running clock moving it; unlike a hand, this never pauses what it moves. */
  setPlayheadFromClock: (ms: number) => void;
  setViewportPx: (px: number) => void;
  /** Starts the clock at the playhead; nothing on a row that draws is a no-op. */
  play: () => void;
  /** Stops the clock where it stands. */
  pause: () => void;
  togglePlay: () => void;
  setQuality: (quality: PreviewQuality) => void;
  setMasterVolume: (volume: number) => void;
  setSnapEnabled: (enabled: boolean) => void;
  toggleLoop: () => void;
}

/** The timeline being read, from the project, for the zooms that need its length. */
function heldTimeline(id: TimelineId | null): TimelineDocument | null {
  const timelines = useProjectStore.getState().moka?.timelines ?? [];
  if (!id) return null;
  return timelines.find((timeline) => timeline.id === id) ?? null;
}

/**
 * What the cutting room is looking at.
 *
 * Only what this package uses: the playhead, the zoom and the scrolling belong
 * to the packages that draw the timeline, and a store that guesses at their
 * shape now would be guesses to undo later. Nothing here ever touches the
 * document — every change to a cut goes through the command pipeline, so this
 * store holds the reader's place and nothing else.
 */
export const useClipStore = create<ClipState>()((set, get) => {
  /** Writes the current view under the timeline it was read on; no timeline, nothing to write. */
  const keep = (view: TimelineView, playheadMs: number): void => {
    const id = get().activeTimelineId;
    if (id) rememberView(id, view, playheadMs);
  };

  const zoomToPxPerSec = (next: number, anchorMs?: number): void => {
    const state = get();
    const timeline = heldTimeline(state.activeTimelineId);
    const length = timeline
      ? contentMs(timeline, state.playheadMs)
      : MIN_CONTENT_MS + TAIL_MS;
    const anchor =
      anchorMs ?? zoomAnchorMs(state.view, state.viewportPx, state.playheadMs);
    const view = viewAfterZoom(
      clampPxPerSec(next),
      state.viewportPx,
      anchor,
      length,
    );
    set({ view });
    keep(view, state.playheadMs);
  };

  /**
   * Moves the playhead, holding it at the head rather than before it.
   *
   * The clock's own writes and a hand's writes land in the same field and are
   * kept apart here: a hand moving the playhead stops the clock first, since
   * placing it is a pause, while the running clock must not pause itself.
   */
  const movePlayhead = (ms: number, fromClock: boolean): void => {
    const state = get();
    if (!fromClock && state.playing) state.pause();
    const playheadMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    set({ playheadMs });
    keep(get().view, playheadMs);
  };

  return {
    activeTimelineId: null,
    // The cut's own material, which is what a reader came into the room for.
    // Only the timeline and the look of the room are remembered on this
    // machine; the face is where the reader is standing, not a choice to keep.
    face: "cut",
    selection: { clipIds: [], transitionId: null },
    adjustDraft: null,
    textDraft: null,
    cueEditor: null,
    mediaSelection: null,
    newTimelineOpen: false,
    view: { pxPerSec: DEFAULT_PX_PER_SEC, scrollLeftPx: 0 },
    playheadMs: 0,
    playing: false,
    quality: rememberedQuality(),
    masterVolume: rememberedMasterVolume(),
    snapEnabled: rememberedSnapEnabled(),
    loop: false,
    viewportPx: 0,

    setActiveTimeline(id) {
      const state = get();
      if (state.activeTimelineId !== id) {
        // The view being left is written down under its own timeline before
        // the next one's is picked up, and a timeline nobody has opened yet
        // starts where a new one should. A clock running on the old cut is
        // stopped: it was keeping the old cut's time.
        if (state.activeTimelineId) {
          rememberView(state.activeTimelineId, state.view, state.playheadMs);
        }
        const remembered = id ? rememberedView(id) : null;
        set({
          activeTimelineId: id,
          playing: false,
          view: remembered?.view ?? {
            pxPerSec: DEFAULT_PX_PER_SEC,
            scrollLeftPx: 0,
          },
          playheadMs: remembered?.playheadMs ?? 0,
          // A draft and a session both stand for clips of the timeline being
          // left, so neither travels to the next one.
          textDraft: null,
          cueEditor: null,
        });
      } else {
        set({ activeTimelineId: id });
      }
      // Switching is also the moment to remember: the machine keeps where the
      // project was left, and a project closed without a last look is a project
      // that opens onto nothing remembered.
      const projectId = useProjectStore.getState().moka?.metadata.id;
      if (projectId) rememberTimelineId(projectId, id);
    },

    setFace(face) {
      set({ face });
    },

    select(patch) {
      set((state) => ({
        selection: { ...state.selection, ...patch },
        // A draft stands in for the clips it named. Choosing other clips is
        // therefore a draft that stands for nothing, and keeping it would
        // leave the preview showing a grade or words no command ever carried.
        adjustDraft: patch.clipIds === undefined ? state.adjustDraft : null,
        textDraft: patch.clipIds === undefined ? state.textDraft : null,
      }));
    },

    setAdjustDraft(draft) {
      // The guard the drafter relies on: a grade is a fraction of each range,
      // so nothing outside -1..1 and nothing that is not a number is written.
      set({
        adjustDraft:
          draft === null || draft.clipIds.length === 0
            ? null
            : {
                clipIds: [...draft.clipIds],
                adjust: clampAdjust(draft.adjust),
              },
      });
    },

    setTextDraft(draft) {
      // The same guard a grade has: a draft that stands for no clip is no
      // draft at all, and the named clips are copied so a caller's own list
      // going stale cannot change what the preview is showing.
      set({
        textDraft:
          draft === null || draft.clipIds.length === 0
            ? null
            : { clipIds: [...draft.clipIds], text: draft.text },
      });
    },

    setCueEditor(session) {
      // Closing a session lets go of the words it was drafting too: the
      // preview goes back to reading the document the moment the editor does.
      set(
        session === null
          ? { cueEditor: null, textDraft: null }
          : { cueEditor: session },
      );
    },

    revealMs(ms) {
      const state = get();
      if (state.viewportPx <= 0) return;
      const x = xAt(ms, state.view);
      if (x >= REVEAL_MARGIN_PX && x <= state.viewportPx - REVEAL_MARGIN_PX) {
        return;
      }
      state.setView({
        scrollLeftPx: Math.max(
          0,
          (ms / 1_000) * state.view.pxPerSec - state.viewportPx * REVEAL_AT,
        ),
      });
    },

    selectMedia(id) {
      set({ mediaSelection: id });
    },

    setNewTimelineOpen(open) {
      set({ newTimelineOpen: open });
    },

    setView(patch) {
      const state = get();
      const view: TimelineView = {
        pxPerSec: clampPxPerSec(patch.pxPerSec ?? state.view.pxPerSec),
        scrollLeftPx: Math.max(
          0,
          patch.scrollLeftPx ?? state.view.scrollLeftPx,
        ),
      };
      set({ view });
      keep(view, state.playheadMs);
    },

    zoomBy(factor, anchorMs) {
      const state = get();
      zoomToPxPerSec(state.view.pxPerSec * factor, anchorMs);
    },

    zoomTo(pxPerSec, anchorMs) {
      zoomToPxPerSec(pxPerSec, anchorMs);
    },

    fit(viewportPx, length) {
      if (viewportPx <= 0 || length <= 0) return;
      const view: TimelineView = {
        pxPerSec: clampPxPerSec(viewportPx / (length / 1_000)),
        scrollLeftPx: 0,
      };
      set({ view });
      keep(view, get().playheadMs);
    },

    setPlayhead(ms) {
      movePlayhead(ms, false);
    },

    setPlayheadFromClock(ms) {
      movePlayhead(ms, true);
    },

    setViewportPx(px) {
      set({ viewportPx: Math.max(0, px) });
    },

    play() {
      const state = get();
      if (state.playing) return;
      const timeline = heldTimeline(state.activeTimelineId);
      // Nothing on a row that draws is nothing to play: a clock running over
      // a cut of no length would stop itself on its next frame.
      if (!timeline || cutEndMs(timeline) <= 0) return;
      const end = cutEndMs(timeline);
      // Pressing play from the tail is asking for the cut from its head.
      if (state.playheadMs >= end) movePlayhead(0, true);
      set({ playing: true });
    },

    pause() {
      if (!get().playing) return;
      set({ playing: false });
    },

    togglePlay() {
      const state = get();
      if (state.playing) state.pause();
      else state.play();
    },

    setQuality(quality) {
      remember(QUALITY_STORED_UNDER, quality);
      set({ quality });
    },

    setMasterVolume(volume) {
      const level = Number.isFinite(volume)
        ? Math.min(1, Math.max(0, volume))
        : 0;
      remember(VOLUME_STORED_UNDER, String(level));
      set({ masterVolume: level });
    },

    setSnapEnabled(enabled) {
      remember(SNAP_STORED_UNDER, enabled ? "on" : "off");
      set({ snapEnabled: enabled });
    },

    toggleLoop() {
      set((state) => ({ loop: !state.loop }));
    },
  };
});
