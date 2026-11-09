import {
  Creator,
  Group,
  Leafer,
  Line,
  Matrix,
  Platform,
  PointerEvent,
  Rect,
} from "leafer-ui";
import type { IBoundsData, ILeaf, IPointerEvent } from "leafer-ui";
import {
  CLICK_DRAG_THRESHOLD_PX,
  FIT_ANIMATION_MS,
  FIT_VIEWPORT_USAGE,
  GRID_BASE_SPACING,
  LOW_DETAIL_ZOOM,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  type AssetId,
  type CanvasId,
  type EdgeId,
  type GroupMembership,
  type NodeId,
  type Point,
  type Rect as WorldRect,
  type ResourceEntry,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import type { ActiveGesture, PortRef, Selection } from "../stores/editorStore";
import type { NodeRunView } from "../stores/runStore";
import {
  centerOn,
  clampZoom,
  panByPixels,
  screenToWorld,
  wheelZoomFactor,
  worldToScreen,
  zoomAtPoint,
  type Camera,
  type ViewSize,
} from "./camera";
import { createEdgeView, updateEdgeView, type EdgeView } from "./edgeRenderer";
import { relatedDimmed } from "./emphasis";
import { GridBackground, type GridMode } from "./gridRenderer";
import { MinimapView } from "./minimap";
import {
  advanceHalo,
  createNodeView,
  haloLeaves,
  portAnchorWorld,
  previewNodeBounds,
  sameRun,
  setPortHighlight,
  updateNodeView,
  type NodeView,
} from "./nodeRenderers";
import { mediaInfoForNode, mediaSignature } from "./mediaCards";
import { applyCanvasTheme, canvasTheme, type CanvasThemeName } from "./theme";

/** Screen-pixel radius in which an input port snaps a pending connection. */
const CONNECT_PORT_SNAP_PX = 40;
/** Screen-pixel padding around a node body that still counts as a target. */
const CONNECT_BODY_PADDING_PX = 32;
/** Corner resize handle hit size in screen pixels. */
const HANDLE_HIT_PX = 28;
const HANDLE_VISUAL_PX = 10;
/** Node edge/center snap distance in screen pixels. */
const SNAP_PX = 6;
/** Grid snap increment in world units when snapToGrid is on. */
const SNAP_INCREMENT = GRID_BASE_SPACING / 4;
/** Two taps within this window and pixel distance count as a double-tap. */
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 6;
/** How many fingers on glass make the second action. */
const SECOND_ACTION_FINGERS = 3;
/** Snapshot density: twice the diagram's own pixels, so text stays crisp. */
const SNAPSHOT_PIXEL_RATIO = 2;
/** The most pixels one snapshot may hold, about 4096². */
const SNAPSHOT_MAX_PIXELS = 4096 * 4096;
/** The longest edge a browser canvas may have. */
const SNAPSHOT_MAX_SIDE = 16384;

export type ConnectionCheck = "ok" | "replace" | "invalid";

export interface ControllerCallbacks {
  onBackgroundTap(world: Point): void;
  onBackgroundDoubleTap(world: Point, screen: Point): void;
  /** Pointer-down selection (capture phase), before any drag begins. */
  onNodePress(nodeId: NodeId, additive: boolean): void;
  onNodeDoubleTap(nodeId: NodeId): void;
  /** Inspector pick mode: a node tap chooses the replacement source. */
  onPickNode(nodeId: NodeId): void;
  onEdgeTap(edgeId: EdgeId, additive: boolean): void;
  /** Committed connection from an output port to a compatible input. */
  onConnect(source: PortRef, target: PortRef): void;
  /** Connection released on blank space: open the filtered add-node menu. */
  onConnectDropOnCanvas(source: PortRef, world: Point, screen: Point): void;
  /** One atomic position commit at the end of a node drag. */
  onMoveNodes(positions: Record<NodeId, Point>): void;
  onResizeNode(nodeId: NodeId, bounds: WorldRect): void;
  onMarqueeSelect(bounds: WorldRect, additive: boolean): void;
  /** Live camera gestures report "move"; the settled camera reports "end". */
  onCameraChange(camera: Camera, phase: "move" | "end"): void;
  onContextMenu(screen: Point, target: HitTarget): void;
  onHover(nodeId: NodeId | null, port: PortRef | null): void;
  onPointerWorld(point: Point | null): void;
  /** Mirrors the gesture state machine into the editor store. */
  onGestureChange(gesture: ActiveGesture): void;
  /** Domain-level validation for a pending connection. */
  checkConnection(source: PortRef, target: PortRef): ConnectionCheck;
  /** True while the pan tool (or a pan modifier) should grab drags. */
  wantPan(): boolean;
  snapEnabled(): boolean;
}

export type HitTarget =
  | { kind: "canvas"; world: Point }
  | { kind: "node"; nodeId: NodeId }
  | { kind: "edge"; edgeId: EdgeId }
  | { kind: "port"; nodeId: NodeId; portId: string }
  | { kind: "resize"; nodeId: NodeId; corner: string };

export interface SceneState {
  canvasId: CanvasId;
  camera: Camera;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: GroupMembership[];
  selection: Selection;
  hoveredNodeId: NodeId | null;
  /** Related-highlight chain; null when the highlight is inactive. */
  related: { nodeIds: NodeId[]; edgeIds: EdgeId[] } | null;
  background: GridMode;
  showMinimap: boolean;
  /** The palette this scene is drawn in; the controller applies it. */
  theme: CanvasThemeName;
  /** Asset registry lookup for media cards. */
  resources: ReadonlyMap<AssetId, ResourceEntry>;
  /** Self-check issue reason per asset id (missing/changed/empty). */
  issues: ReadonlyMap<AssetId, "missing" | "changed" | "empty">;
  /** Inspector input-replace pick mode; candidates are the allowed sources. */
  pick: {
    nodeId: NodeId;
    portId: string;
    candidates: ReadonlySet<NodeId>;
  } | null;
  /** What each node's own run says about it; absent when no run covers it. */
  runViews: ReadonlyMap<NodeId, NodeRunView>;
}

interface EdgeRecord {
  view: EdgeView;
  from: Point;
  to: Point;
  signature: string;
}

type Corner = "nw" | "ne" | "sw" | "se";

type Gesture =
  | { kind: "idle" }
  | {
      kind: "pendingNode";
      startView: Point;
      nodeId: NodeId;
      additive: boolean;
      wasSelected: boolean;
    }
  | {
      kind: "pendingBackground";
      startView: Point;
      panEligible: boolean;
      /** What the pointer actually pressed (edge or blank canvas). */
      target: HitTarget;
    }
  | {
      kind: "panning";
      startView: Point;
      lastView: Point;
      startCamera: Camera;
    }
  | {
      kind: "marquee";
      startWorld: Point;
      additive: boolean;
      rect: Rect;
    }
  | {
      kind: "draggingNodes";
      nodeIds: NodeId[];
      primaryId: NodeId;
      startPositions: Map<NodeId, Point>;
      delta: Point;
    }
  | {
      kind: "resizingNode";
      nodeId: NodeId;
      corner: Corner;
      startBounds: WorldRect;
      bounds: WorldRect;
    }
  | {
      kind: "connecting";
      source: PortRef;
      sourceWorld: Point;
      currentWorld: Point;
      preview: EdgeView;
      target: { ref: PortRef; check: ConnectionCheck } | null;
    }
  | { kind: "minimap" };

export class LeaferEditorController {
  private leafer: Leafer | null = null;
  private container: HTMLElement | null = null;
  private callbacks: ControllerCallbacks | null = null;
  private observer: ResizeObserver | null = null;
  private size: ViewSize = { width: 0, height: 0 };
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private canvasId: CanvasId | null = null;
  /** True while inspector input-replace pick mode owns node taps. */
  private pickActive = false;
  private lastBackground: GridMode = "dots";
  private lastNodes: WorkflowNode[] = [];
  private lastShowMinimap = true;
  private lastTheme: CanvasThemeName | null = null;
  private lastGroups = new Map<NodeId, NodeId[]>();

  private grid = new GridBackground();
  private world = new Group({ data: { role: "world" } });
  private edgeLayer = new Group({ data: { role: "edgeLayer" } });
  private nodeLayer = new Group({ data: { role: "nodeLayer" } });
  private interactionLayer = new Group({ data: { role: "interactionLayer" } });
  private selectionLayer = new Group({ data: { role: "selectionLayer" } });
  private minimap = new MinimapView();

  private nodeViews = new Map<NodeId, NodeView>();
  private edgeViews = new Map<EdgeId, EdgeRecord>();
  private selectionSignature = "";
  private gesture: Gesture = { kind: "idle" };
  private dragOriginView: Point | null = null;
  /**
   * The fingers down on glass, and the second action three of them own.
   *
   * A trackpad on a Mac has no middle button to press, and what it has
   * instead is three fingers: the third one to land takes the canvas over
   * from whatever the first two were doing, and the three of them together
   * drag the second action until one of them lifts.
   */
  private touchPoints = new Map<number, Point>();
  private secondary: { kind: "pan" | "marquee"; last: Point } | null = null;
  private lastTap: { time: number; view: Point; key: string } | null = null;
  private guides: Line[] = [];
  private animation: { frame: number } | null = null;
  /** The clock the rings of running cards are moved by; null while none are. */
  private haloTick: number | null = null;

  private cameraEndTimer: ReturnType<typeof setTimeout> | null = null;
  private disposers: (() => void)[] = [];

  private stats = { renders: 0, nodeCreates: 0, nodeUpdates: 0 };

  mount(container: HTMLElement, callbacks: ControllerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    const rect = container.getBoundingClientRect();
    this.size = {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };

    const leafer = new Leafer({
      view: container,
      width: this.size.width,
      height: this.size.height,
      fill: canvasTheme.background,
    });
    this.leafer = leafer;

    this.grid.resize(this.size);
    leafer.add(this.grid.canvas);
    this.world.add(this.edgeLayer);
    this.world.add(this.nodeLayer);
    this.world.add(this.interactionLayer);
    this.world.add(this.selectionLayer);
    leafer.add(this.world);
    leafer.add(this.minimap.group);

    // Taps are detected by the gesture machine itself: Leafer's TAP fires
    // before the window pointerup that ends a pending gesture, which would
    // swallow plain clicks. DOWN/MOVE/MENU are safe to consume directly.
    leafer.on(PointerEvent.DOWN, (event) => this.handleDown(event));
    leafer.on(PointerEvent.MENU, (event) => this.handleMenu(event));
    leafer.on(PointerEvent.MOVE, (event) => this.handleHover(event));

    const onPointerMove = (event: globalThis.PointerEvent) =>
      this.handleDragMove(event);
    const onPointerUp = (event: globalThis.PointerEvent) =>
      this.handleDragEnd(event);
    const onPointerCancel = () => this.cancelGesture();
    const onWheel = (event: WheelEvent) => this.handleWheel(event);
    // Fingers on glass are counted here, on the raw events, because the
    // second action they make is one leafer knows nothing about.
    const onTouchDown = (event: globalThis.PointerEvent) =>
      this.handleTouchDown(event);
    const onTouchMove = (event: globalThis.PointerEvent) =>
      this.handleTouchMove(event);
    const onTouchUp = (event: globalThis.PointerEvent) =>
      this.handleTouchUp(event);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    container.addEventListener("pointerdown", onTouchDown);
    window.addEventListener("pointermove", onTouchMove);
    window.addEventListener("pointerup", onTouchUp);
    window.addEventListener("pointercancel", onTouchUp);
    container.addEventListener("wheel", onWheel, { passive: false });
    this.disposers.push(() => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      container.removeEventListener("pointerdown", onTouchDown);
      window.removeEventListener("pointermove", onTouchMove);
      window.removeEventListener("pointerup", onTouchUp);
      window.removeEventListener("pointercancel", onTouchUp);
      container.removeEventListener("wheel", onWheel);
    });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
  }

  resize() {
    const container = this.container;
    const leafer = this.leafer;
    if (!container || !leafer) return;
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.size = { width: rect.width, height: rect.height };
    leafer.resize(this.size);
    this.grid.resize(this.size);
    this.grid.draw(this.camera, this.lastBackground);
    this.applyCamera();
    this.selectionSignature = "";
    if (this.lastShowMinimap) {
      this.minimap.update(
        this.lastNodes,
        this.camera,
        this.size,
        minimapAccent,
      );
    }
  }

  render(scene: SceneState) {
    this.stats.renders += 1;
    if (!this.leafer) return;

    if (scene.canvasId !== this.canvasId) {
      this.canvasId = scene.canvasId;
      this.clearScene();
    }

    // A palette is read while views are being built, so a switch has to happen
    // before them: everything already drawn was drawn in the old one and is
    // rebuilt below rather than patched in place.
    applyCanvasTheme(scene.theme);
    if (scene.theme !== this.lastTheme) {
      this.lastTheme = scene.theme;
      this.clearScene();
      // The workspace itself is painted by the canvas element rather than by a
      // view, so its background is taken by hand.
      this.leafer.set({ fill: canvasTheme.background });
    }

    this.camera = scene.camera;
    this.lastBackground = scene.background;
    this.lastNodes = scene.nodes;
    this.lastShowMinimap = scene.showMinimap;
    this.lastGroups = new Map(
      scene.groups.map((g) => [g.groupId, g.childNodeIds]),
    );
    this.applyCamera();
    this.grid.draw(scene.camera, scene.background);

    const lowDetail = scene.camera.zoom < LOW_DETAIL_ZOOM;
    const relatedNodes = scene.related ? new Set(scene.related.nodeIds) : null;
    this.pickActive = scene.pick !== null;
    const seen = new Set<NodeId>();
    for (const node of scene.nodes) {
      seen.add(node.id);
      const pickDimmed =
        scene.pick !== null &&
        node.id !== scene.pick.nodeId &&
        !scene.pick.candidates.has(node.id);
      const run = scene.runViews.get(node.id) ?? null;
      const visual = {
        selected: scene.selection.nodeIds.includes(node.id),
        hovered: scene.hoveredNodeId === node.id,
        lowDetail,
        dimmed:
          pickDimmed ||
          (scene.pick === null && relatedDimmed(relatedNodes, node.id)),
        run,
      };
      let view = this.nodeViews.get(node.id);
      const media = mediaInfoForNode(node, scene.resources, scene.issues);
      const signature = mediaSignature(media);
      if (!view) {
        view = createNodeView(node, visual, media);
        this.nodeLayer.add(view.group);
        this.nodeViews.set(node.id, view);
        this.stats.nodeCreates += 1;
      } else if (
        view.node !== node ||
        view.media.signature !== signature ||
        view.visual.selected !== visual.selected ||
        view.visual.hovered !== visual.hovered ||
        view.visual.lowDetail !== visual.lowDetail ||
        view.visual.dimmed !== visual.dimmed ||
        !sameRun(view.visual.run, visual.run)
      ) {
        updateNodeView(view, node, visual, media);
        this.stats.nodeUpdates += 1;
      }
      view.visual = visual;
      view.group.zIndex = node.zIndex;
    }
    for (const [nodeId, view] of this.nodeViews) {
      if (!seen.has(nodeId)) {
        view.group.destroy();
        this.nodeViews.delete(nodeId);
      }
    }
    this.syncHaloLoop();

    this.reconcileEdges(
      scene,
      scene.related ? new Set(scene.related.edgeIds) : null,
    );
    this.reconcileSelection(scene);

    this.minimap.group.visible = scene.showMinimap;
    if (scene.showMinimap) {
      this.minimap.update(scene.nodes, scene.camera, this.size, minimapAccent);
    }

    if (import.meta.env.DEV) {
      (window as unknown as { __mokaRenderStats?: unknown }).__mokaRenderStats =
        this.stats;
    }
  }

  focusNode(nodeId: NodeId) {
    const view = this.nodeViews.get(nodeId);
    if (!view || !this.callbacks) return;
    this.callbacks.onCameraChange(
      centerOn(this.camera, view.node.bounds),
      "end",
    );
  }

  worldToClient(point: Point): Point {
    return worldToScreen(this.camera, this.size, point);
  }

  clientToWorld(point: Point): Point {
    return screenToWorld(this.camera, this.size, point);
  }

  viewCenterWorld(): Point {
    return { x: this.camera.x, y: this.camera.y };
  }

  zoomByAtCenter(factor: number) {
    this.zoomToAtCenter(this.camera.zoom * factor);
  }

  zoomToAtCenter(zoom: number) {
    const next = clampZoom(zoom);
    if (next === this.camera.zoom) return;
    this.emitCamera(
      zoomAtPoint(
        this.camera,
        this.size,
        { x: this.size.width / 2, y: this.size.height / 2 },
        next / this.camera.zoom,
      ),
      "end",
    );
  }

  /** Animated fit-to-bounds with ease-out, ~60% viewport usage. */
  fitBoundsAnimated(bounds: WorldRect) {
    const zoom = clampZoom(
      Math.min(
        (this.size.width * FIT_VIEWPORT_USAGE) / Math.max(1, bounds.width),
        (this.size.height * FIT_VIEWPORT_USAGE) / Math.max(1, bounds.height),
      ),
    );
    const target = centerOn({ ...this.camera, zoom }, bounds);
    this.animateCamera(target);
  }

  /**
   * A PNG of everything the canvas holds, drawn in the diagram's own
   * coordinates rather than through the camera, so what is saved does not
   * depend on how the canvas happens to be scrolled or zoomed. Marks that
   * exist only for the hand — the selection outline, a connection being
   * pulled, the minimap — stay out of the picture.
   */
  async renderSnapshot(): Promise<Blob> {
    const leafer = this.leafer;
    if (!leafer || this.nodeViews.size === 0) {
      throw new Error(i18n.t("editor:canvas.nothingToExport"));
    }
    // Bounds are read from the views themselves so that everything drawn —
    // strokes, shadows, run badges — fits inside the picture.
    this.world.updateLayout();
    const boxes: IBoundsData[] = [this.nodeLayer.getBounds("render", "inner")];
    if (this.edgeViews.size > 0) {
      boxes.push(this.edgeLayer.getBounds("render", "inner"));
    }
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const width = Math.ceil(
      Math.max(...boxes.map((box) => box.x + box.width)) - left,
    );
    const height = Math.ceil(
      Math.max(...boxes.map((box) => box.y + box.height)) - top,
    );
    if (width < 1 || height < 1) {
      throw new Error(i18n.t("editor:canvas.nothingToExport"));
    }

    // One picture rather than tiles: the density gives way as the diagram
    // grows, so the browser is never asked for a canvas it cannot hold.
    const density = Math.min(
      SNAPSHOT_PIXEL_RATIO,
      Math.sqrt(SNAPSHOT_MAX_PIXELS / (width * height)),
      SNAPSHOT_MAX_SIDE / Math.max(width, height),
    );
    const canvas = Creator.canvas!({ width, height, pixelRatio: density });
    // The ring a running card wears says something about this moment rather
    // than about the document, so it is kept out of the picture.
    const halos = [...this.nodeViews.values()].flatMap(haloLeaves);
    const hidden = [
      this.grid.canvas,
      this.minimap.group,
      this.interactionLayer,
      this.selectionLayer,
      ...halos,
    ];
    const wasVisible = hidden.map((leaf) => leaf.visible);
    hidden.forEach((leaf) => (leaf.visible = false));
    let blob: Blob | null = null;
    try {
      // The matrix cancels the camera, so every view draws where the document
      // puts it. The workspace colour comes from the leafer's own canvas
      // element rather than from any view, so it is put back here by hand.
      const matrix = new Matrix(this.world.worldTransform)
        .invert()
        .translate(-left, -top);
      canvas.save();
      Platform.render!(leafer, canvas, { exporting: true, matrix });
      canvas.restore();
      canvas.fillWorld(
        canvas.bounds,
        canvasTheme.background,
        "destination-over",
      );
      blob = await new Promise<Blob | null>((resolve) =>
        (canvas.view as HTMLCanvasElement).toBlob(resolve, "image/png"),
      );
    } finally {
      hidden.forEach((leaf, index) => (leaf.visible = wasVisible[index]));
      canvas.destroy();
    }
    if (!blob) throw new Error(i18n.t("editor:canvas.encodeFailed"));
    return blob;
  }

  /** Ends any active gesture, clearing previews without committing. */
  cancelGesture() {
    if (this.gesture.kind === "idle") return;
    const gesture = this.gesture;
    this.teardownGesture(gesture);
    this.setGesture({ kind: "idle" });
  }

  dispose() {
    this.cancelGesture();
    this.stopHaloLoop();
    if (this.animation) cancelAnimationFrame(this.animation.frame);
    if (this.cameraEndTimer) clearTimeout(this.cameraEndTimer);
    this.observer?.disconnect();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.clearScene();
    this.leafer?.destroy();
    this.leafer = null;
    this.container = null;
    this.callbacks = null;
  }

  // --- internals ---------------------------------------------------------

  /**
   * Keeps the ring clock running exactly as long as something is lit.
   *
   * Started when the first card begins to be worked on and stopped when the
   * last one finishes, rather than left turning with nothing to move: a canvas
   * with nothing running should cost no frames at all, and one with a single
   * node running should cost no more than the ring it is drawing.
   */
  private syncHaloLoop() {
    let lit = false;
    for (const view of this.nodeViews.values()) {
      if (view.halo) {
        lit = true;
        break;
      }
    }
    if (lit && this.haloTick === null) {
      const step = (now: number) => {
        for (const view of this.nodeViews.values()) advanceHalo(view, now);
        this.haloTick = requestAnimationFrame(step);
      };
      this.haloTick = requestAnimationFrame(step);
    } else if (!lit) {
      this.stopHaloLoop();
    }
  }

  private stopHaloLoop() {
    if (this.haloTick === null) return;
    cancelAnimationFrame(this.haloTick);
    this.haloTick = null;
  }

  private clearScene() {
    this.stopHaloLoop();
    for (const view of this.nodeViews.values()) view.group.destroy();
    this.nodeViews.clear();
    for (const record of this.edgeViews.values()) record.view.group.destroy();
    this.edgeViews.clear();
    this.selectionLayer.removeAll();
    this.interactionLayer.removeAll();
    this.guides = [];
    this.selectionSignature = "";
  }

  private applyCamera() {
    this.world.set({
      x: this.size.width / 2 - this.camera.x * this.camera.zoom,
      y: this.size.height / 2 - this.camera.y * this.camera.zoom,
      scaleX: this.camera.zoom,
      scaleY: this.camera.zoom,
    });
  }

  private animateCamera(target: Camera) {
    if (this.animation) cancelAnimationFrame(this.animation.frame);
    const from = this.camera;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / FIT_ANIMATION_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      this.emitCamera(
        {
          x: from.x + (target.x - from.x) * eased,
          y: from.y + (target.y - from.y) * eased,
          zoom: from.zoom + (target.zoom - from.zoom) * eased,
        },
        t >= 1 ? "end" : "move",
      );
      if (t < 1) {
        this.animation = { frame: requestAnimationFrame(step) };
      } else {
        this.animation = null;
      }
    };
    this.animation = { frame: requestAnimationFrame(step) };
  }

  private hitTarget(event: IPointerEvent): HitTarget {
    const world = screenToWorld(this.camera, this.size, {
      x: event.x,
      y: event.y,
    });
    let leaf = event.target as ILeaf | undefined;
    while (leaf && leaf !== this.leafer && leaf !== this.world) {
      const data = leaf.data as
        | {
            role?: string;
            nodeId?: string;
            portId?: string;
            edgeId?: string;
            corner?: string;
          }
        | undefined;
      if (data?.role === "minimap") return { kind: "canvas", world };
      if (data?.role === "resizeHandle" && data.nodeId && data.corner) {
        return { kind: "resize", nodeId: data.nodeId, corner: data.corner };
      }
      if (data?.role === "port" && data.nodeId && data.portId) {
        return { kind: "port", nodeId: data.nodeId, portId: data.portId };
      }
      if ((data?.role === "node" || data?.role === "body") && data.nodeId) {
        return { kind: "node", nodeId: data.nodeId };
      }
      if (data?.role === "edge" && data.edgeId) {
        return { kind: "edge", edgeId: data.edgeId };
      }
      leaf = leaf.parent as ILeaf | undefined;
    }
    return { kind: "canvas", world };
  }

  private isMinimapHit(event: IPointerEvent): boolean {
    let leaf = event.target as ILeaf | undefined;
    while (leaf && leaf !== this.leafer) {
      const data = leaf.data as { role?: string } | undefined;
      if (data?.role === "minimap") return true;
      leaf = leaf.parent as ILeaf | undefined;
    }
    return false;
  }

  private handleDoubleTapKey(target: HitTarget): string {
    switch (target.kind) {
      case "node":
        return `node:${target.nodeId}`;
      case "edge":
        return `edge:${target.edgeId}`;
      default:
        return "canvas";
    }
  }

  /** True when this tap follows an identical-target tap within the window. */
  private detectDoubleTap(view: Point, target: HitTarget): boolean {
    const key = this.handleDoubleTapKey(target);
    const previous = this.lastTap;
    this.lastTap = { time: performance.now(), view, key };
    return (
      previous !== null &&
      previous.key === key &&
      performance.now() - previous.time <= DOUBLE_TAP_MS &&
      distance(previous.view, view) <= DOUBLE_TAP_PX
    );
  }

  private handleDown(event: IPointerEvent) {
    const callbacks = this.callbacks;
    if (!callbacks || this.gesture.kind !== "idle") return;
    // The fingers owning the second action are the only hand on the canvas
    // until one of them lifts.
    if (this.secondary !== null) return;
    // Right button is handled by MENU (context menu), never starts a gesture.
    if (event.right) return;
    const view = { x: event.x, y: event.y };

    if (this.isMinimapHit(event)) {
      const center = this.minimap.toWorld(view);
      this.emitCamera({ ...this.camera, x: center.x, y: center.y }, "move");
      this.setGesture({ kind: "minimap" });
      return;
    }

    const target = this.hitTarget(event);
    const additive = Boolean(event.shiftKey || event.metaKey || event.ctrlKey);

    // The middle button is the second action, and the second action is the
    // opposite of the first: the select tool chooses with the primary drag and
    // moves the canvas with the middle one, and the pan tool moves the canvas
    // with the primary drag and chooses with the middle one. A three-finger
    // drag on a Mac arrives here the same way, being what the trackpad makes
    // of a middle button.
    if (event.middle) {
      if (callbacks.wantPan()) {
        this.startMarquee(view, additive);
      } else {
        this.startPanning(view);
      }
      return;
    }

    switch (target.kind) {
      case "resize": {
        const nodeView = this.nodeViews.get(target.nodeId);
        if (!nodeView) return;
        this.setGesture({
          kind: "resizingNode",
          nodeId: target.nodeId,
          corner: target.corner as Corner,
          startBounds: { ...nodeView.node.bounds },
          bounds: { ...nodeView.node.bounds },
        });
        return;
      }
      case "port": {
        const nodeView = this.nodeViews.get(target.nodeId);
        const port = nodeView?.node.ports.find((p) => p.id === target.portId);
        if (!nodeView || !port) return;
        if (port.direction === "output") {
          this.startConnecting(
            { nodeId: target.nodeId, portId: target.portId },
            nodeView,
          );
          return;
        }
        // Input ports behave like node body presses (selection only).
        this.pressNode(target.nodeId, additive, view);
        return;
      }
      case "node": {
        this.pressNode(target.nodeId, additive, view);
        return;
      }
      default: {
        this.setGesture({
          kind: "pendingBackground",
          startView: view,
          panEligible: callbacks.wantPan(),
          target,
        });
      }
    }
  }

  private pressNode(nodeId: NodeId, additive: boolean, view: Point) {
    const callbacks = this.callbacks;
    if (!callbacks) return;
    const wasSelected = this.currentSelection().nodeIds.includes(nodeId);
    if (!wasSelected && !this.pickActive) {
      callbacks.onNodePress(nodeId, additive);
    }
    this.setGesture({
      kind: "pendingNode",
      startView: view,
      nodeId,
      additive,
      wasSelected,
    });
  }

  private currentSelection(): Selection {
    const nodeIds: NodeId[] = [];
    for (const [nodeId, view] of this.nodeViews) {
      if (view.visual.selected) nodeIds.push(nodeId);
    }
    return { nodeIds, edgeIds: [] };
  }

  private handleHover(event: IPointerEvent) {
    const callbacks = this.callbacks;
    if (!callbacks || this.gesture.kind !== "idle") return;
    const target = this.hitTarget(event);
    if (target.kind === "node" || target.kind === "resize") {
      callbacks.onHover(target.nodeId, null);
    } else if (target.kind === "port") {
      callbacks.onHover(target.nodeId, {
        nodeId: target.nodeId,
        portId: target.portId,
      });
    } else {
      callbacks.onHover(null, null);
    }
  }

  private viewPointOf(event: globalThis.PointerEvent): Point {
    const rect = this.container?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  }

  private handleDragMove(event: globalThis.PointerEvent) {
    if (event.isPrimary === false) return;
    // A finger is not the hand while three of them own the second action.
    if (this.secondary !== null && event.pointerType === "touch") return;
    const callbacks = this.callbacks;
    if (!callbacks) return;
    const view = this.viewPointOf(event);
    const world = screenToWorld(this.camera, this.size, view);
    callbacks.onPointerWorld(world);
    const gesture = this.gesture;
    if (gesture.kind === "idle") return;

    switch (gesture.kind) {
      case "pendingNode": {
        if (distance(view, gesture.startView) <= CLICK_DRAG_THRESHOLD_PX)
          return;
        // Pick mode is tap-only; moves stay frozen while it owns the canvas.
        if (this.pickActive) return;
        // Promote to a drag over the full current selection.
        const selection = this.currentSelection();
        const nodeIds = selection.nodeIds.includes(gesture.nodeId)
          ? this.expandWithMembers(selection.nodeIds)
          : this.expandWithMembers([gesture.nodeId]);
        const startPositions = new Map<NodeId, Point>();
        for (const nodeId of nodeIds) {
          const nodeView = this.nodeViews.get(nodeId);
          if (nodeView) {
            startPositions.set(nodeId, {
              x: nodeView.node.bounds.x,
              y: nodeView.node.bounds.y,
            });
          }
        }
        this.dragOriginView = gesture.startView;
        this.setGesture({
          kind: "draggingNodes",
          nodeIds: [...startPositions.keys()],
          primaryId: gesture.nodeId,
          startPositions,
          delta: { x: 0, y: 0 },
        });
        return;
      }
      case "pendingBackground": {
        if (distance(view, gesture.startView) <= CLICK_DRAG_THRESHOLD_PX)
          return;
        if (gesture.panEligible) {
          this.startPanning(gesture.startView);
        } else {
          this.startMarquee(
            gesture.startView,
            Boolean(event.shiftKey || event.metaKey || event.ctrlKey),
          );
        }
        this.handleDragMove(event);
        return;
      }
      case "panning": {
        const dx = view.x - gesture.lastView.x;
        const dy = view.y - gesture.lastView.y;
        gesture.lastView = view;
        this.emitCamera(panByPixels(this.camera, dx, dy), "move");
        return;
      }
      case "minimap": {
        const center = this.minimap.toWorld(view);
        this.emitCamera({ ...this.camera, x: center.x, y: center.y }, "move");
        return;
      }
      case "marquee": {
        this.updateMarquee(gesture, world);
        return;
      }
      case "draggingNodes": {
        this.updateNodeDrag(gesture, view);
        return;
      }
      case "resizingNode": {
        this.updateResize(gesture, world, event.shiftKey);
        return;
      }
      case "connecting": {
        gesture.currentWorld = world;
        this.updateConnection(gesture);
        return;
      }
    }
  }

  private handleDragEnd(event: globalThis.PointerEvent) {
    if (event.isPrimary === false) return;
    if (this.secondary !== null && event.pointerType === "touch") return;
    const callbacks = this.callbacks;
    if (!callbacks) return;
    const gesture = this.gesture;
    if (gesture.kind === "idle") return;
    const view = this.viewPointOf(event);
    const world = screenToWorld(this.camera, this.size, view);
    const additive = Boolean(event.shiftKey || event.metaKey || event.ctrlKey);

    switch (gesture.kind) {
      case "pendingNode": {
        if (this.pickActive) {
          callbacks.onPickNode(gesture.nodeId);
          break;
        }
        if (
          this.detectDoubleTap(view, { kind: "node", nodeId: gesture.nodeId })
        ) {
          callbacks.onNodeDoubleTap(gesture.nodeId);
        } else if (gesture.wasSelected) {
          // Click without drag on an already-selected node: collapse the kept
          // multi-selection, or toggle it back off in additive mode.
          callbacks.onNodePress(gesture.nodeId, gesture.additive);
        }
        break;
      }
      case "pendingBackground": {
        if (gesture.target.kind === "edge") {
          this.detectDoubleTap(view, gesture.target);
          callbacks.onEdgeTap(gesture.target.edgeId, additive);
        } else {
          if (this.detectDoubleTap(view, { kind: "canvas", world })) {
            callbacks.onBackgroundDoubleTap(world, view);
          } else {
            callbacks.onBackgroundTap(world);
          }
        }
        break;
      }
      case "panning":
      case "minimap": {
        this.emitCamera(this.camera, "end");
        break;
      }
      case "marquee": {
        const bounds: WorldRect = {
          x: Math.min(gesture.startWorld.x, world.x),
          y: Math.min(gesture.startWorld.y, world.y),
          width: Math.abs(world.x - gesture.startWorld.x),
          height: Math.abs(world.y - gesture.startWorld.y),
        };
        callbacks.onMarqueeSelect(bounds, gesture.additive);
        break;
      }
      case "draggingNodes": {
        if (gesture.delta.x !== 0 || gesture.delta.y !== 0) {
          const positions: Record<NodeId, Point> = {};
          for (const [nodeId, start] of gesture.startPositions) {
            positions[nodeId] = {
              x: start.x + gesture.delta.x,
              y: start.y + gesture.delta.y,
            };
          }
          callbacks.onMoveNodes(positions);
        }
        break;
      }
      case "resizingNode": {
        const start = gesture.startBounds;
        const end = gesture.bounds;
        if (
          start.x !== end.x ||
          start.y !== end.y ||
          start.width !== end.width ||
          start.height !== end.height
        ) {
          callbacks.onResizeNode(gesture.nodeId, end);
        }
        break;
      }
      case "connecting": {
        if (gesture.target && gesture.target.check !== "invalid") {
          callbacks.onConnect(gesture.source, gesture.target.ref);
        } else if (!gesture.target) {
          callbacks.onConnectDropOnCanvas(gesture.source, world, view);
        }
        break;
      }
    }
    this.teardownGesture(gesture);
    this.setGesture({ kind: "idle" });
  }

  /** Removes preview artifacts of a finished or cancelled gesture. */
  private teardownGesture(gesture: Gesture) {
    switch (gesture.kind) {
      case "marquee":
        gesture.rect.remove();
        break;
      case "draggingNodes":
        this.clearGuides();
        this.dragOriginView = null;
        break;
      case "resizingNode": {
        const view = this.nodeViews.get(gesture.nodeId);
        if (view) previewNodeBounds(view, view.node.bounds);
        break;
      }
      case "connecting":
        gesture.preview.group.destroy();
        this.clearPortHighlights();
        break;
      default:
        break;
    }
  }

  private setGesture(next: Gesture) {
    this.gesture = next;
    if (this.container) {
      this.container.style.cursor =
        next.kind === "panning" || next.kind === "minimap" ? "grabbing" : "";
    }
    this.mirrorGesture(next, null);
  }

  /** Mirrors the plan-shaped gesture into the editor store. */
  private mirrorGesture(gesture: Gesture, world: Point | null) {
    const callbacks = this.callbacks;
    if (!callbacks) return;
    switch (gesture.kind) {
      case "idle":
        callbacks.onGestureChange({ kind: "idle" });
        break;
      case "panning":
        callbacks.onGestureChange({
          kind: "panning",
          pointerId: 1,
          startClient: gesture.startView,
          startViewport: gesture.startCamera,
        });
        break;
      case "marquee":
        callbacks.onGestureChange({
          kind: "marquee",
          pointerId: 1,
          startWorld: gesture.startWorld,
          currentWorld: world ?? gesture.startWorld,
          additive: gesture.additive,
        });
        break;
      case "draggingNodes":
        callbacks.onGestureChange({
          kind: "draggingNodes",
          pointerId: 1,
          nodeIds: gesture.nodeIds,
          startPositions: Object.fromEntries(gesture.startPositions),
          currentDelta: gesture.delta,
          snap: callbacks.snapEnabled(),
        });
        break;
      case "resizingNode":
        callbacks.onGestureChange({
          kind: "resizingNode",
          pointerId: 1,
          nodeId: gesture.nodeId,
          handle: gesture.corner,
          startBounds: gesture.startBounds,
        });
        break;
      case "connecting":
        callbacks.onGestureChange({
          kind: "connecting",
          pointerId: 1,
          source: gesture.source,
          currentWorld: world ?? gesture.currentWorld,
          compatibleTargets: this.compatibleInputPorts(gesture.source),
        });
        break;
      case "minimap":
        callbacks.onGestureChange({ kind: "draggingMinimap", pointerId: 1 });
        break;
      default:
        break;
    }
  }

  // --- pan / zoom --------------------------------------------------------

  private startPanning(view: Point) {
    this.setGesture({
      kind: "panning",
      startView: view,
      lastView: view,
      startCamera: this.camera,
    });
  }

  /**
   * The other half of the second action: a drag that chooses rather than
   * moves. Started by a primary drag under the select tool, and by the
   * middle button (or three-finger drag) under the pan tool.
   */
  private startMarquee(view: Point, additive: boolean) {
    const rect = new Rect({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fill: canvasTheme.marqueeFill,
      stroke: canvasTheme.marquee,
      strokeWidth: 1 / this.camera.zoom,
      dashPattern: [5 / this.camera.zoom, 4 / this.camera.zoom],
      hittable: false,
    });
    this.interactionLayer.add(rect);
    this.setGesture({
      kind: "marquee",
      startWorld: screenToWorld(this.camera, this.size, view),
      additive,
      rect,
    });
  }

  private updateMarquee(
    gesture: Extract<Gesture, { kind: "marquee" }>,
    world: Point,
  ) {
    const x = Math.min(gesture.startWorld.x, world.x);
    const y = Math.min(gesture.startWorld.y, world.y);
    gesture.rect.set({
      x,
      y,
      width: Math.abs(world.x - gesture.startWorld.x),
      height: Math.abs(world.y - gesture.startWorld.y),
    });
    this.mirrorGesture(gesture, world);
  }

  // --- the second action on glass -----------------------------------------

  /** Where the fingers being tracked are, on average. */
  private touchCentroid(): Point {
    let x = 0;
    let y = 0;
    for (const point of this.touchPoints.values()) {
      x += point.x;
      y += point.y;
    }
    const count = Math.max(1, this.touchPoints.size);
    return { x: x / count, y: y / count };
  }

  private handleTouchDown(event: globalThis.PointerEvent) {
    if (event.pointerType !== "touch") return;
    this.touchPoints.set(event.pointerId, this.viewPointOf(event));
    if (
      this.secondary !== null ||
      this.touchPoints.size < SECOND_ACTION_FINGERS
    ) {
      return;
    }
    const callbacks = this.callbacks;
    if (!callbacks) return;
    const at = this.touchCentroid();
    // Whatever the first two fingers started is not what was asked for: a
    // third finger landing says the canvas, not the cards, is what is being
    // held, and the gesture under them is taken down without committing.
    this.cancelGesture();
    if (callbacks.wantPan()) {
      this.startMarquee(at, false);
      this.secondary = { kind: "marquee", last: at };
    } else {
      this.startPanning(at);
      this.secondary = { kind: "pan", last: at };
    }
  }

  private handleTouchMove(event: globalThis.PointerEvent) {
    if (event.pointerType !== "touch") return;
    if (!this.touchPoints.has(event.pointerId)) return;
    this.touchPoints.set(event.pointerId, this.viewPointOf(event));
    if (this.secondary === null) return;
    const at = this.touchCentroid();
    if (this.secondary.kind === "pan") {
      const dx = at.x - this.secondary.last.x;
      const dy = at.y - this.secondary.last.y;
      this.secondary.last = at;
      this.emitCamera(panByPixels(this.camera, dx, dy), "move");
      return;
    }
    const gesture = this.gesture;
    if (gesture.kind === "marquee") {
      this.secondary.last = at;
      this.updateMarquee(gesture, screenToWorld(this.camera, this.size, at));
    }
  }

  private handleTouchUp(event: globalThis.PointerEvent) {
    if (event.pointerType !== "touch") return;
    this.touchPoints.delete(event.pointerId);
    if (this.secondary === null) return;
    if (this.touchPoints.size >= SECOND_ACTION_FINGERS) return;
    // A finger lifted is the second action over: what it was doing lands the
    // way the same gesture from a mouse lands, and the fingers still down are
    // let go of, since what they do from here is the first action's business.
    const gesture = this.gesture;
    if (gesture.kind === "panning") {
      this.emitCamera(this.camera, "end");
    } else if (gesture.kind === "marquee") {
      const world = screenToWorld(this.camera, this.size, this.secondary.last);
      const bounds: WorldRect = {
        x: Math.min(gesture.startWorld.x, world.x),
        y: Math.min(gesture.startWorld.y, world.y),
        width: Math.abs(world.x - gesture.startWorld.x),
        height: Math.abs(world.y - gesture.startWorld.y),
      };
      this.callbacks?.onMarqueeSelect(bounds, gesture.additive);
    }
    this.teardownGesture(gesture);
    this.setGesture({ kind: "idle" });
    this.secondary = null;
    this.touchPoints.clear();
  }

  private handleWheel(event: WheelEvent) {
    event.preventDefault();
    const container = this.container;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const screen = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const factor = wheelZoomFactor(
      event.deltaY,
      event.ctrlKey || event.metaKey,
      this.camera.zoom,
    );
    this.emitCamera(
      zoomAtPoint(this.camera, this.size, screen, factor),
      "move",
    );
    if (this.cameraEndTimer) clearTimeout(this.cameraEndTimer);
    this.cameraEndTimer = setTimeout(
      () => this.emitCamera(this.camera, "end"),
      240,
    );
  }

  private handleMenu(event: IPointerEvent) {
    // A click that carries Ctrl is not the right button, however a Mac reads
    // it: Ctrl is held to borrow the other tool, and the menu that pops under
    // a hand in the middle of panning is a menu nobody asked for. A real
    // right button still brings the menu, Ctrl held over it or not.
    if (event.ctrlKey && !event.right) return;
    const target = this.hitTarget(event);
    this.callbacks?.onContextMenu({ x: event.x, y: event.y }, target);
  }

  private emitCamera(camera: Camera, phase: "move" | "end") {
    if (this.animation && phase === "move") {
      cancelAnimationFrame(this.animation.frame);
      this.animation = null;
    }
    this.camera = camera;
    this.callbacks?.onCameraChange(camera, phase);
  }

  // --- node drag + snap --------------------------------------------------

  private expandWithMembers(nodeIds: NodeId[]): NodeId[] {
    const result = new Set<NodeId>();
    for (const nodeId of nodeIds) {
      result.add(nodeId);
      const membership = this.lastGroups.get(nodeId);
      if (membership) {
        for (const member of membership) result.add(member);
      }
    }
    return [...result];
  }

  private updateNodeDrag(
    gesture: Extract<Gesture, { kind: "draggingNodes" }>,
    view: Point,
  ) {
    const origin = this.dragOriginView;
    if (!origin) return;
    let delta = {
      x: (view.x - origin.x) / this.camera.zoom,
      y: (view.y - origin.y) / this.camera.zoom,
    };

    const primaryStart = gesture.startPositions.get(gesture.primaryId);
    if (primaryStart && this.callbacks?.snapEnabled()) {
      const snapped = {
        x:
          Math.round((primaryStart.x + delta.x) / SNAP_INCREMENT) *
          SNAP_INCREMENT,
        y:
          Math.round((primaryStart.y + delta.y) / SNAP_INCREMENT) *
          SNAP_INCREMENT,
      };
      delta = { x: snapped.x - primaryStart.x, y: snapped.y - primaryStart.y };
    }

    this.clearGuides();
    if (primaryStart) {
      const primaryView = this.nodeViews.get(gesture.primaryId);
      if (primaryView) {
        const moved = {
          x: primaryStart.x + delta.x,
          y: primaryStart.y + delta.y,
          width: primaryView.node.bounds.width,
          height: primaryView.node.bounds.height,
        };
        const snap = this.findSnap(moved, new Set(gesture.nodeIds));
        delta = { x: delta.x + snap.dx, y: delta.y + snap.dy };
      }
    }

    gesture.delta = delta;
    for (const [nodeId, start] of gesture.startPositions) {
      const nodeView = this.nodeViews.get(nodeId);
      nodeView?.group.set({ x: start.x + delta.x, y: start.y + delta.y });
    }
    this.refreshEdgesTouching(new Set(gesture.nodeIds));
    this.mirrorGesture(gesture, null);
  }

  private findSnap(
    moved: WorldRect,
    dragged: Set<NodeId>,
  ): { dx: number; dy: number } {
    const threshold = SNAP_PX / this.camera.zoom;
    const sourcesX = [
      moved.x,
      moved.x + moved.width / 2,
      moved.x + moved.width,
    ];
    const sourcesY = [
      moved.y,
      moved.y + moved.height / 2,
      moved.y + moved.height,
    ];
    let bestX: { d: number; at: number } | null = null;
    let bestY: { d: number; at: number } | null = null;
    for (const [nodeId, view] of this.nodeViews) {
      if (dragged.has(nodeId)) continue;
      const b = view.node.bounds;
      const targetsX = [b.x, b.x + b.width / 2, b.x + b.width];
      const targetsY = [b.y, b.y + b.height / 2, b.y + b.height];
      for (const sx of sourcesX) {
        for (const tx of targetsX) {
          const d = tx - sx;
          if (
            Math.abs(d) <= threshold &&
            (!bestX || Math.abs(d) < Math.abs(bestX.d))
          ) {
            bestX = { d, at: tx };
          }
        }
      }
      for (const sy of sourcesY) {
        for (const ty of targetsY) {
          const d = ty - sy;
          if (
            Math.abs(d) <= threshold &&
            (!bestY || Math.abs(d) < Math.abs(bestY.d))
          ) {
            bestY = { d, at: ty };
          }
        }
      }
    }
    if (bestX) this.drawGuide("v", bestX.at, moved);
    if (bestY) this.drawGuide("h", bestY.at, moved);
    return { dx: bestX?.d ?? 0, dy: bestY?.d ?? 0 };
  }

  private drawGuide(axis: "h" | "v", at: number, near: WorldRect) {
    const span = 2000;
    const line = new Line({
      points:
        axis === "v"
          ? [at, near.y - span / 2, at, near.y + span]
          : [near.x - span / 2, at, near.x + span, at],
      stroke: canvasTheme.snapGuide,
      strokeWidth: 1 / this.camera.zoom,
      dashPattern: [4 / this.camera.zoom, 4 / this.camera.zoom],
      hittable: false,
    });
    this.interactionLayer.add(line);
    this.guides.push(line);
  }

  private clearGuides() {
    for (const line of this.guides) line.remove();
    this.guides = [];
  }

  // --- resize ------------------------------------------------------------

  private updateResize(
    gesture: Extract<Gesture, { kind: "resizingNode" }>,
    world: Point,
    freeResize: boolean,
  ) {
    const start = gesture.startBounds;
    const anchor = {
      x: gesture.corner.includes("w") ? start.x + start.width : start.x,
      y: gesture.corner.includes("n") ? start.y + start.height : start.y,
    };
    let width = Math.abs(world.x - anchor.x);
    let height = Math.abs(world.y - anchor.y);
    const view = this.nodeViews.get(gesture.nodeId);
    const keepAspect =
      !freeResize &&
      (view?.node.kind === "image" || view?.node.kind === "video");
    if (keepAspect) {
      const aspect = start.width / Math.max(1, start.height);
      if (width / Math.max(1, height) > aspect) width = height * aspect;
      else height = width / aspect;
    }
    width = Math.max(MIN_NODE_WIDTH, width);
    height = Math.max(MIN_NODE_HEIGHT, height);
    const x = gesture.corner.includes("w") ? anchor.x - width : anchor.x;
    const y = gesture.corner.includes("n") ? anchor.y - height : anchor.y;
    gesture.bounds = { x, y, width, height };
    if (view) {
      previewNodeBounds(view, gesture.bounds);
      this.refreshEdgesTouching(new Set([gesture.nodeId]));
    }
    this.mirrorGesture(gesture, null);
  }

  // --- connecting --------------------------------------------------------

  private startConnecting(source: PortRef, nodeView: NodeView) {
    const sourceWorld = portAnchorWorld(nodeView, source.portId);
    if (!sourceWorld) return;
    const preview = createEdgeView(
      { id: "__connection_preview__", source, target: source, createdAt: "" },
      sourceWorld,
      sourceWorld,
      { preview: true },
    );
    preview.hit.visible = false;
    this.interactionLayer.add(preview.group);
    this.setGesture({
      kind: "connecting",
      source,
      sourceWorld,
      currentWorld: sourceWorld,
      preview,
      target: null,
    });
    this.highlightCompatiblePorts(source);
  }

  private compatibleInputPorts(source: PortRef): PortRef[] {
    const sourceView = this.nodeViews.get(source.nodeId);
    const sourcePort = sourceView?.node.ports.find(
      (p) => p.id === source.portId,
    );
    if (!sourceView || !sourcePort) return [];
    const result: PortRef[] = [];
    for (const [nodeId, view] of this.nodeViews) {
      if (nodeId === source.nodeId) continue;
      for (const port of view.node.ports) {
        if (port.direction !== "input") continue;
        if (port.dataTypes.some((t) => sourcePort.dataTypes.includes(t))) {
          result.push({ nodeId, portId: port.id });
        }
      }
    }
    return result;
  }

  private highlightCompatiblePorts(source: PortRef) {
    const compatible = new Set(
      this.compatibleInputPorts(source).map(
        (ref) => `${ref.nodeId}:${ref.portId}`,
      ),
    );
    for (const [nodeId, view] of this.nodeViews) {
      if (nodeId === source.nodeId) continue;
      for (const [portId, port] of view.ports) {
        if (port.direction !== "input") continue;
        setPortHighlight(
          view,
          portId,
          compatible.has(`${nodeId}:${portId}`) ? "compatible" : "rejected",
        );
      }
    }
  }

  private clearPortHighlights() {
    for (const view of this.nodeViews.values()) {
      for (const portId of view.ports.keys()) {
        setPortHighlight(view, portId, null);
      }
    }
  }

  /** Zoom-scaled target tiers: port anchor → node body → outer padding. */
  private connectionTargetAt(
    world: Point,
    gesture: Extract<Gesture, { kind: "connecting" }>,
  ): { ref: PortRef; check: ConnectionCheck } | null {
    const callbacks = this.callbacks;
    if (!callbacks) return null;
    const compatible = this.compatibleInputPorts(gesture.source);
    const portSnap = CONNECT_PORT_SNAP_PX / this.camera.zoom;
    const bodyPad = CONNECT_BODY_PADDING_PX / this.camera.zoom;

    let best: { ref: PortRef; dist: number } | null = null;
    for (const ref of compatible) {
      const view = this.nodeViews.get(ref.nodeId);
      if (!view) continue;
      const anchor = portAnchorWorld(view, ref.portId);
      if (!anchor) continue;
      const dist = Math.hypot(anchor.x - world.x, anchor.y - world.y);
      if (dist <= portSnap && (!best || dist < best.dist)) {
        best = { ref, dist };
      }
    }
    if (best) {
      return {
        ref: best.ref,
        check: callbacks.checkConnection(gesture.source, best.ref),
      };
    }

    for (const tier of [0, bodyPad]) {
      for (const ref of compatible) {
        const view = this.nodeViews.get(ref.nodeId);
        if (!view) continue;
        const b = {
          x: view.group.x ?? view.node.bounds.x,
          y: view.group.y ?? view.node.bounds.y,
          width: view.node.bounds.width,
          height: view.node.bounds.height,
        };
        if (
          world.x >= b.x - tier &&
          world.x <= b.x + b.width + tier &&
          world.y >= b.y - tier &&
          world.y <= b.y + b.height + tier
        ) {
          return { ref, check: callbacks.checkConnection(gesture.source, ref) };
        }
      }
    }
    return null;
  }

  private updateConnection(gesture: Extract<Gesture, { kind: "connecting" }>) {
    const previous = gesture.target?.ref;
    const target = this.connectionTargetAt(gesture.currentWorld, gesture);
    if (
      previous?.nodeId !== target?.ref.nodeId ||
      previous?.portId !== target?.ref.portId
    ) {
      if (previous) {
        const view = this.nodeViews.get(previous.nodeId);
        if (view) setPortHighlight(view, previous.portId, "compatible");
      }
      if (target) {
        const view = this.nodeViews.get(target.ref.nodeId);
        if (view) {
          setPortHighlight(
            view,
            target.ref.portId,
            target.check === "invalid" ? "rejected" : "candidate",
          );
        }
      }
    }
    gesture.target = target;
    const end = target
      ? (portAnchorWorld(
          this.nodeViews.get(target.ref.nodeId)!,
          target.ref.portId,
        ) ?? gesture.currentWorld)
      : gesture.currentWorld;
    updateEdgeView(
      gesture.preview,
      gesture.preview.edge,
      gesture.sourceWorld,
      end,
      { preview: true },
    );
    this.mirrorGesture(gesture, gesture.currentWorld);
  }

  // --- edges + selection reconciliation ----------------------------------

  private anchorOf(endpoint: { nodeId: NodeId; portId: string }): Point | null {
    const view = this.nodeViews.get(endpoint.nodeId);
    if (!view) return null;
    const anchor = portAnchorWorld(view, endpoint.portId);
    if (anchor) return anchor;
    const { bounds } = view.node;
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }

  private refreshEdgesTouching(nodeIds: Set<NodeId>) {
    for (const record of this.edgeViews.values()) {
      const edge = record.view.edge;
      if (!nodeIds.has(edge.source.nodeId) && !nodeIds.has(edge.target.nodeId))
        continue;
      const from = this.anchorOf(edge.source);
      const to = this.anchorOf(edge.target);
      if (!from || !to) continue;
      updateEdgeView(record.view, edge, from, to, {
        selected: record.signature.includes("sel"),
        highlighted: record.signature.includes("hl"),
      });
      record.from = from;
      record.to = to;
    }
  }

  private reconcileEdges(scene: SceneState, related: Set<EdgeId> | null) {
    const seen = new Set<EdgeId>();
    for (const edge of scene.edges) {
      const from = this.anchorOf(edge.source);
      const to = this.anchorOf(edge.target);
      if (!from || !to) continue;
      seen.add(edge.id);
      const selected = scene.selection.edgeIds.includes(edge.id);
      const highlighted = related?.has(edge.id) ?? false;
      const signature = `${selected ? "sel" : ""}${highlighted ? "hl" : ""}`;
      const record = this.edgeViews.get(edge.id);
      if (!record) {
        const view = createEdgeView(edge, from, to, { selected, highlighted });
        this.edgeLayer.add(view.group);
        this.edgeViews.set(edge.id, { view, from, to, signature });
      } else if (
        record.view.edge !== edge ||
        record.from.x !== from.x ||
        record.from.y !== from.y ||
        record.to.x !== to.x ||
        record.to.y !== to.y ||
        record.signature !== signature
      ) {
        updateEdgeView(record.view, edge, from, to, { selected, highlighted });
        record.from = from;
        record.to = to;
        record.signature = signature;
      }
    }
    for (const [edgeId, record] of this.edgeViews) {
      if (!seen.has(edgeId)) {
        record.view.group.destroy();
        this.edgeViews.delete(edgeId);
      }
    }
  }

  private reconcileSelection(scene: SceneState) {
    const zoom = scene.camera.zoom;
    const parts: string[] = [zoom.toFixed(4)];
    const selected: { node: WorkflowNode; x: number; y: number }[] = [];
    for (const nodeId of scene.selection.nodeIds) {
      const view = this.nodeViews.get(nodeId);
      if (!view) continue;
      const b = view.node.bounds;
      // Follow the live preview position while a drag/resize is in flight.
      const x = view.group.x ?? b.x;
      const y = view.group.y ?? b.y;
      parts.push(`${nodeId}:${x},${y},${b.width},${b.height}`);
      selected.push({ node: view.node, x, y });
    }
    const signature = parts.join("|");
    if (signature === this.selectionSignature) return;
    this.selectionSignature = signature;
    this.selectionLayer.removeAll();
    const strokeWidth = 2 / zoom;
    const handleHit = HANDLE_HIT_PX / zoom;
    const handleVisual = HANDLE_VISUAL_PX / zoom;
    for (const { node, x, y } of selected) {
      this.selectionLayer.add(
        new Rect({
          x: x - 5,
          y: y - 5,
          width: node.bounds.width + 10,
          height: node.bounds.height + 10,
          cornerRadius: 14,
          fill: "#00000000",
          stroke: canvasTheme.selection,
          strokeWidth,
          dashPattern: [6 / zoom, 4 / zoom],
          hittable: false,
        }),
      );
      const corners: { corner: Corner; cx: number; cy: number }[] = [
        { corner: "nw", cx: x, cy: y },
        { corner: "ne", cx: x + node.bounds.width, cy: y },
        { corner: "sw", cx: x, cy: y + node.bounds.height },
        { corner: "se", cx: x + node.bounds.width, cy: y + node.bounds.height },
      ];
      for (const { corner, cx, cy } of corners) {
        this.selectionLayer.add(
          new Rect({
            x: cx - handleHit / 2,
            y: cy - handleHit / 2,
            width: handleHit,
            height: handleHit,
            fill: "#00000000",
            data: { role: "resizeHandle", nodeId: node.id, corner },
          }),
        );
        this.selectionLayer.add(
          new Rect({
            x: cx - handleVisual / 2,
            y: cy - handleVisual / 2,
            width: handleVisual,
            height: handleVisual,
            cornerRadius: 2 / zoom,
            fill: canvasTheme.selection,
            stroke: canvasTheme.background,
            strokeWidth: 1 / zoom,
            hittable: false,
          }),
        );
      }
    }
  }
}

function minimapAccent(node: WorkflowNode): string {
  return canvasTheme.kindAccent[node.kind] ?? canvasTheme.nodeMuted;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
