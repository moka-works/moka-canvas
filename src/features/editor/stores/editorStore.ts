import { create } from "zustand";
import type {
  AssetDrawing,
  AssetId,
  AssetKind,
  AssetVoiceReference,
  CanvasId,
  EdgeId,
  NodeId,
  Point,
  Viewport,
} from "../../../shared/domain";
import { openCanvas } from "../interactions/canvasTree";
import { usePanelFolds } from "./panelFolds";
import { useProjectStore } from "./projectStore";
import type { BarEntry } from "./toolPrefs";

export type EditorTool = "select" | "pan";

/**
 * What the column beside the canvas is showing.
 *
 * One column and a choice rather than several columns, since a canvas with a
 * resources column, an inspector, a conversation and a history beside it has
 * very little of itself left to look at.
 */
export type SidePanelTab = "inspector" | "assistant" | "history";

/**
 * What the column on the other side of the canvas is showing.
 *
 * Two faces of one column rather than two columns: what a project holds — its
 * boards and the folders they are filed in — and what it is made of, the assets
 * a board can be given. They are read together often enough to sit beside each
 * other, and a canvas narrow enough to need one of them folded away needs the
 * other folded away too.
 */
export type LeftPanelTab = "project" | "assets";

export interface Selection {
  nodeIds: NodeId[];
  edgeIds: EdgeId[];
}

export interface PortRef {
  nodeId: NodeId;
  portId: string;
}

export type ContextMenuTarget =
  | { kind: "canvas"; world: Point }
  | { kind: "node"; nodeId: NodeId }
  | { kind: "edge"; edgeId: EdgeId }
  | { kind: "port"; nodeId: NodeId; portId: string };

export interface ContextMenuState {
  x: number;
  y: number;
  target: ContextMenuTarget;
}

export interface NodeMenuState {
  /** Screen coordinates for the DOM menu. */
  x: number;
  y: number;
  /** World coordinate where the new node is created. */
  world: Point;
  /** Set when the menu opened from a dropped connection. */
  connectFrom: PortRef | null;
}

/**
 * One primary pointer gesture runs at a time. The canvas controller owns the
 * live preview and mirrors transitions here so DOM UI (menus, status line,
 * cursor affordances) can react without touching Leafer internals.
 */
export type ActiveGesture =
  | { kind: "idle" }
  | {
      kind: "panning";
      pointerId: number;
      startClient: Point;
      startViewport: Viewport;
    }
  | {
      kind: "marquee";
      pointerId: number;
      startWorld: Point;
      currentWorld: Point;
      additive: boolean;
    }
  | {
      kind: "draggingNodes";
      pointerId: number;
      nodeIds: NodeId[];
      startPositions: Record<NodeId, Point>;
      currentDelta: Point;
      snap: boolean;
    }
  | {
      kind: "resizingNode";
      pointerId: number;
      nodeId: NodeId;
      handle: string;
      startBounds: { x: number; y: number; width: number; height: number };
    }
  | {
      kind: "connecting";
      pointerId: number;
      source: PortRef;
      currentWorld: Point;
      compatibleTargets: PortRef[];
    }
  | { kind: "draggingAsset"; assetId: string; currentWorld: Point }
  | { kind: "draggingMinimap"; pointerId: number };

/** A tool asked of the picture a node holds, naming the picture it was asked of. */
export interface PictureToolAsk {
  nodeId: NodeId;
  assetId: AssetId;
  tool: BarEntry;
}

/**
 * What the asset picker was opened for.
 *
 * A dialog that only picks files would not know what picking them means: the
 * same shelf file becomes a node of its own, or something one node is given,
 * or a clip landing on the cut — three asks, and the dialog's own footer says
 * what the answer will come to. Where it is meant to become a node, the world
 * point the ask was made at travels with it, so the nodes land where the
 * reader was looking rather than at the middle of the view.
 */
export type AssetPickerState =
  | { mode: "nodes"; at: Point | null }
  | { mode: "reference"; nodeId: NodeId }
  | { mode: "place" };

