import { useEffect, useRef } from "react";
import type { CanvasDocument } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import type {
  ControllerCallbacks,
  HitTarget,
  LeaferEditorController,
} from "./controller";
import { coalescing, registerController } from "./canvasControl";
import {
  checkConnection,
  connectPorts,
  marqueeSelect,
  moveNodes,
  pickSourceCandidates,
  relatedHighlight,
  resizeNodeTo,
  resolveInputPick,
  selectNodeWithMembers,
} from "../interactions/actions";
import { useAppearance } from "../stores/appearance";
import { useEditorStore, type ContextMenuTarget } from "../stores/editorStore";
import { openDirector } from "../../director/stores/directorStore";
import { useProjectStore } from "../stores/projectStore";
import { nodeRunViews, useRunStore } from "../stores/runStore";
import { buildIssueIndex, buildResourceIndex } from "./mediaCards";

/** How often words arriving from a run may redraw the scene, at the most. */
const RUN_REDRAW_MS = 100;

function activeCanvas(): CanvasDocument | null {
  const { moka, activeCanvasId } = useProjectStore.getState();
  if (!moka) return null;
  return (
    moka.canvas.find((canvas) => canvas.id === activeCanvasId) ??
    moka.canvas[0] ??
    null
  );
}

/** Controller callbacks bound to the host element for screen→client offsets. */
function createCallbacks(host: () => HTMLElement | null): ControllerCallbacks {
  const toClient = (screen: { x: number; y: number }) => {
    const rect = host()?.getBoundingClientRect();
    return { x: screen.x + (rect?.left ?? 0), y: screen.y + (rect?.top ?? 0) };
  };
  return {
    onBackgroundTap: () => {
      const editor = useEditorStore.getState();
      if (editor.inputPick) {
        editor.stopInputPick();
        return;
      }
      editor.clearSelection();
      editor.announce(i18n.t("editor:interactions.nothingSelected"));
    },
    onBackgroundDoubleTap: (world, screen) => {
      const client = toClient(screen);
      useEditorStore
        .getState()
        .openNodeMenu({ x: client.x, y: client.y, world, connectFrom: null });
    },
    onNodePress: (nodeId, additive) => selectNodeWithMembers(nodeId, additive),
    onPickNode: (nodeId) => resolveInputPick(nodeId),
    onNodeDoubleTap: (nodeId) => {
      const canvas = activeCanvas();
      const node = canvas?.nodes.find((entry) => entry.id === nodeId);
      const editor = useEditorStore.getState();
      if (node?.kind === "text") {
        editor.startEditingText(nodeId);
      } else if (node?.kind === "director") {
        openDirector(nodeId);
      } else {
        editor.startRenaming(nodeId);
      }
    },
    onEdgeTap: (edgeId, additive) => {
      const editor = useEditorStore.getState();
      const edgeIds = editor.selection.edgeIds;
      if (additive) {
        editor.setSelection({
          nodeIds: editor.selection.nodeIds,
          edgeIds: edgeIds.includes(edgeId)
            ? edgeIds.filter((id) => id !== edgeId)
            : [...edgeIds, edgeId],
        });
      } else {
        editor.setSelection({ nodeIds: [], edgeIds: [edgeId] });
      }
    },
    onConnect: (source, target) => connectPorts(source, target),
    onConnectDropOnCanvas: (source, world, screen) => {
      const client = toClient(screen);
      useEditorStore.getState().openNodeMenu({
        x: client.x,
        y: client.y,
        world,
        connectFrom: source,
      });
    },
    onMoveNodes: (positions) => moveNodes(positions),
    onResizeNode: (nodeId, bounds) => resizeNodeTo(nodeId, bounds),
    onMarqueeSelect: (bounds, additive) => marqueeSelect(bounds, additive),
    onCameraChange: (camera, phase) => {
      useEditorStore.getState().setCamera(camera);
      if (phase !== "end") return;
      const canvas = activeCanvas();
      if (!canvas) return;
      try {
        // Viewport persistence bypasses history: camera moves are not undoable.
        useProjectStore
          .getState()
          .applyLocal([
            { type: "setViewport", canvasId: canvas.id, viewport: camera },
          ]);
      } catch {
        // A save conflict freezes autosave; keep the local camera.
      }
    },
    onContextMenu: (screen, target: HitTarget) => {
      const editor = useEditorStore.getState();
      let menuTarget: ContextMenuTarget;
      if (target.kind === "node" || target.kind === "resize") {
        if (!editor.selection.nodeIds.includes(target.nodeId)) {
          selectNodeWithMembers(target.nodeId, false);
        }
        menuTarget = { kind: "node", nodeId: target.nodeId };
      } else if (target.kind === "edge") {
        editor.setSelection({ nodeIds: [], edgeIds: [target.edgeId] });
        menuTarget = { kind: "edge", edgeId: target.edgeId };
      } else if (target.kind === "port") {
        menuTarget = { kind: "node", nodeId: target.nodeId };
      } else {
        menuTarget = { kind: "canvas", world: target.world };
      }
      const client = toClient(screen);
      editor.openContextMenu({ x: client.x, y: client.y, target: menuTarget });
    },
    onHover: (nodeId, port) => {
      const editor = useEditorStore.getState();
      editor.setHoveredNode(nodeId);
      editor.setHoveredPort(port);
    },
    onPointerWorld: (point) => useEditorStore.getState().setPointerWorld(point),
    onGestureChange: (gesture) => useEditorStore.getState().setGesture(gesture),
    checkConnection: (source, target) => checkConnection(source, target),
    wantPan: () => {
      const editor = useEditorStore.getState();
      return (editor.temporaryTool ?? editor.tool) === "pan";
    },
    snapEnabled: () => activeCanvas()?.settings.snapToGrid ?? true,
  };
}

