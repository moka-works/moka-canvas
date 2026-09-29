import { useEffect } from "react";
import { redo, undo } from "../../editor/commands/execute";
import { useClipStore } from "../stores/clipStore";
import { ZOOM_STEP } from "../timeline/TimelineToolbar";
import { cutEndMs } from "../timeline/geometry";
import { nextFrameMs, prevFrameMs } from "../timeline/timecode";
import {
  activeTimeline,
  clearSelection,
  deleteSelection,
  duplicateSelection,
  nearestClipEdgeMs,
  selectAll,
  selectedClips,
  splitSelectionAtPlayhead,
} from "./clipActions";
import { editCue } from "./textActions";

/** One line of the room's shortcuts list: the keys that work and what they do. */
export interface ClipShortcutRow {
  /** The words the line is read under, as a translation key. */
  label: string;
  /** Alternate ways to press it, as a reader of either platform would say them. */
  chords: string[];
}

export interface ClipShortcutGroup {
  /** The words the group is read under, as a translation key. */
  title: string;
  rows: ClipShortcutRow[];
}

/**
 * What the cutting room answers to, as its help list reads it.
 *
 * Written here under the handler so the two are read together: a key that
 * moves in one and not the other is caught between neighbours rather than
 * between files. Nothing is listed that the room cannot do today. The groups,
 * the lines and the keys every line names are held as translation keys and
 * read into the current language by the dialog; a key is a name rather than a
 * word, so its lines read the same in either language.
 */
export const CLIP_SHORTCUT_GROUPS: ClipShortcutGroup[] = [
  {
    title: "clip:shortcuts.group.editing",
    rows: [
      {
        label: "clip:common.undo",
        chords: ["clip:shortcuts.chord.ctrlCmdZ"],
      },
      {
        label: "clip:common.redo",
        chords: [
          "clip:shortcuts.chord.ctrlCmdShiftZ",
          "clip:shortcuts.chord.ctrlY",
        ],
      },
      {
        label: "clip:common.splitAtThePlayhead",
        chords: ["clip:shortcuts.chord.ctrlCmdB"],
      },
      {
        label: "clip:common.duplicateSelection",
        chords: ["clip:shortcuts.chord.ctrlCmdD"],
      },
      {
        label: "clip:common.deleteSelection",
        chords: [
          "clip:shortcuts.chord.delete",
          "clip:shortcuts.chord.backspace",
        ],
      },
      {
        label: "clip:common.selectAll",
        chords: ["clip:shortcuts.chord.ctrlCmdA"],
      },
      {
        label: "clip:shortcuts.label.clearSelection",
        chords: ["clip:shortcuts.chord.escape"],
      },
      {
        label: "clip:shortcuts.label.editSubtitle",
        chords: ["clip:shortcuts.chord.enter", "clip:shortcuts.chord.f2"],
      },
    ],
  },
  {
    title: "clip:shortcuts.group.playhead",
    rows: [
      {
        label: "clip:shortcuts.label.playPause",
        chords: ["clip:shortcuts.chord.space"],
      },
      {
        label: "clip:shortcuts.label.backToHead",
        chords: ["clip:shortcuts.chord.home"],
      },
      {
        label: "clip:shortcuts.label.toEnd",
        chords: ["clip:shortcuts.chord.end"],
      },
      {
        label: "clip:shortcuts.label.backFrame",
        chords: ["clip:shortcuts.chord.left"],
      },
      {
        label: "clip:shortcuts.label.forwardFrame",
        chords: ["clip:shortcuts.chord.right"],
      },
      {
        label: "clip:shortcuts.label.backSecond",
        chords: ["clip:shortcuts.chord.shiftLeft"],
      },
      {
        label: "clip:shortcuts.label.forwardSecond",
        chords: ["clip:shortcuts.chord.shiftRight"],
      },
      {
        label: "clip:shortcuts.label.toEdge",
        chords: ["clip:shortcuts.chord.up", "clip:shortcuts.chord.down"],
      },
    ],
  },
  {
    title: "clip:shortcuts.group.view",
    rows: [
      {
        label: "clip:common.zoomIn",
        chords: ["clip:shortcuts.chord.plus"],
      },
      {
        label: "clip:common.zoomOut",
        chords: ["clip:shortcuts.chord.minus"],
      },
    ],
  },
  {
    title: "clip:shortcuts.group.help",
    rows: [
      {
        label: "clip:shortcuts.title",
        chords: ["clip:shortcuts.chord.question"],
      },
    ],
  },
];