interface EditorState {
  tool: EditorTool;
  /** Space/Ctrl-held temporary tool inversion. */
  temporaryTool: EditorTool | null;
  /** Live camera while panning/zooming; persisted to the canvas on gesture end. */
  camera: Viewport | null;
  selection: Selection;
  hoveredNodeId: NodeId | null;
  hoveredPort: PortRef | null;
  gesture: ActiveGesture;
  /** Last known pointer position in world coordinates (paste-at-pointer). */
  pointerWorld: Point | null;
  /** Which of its two faces the left column is showing. */
  leftPanelTab: LeftPanelTab;
  /** Which kind of asset the assets column is listing. */
  assetKind: AssetKind;
  /**
   * The asset a reader was taken to, when one was asked for by name.
   *
   * Following an asset from the tree lands on the shelf with that one row marked
   * and in view, since a list of a hundred files scrolled to somewhere in the
   * middle is a list nobody can find their place in.
   */
  focusedAssetId: AssetId | null;
  /**
   * The file the column beside the canvas is reading, when one is.
   *
   * A click on the shelf is a question about that file rather than a move on
   * the canvas, so what the inspector reads is the file: what it is, what it
   * holds, and where it came from. Going to the cards that use it is offered
   * beside the row instead, since a reader who wanted the cards would have
   * asked for the cards — and would not want the click that showed them a file
   * to have moved the canvas under them first.
   */
  inspectedAssetId: AssetId | null;
  /** Which of its three faces the column beside the canvas is showing. */
  sidePanelTab: SidePanelTab;
  contextMenu: ContextMenuState | null;
  nodeMenu: NodeMenuState | null;
  renaming: { nodeId: NodeId } | null;
  /** Text-node body editing (textarea overlay). */
  textEditing: { nodeId: NodeId } | null;
  /**
   * The generation panel open under a node, and whether it takes the keyboard.
   *
   * Asked for by an entry the user chose (Enter, the right-click menu) it does;
   * brought up because a node was selected it must not, or typing would land in
   * the prompt and Delete would stop deleting the node.
   */
  promptPanel: { nodeId: NodeId; focus: boolean } | null;
  /** Inspector "replace input" pick mode: choosing a new source node. */
  inputPick: { nodeId: NodeId; portId: string } | null;
  /**
   * Confirmation for deleting an asset something still holds.
   *
   * What a delete can empty, listed whole: the cards to take the file out of,
   * the story places keeping it as a drawing they are not using, and the
   * voices naming it as their reference recording. A file held by nothing
   * opens no prompt.
   */
  assetDeletePrompt: {
    assetId: AssetId;
    nodeIds: NodeId[];
    drawings: AssetDrawing[];
    references: AssetVoiceReference[];
  } | null;
  /** Full-preview dialog for an asset (image/video). */
  previewAssetId: AssetId | null;
  /** The keyboard help dialog. */
  shortcutsOpen: boolean;
  /**
   * The tool being asked of a node's picture, if one is.
   *
   * The asset is named here rather than left to be found again from the node:
   * what a tool works on is the file the node held when it was asked, and a node
   * re-filled while the dialog is open must not change the subject under it.
   *
   * One field for every entry the bar offers, including the one that ends in a
   * generation rather than in a local operator, because the bar asks one
   * question at a time and two fields for it could both be answered at once.
   */
  pictureTool: PictureToolAsk | null;
  /** The asset picker dialog, and what it was opened for. */
  assetPicker: AssetPickerState | null;
  /** Screen-reader announcement fed to the editor's live region. */
  announcement: string;

  setTool: (tool: EditorTool) => void;
  setTemporaryTool: (tool: EditorTool | null) => void;
  setCamera: (camera: Viewport) => void;
  setSelection: (selection: Selection) => void;
  selectOnly: (nodeId: NodeId) => void;
  toggleNode: (nodeId: NodeId) => void;
  clearSelection: () => void;
  setHoveredNode: (nodeId: NodeId | null) => void;
  setHoveredPort: (port: PortRef | null) => void;
  setGesture: (gesture: ActiveGesture) => void;
  setPointerWorld: (point: Point | null) => void;
  setLeftPanelTab: (tab: LeftPanelTab) => void;
  setAssetKind: (kind: AssetKind) => void;
  /**
   * Opens the assets column on the kind an asset is filed under, with that one
   * marked. The kind travels with the ask rather than being worked out here,
   * since what asked is a row of the tree that was already grouping by it.
   *
   * The column reads one board — the one being looked at — so a file a tree
   * row names is followed to the board that holds it: marking it where the
   * reader is standing would mark a row that is not there. The board may be
   * left out, and then the column is turned over where the reader already is.
   */
  showAssetOnShelf: (
    assetId: AssetId,
    kind: AssetKind,
    canvasId?: CanvasId,
  ) => void;
  clearAssetFocus: () => void;
  /**
   * Turns the column beside the canvas to its inspector and gives it a file to
   * read. The turn is part of the ask rather than a second one: a reader who
   * clicked a file to find out about it is not helped by an answer given to a
   * conversation they were having on another face of the same column — nor by
   * one given to a column they folded away, so a column that is away stands
   * back up to answer.
   */
  inspectAsset: (assetId: AssetId) => void;
  /** Puts the file down, leaving the inspector to whatever is chosen instead. */
  clearAssetInspection: () => void;
  setSidePanelTab: (tab: SidePanelTab) => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
  openNodeMenu: (menu: NodeMenuState) => void;
  closeNodeMenu: () => void;
  startRenaming: (nodeId: NodeId) => void;
  stopRenaming: () => void;
  startEditingText: (nodeId: NodeId) => void;
  stopEditingText: () => void;
  openPromptPanel: (nodeId: NodeId, focus?: boolean) => void;
  closePromptPanel: () => void;
  startInputPick: (target: { nodeId: NodeId; portId: string }) => void;
  stopInputPick: () => void;
  openAssetDeletePrompt: (prompt: {
    assetId: AssetId;
    nodeIds: NodeId[];
    drawings: AssetDrawing[];
    references: AssetVoiceReference[];
  }) => void;
  closeAssetDeletePrompt: () => void;
  openPreview: (assetId: AssetId) => void;
  closePreview: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  openPictureTool: (ask: PictureToolAsk) => void;
  closePictureTool: () => void;
  openAssetPicker: (ask: AssetPickerState) => void;
  closeAssetPicker: () => void;
  announce: (message: string) => void;
}

