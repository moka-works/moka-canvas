import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  DEFAULT_TRANSITION_KIND,
  newId,
  nowIso,
  type ClipPatch,
  type TimelineClip,
  type TimelineDocument,
  type TimelineTransition,
} from "../../../shared/domain";
import { followerOf } from "../../../shared/domain/timeline";
import { execute } from "../../editor/commands/execute";
import { ASSET_DRAG_MIME } from "../../editor/interactions/actions";
import { useAppStore } from "../../editor/stores/appStore";
import { i18n } from "../../../shared/i18n";
import {
  clickSelection,
  dropAssetOnTrack,
  dropPreview,
  materialOf,
  selectedClips,
} from "../interactions/clipActions";
import {
  CLICK_SLOP_PX,
  clipsInRect,
  marqueeRect,
  moveDraft,
  trimDraft,
  type MoveDraft,
  type TimelineDraft,
  type TrimDraft,
} from "../interactions/gestures";
import { snapContext } from "../interactions/snapping";
import { editCue } from "../interactions/textActions";
import {
  SEAM_TOO_SHORT_MESSAGE,
  clampSeamMs,
  seamAddCommands,
  seamEditCommands,
} from "../interactions/transitions";
import { useClipStore } from "../stores/clipStore";
import {
  TimelineMenu,
  type TimelineMenuTarget,
} from "../components/TimelineMenu";
import {
  RULER_H,
  contentHeight,
  contentMs,
  contentWidth,
  edgeAt,
  hitTest,
  msAt,
  trackRows,
  type ClipEdge,
  type TimelineHit,
  type TrackRow,
} from "./geometry";
import { renderTimeline } from "./render";
import { CueEditor } from "./CueEditor";
import { frameAligned } from "./timecode";
import { useTimelineDecor } from "./decor";

interface TimelineCanvasProps {
  timeline: TimelineDocument;
  /** The headers column, moved by the same vertical scroll that moves the rows. */
  headersRef: RefObject<HTMLDivElement | null>;
}

/**
 * One pointer session: what went down, and what it has grown into.
 *
 * Everything here lives in a ref rather than in state: a drag moves with
 * every pointer event, and a component that re-rendered once per event would
 * re-render the whole room for each pixel of it. What a session draws is the
 * draft the canvas hands the renderer, and what it commits on release is one
 * command — the document never sees the middle of a gesture.
 */
type CandidateGesture = {
  kind: "candidate";
  x: number;
  y: number;
  hit: TimelineHit;
  edge: ClipEdge | null;
  locked: boolean;
  additive: boolean;
};

type Gesture =
  | CandidateGesture
  | {
      kind: "move";
      members: TimelineClip[];
      pressedId: string;
      downX: number;
      downY: number;
      draft: MoveDraft | null;
    }
  | {
      kind: "trim";
      clip: TimelineClip;
      edge: ClipEdge;
      downX: number;
      draft: TrimDraft | null;
    }
  | {
      kind: "marquee";
      downX: number;
      downY: number;
      additive: boolean;
      rect: { x: number; y: number; width: number; height: number } | null;
    }
  | {
      kind: "seam";
      transition: TimelineTransition;
      downX: number;
      /** The window the drag would give the transition; never in the document. */
      draft: Extract<TimelineDraft, { kind: "seam" }> | null;
    };

/** How the canvas answers the pointer, as the class its edges wear. */
type Cursor = "default" | "grab" | "grabbing" | "ew" | "crosshair" | "pointer";

const CURSOR_CLASS: Record<Exclude<Cursor, "default">, string> = {
  grab: "is-cursor-grab",
  grabbing: "is-cursor-grabbing",
  ew: "is-cursor-ew",
  crosshair: "is-cursor-crosshair",
  pointer: "is-cursor-pointer",
};

interface MenuState {
  x: number;
  y: number;
  target: TimelineMenuTarget;
}

