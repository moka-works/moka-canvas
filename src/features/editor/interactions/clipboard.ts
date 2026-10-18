import {
  FRAGMENT_SCHEMA_VERSION,
  MAX_TEXT_CONTENT_LENGTH,
  MOKA_FRAGMENT_MIME,
  findResource,
  mentionSpans,
  newId,
  type AssetId,
  type CanvasDocument,
  type GenerationSpec,
  type MokaFile,
  type NodeId,
  type Point,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { mentionToken } from "../canvas/mentions";

/**
 * In-app fragment clipboard. Copy/paste between canvases and across project
 * reloads works without system clipboard permission; the system clipboard is
 * written best-effort for cross-app summaries and read as a fallback.
 */
export interface CanvasFragment {
  version: number;
  /** Fragment origin: minimum node bounds corner at copy time. */
  origin: Point;
  nodes: WorkflowNode[];
  /** Only edges whose both endpoints are inside `nodes`. */
  edges: WorkflowEdge[];
  assetIds: AssetId[];
}

let memory: CanvasFragment | null = null;

export function buildFragment(
  canvas: CanvasDocument,
  nodeIds: NodeId[],
): CanvasFragment | null {
  const included = new Set(nodeIds);
  const nodes = canvas.nodes.filter((node) => included.has(node.id));
  if (nodes.length === 0) return null;
  const edges = canvas.edges.filter(
    (edge) =>
      included.has(edge.source.nodeId) && included.has(edge.target.nodeId),
  );
  const origin = {
    x: Math.min(...nodes.map((node) => node.bounds.x)),
    y: Math.min(...nodes.map((node) => node.bounds.y)),
  };
  const assetIds = new Set<AssetId>();
  for (const node of nodes) {
    const data = node.data as { assetId?: string; posterAssetId?: string };
    if (data.assetId) assetIds.add(data.assetId);
    if (data.posterAssetId) assetIds.add(data.posterAssetId);
  }
  return {
    version: FRAGMENT_SCHEMA_VERSION,
    origin,
    nodes,
    edges,
    assetIds: [...assetIds],
  };
}

export function readMemoryFragment(): CanvasFragment | null {
  return memory;
}

export function parseFragment(raw: string): CanvasFragment | null {
  try {
    const parsed = JSON.parse(raw) as CanvasFragment;
    if (
      parsed?.version !== FRAGMENT_SCHEMA_VERSION ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.edges) ||
      typeof parsed.origin?.x !== "number" ||
      typeof parsed.origin?.y !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Writes the fragment to the in-app clipboard plus best-effort system copy. */
export async function writeFragment(fragment: CanvasFragment): Promise<void> {
  memory = fragment;
  const payload = JSON.stringify(fragment);
  const summary =
    fragment.nodes.length === 1
      ? i18n.t("editor:stores.clipboardNodeSummary", {
          name: fragment.nodes[0].title,
        })
      : i18n.t("editor:stores.clipboardFragmentSummary", {
          count: fragment.nodes.length,
        });
  try {
    await navigator.clipboard.writeText(`${summary}\n${payload}`);
  } catch {
    // System clipboard unavailable (permissions); the in-app clipboard stands.
  }
}

export interface SystemPaste {
  kind: "fragment" | "text" | "image";
  fragment?: CanvasFragment;
  text?: string;
  image?: Blob;
}

/**
 * Reads the system clipboard, preferring our fragment MIME embedded in the
 * text fallback. HTML is never parsed or executed.
 */
export async function readSystemClipboard(): Promise<SystemPaste | null> {
  try {
    if (navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes("image/png")) {
          const blob = await item.getType("image/png");
          return { kind: "image", image: blob };
        }
        if (item.types.includes("image/jpeg")) {
          const blob = await item.getType("image/jpeg");
          return { kind: "image", image: blob };
        }
      }
      for (const item of items) {
        if (item.types.includes("text/plain")) {
          const text = await (await item.getType("text/plain")).text();
          const embedded = parseFragment(text.slice(text.indexOf("{")));
          if (embedded) return { kind: "fragment", fragment: embedded };
          if (text.trim()) {
            return {
              kind: "text",
              text: text.slice(0, MAX_TEXT_CONTENT_LENGTH),
            };
          }
        }
      }
      return null;
    }
  } catch {
    // Fall through to readText.
  }
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return null;
    const embedded = parseFragment(text.slice(text.indexOf("{")));
    if (embedded) return { kind: "fragment", fragment: embedded };
    return { kind: "text", text: text.slice(0, MAX_TEXT_CONTENT_LENGTH) };
  } catch {
    return null;
  }
}

