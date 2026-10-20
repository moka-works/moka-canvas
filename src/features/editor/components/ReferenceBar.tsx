import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  findNode,
  type AssetId,
  type CanvasDocument,
  type GenerationSpec,
  type NodeId,
  type PortDefinition,
  type ResourceEntry,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../../shared/domain";
import {
  mediaInfoForNode,
  type MediaCardInfo,
  type MediaState,
} from "../canvas/mediaCards";
import { ASSET_DRAG_MIME } from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";

/**
 * Where an ask takes what it is given from.
 *
 * No longer a choice on the bar: the words and the graph decide it — a prompt
 * that names cards takes those, a list kept by hand takes itself, and the
 * wiring speaks where there is neither — and the bar only shows what the
 * decision means for what will be sent.
 */

/** One edge arriving at this node, which is one thing it is being given. */
interface Arrival {
  edge: WorkflowEdge;
  source: WorkflowNode;
  /** What this node calls the input the edge lands on. */
  port: string;
  /** What the source calls the output the edge leaves by. */
  sourcePort: string;
  media: MediaCardInfo | null;
  /** The other inputs of this node the arrival could be moved to. */
  moves: PortDefinition[];
}

/**
 * The inputs of `node` that hold one thing and could take what `source` gives:
 * the mask of a picture being painted over, the frames a shot is built between.
 */
function movesFor(node: WorkflowNode, source: WorkflowNode): PortDefinition[] {
  const gives = source.ports
    .filter((port) => port.direction === "output")
    .flatMap((port) => port.dataTypes);
  return node.ports.filter(
    (port) =>
      port.direction === "input" &&
      port.cardinality === "one" &&
      port.dataTypes.some((type) => gives.includes(type)),
  );
}

/**
 * What is arriving at `node`, in the order the document holds the edges in.
 *
 * That order is the one the resolver reads them in, so the bar lists what will
 * be sent in the order it will be sent rather than in one of its own.
 */
function arrivalsAt(
  canvas: CanvasDocument,
  node: WorkflowNode,
  resources: ReadonlyMap<AssetId, ResourceEntry>,
  issues: ReadonlyMap<AssetId, MediaState>,
): Arrival[] {
  const found: Arrival[] = [];
  for (const edge of canvas.edges) {
    if (edge.target.nodeId !== node.id) continue;
    const source = findNode(canvas, edge.source.nodeId);
    if (!source) continue;
    found.push({
      edge,
      source,
      port:
        node.ports.find((port) => port.id === edge.target.portId)?.label ??
        edge.target.portId,
      sourcePort:
        source.ports.find((port) => port.id === edge.source.portId)?.label ??
        edge.source.portId,
      media: mediaInfoForNode(source, resources, issues, edge.source.portId),
      moves: movesFor(node, source).filter(
        (port) => port.id !== edge.target.portId,
      ),
    });
  }
  return found;
}

/** A list with one entry taken from where it was and put where it is going. */
function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [taken] = next.splice(from, 1);
  if (taken === undefined) return next;
  next.splice(to, 0, taken);
  return next;
}

export interface ReferenceBarProps {
  canvas: CanvasDocument;
  issues: ReadonlyMap<AssetId, MediaState>;
  node: WorkflowNode;
  resources: ReadonlyMap<AssetId, ResourceEntry>;
  spec: GenerationSpec;
  /** Takes a wired-in arrival out, which is one edge and one step of history. */
  onCut: (edge: WorkflowEdge) => void;
  /** Brings a node into view on the canvas. */
  onFind: (nodeId: NodeId) => void;
  /** Moves an arrival to another of this node's inputs. */
  onMove: (edge: WorkflowEdge, portId: string) => void;
  /**
   * Writes the list pointed at by hand, whole.
   *
   * Whole because the order is the priority, and a reorder is one thing a reader
   * will want to undo in one step rather than one per chip that moved.
   */
  onPoint: (nodeIds: NodeId[]) => void;
  /** Takes an asset dropped here from the resource panel. */
  onTakeAsset: (assetId: AssetId) => void;
  /** Takes files dropped here from this machine, filed then listed. */
  onTakeFiles: (files: File[]) => void;
}

/**
 * What this node is being given, above the words it is being asked in.
 *
 * The list is read off the graph rather than kept beside it: an edge is the
 * only thing that says one node feeds another, and a second copy of that would
 * be free to disagree with the first.
 */