/**
 * The screen the cut is drawn on.
 *
 * One screenful is all the canvas holds, whatever the cut's length: the spacer
 * beside it carries the scrollbars, the canvas stays pinned to the viewport's
 * corner, and every scroll schedules a redraw with the new offset. Nothing is
 * drawn twice into the same frame, so a scroll is a frame's work and not a
 * scroll's.
 *
 * Pointers land in one of two sessions. The ruler's is the seek: the playhead
 * follows the pointer for as long as it is down. Everything below is the
 * cut's: a press records what it landed on, four pixels of wandering turn it
 * into a drag of the block, a trim of its edge or a marquee over the rows,
 * and the release commits exactly one step of history. Escape or a cancelled
 * pointer drops the draft and leaves the document untouched.
 */
export function TimelineCanvas({ timeline, headersRef }: TimelineCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const gestureRef = useRef<Gesture | null>(null);
  const draftRef = useRef<TimelineDraft | null>(null);
  // The clip a Shift click reaches from, which is the last clip picked alone.
  const anchorRef = useRef<string | null>(null);
  // The file a drag in flight is carrying, read off the row it started on.
  const draggedAssetRef = useRef<string>("");
  const [dropping, setDropping] = useState(false);
  const [cursor, setCursor] = useState<Cursor>("default");
  const [menu, setMenu] = useState<MenuState | null>(null);
  // The seam under the pointer, held only while the pointer is over one. It
  // is component state rather than a store's: a hover is a reading of the
  // pointer, and only the canvas draws it. The key keeps it from being set
  // again for every move that stays on the same seam.
  const hoverKeyRef = useRef("");
  const [hoverSeam, setHoverSeam] = useState<{
    leader: TimelineClip;
    follower: TimelineClip;
  } | null>(null);
  const pxPerSec = useClipStore((state) => state.view.pxPerSec);
  const playheadMs = useClipStore((state) => state.playheadMs);
  const cueEditor = useClipStore((state) => state.cueEditor);
  const decor = useTimelineDecor();
  const spacerWidth = contentWidth(timeline, playheadMs, pxPerSec);
  const spacerHeight = contentHeight(timeline);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const cssW = viewport.clientWidth;
    const cssH = viewport.clientHeight;
    // Before anything is asked of the context: a window with no room in it
    // (a test without a layout, a hidden panel) has nothing to draw into.
    if (cssW <= 0 || cssH <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    sizeCanvas(canvas, cssW, cssH);
    // The backing store is the device's; the drawing stays in CSS pixels, so
    // what the renderer measures lands where a pointer does. Set per frame,
    // since resizing the canvas starts the context over.
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const state = useClipStore.getState();
    renderTimeline(ctx, {
      timeline,
      view: {
        pxPerSec: state.view.pxPerSec,
        scrollLeftPx: viewport.scrollLeft,
      },
      viewport: { width: cssW, height: cssH, scrollTopPx: viewport.scrollTop },
      playheadMs: state.playheadMs,
      selection: state.selection,
      decor,
      // Read at the frame rather than handed in: a draft lives only as long
      // as the pointer is down, and the drawing asks for it every frame.
      draft: draftRef.current,
      hoverSeam,
    });
    // What is drawn is pixels, which nothing can read back: what changed is
    // written onto the room instead, a moment behind the frame that drew it.
    // These attributes are the only observation point a test has on the cut,
    // and packages 08/10 keep them true rather than growing their own.
    const room = canvas.closest(".clip-timeline");
    if (room) {
      room.setAttribute("data-clip-count", String(timeline.clips.length));
      room.setAttribute("data-track-count", String(timeline.tracks.length));
      // The seam the e2e reads the whole cut through: where every block is,
      // as the document holds it — never as a draft drew it.
      room.setAttribute(
        "data-clip-spans",
        timeline.clips
          .map(
            (clip) =>
              `${clip.id}@${clip.trackId}:${clip.startMs}:${clip.durationMs}`,
          )
          .join(";"),
      );
      // Every transition as one line: which seam it sits on, where its window
      // opens, how long it runs, and what kind it is. The window's start is
      // the follower's own start, which is the pull-back the doc holds.
      room.setAttribute(
        "data-transitions",
        timeline.transitions
          .map((transition) => {
            const leader = timeline.clips.find(
              (clip) => clip.id === transition.afterClipId,
            );
            if (!leader) return "";
            const follower = followerOf(timeline, leader);
            if (!follower) return "";
            return `${transition.id}@${leader.trackId}:${leader.id}:${follower.startMs}:${transition.durationMs}:${transition.kind}`;
          })
          .filter((entry) => entry.length > 0)
          .join(";"),
      );
      // The block a file hanging over the rows would land as, or empty: the
      // ghost is pixels like everything else, and this is where a test reads
      // the very arithmetic the release will land through.
      const ghost =
        draftRef.current?.kind === "drop" ? draftRef.current.clip : null;
      room.setAttribute(
        "data-drop-preview",
        ghost ? `${ghost.trackId}:${ghost.startMs}:${ghost.durationMs}` : "",
      );
      room.setAttribute(
        "data-selected-clip-ids",
        state.selection.clipIds.join(","),
      );
      room.setAttribute(
        "data-selected-transition-id",
        state.selection.transitionId ?? "",
      );
    }
  }, [timeline, decor, hoverSeam]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      draw();
    });
  }, [draw]);

  // Every draw answers to the same two things: the store, which holds what to
  // draw, and the scroller, whose position is read at draw time. A zoom that
  // moves the view is applied back onto the scroller here, since the browser
  // only knows about scrolling the reader did.
  useEffect(
    () =>
      useClipStore.subscribe((state, previous) => {
        const viewport = viewportRef.current;
        if (
          viewport &&
          state.view.scrollLeftPx !== previous.view.scrollLeftPx &&
          viewport.scrollLeft !== state.view.scrollLeftPx
        ) {
          viewport.scrollLeft = state.view.scrollLeftPx;
        }
        schedule();
      }),
    [schedule],
  );

  useEffect(() => {
    schedule();
  }, [schedule, timeline]);

  /** Take the viewport's size: the backing store, the store's idea of a screen, and a draw. */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const cssW = viewport.clientWidth;
    const cssH = viewport.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    sizeCanvas(canvas, cssW, cssH);
    useClipStore.getState().setViewportPx(cssW);
    schedule();
  }, [schedule]);

  // Sized in the layout pass rather than on the first frame: the element is a
  // screen from the moment it is in the DOM, so a pointer never lands beside
  // a canvas that is still wearing the browser's default 300×150.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    resize();
    return () => observer.disconnect();
  }, [resize]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const store = useClipStore.getState();
      if (store.view.scrollLeftPx !== viewport.scrollLeft) {
        store.setView({ scrollLeftPx: viewport.scrollLeft });
      }
      if (headersRef.current) {
        headersRef.current.style.transform = `translateY(${-viewport.scrollTop}px)`;
      }
      schedule();
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [headersRef, schedule]);

  // A wheel with Ctrl or the command key zooms around the pointer; a plain
  // wheel is the reader moving the view and stays the browser's own scroll.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const state = useClipStore.getState();
      const anchorMs = msAt(event.clientX - rect.left, {
        pxPerSec: state.view.pxPerSec,
        scrollLeftPx: viewport.scrollLeft,
      });
      state.zoomBy(Math.exp(-event.deltaY * 0.0015), anchorMs);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  /** Where a pointer sits on the drawn screen, in canvas pixels. */
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** The view as the scroller holds it, which is what x and ms read through. */
  const viewNow = () => ({
    pxPerSec: useClipStore.getState().view.pxPerSec,
    scrollLeftPx: viewportRef.current?.scrollLeft ?? 0,
  });

  const seek = (localX: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const store = useClipStore.getState();
    const ms = msAt(localX, {
      pxPerSec: store.view.pxPerSec,
      scrollLeftPx: viewport.scrollLeft,
    });
    // The playhead can stand anywhere the cut reaches, and nowhere past it.
    store.setPlayhead(
      Math.min(Math.max(0, ms), contentMs(timeline, store.playheadMs)),
    );
  };

  const inRuler = (localY: number, scrollTop: number) =>
    localY + scrollTop < RULER_H;

  /** What a point on the drawn screen is over, with the point moved into content space. */
  const hitAt = (x: number, y: number): TimelineHit | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    return hitTest(timeline, viewNow(), {
      x,
      y: y + viewport.scrollTop,
    });
  };

  /** Drops the draft and the session: the clip stays where the document has it. */
  const cancelGesture = useCallback(() => {
    gestureRef.current = null;
    draftRef.current = null;
    setCursor("default");
    schedule();
  }, [schedule]);

  // Escape during a session is the session's own key: the draft is let go of
  // and the room's own Escape — which clears the selection — never hears it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || gestureRef.current === null) return;
      event.preventDefault();
      event.stopPropagation();
      cancelGesture();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancelGesture]);

  /** What a pointer over the cut is about to do, as the cursor says. */
  const cursorFor = (hit: TimelineHit | null, x: number): Cursor => {
    // A seam badge and an empty seam's ghost are both things to drag or click
    // along the line, so both wear the same left-right cursor.
    if (hit?.kind === "transition" || hit?.kind === "seam") return "ew";
    if (hit?.kind !== "clip") return "default";
    const track = timeline.tracks.find((row) => row.id === hit.clip.trackId);
    if (track?.locked) return "default";
    const edge = edgeAt(hit.clip, trackRows(timeline), viewNow(), x);
    if (edge) return "ew";
    return "grab";
  };

  /** The hover the drawing reads: only a seam is worth holding onto. */
  const showHover = (hit: TimelineHit | null) => {
    const key =
      hit?.kind === "seam"
        ? `seam:${hit.leader.id}`
        : hit?.kind === "transition"
          ? `transition:${hit.transition.id}`
          : (hit?.kind ?? "");
    if (key === hoverKeyRef.current) return;
    hoverKeyRef.current = key;
    setHoverSeam(
      hit?.kind === "seam"
        ? { leader: hit.leader, follower: hit.follower }
        : null,
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const viewport = viewportRef.current;
    const local = localPoint(event);
    if (!viewport || !local || event.button !== 0) return;
    if (inRuler(local.y, viewport.scrollTop)) {
      // The ruler is 04's own hand-hold; choosing clips happens below it.
      // The seek lands first: a capture that a browser refuses is a drag that
      // stops at the edge, not a click that never happened.
      draggingRef.current = true;
      seek(local.x);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const hit = hitAt(local.x, local.y);
    if (!hit) return;
    const edge =
      hit.kind === "clip"
        ? edgeAt(hit.clip, trackRows(timeline), viewNow(), local.x)
        : null;
    // A locked row takes the press — a click still picks its clips, which is
    // how the room offers to say why an edit there is refused — but the drag
    // that follows is a wish the room will not carry out.
    const track =
      hit.kind === "clip"
        ? timeline.tracks.find((row) => row.id === hit.clip.trackId)
        : undefined;
    gestureRef.current = {
      kind: "candidate",
      x: local.x,
      y: local.y,
      hit,
      edge,
      locked: track?.locked === true,
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /**
   * Lays the default transition on a butted seam the pointer clicked.
   *
   * The window is the default clamped by the two clips, and the pull-back is
   * the command's own doing — nothing here moves a clip. A pair too short for
   * even the smallest window is the one refusal the UI says itself, because
   * the command that would carry it cannot exist; everything else the command
   * layer answers. A new transition is chosen on landing, so the inspector
   * opens straight onto it.
   */
  const addSeamTransition = (seam: { leader: TimelineClip }) => {
    const plan = seamAddCommands(
      timeline,
      seam.leader.id,
      DEFAULT_TRANSITION_KIND,
      newId(),
      nowIso(),
    );
    if (!plan.ok) {
      if (plan.reason === "too-short")
        useAppStore
          .getState()
          .pushToast("error", i18n.t(SEAM_TOO_SHORT_MESSAGE));
      return;
    }
    if (!execute(i18n.t("clip:history.addTransition"), plan.commands)) return;
    showHover(null);
    useClipStore
      .getState()
      .select({ clipIds: [], transitionId: plan.transition.id });
  };

  /** Turns a wandering press into the gesture it has become. */
  const beginGesture = (candidate: CandidateGesture) => {
    if (candidate.hit.kind === "clip" && candidate.edge) {
      const clip = candidate.hit.clip;
      const material = materialOf(clip);
      if (candidate.edge === "end" && material.unprobed) {
        // The end of an unmeasured file is unknown, so the drag is not
        // bounded by it; the reader is told once rather than stopped.
        useAppStore
          .getState()
          .pushToast("info", i18n.t("clip:actions.durationUnknown"));
      }
      gestureRef.current = {
        kind: "trim",
        clip,
        edge: candidate.edge,
        downX: candidate.x,
        draft: null,
      };
      return;
    }
    if (candidate.hit.kind === "clip") {
      const clip = candidate.hit.clip;
      const store = useClipStore.getState();
      const held = selectedClips(timeline, store.selection);
      const already = held.some((member) => member.id === clip.id);
      const members = already ? held : [clip];
      if (!already) {
        store.select({ clipIds: [clip.id], transitionId: null });
        anchorRef.current = clip.id;
      }
      gestureRef.current = {
        kind: "move",
        members,
        pressedId: clip.id,
        downX: candidate.x,
        downY: candidate.y,
        draft: null,
      };
      return;
    }
    if (candidate.hit.kind === "empty") {
      gestureRef.current = {
        kind: "marquee",
        downX: candidate.x,
        downY: candidate.y,
        additive: candidate.additive,
        rect: null,
      };
      return;
    }
    if (candidate.hit.kind === "transition") {
      // The badge is 10's to drag: the window it would give the seam is drawn
      // from the moment under the pointer and committed in one command.
      gestureRef.current = {
        kind: "seam",
        transition: candidate.hit.transition,
        downX: candidate.x,
        draft: null,
      };
      return;
    }
    // Nothing else below the ruler drags: an empty seam's `+` is a click.
    gestureRef.current = null;
  };

  /** What the gesture draws, recomputed at every pointer position. */
  const updateGesture = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    local: { x: number; y: number },
  ) => {
    const gesture = gestureRef.current;
    const viewport = viewportRef.current;
    if (!gesture || gesture.kind === "candidate" || !viewport) return;
    const store = useClipStore.getState();
    const view = viewNow();
    if (gesture.kind === "marquee") {
      const rect = marqueeRect(
        { x: gesture.downX, y: gesture.downY + viewport.scrollTop },
        { x: local.x, y: local.y + viewport.scrollTop },
      );
      gestureRef.current = { ...gesture, rect };
      draftRef.current = { kind: "marquee", rect };
      setCursor("crosshair");
      schedule();
      return;
    }
    // Shift suspends the magnet for as long as it is held, which is how a
    // reader nudges a block onto something the edges would otherwise catch.
    const snapEnabled = store.snapEnabled && !event.shiftKey;
    const rows = trackRows(timeline);
    const deltaMs = msAt(local.x, view) - msAt(gesture.downX, view);
    if (gesture.kind === "seam") {
      // The window the seam would wear: the one it has, moved by the pointer's
      // own distance in time and kept inside what the two clips allow. The
      // document is not touched until the release.
      const durationMs = clampSeamMs(
        timeline,
        gesture.transition.id,
        Math.round(gesture.transition.durationMs + deltaMs),
      );
      const draft = {
        kind: "seam" as const,
        transitionId: gesture.transition.id,
        durationMs,
      };
      gestureRef.current = { ...gesture, draft };
      draftRef.current = draft;
      setCursor("ew");
      schedule();
      return;
    }
    if (gesture.kind === "move") {
      const pressed =
        gesture.members.find((member) => member.id === gesture.pressedId) ??
        gesture.members[0];
      const pressedRow = rows.findIndex(
        (row) => row.track.id === pressed.trackId,
      );
      const overRow = rowAt(rows, local.y + viewport.scrollTop);
      const rowDelta =
        overRow === null || pressedRow < 0 ? 0 : overRow - pressedRow;
      const draft = moveDraft({
        clips: gesture.members,
        pressedId: gesture.pressedId,
        rows,
        rowDelta,
        deltaMs,
        fps: timeline.settings.fps,
        ctx: snapContext(
          timeline,
          store.playheadMs,
          gesture.members.map((member) => member.id),
        ),
        pxPerSec: view.pxPerSec,
        snapEnabled,
      });
      gestureRef.current = { ...gesture, draft };
      draftRef.current = {
        kind: "move",
        clips: draft.clips,
        guideMs: draft.guideMs,
        rowTrackId: draft.rowTrackId,
      };
      setCursor("grabbing");
      schedule();
      return;
    }
    const draft = trimDraft({
      clip: gesture.clip,
      edge: gesture.edge,
      deltaMs,
      fps: timeline.settings.fps,
      material: materialOf(gesture.clip),
      ctx: snapContext(timeline, store.playheadMs, [gesture.clip.id]),
      pxPerSec: view.pxPerSec,
      snapEnabled,
    });
    gestureRef.current = { ...gesture, draft };
    draftRef.current = {
      kind: "trim",
      clip: {
        clipId: gesture.clip.id,
        trackId: gesture.clip.trackId,
        kind: gesture.clip.kind,
        startMs: draft.startMs,
        durationMs: draft.durationMs,
      },
      edge: gesture.edge,
      guideMs: draft.guideMs,
    };
    setCursor("ew");
    schedule();
  };

  /** The one command a session leaves behind, or nothing when nothing moved. */
  const commitGesture = (gesture: Gesture) => {
    const store = useClipStore.getState();
    if (gesture.kind === "marquee") {
      const rect = gesture.rect;
      if (!rect) return;
      const caught = clipsInRect(
        timeline,
        trackRows(timeline),
        viewNow(),
        rect,
      );
      store.select({
        clipIds: gesture.additive
          ? [...new Set([...store.selection.clipIds, ...caught])]
          : caught,
        transitionId: null,
      });
      anchorRef.current = null;
      return;
    }
    if (gesture.kind === "move") {
      const draft = gesture.draft;
      if (!draft) return;
      const moves = draft.clips
        .filter((ghost) => {
          const held = gesture.members.find(
            (member) => member.id === ghost.clipId,
          );
          return (
            held !== undefined &&
            (ghost.startMs !== held.startMs || ghost.trackId !== held.trackId)
          );
        })
        .map((ghost) => {
          const held = gesture.members.find(
            (member) => member.id === ghost.clipId,
          );
          return ghost.trackId === held?.trackId
            ? { clipId: ghost.clipId, startMs: ghost.startMs }
            : {
                clipId: ghost.clipId,
                startMs: ghost.startMs,
                trackId: ghost.trackId,
              };
        });
      if (moves.length === 0) return;
      execute(
        i18n.t(
          moves.length > 1 ? "clip:history.moveClips" : "clip:history.moveClip",
        ),
        [{ type: "moveClips", timelineId: timeline.id, moves }],
      );
      return;
    }
    if (gesture.kind === "seam") {
      const draft = gesture.draft;
      if (!draft) return;
      // The chain edit is one command array: the suffix comes down and is laid
      // back with the new window, so one history step holds the whole change.
      const commands = seamEditCommands(timeline, draft.transitionId, {
        durationMs: draft.durationMs,
      });
      if (!commands) return;
      execute(i18n.t("clip:history.changeTransition"), commands);
      return;
    }
    if (gesture.kind !== "trim") return;
    const draft = gesture.draft;
    if (!draft) return;
    const patch: ClipPatch = {};
    if (draft.startMs !== gesture.clip.startMs) patch.startMs = draft.startMs;
    if (draft.durationMs !== gesture.clip.durationMs)
      patch.durationMs = draft.durationMs;
    if (draft.inPointMs !== gesture.clip.inPointMs)
      patch.inPointMs = draft.inPointMs;
    if (draft.outPointMs !== gesture.clip.outPointMs)
      patch.outPointMs = draft.outPointMs;
    if (Object.keys(patch).length === 0) return;
    execute(i18n.t("clip:history.trimClip"), [
      {
        type: "updateClips",
        timelineId: timeline.id,
        patches: [{ clipId: gesture.clip.id, patch }],
      },
    ]);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const local = localPoint(event);
    if (!local) return;
    if (draggingRef.current) {
      seek(local.x);
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture) {
      const hit = hitAt(local.x, local.y);
      showHover(hit);
      setCursor(cursorFor(hit, local.x));
      return;
    }
    if (gesture.kind === "candidate") {
      const wandered =
        Math.abs(local.x - gesture.x) >= CLICK_SLOP_PX ||
        Math.abs(local.y - gesture.y) >= CLICK_SLOP_PX;
      if (!wandered) return;
      if (gesture.hit.kind === "clip" && gesture.locked) {
        // The press is over: a drag on a locked row is refused where it
        // starts, with the reason, and the clip never even becomes a draft.
        useAppStore
          .getState()
          .pushToast("error", i18n.t("clip:actions.trackLocked"));
        gestureRef.current = null;
        setCursor("default");
        return;
      }
      beginGesture(gesture);
      // The gesture takes the first move's position as its own, so a drag
      // begins where the pointer is rather than where it went down.
      const started = gestureRef.current;
      if (started && started.kind !== "candidate") updateGesture(event, local);
      return;
    }
    updateGesture(event, local);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (draggingRef.current) draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gestureRef.current = null;
    draftRef.current = null;
    if (!gesture) return;
    const local = localPoint(event);
    if (!local) return;
    if (gesture.kind === "candidate") {
      const wandered =
        Math.abs(local.x - gesture.x) >= CLICK_SLOP_PX ||
        Math.abs(local.y - gesture.y) >= CLICK_SLOP_PX;
      if (wandered) return;
      // An empty seam is a click and not a choice: it lays the default
      // transition down and chooses it, so the card opens on the new seam.
      if (gesture.hit.kind === "seam") {
        addSeamTransition(gesture.hit);
        return;
      }
      const store = useClipStore.getState();
      const mode = event.shiftKey
        ? "add"
        : event.ctrlKey || event.metaKey
          ? "toggle"
          : "replace";
      const selection = clickSelection(
        timeline,
        store.selection,
        gesture.hit,
        mode,
        anchorRef.current,
      );
      store.select(selection);
      if (mode === "replace" && gesture.hit.kind === "clip") {
        anchorRef.current = gesture.hit.clip.id;
      } else if (gesture.hit.kind !== "clip") {
        anchorRef.current = null;
      }
      return;
    }
    commitGesture(gesture);
    const hit = hitAt(local.x, local.y);
    showHover(hit);
    setCursor(cursorFor(hit, local.x));
    schedule();
  };

  const onPointerCancel = () => {
    draggingRef.current = false;
    cancelGesture();
  };

  /** A pointer that leaves the screen takes its offer with it. */
  const onPointerLeave = () => {
    showHover(null);
  };

  /**
   * A double click opens the cue editor over the words it landed on.
   *
   * Only a text block takes a double click: a picture or a sound has no words
   * to write in place, and everything else on the cut already answers the
   * pointer on its first press.
   */
  const onDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const local = localPoint(event);
    if (!local) return;
    const hit = hitAt(local.x, local.y);
    if (hit?.kind !== "clip" || hit.clip.kind !== "text") return;
    editCue(hit.clip);
  };

  /** A right-click opens the cut's own menu, over whichever piece it landed on. */
  const onContextMenu = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const local = localPoint(event);
    if (!local) return;
    const hit = hitAt(local.x, local.y);
    if (!hit) return;
    // A seam and its badge have no menu: the window is edited by the card or
    // by dragging the badge itself, and a third surface would be one too many.
    if (
      hit.kind === "transition" ||
      hit.kind === "seam" ||
      hit.kind === "ruler"
    )
      return;
    if (hit.kind === "clip") {
      const store = useClipStore.getState();
      // The menu acts on the selection, so a piece it landed on that was not
      // chosen is chosen first — the menu then reads as being about it.
      if (!store.selection.clipIds.includes(hit.clip.id)) {
        store.select({ clipIds: [hit.clip.id], transitionId: null });
        anchorRef.current = hit.clip.id;
      }
    }
    setMenu({
      x: event.clientX,
      y: event.clientY,
      target: { kind: "clips", onClip: hit.kind === "clip" },
    });
  };

  /**
   * The file a drag in flight is carrying, watched off the row it started on.
   *
   * A drag's data is private to the drop that ends it, so what hangs over the
   * rows during a drag cannot ask the data transfer what it holds. The row's
   * own contract is read instead — `data-asset-id`, the same mark the shelf
   * writes and this canvas's drop already trusts — taken at the dragstart
   * that begins the drag and let go of at its end, wherever that end falls.
   */
  useEffect(() => {
    const onDragStart = (event: DragEvent) => {
      const row =
        event.target instanceof Element
          ? event.target.closest("[data-asset-id]")
          : null;
      draggedAssetRef.current = row?.getAttribute("data-asset-id") ?? "";
    };
    const forget = () => {
      draggedAssetRef.current = "";
      // A drag that ends anywhere but on the rows takes its ghost with it.
      if (draftRef.current?.kind === "drop") {
        draftRef.current = null;
        setDropping(false);
        schedule();
      }
    };
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", forget);
    document.addEventListener("drop", forget);
    return () => {
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", forget);
      document.removeEventListener("drop", forget);
    };
  }, [schedule]);

  /** Whether a drag carries a file from the shelf, which is the only drag the rows take. */
  const carriedAssetId = (event: ReactDragEvent<HTMLCanvasElement>) =>
    event.dataTransfer.types.includes(ASSET_DRAG_MIME)
      ? event.dataTransfer.getData(ASSET_DRAG_MIME)
      : "";

  /** Where a drag's pointer would put the file: the row under it, and the frame the moment names. */
  const dropTargetAt = (event: { clientX: number; clientY: number }) => {
    const viewport = viewportRef.current;
    const local = localPoint(event);
    if (!viewport || !local) return null;
    const view = viewNow();
    const hit = hitTest(timeline, view, {
      x: local.x,
      y: local.y + viewport.scrollTop,
    });
    const trackId =
      hit.kind === "clip"
        ? hit.clip.trackId
        : hit.kind === "transition"
          ? (timeline.clips.find(
              (clip) => clip.id === hit.transition.afterClipId,
            )?.trackId ?? null)
          : hit.kind === "seam"
            ? hit.leader.trackId
            : hit.kind === "empty"
              ? hit.trackId
              : null;
    if (trackId === null) return null;
    // The file lands on the frame the pointer's moment falls on, and the
    // ghost hanging over the rows is drawn from this same reading.
    const startMs = Math.max(
      0,
      frameAligned(msAt(local.x, view), timeline.settings.fps),
    );
    return { trackId, startMs };
  };

  const onDragOver = (event: ReactDragEvent<HTMLCanvasElement>) => {
    if (!event.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    // Saying the canvas can take the drop is what makes the drop arrive; the
    // copy is the shelf's own promise, not the room moving anything.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
    // The file's own ghost, drawn where the release would leave it: the row
    // it hangs over, the frame under the pointer, the magnet's catch.
    const target = dropTargetAt(event);
    const preview = target
      ? dropPreview(
          timeline,
          draggedAssetRef.current,
          target.trackId,
          target.startMs,
        )
      : null;
    draftRef.current = preview
      ? { kind: "drop", clip: preview.clip, guideMs: preview.guideMs }
      : null;
    schedule();
  };

  const onDragLeave = () => {
    setDropping(false);
    draftRef.current = null;
    schedule();
  };

  const onDrop = (event: ReactDragEvent<HTMLCanvasElement>) => {
    if (!event.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    event.preventDefault();
    setDropping(false);
    draftRef.current = null;
    schedule();
    const assetId = carriedAssetId(event);
    const target = dropTargetAt(event);
    if (!assetId || !target) return;
    dropAssetOnTrack(timeline, assetId, target.trackId, target.startMs);
  };

  const canvasClass = [
    "clip-tl-canvas",
    dropping ? "is-drop-target" : "",
    cursor === "default" ? "" : CURSOR_CLASS[cursor],
  ]
    .filter((name) => name.length > 0)
    .join(" ");

  return (
    <div className="clip-tl-viewport" ref={viewportRef}>
      <div
        className="clip-tl-spacer"
        style={{ height: spacerHeight, width: spacerWidth }}
      />
      <canvas
        className={canvasClass}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={canvasRef}
      />
      {cueEditor && <CueEditor session={cueEditor} timeline={timeline} />}
      {menu && (
        <TimelineMenu
          onClose={() => setMenu(null)}
          target={menu.target}
          timeline={timeline}
          x={menu.x}
          y={menu.y}
        />
      )}
    </div>
  );
}

/** The row a content-space y falls in, pulled back to the rows when it falls past them. */
function rowAt(rows: TrackRow[], y: number): number | null {
  if (rows.length === 0) return null;
  for (let index = 0; index < rows.length; index += 1) {
    if (y < rows[index].top + rows[index].height) return index;
  }
  return rows.length - 1;
}

/** The backing store follows the device's pixel ratio; the drawing works in CSS pixels. */
function sizeCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(cssW * dpr));
  const height = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
}