/**
 * Mounts the long-lived Leafer controller and feeds it store projections.
 * All document mutations flow back through store actions via callbacks.
 * The controller is imported lazily so environments without a canvas
 * implementation (jsdom tests) still render the DOM fallback.
 */
export function CanvasSurface() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: LeaferEditorController | null = null;
    let unsubscribe: (() => void) | null = null;

    const start = (Ctor: typeof LeaferEditorController) => {
      const host = hostRef.current;
      if (cancelled || !host) return;
      const instance = new Ctor();
      try {
        instance.mount(
          host,
          createCallbacks(() => hostRef.current),
        );
      } catch {
        // No working canvas implementation: the DOM hint overlay remains as
        // the accessible fallback.
        return;
      }
      controller = instance;
      registerController(instance);

      let lastCanvasId: string | null = null;
      const push = () => {
        const canvas = activeCanvas();
        const editor = useEditorStore.getState();
        if (!canvas) return;
        if (canvas.id !== lastCanvasId) {
          // Adopt the target canvas's persisted viewport on switch.
          lastCanvasId = canvas.id;
          editor.setCamera(canvas.viewport);
        }
        const camera = editor.camera ?? canvas.viewport;
        const { moka, selfCheck } = useProjectStore.getState();
        instance.render({
          canvasId: canvas.id,
          camera,
          nodes: canvas.nodes,
          edges: canvas.edges,
          groups: canvas.groups,
          selection: editor.selection,
          hoveredNodeId: editor.hoveredNodeId,
          related: relatedHighlight(),
          background: canvas.settings.background,
          showMinimap: canvas.settings.showMinimap,
          theme: useAppearance.getState().theme,
          resources: moka ? buildResourceIndex(moka) : new Map(),
          issues: buildIssueIndex(selfCheck),
          pick: editor.inputPick
            ? {
                ...editor.inputPick,
                candidates: pickSourceCandidates(canvas, editor.inputPick),
              }
            : null,
          runViews: nodeRunViews(),
        });
      };

      // Words arriving from a run move the store once per word. The document and
      // the pointer redraw at once, since a hand waiting on its own click is a
      // hand that clicks again; the words may wait for the end of their frame.
      const words = coalescing(RUN_REDRAW_MS, push);
      const unsubscribeProject = useProjectStore.subscribe(push);
      const unsubscribeEditor = useEditorStore.subscribe(push);
      const unsubscribeRuns = useRunStore.subscribe(words.fire);
      const unsubscribeAppearance = useAppearance.subscribe(push);
      unsubscribe = () => {
        unsubscribeProject();
        unsubscribeEditor();
        unsubscribeRuns();
        unsubscribeAppearance();
        words.stop();
      };
      push();
    };

    import("./controller")
      .then((module) => start(module.LeaferEditorController))
      .catch(() => {
        // Leafer cannot load here (e.g. jsdom); keep the DOM fallback.
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      registerController(null);
      controller?.dispose();
    };
  }, []);

  return (
    <div
      className="canvas-surface"
      data-testid="canvas-surface"
      ref={hostRef}
    />
  );
}