export interface FragmentInstantiation {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  missingAssets: number;
}

/**
 * The ask a copy carries, pointed at the copies beside it.
 *
 * Only what the fragment carried is moved: a mention of a node left behind
 * still names the node left behind, which is what whoever copied it meant, and
 * the panel says so when that node is not where it can be reached.
 *
 * The mentions are rewritten back through the prompt so the offsets ahead of
 * each one are still the ones the scan reported.
 */
function carriedSpec(
  spec: GenerationSpec,
  idMap: ReadonlyMap<NodeId, NodeId>,
): GenerationSpec {
  let prompt = spec.prompt;
  for (const span of [...mentionSpans(prompt)].reverse()) {
    const carried = idMap.get(span.nodeId);
    if (!carried) continue;
    prompt =
      prompt.slice(0, span.start) +
      mentionToken(carried) +
      prompt.slice(span.end);
  }
  return {
    ...spec,
    prompt,
    referenceNodeIds: spec.referenceNodeIds.map(
      (nodeId) => idMap.get(nodeId) ?? nodeId,
    ),
  };
}

/**
 * Clones fragment nodes/edges with fresh IDs at the target anchor, keeping
 * asset references that exist in the target project's registry and stripping
 * (counting) the rest.
 */
export function instantiateFragment(
  fragment: CanvasFragment,
  moka: MokaFile,
  anchor: Point,
): FragmentInstantiation {
  const idMap = new Map<NodeId, NodeId>();
  for (const node of fragment.nodes) idMap.set(node.id, newId());
  const dx = anchor.x - fragment.origin.x;
  const dy = anchor.y - fragment.origin.y;

  let missingAssets = 0;
  const nodes = fragment.nodes.map((node) => {
    const data = { ...(node.data as Record<string, unknown>) };
    for (const key of ["assetId", "posterAssetId"] as const) {
      const assetId = data[key] as string | undefined;
      if (assetId && !findResource(moka, assetId)) {
        delete data[key];
        missingAssets += 1;
      }
    }
    const spec = data.generation as GenerationSpec | undefined;
    if (spec) data.generation = carriedSpec(spec, idMap);
    if (node.kind === "extension" && data.extension) {
      // Bindings are model ids on this machine and travel with the copy; what
      // the copied node produced did not. A pasted node starts empty so its
      // panel cannot point at files in the project it was copied out of.
      const extension = { ...(data.extension as Record<string, unknown>) };
      delete extension.outputs;
      delete extension.runId;
      delete extension.outputsUpdatedAt;
      data.extension = extension;
      data.resultSlots = [];
      data.resultNodeIds = [];
    }
    return {
      ...node,
      id: idMap.get(node.id)!,
      bounds: { ...node.bounds, x: node.bounds.x + dx, y: node.bounds.y + dy },
      data: data as WorkflowNode["data"],
    };
  });
  const edges = fragment.edges
    .filter(
      (edge) => idMap.has(edge.source.nodeId) && idMap.has(edge.target.nodeId),
    )
    .map((edge) => ({
      ...edge,
      id: newId(),
      source: {
        nodeId: idMap.get(edge.source.nodeId)!,
        portId: edge.source.portId,
      },
      target: {
        nodeId: idMap.get(edge.target.nodeId)!,
        portId: edge.target.portId,
      },
    }));
  return { nodes, edges, missingAssets };
}

export { MOKA_FRAGMENT_MIME };