export function ReferenceBar({
  canvas,
  issues,
  node,
  resources,
  spec,
  onCut,
  onFind,
  onMove,
  onPoint,
  onTakeAsset,
  onTakeFiles,
}: ReferenceBarProps) {
  const { t } = useTranslation();
  const [dragged, setDragged] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);

  const arrivals = arrivalsAt(canvas, node, resources, issues);
  const pointed = spec.referenceNodeIds;

  // Where the prompt's own pointing decides, a dropped asset would be wired in
  // to no effect: the ask reads the tokens and nothing else. Better to say so
  // by not being a place anything can be left.
  const takes = spec.inputMode !== "mentions";

  return (
    <div
      aria-label={t("editor:referenceBar.aria")}
      className={hovered ? "reference-bar is-dropping" : "reference-bar"}
      data-testid="reference-bar"
      onDragLeave={() => setHovered(false)}
      onDragOver={(event) => {
        if (!takes) return;
        const kinds = event.dataTransfer.types;
        if (!kinds.includes(ASSET_DRAG_MIME) && !kinds.includes("Files")) {
          return;
        }
        event.preventDefault();
        setHovered(true);
      }}
      onDrop={(event) => {
        setHovered(false);
        if (!takes) return;
        // Consumed here: the canvas under the panel would otherwise take the
        // same drop and make a node of it a second time.
        const files = [...(event.dataTransfer.files ?? [])];
        if (files.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          onTakeFiles(files);
          return;
        }
        const assetId = event.dataTransfer.getData(ASSET_DRAG_MIME);
        if (!assetId) return;
        event.preventDefault();
        event.stopPropagation();
        onTakeAsset(assetId as AssetId);
      }}
      role="group"
    >
      {spec.inputMode === "upstream" &&
        (arrivals.length === 0 ? (
          <p className="reference-empty">
            {t("editor:referenceBar.nothingWired")}
          </p>
        ) : (
          <ul
            aria-label={t("editor:referenceBar.wiredIn")}
            className="reference-chips"
          >
            {arrivals.map((arrival) => (
              <li className="reference-chip" key={arrival.edge.id}>
                {arrival.media?.url && (
                  <img
                    alt=""
                    className="reference-thumb"
                    src={arrival.media.url}
                  />
                )}
                <span className="reference-name">{arrival.source.title}</span>
                <span
                  className="reference-port"
                  data-source-port={arrival.edge.source.portId}
                >
                  {arrival.source.kind === "director"
                    ? arrival.sourcePort
                    : arrival.port}
                </span>
                {arrival.moves.map((port) => (
                  <button
                    aria-label={t("editor:referenceBar.useAs", {
                      name: arrival.source.title,
                      port: port.label.toLowerCase(),
                    })}
                    className="reference-action"
                    key={port.id}
                    onClick={() => onMove(arrival.edge, port.id)}
                    type="button"
                  >
                    {port.label}
                  </button>
                ))}
                <button
                  aria-label={t("editor:referenceBar.findOnCanvas", {
                    name: arrival.source.title,
                  })}
                  className="reference-action"
                  onClick={() => onFind(arrival.source.id)}
                  type="button"
                >
                  {t("editor:action.find")}
                </button>
                <button
                  aria-label={t("editor:referenceBar.disconnectFrom", {
                    name: arrival.source.title,
                    node: node.title,
                  })}
                  className="reference-action"
                  onClick={() => onCut(arrival.edge)}
                  type="button"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ))}

      {spec.inputMode === "manual" &&
        (pointed.length === 0 ? (
          <p className="reference-empty">
            {t("editor:referenceBar.nothingListed")}
            {arrivals.length > 0 ? (
              <button
                className="reference-action"
                onClick={() =>
                  onPoint(
                    arrivals
                      .map((arrival) => arrival.source.id)
                      .filter((id, at, all) => all.indexOf(id) === at),
                  )
                }
                type="button"
              >
                {t("editor:action.listWiredIn")}
              </button>
            ) : (
              t("editor:referenceBar.connectOrWrite")
            )}
          </p>
        ) : (
          <ul
            aria-label={t("editor:referenceBar.pointedByHand")}
            className="reference-chips"
          >
            {pointed.map((nodeId, at) => {
              const named = findNode(canvas, nodeId);
              const media = named
                ? mediaInfoForNode(named, resources, issues)
                : null;
              const name = named?.title ?? t("editor:referenceBar.nodeGone");
              return (
                <li
                  className={
                    named ? "reference-chip" : "reference-chip is-gone"
                  }
                  draggable={Boolean(named)}
                  key={nodeId}
                  onDragEnd={() => setDragged(null)}
                  onDragOver={(event) => {
                    if (dragged === null) return;
                    event.preventDefault();
                  }}
                  onDragStart={() => setDragged(at)}
                  onDrop={(event) => {
                    // A chip landing on a chip is a reorder, not an asset
                    // arriving from the resource panel.
                    event.stopPropagation();
                    if (dragged === null) return;
                    event.preventDefault();
                    setDragged(null);
                    onPoint(moved(pointed, dragged, at));
                  }}
                >
                  {media?.url && (
                    <img alt="" className="reference-thumb" src={media.url} />
                  )}
                  <span
                    className="reference-name"
                    title={t("editor:referenceBar.dragToReorder")}
                  >
                    {name}
                  </span>
                  {named && (
                    <button
                      aria-label={t("editor:referenceBar.findOnCanvas", {
                        name: named.title,
                      })}
                      className="reference-action"
                      onClick={() => onFind(named.id)}
                      type="button"
                    >
                      {t("editor:action.find")}
                    </button>
                  )}
                  <button
                    aria-label={t("editor:referenceBar.takeOutOfList", {
                      name,
                    })}
                    className="reference-action"
                    onClick={() =>
                      onPoint(
                        pointed.filter((_, elsewhere) => elsewhere !== at),
                      )
                    }
                    type="button"
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        ))}

      {spec.inputMode === "mentions" && (
        <p className="reference-empty">
          {t("editor:referenceBar.mentionOrder")}
        </p>
      )}

      {takes && (
        <button
          className="reference-add"
          onClick={() =>
            useEditorStore
              .getState()
              .openAssetPicker({ mode: "reference", nodeId: node.id })
          }
          type="button"
        >
          {t("editor:referenceBar.fromAssets")}
        </button>
      )}
    </div>
  );
}