export const EMPTY_SELECTION: Selection = { nodeIds: [], edgeIds: [] };

export const useEditorStore = create<EditorState>()((set) => ({
  tool: "select",
  temporaryTool: null,
  camera: null,
  selection: EMPTY_SELECTION,
  hoveredNodeId: null,
  hoveredPort: null,
  gesture: { kind: "idle" },
  pointerWorld: null,
  leftPanelTab: "project",
  assetKind: "image",
  focusedAssetId: null,
  inspectedAssetId: null,
  sidePanelTab: "inspector",
  contextMenu: null,
  nodeMenu: null,
  renaming: null,
  textEditing: null,
  promptPanel: null,
  inputPick: null,
  assetDeletePrompt: null,
  previewAssetId: null,
  shortcutsOpen: false,
  pictureTool: null,
  assetPicker: null,
  announcement: "",

  setTool: (tool) => set({ tool }),
  setTemporaryTool: (tool) => set({ temporaryTool: tool }),
  setCamera: (camera) => set({ camera }),
  // Choosing on the canvas puts the file down: what the inspector reads is
  // whatever was chosen last, so a file read a moment ago does not keep the
  // column from saying what the thing just clicked on is.
  setSelection: (selection) => set({ selection, inspectedAssetId: null }),
  selectOnly: (nodeId) =>
    set({
      selection: { nodeIds: [nodeId], edgeIds: [] },
      inspectedAssetId: null,
    }),
  toggleNode: (nodeId) =>
    set((state) => {
      const nodeIds = state.selection.nodeIds.includes(nodeId)
        ? state.selection.nodeIds.filter((id) => id !== nodeId)
        : [...state.selection.nodeIds, nodeId];
      return {
        selection: { nodeIds, edgeIds: state.selection.edgeIds },
        inspectedAssetId: null,
      };
    }),
  clearSelection: () =>
    set({ selection: EMPTY_SELECTION, inspectedAssetId: null }),
  setHoveredNode: (nodeId) => set({ hoveredNodeId: nodeId }),
  setHoveredPort: (port) => set({ hoveredPort: port }),
  setGesture: (gesture) => set({ gesture }),
  setPointerWorld: (point) => set({ pointerWorld: point }),
  setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),
  setAssetKind: (kind) => set({ assetKind: kind }),
  showAssetOnShelf: (assetId, kind, canvasId) => {
    const project = useProjectStore.getState();
    if (canvasId !== undefined && canvasId !== project.activeCanvasId) {
      openCanvas(canvasId);
    }
    set({
      leftPanelTab: "assets",
      assetKind: kind,
      focusedAssetId: assetId,
    });
  },
  clearAssetFocus: () => set({ focusedAssetId: null }),
  inspectAsset: (assetId) => {
    // A column folded away cannot answer, and a click that goes nowhere reads
    // as a click that was not taken: the column stands back up to say what the
    // file is, and stays standing until it is folded away again.
    usePanelFolds.getState().setFolded("right", false);
    set({ inspectedAssetId: assetId, sidePanelTab: "inspector" });
  },
  clearAssetInspection: () => set({ inspectedAssetId: null }),
  setSidePanelTab: (tab) => set({ sidePanelTab: tab }),
  openContextMenu: (menu) => set({ contextMenu: menu }),
  closeContextMenu: () => set({ contextMenu: null }),
  openNodeMenu: (menu) => set({ nodeMenu: menu }),
  closeNodeMenu: () => set({ nodeMenu: null }),
  startRenaming: (nodeId) => set({ renaming: { nodeId } }),
  stopRenaming: () => set({ renaming: null }),
  startEditingText: (nodeId) => set({ textEditing: { nodeId } }),
  stopEditingText: () => set({ textEditing: null }),
  openPromptPanel: (nodeId, focus = false) =>
    set({ promptPanel: { nodeId, focus } }),
  closePromptPanel: () => set({ promptPanel: null }),
  startInputPick: (target) => set({ inputPick: target }),
  stopInputPick: () => set({ inputPick: null }),
  openAssetDeletePrompt: (prompt) => set({ assetDeletePrompt: prompt }),
  closeAssetDeletePrompt: () => set({ assetDeletePrompt: null }),
  openPreview: (assetId) => set({ previewAssetId: assetId }),
  closePreview: () => set({ previewAssetId: null }),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  openPictureTool: (ask) => set({ pictureTool: ask }),
  closePictureTool: () => set({ pictureTool: null }),
  openAssetPicker: (ask) => set({ assetPicker: ask }),
  closeAssetPicker: () => set({ assetPicker: null }),
  announce: (message) => set({ announcement: message }),
}));

export function useEffectiveTool(): EditorTool {
  return useEditorStore((state) => state.temporaryTool ?? state.tool);
}
