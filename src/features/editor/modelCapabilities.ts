import type { ModelsView, ProtocolGroups } from "../../api/models";
import {
  findNode,
  type CanvasDocument,
  type GenerationSpec,
  type WorkflowNode,
} from "../../shared/domain";
import { effectiveDefaultId, protocolFeatures } from "../settings/modelStore";

/** The port a mask is fed through, and the only one that carries it as one. */
export const MASK_PORT = "mask";

/**
 * Whether the image model this node will be asked through takes a mask.
 *
 * The model named by the node wins, and the deployment's default answers where
 * the node names none — the same two steps the server takes. A model nobody can
 * find declares no mask, which is the safe reading: an unknown protocol has
 * promised nothing.
 */
export function imageNodeTakesMask(
  node: WorkflowNode,
  view: ModelsView | null,
  protocols: ProtocolGroups | null,
): boolean {
  if (node.kind !== "image") return false;
  const spec = (node.data as { generation?: GenerationSpec }).generation;
  if (spec !== undefined && spec.capability !== "image") return false;
  const named = (spec?.model ?? "").trim();
  const id = named === "" ? effectiveDefaultId(view, "image") : named;
  if (id === null) return false;
  const held = view?.models.find((model) => model.id === id);
  if (held === undefined) return false;
  return protocolFeatures(protocols, held.protocol).mask === true;
}

/**
 * Whether the mask port is shown for this node: the model takes one, or a mask
 * is already wired into it and its picture would otherwise lose the edge.
 *
 * A wire that already exists is grandfathered rather than hidden with its port;
 * new wires are refused by {@link imageNodeTakesMask} alone.
 */
export function canvasImageShowsMask(
  canvas: CanvasDocument,
  nodeId: string,
  view: ModelsView | null,
  protocols: ProtocolGroups | null,
): boolean {
  const node = findNode(canvas, nodeId);
  if (node === undefined) return false;
  if (imageNodeTakesMask(node, view, protocols)) return true;
  return canvas.edges.some(
    (edge) => edge.target.nodeId === nodeId && edge.target.portId === MASK_PORT,
  );
}
