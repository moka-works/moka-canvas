import { useEffect } from "react";
import { findNode, generationCapabilityFor } from "../../../shared/domain";
import type { WorkflowNode } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { redo, undo } from "../commands/execute";
import { cancelGesture, zoomBy, zoomReset } from "../canvas/canvasControl";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import {
  activeCanvas,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  fitSelectionAction,
  fitViewAction,
  groupSelection,
  pasteClipboard,
  selectAll,
  ungroupSelection,
} from "./actions";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Words the page itself has selected, as opposed to nodes the canvas has.
 *
 * The canvas is painted, so a selection can only be words — in a panel, a
 * dialog, a title. Those words are what a copy or a cut means when they are
 * selected, even while nodes are selected too: answering with a fragment
 * would bury what was pointed at under a JSON blob, and a cut would delete
 * nodes nobody asked about.
 */
export function pageTextSelected(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return selection.toString().trim() !== "";
}

/** One line of the shortcuts dialog: the keys that work and what they do. */
export interface ShortcutRow {
  label: string;
  /** Alternate ways to press it; "Mod" and "Shift" are drawn per platform. */
  chords: string[][];
}

/** A section of the shortcuts dialog. */
export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

/**
 * What the editor answers to, as the help dialog lists it.
 *
 * Written here under the handler rather than in the dialog so the two are read
 * together: a key that moves in one and not the other is caught between
 * neighbours rather than between files.
 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "editor:shortcuts.groupEditing",
    rows: [
      { label: "editor:shortcuts.undo", chords: [["Mod", "Z"]] },
      {
        label: "editor:shortcuts.redo",
        chords: [
          ["Shift", "Mod", "Z"],
          ["Mod", "Y"],
        ],
      },
      { label: "editor:shortcuts.selectAll", chords: [["Mod", "A"]] },
      { label: "editor:shortcuts.copy", chords: [["Mod", "C"]] },
      { label: "editor:shortcuts.cut", chords: [["Mod", "X"]] },
      { label: "editor:shortcuts.paste", chords: [["Mod", "V"]] },
      { label: "editor:shortcuts.duplicate", chords: [["Mod", "D"]] },
      {
        label: "editor:shortcuts.deleteSelection",
        chords: [["Delete"], ["Backspace"]],
      },
      {
        label: "editor:shortcuts.editOrAsk",
        chords: [["Enter"]],
      },
      {
        label: "editor:shortcuts.closeOrClear",
        chords: [["Escape"]],
      },
    ],
  },
  {
    title: "editor:shortcuts.groupSelection",
    rows: [
      { label: "editor:shortcuts.group", chords: [["Mod", "G"]] },
      { label: "editor:shortcuts.ungroup", chords: [["Shift", "Mod", "G"]] },
    ],
  },
  {
    title: "editor:shortcuts.groupView",
    rows: [
      { label: "editor:shortcuts.zoomIn", chords: [["Mod", "="]] },
      { label: "editor:shortcuts.zoomOut", chords: [["Mod", "-"]] },
      { label: "editor:shortcuts.actualSize", chords: [["Mod", "0"]] },
      { label: "editor:shortcuts.fitEverything", chords: [["Mod", "1"]] },
      {
        label: "editor:shortcuts.fitSelection",
        chords: [["Shift", "Mod", "1"]],
      },
      {
        label: "editor:shortcuts.panWhileHeld",
        chords: [["Space"]],
      },
      {
        label: "editor:shortcuts.otherToolWhileHeld",
        chords: [["Ctrl"]],
      },
      {
        label: "editor:shortcuts.secondAction",
        chords: [["Middle-drag"], ["Three-finger drag"]],
      },
      { label: "editor:shortcuts.selectTool", chords: [["V"]] },
      { label: "editor:shortcuts.panTool", chords: [["H"]] },
    ],
  },
  {
    title: "editor:shortcuts.groupHelp",
    rows: [{ label: "editor:shortcuts.keyboardShortcuts", chords: [["?"]] }],
  },
];

/** What Enter does to the one selected node. */
export type EnterIntent = "edit" | "ask" | "configure" | "rename";

/**
 * Enter edits a text node that already has words in it, configures a node
 * whose inputs are declared by an installed definition, and otherwise asks the
 * node for something.
 *
 * A node with nothing in it is more often a request waiting to be typed than a
 * title waiting to be changed, so the panel takes the key. Renaming keeps
 * double-click and the right-click menu, which is where a title edit is looked
 * for once Enter is spoken for.
 */
export function enterIntent(node: WorkflowNode | undefined): EnterIntent {
  if (!node) return "rename";
  if (node.kind === "text") {
    const content = (node.data as { content?: string }).content ?? "";
    return content.trim() === "" ? "ask" : "edit";
  }
  if (node.kind === "extension") return "configure";
  return generationCapabilityFor(node.kind) === null ? "rename" : "ask";
}