/** A guard every key meets first: the field a reader is typing in keeps its keys. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export interface ClipShortcutOptions {
  /** Whether a dialog the room put up is standing; its keys are its own. */
  isBlocked?: () => boolean;
  /** The `?` list, which the page owns the standing of. */
  onShowHelp?: () => void;
}

/**
 * The room's keys, bound while the page is up and taken down with it.
 *
 * A room nobody is standing in must not keep answering for one, so the
 * listener lives exactly as long as the page does. Both Ctrl and Cmd are
 * accepted so either platform works; a key typed into a field is the field's
 * own, and a key a dialog has already answered is left alone.
 */
export function useClipShortcuts(options: ClipShortcutOptions = {}) {
  const { isBlocked, onShowHelp } = options;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (isBlocked?.()) return;

      const state = useClipStore.getState();
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod) {
        if (key === "z" && event.shiftKey) {
          event.preventDefault();
          redo();
        } else if (key === "z") {
          event.preventDefault();
          undo();
        } else if (key === "y") {
          event.preventDefault();
          redo();
        } else if (key === "b") {
          event.preventDefault();
          splitSelectionAtPlayhead();
        } else if (key === "d") {
          // The browser would otherwise take this one for a bookmark.
          event.preventDefault();
          duplicateSelection();
        } else if (key === "a") {
          event.preventDefault();
          selectAll();
        }
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (event.key === "Escape") {
        clearSelection();
        return;
      }
      if (event.key === "Enter" || event.key === "F2") {
        // Enter belongs to a button that has the focus before it belongs to a
        // cue, and a field never reaches here at all.
        if (
          event.target instanceof HTMLElement &&
          event.target.tagName === "BUTTON"
        )
          return;
        const timeline = activeTimeline();
        if (!timeline) return;
        const chosen = selectedClips(timeline, state.selection);
        if (chosen.length !== 1 || chosen[0].kind !== "text") return;
        event.preventDefault();
        editCue(chosen[0]);
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        onShowHelp?.();
        return;
      }
      if (event.key === " ") {
        // The browser would otherwise page the room along under the keys.
        event.preventDefault();
        state.togglePlay();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        state.setPlayhead(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        const timeline = activeTimeline();
        state.setPlayhead(timeline ? cutEndMs(timeline) : 0);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        // A key at the playhead is a hand placing it, so the store's own
        // setter stops the clock first. A second is a second; a frame is the
        // document's own frame, stepped on its clock.
        const fps = activeTimeline()?.settings.fps ?? 30;
        const back = event.key === "ArrowLeft";
        if (event.shiftKey) {
          state.setPlayhead(state.playheadMs + (back ? -1_000 : 1_000));
        } else {
          state.setPlayhead(
            back
              ? prevFrameMs(state.playheadMs, fps)
              : nextFrameMs(state.playheadMs, fps),
          );
        }
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const timeline = activeTimeline();
        if (!timeline) return;
        const edge = nearestClipEdgeMs(
          timeline,
          state.playheadMs,
          event.key === "ArrowUp" ? -1 : 1,
        );
        if (edge !== null) state.setPlayhead(edge);
        return;
      }
      if (event.key === "+") {
        event.preventDefault();
        state.zoomBy(ZOOM_STEP);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        state.zoomBy(1 / ZOOM_STEP);
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isBlocked, onShowHelp]);
}