/**
 * Global editor keyboard map. Both Cmd and Ctrl are accepted so automated
 * tests and either platform work; display labels use the platform modifier.
 */
export function useEditorKeyboard() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editor = useEditorStore.getState();
      const project = useProjectStore.getState();
      if (!project.moka) return;
      if (
        editor.assetDeletePrompt ||
        editor.previewAssetId ||
        editor.shortcutsOpen
      )
        return;
      if (editor.pictureTool) return;
      if (isEditableTarget(event.target)) return;

      const mod = event.metaKey || event.ctrlKey;

      // Temporary tool inversion while held. Space always borrows the pan
      // tool; Ctrl holds the other of the two, whichever is not being held —
      // the choosing hand pans and the panning hand chooses. With Cmd held,
      // Ctrl keydowns are modifier noise, so gate on key.
      if (event.key === " " && !mod && !event.repeat) {
        editor.setTemporaryTool("pan");
        event.preventDefault();
        return;
      }
      if (event.key === "Control" && !event.metaKey && !event.repeat) {
        editor.setTemporaryTool(editor.tool === "pan" ? "select" : "pan");
        return;
      }

      if (event.key === "Escape") {
        if (editor.nodeMenu) {
          editor.closeNodeMenu();
        } else if (editor.contextMenu) {
          editor.closeContextMenu();
        } else if (editor.renaming) {
          editor.stopRenaming();
        } else if (editor.textEditing) {
          editor.stopEditingText();
        } else if (editor.promptPanel) {
          editor.closePromptPanel();
        } else if (editor.extensionPanel) {
          editor.closeExtensionPanel();
        } else if (editor.inputPick) {
          editor.stopInputPick();
        } else if (editor.gesture.kind !== "idle") {
          cancelGesture();
        } else {
          editor.clearSelection();
          editor.announce(i18n.t("editor:interactions.nothingSelected"));
        }
        return;
      }

      if (mod) {
        const key = event.key.toLowerCase();
        // Selected words belong to the browser, which copies them as words.
        if ((key === "c" || key === "x") && pageTextSelected()) return;
        if (key === "z" && event.shiftKey) {
          event.preventDefault();
          redo();
        } else if (key === "z") {
          event.preventDefault();
          undo();
        } else if (key === "y") {
          event.preventDefault();
          redo();
        } else if (key === "a") {
          event.preventDefault();
          selectAll();
        } else if (key === "c") {
          event.preventDefault();
          void copySelection();
        } else if (key === "x") {
          event.preventDefault();
          void cutSelection();
        } else if (key === "d") {
          event.preventDefault();
          void duplicateSelection();
        } else if (key === "g" && event.shiftKey) {
          event.preventDefault();
          ungroupSelection();
        } else if (key === "g") {
          event.preventDefault();
          groupSelection();
        } else if (key === "=" || key === "+") {
          event.preventDefault();
          zoomBy(1.2);
        } else if (key === "-") {
          event.preventDefault();
          zoomBy(1 / 1.2);
        } else if (key === "0") {
          event.preventDefault();
          zoomReset();
        } else if (key === "1" && event.shiftKey) {
          event.preventDefault();
          fitSelectionAction();
        } else if (key === "1") {
          event.preventDefault();
          fitViewAction();
        }
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        editor.openShortcuts();
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
        return;
      }

      if (event.key === "Enter") {
        const selection = editor.selection;
        if (selection.nodeIds.length === 1) {
          const nodeId = selection.nodeIds[0];
          const canvas = activeCanvas();
          const node = canvas ? findNode(canvas, nodeId) : undefined;
          if (!node) return;
          const intent = enterIntent(node);
          if (intent === "edit") editor.startEditingText(nodeId);
          else if (intent === "ask") editor.openPromptPanel(nodeId, true);
          else if (intent === "configure")
            editor.openExtensionPanel(nodeId, true);
          else editor.startRenaming(nodeId);
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "v" && !event.repeat) editor.setTool("select");
      if (key === "h" && !event.repeat) editor.setTool("pan");
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "Control") {
        useEditorStore.getState().setTemporaryTool(null);
      }
    };

    // Paste rides the event rather than the keydown: a keydown carries no
    // clipboard, and only the event knows what a paste actually holds — files
    // among it, several at once.
    const onPaste = (event: ClipboardEvent) => {
      const editor = useEditorStore.getState();
      if (!useProjectStore.getState().moka) return;
      if (
        editor.assetDeletePrompt ||
        editor.previewAssetId ||
        editor.shortcutsOpen ||
        editor.pictureTool
      ) {
        return;
      }
      // A field keeps its own paste; the browser knows what to put in it.
      if (isEditableTarget(event.target)) return;
      void pasteClipboard(event);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  }, []);
}

/** Uses the active canvas; exported for menu/shortcut parity tests. */
export { activeCanvas };
