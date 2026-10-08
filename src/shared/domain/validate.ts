import {
  ASSET_ORIGINS,
  COORDINATE_LIMIT,
  GENERATION_PARAM_KEYS,
  MAX_ACTS_PER_CHAPTER,
  MAX_ASSET_KEYWORD_LENGTH,
  MAX_ASSET_NOTE_LENGTH,
  MAX_ASSET_TAG_LENGTH,
  MAX_ASSET_TAGS,
  MAX_ASSISTANT_MESSAGES_PER_SESSION,
  MAX_ASSISTANT_SESSIONS_PER_CANVAS,
  MAX_CHAPTERS_PER_STORY,
  MAX_EDGES_PER_CANVAS,
  MAX_ELEMENTS_PER_STORY,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME_LENGTH,
  MAX_FOLDERS_PER_PROJECT,
  MAX_KEYFRAMES_PER_ACT,
  MAX_KEYFRAME_MS,
  MAX_NODES_PER_CANVAS,
  MAX_PROMPT_LENGTH,
  MAX_RESULT_SLOTS,
  MAX_STORIES_PER_PROJECT,
  MAX_TAKES_PER_SLOT,
  MAX_TOTAL_DURATION_MS,
  MIN_KEYFRAME_MS,
  MIN_TOTAL_DURATION_MS,
  PROJECT_ASSET_CATEGORIES,
  REFERENCE_IMAGES_MAX,
  STORY_NAME_MAX,
  STORY_SCHEMA_VERSION,
} from "./constants";
import { capabilityServes } from "./factories";
import { STORY_ASPECTS } from "./types";
import type {
  AssetHolder,
  AssetId,
  CanvasDocument,
  DataType,
  EdgeEndpoint,
  GenerationSpec,
  MokaFile,
  NodeId,
  PortDefinition,
  ProjectRelativePath,
  Rect,
  ResourceEntry,
  ResultSlot,
  StoryDocument,
  StorySlot,
  StorySlotTarget,
  StoryTake,
  TimelineDocument,
  ValidationIssue,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
import { folderDepth, foldersOf } from "./folders";
import { currentTake } from "./story";
import { validateTimeline } from "./timeline";
import { i18n } from "../i18n";

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateBounds(bounds: Rect): boolean {
  return (
    isFiniteNumber(bounds.x) &&
    isFiniteNumber(bounds.y) &&
    isFiniteNumber(bounds.width) &&
    isFiniteNumber(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    Math.abs(bounds.x) <= COORDINATE_LIMIT &&
    Math.abs(bounds.y) <= COORDINATE_LIMIT &&
    bounds.width <= COORDINATE_LIMIT * 2 &&
    bounds.height <= COORDINATE_LIMIT * 2
  );
}

export function validateResourcePath(path: ProjectRelativePath): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("\\") || path.includes("	")) return false;
  if (path.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

export function portTypesIntersect(
  a: DataType[],
  b: DataType[],
): DataType | undefined {
  return a.find((t) => b.includes(t));
}

export function findNode(
  canvas: CanvasDocument,
  nodeId: NodeId,
): WorkflowNode | undefined {
  return canvas.nodes.find((n) => n.id === nodeId);
}

export function findPort(
  node: WorkflowNode,
  portId: string,
): PortDefinition | undefined {
  return node.ports.find((p) => p.id === portId);
}

export function wouldCreateCycle(
  edges: WorkflowEdge[],
  candidate: { source: EdgeEndpoint; target: EdgeEndpoint },
): boolean {
  const adjacency = new Map<NodeId, NodeId[]>();
  const addEdge = (from: NodeId, to: NodeId) => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const edge of edges) addEdge(edge.source.nodeId, edge.target.nodeId);
  addEdge(candidate.source.nodeId, candidate.target.nodeId);

  const stack: NodeId[] = [candidate.target.nodeId];
  const visited = new Set<NodeId>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === candidate.source.nodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

export type EdgeCandidateResult =
  { ok: true } | { ok: false; code: string; message: string };

export function validateEdgeCandidate(
  canvas: CanvasDocument,
  source: EdgeEndpoint,
  target: EdgeEndpoint,
): EdgeCandidateResult {
  const sourceNode = findNode(canvas, source.nodeId);
  if (!sourceNode)
    return {
      ok: false,
      code: "NODE_NOT_FOUND",
      message: i18n.t("errors:validate.sourceNodeMissing"),
    };
  const targetNode = findNode(canvas, target.nodeId);
  if (!targetNode)
    return {
      ok: false,
      code: "NODE_NOT_FOUND",
      message: i18n.t("errors:validate.targetNodeMissing"),
    };

  const sourcePort = findPort(sourceNode, source.portId);
  if (!sourcePort)
    return {
      ok: false,
      code: "PORT_NOT_FOUND",
      message: i18n.t("errors:validate.sourcePortMissing"),
    };
  const targetPort = findPort(targetNode, target.portId);
  if (!targetPort)
    return {
      ok: false,
      code: "PORT_NOT_FOUND",
      message: i18n.t("errors:validate.targetPortMissing"),
    };

  if (sourcePort.direction !== "output" || targetPort.direction !== "input") {
    return {
      ok: false,
      code: "PORT_TYPE_MISMATCH",
      message: i18n.t("errors:validate.edgesOutputToInput"),
    };
  }

  if (source.nodeId === target.nodeId) {
    return {
      ok: false,
      code: "SELF_LOOP",
      message: i18n.t("errors:validate.selfLoop"),
    };
  }

  if (!portTypesIntersect(sourcePort.dataTypes, targetPort.dataTypes)) {
    return {
      ok: false,
      code: "PORT_TYPE_MISMATCH",
      message: i18n.t("errors:validate.portTypesIncompatible", {
        source: sourcePort.dataTypes.join("/"),
        target: targetPort.dataTypes.join("/"),
      }),
    };
  }

  if (targetPort.cardinality === "one") {
    const incoming = canvas.edges.filter(
      (e) =>
        e.target.nodeId === target.nodeId && e.target.portId === target.portId,
    );
    if (incoming.length > 0) {
      return {
        ok: false,
        code: "CARDINALITY_VIOLATION",
        message: i18n.t("errors:validate.cardinalityViolation"),
      };
    }
  }

  if (
    canvas.edges.some(
      (e) =>
        e.source.nodeId === source.nodeId &&
        e.source.portId === source.portId &&
        e.target.nodeId === target.nodeId &&
        e.target.portId === target.portId,
    )
  ) {
    return {
      ok: false,
      code: "CONFLICT",
      message: i18n.t("errors:validate.connectionExists"),
    };
  }

  if (wouldCreateCycle(canvas.edges, { source, target })) {
    return {
      ok: false,
      code: "GRAPH_CYCLE",
      message: i18n.t("errors:validate.wouldCreateCycle"),
    };
  }

  return { ok: true };
}

export function topologicalOrder(canvas: CanvasDocument): WorkflowNode[] {
  const indegree = new Map<NodeId, number>();
  const outgoing = new Map<NodeId, NodeId[]>();
  for (const node of canvas.nodes) indegree.set(node.id, 0);
  for (const edge of canvas.edges) {
    if (!indegree.has(edge.source.nodeId) || !indegree.has(edge.target.nodeId))
      continue;
    indegree.set(
      edge.target.nodeId,
      (indegree.get(edge.target.nodeId) ?? 0) + 1,
    );
    const list = outgoing.get(edge.source.nodeId);
    if (list) list.push(edge.target.nodeId);
    else outgoing.set(edge.source.nodeId, [edge.target.nodeId]);
  }

  const byRank = (a: WorkflowNode, b: WorkflowNode) =>
    a.zIndex - b.zIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const nodeById = new Map(canvas.nodes.map((n) => [n.id, n]));
  let frontier = canvas.nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .sort(byRank);
  const ordered: WorkflowNode[] = [];
  while (frontier.length > 0) {
    const nextFrontier: WorkflowNode[] = [];
    for (const node of frontier) {
      ordered.push(node);
      for (const targetId of outgoing.get(node.id) ?? []) {
        const remaining = (indegree.get(targetId) ?? 0) - 1;
        indegree.set(targetId, remaining);
        if (remaining === 0) nextFrontier.push(nodeById.get(targetId)!);
      }
    }
    frontier = nextFrontier.sort(byRank);
  }
  return ordered;
}

/**
 * The files one card points at.
 *
 * All of them, not only the one it shows: a card asked several times over
 * keeps its first answer and holds the rest in slots beside it, and a video
 * keeps the still that stands for it.
 */
export function nodeAssetIds(node: WorkflowNode): AssetId[] {
  // Read as a record rather than as one arm of the union: which of these a
  // card carries depends on its kind, and a group carries none of them. Asking
  // each in turn is the same question asked of every kind at once, and cannot
  // go out of step with a kind that gains a way of holding a file.
  const data = node.data as {
    assetId?: AssetId;
    posterAssetId?: AssetId;
    resultSlots?: { assetId?: AssetId }[];
  };
  const ids: AssetId[] = [];
  if (data.assetId) ids.push(data.assetId);
  if (data.posterAssetId) ids.push(data.posterAssetId);
  for (const slot of data.resultSlots ?? []) {
    if (slot.assetId) ids.push(slot.assetId);
  }
  return ids;
}

/**
 * The files one cut is made of.
 *
 * Every clip that reads a file, once each and in the order the clips are laid
 * down; a clip written on the timeline rather than taken from the shelf (a
 * text clip) reads none, so a cut made of words alone holds nothing.
 */
export function timelineAssetIds(timeline: TimelineDocument): AssetId[] {
  const seen = new Set<AssetId>();
  for (const clip of timeline.clips) {
    if (clip.assetId) seen.add(clip.assetId);
  }
  return [...seen];
}

/**
 * What points at each asset, as a list of the cards and clips that do.
 *
 * Both halves of a document hold assets — a canvas node shows one, a timeline
 * clip reads one — so the two are collected together: whether an asset is
 * still in use is a question about the project, not about one board.
 */
export function collectAssetReferences(moka: MokaFile): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const add = (assetId: string | undefined, holderId: string) => {
    if (!assetId) return;
    const list = refs.get(assetId);
    if (list) list.push(holderId);
    else refs.set(assetId, [holderId]);
  };
  /** Every file a take is made of is in use, not only the one it opens on. */
  const files = (take: StoryTake, holderId: string) => {
    for (const assetId of take.assetIds) add(assetId, holderId);
  };
  for (const canvas of moka.canvas) {
    for (const node of canvas.nodes) {
      for (const assetId of nodeAssetIds(node)) add(assetId, node.id);
    }
  }
  for (const timeline of moka.timelines ?? []) {
    for (const clip of timeline.clips) add(clip.assetId, clip.id);
  }
  // A story's pictures are its own: the frames drawn for a shot, the clip
  // made of an act, and the manuscript a premise was lifted from are all in
  // use, however little of a canvas or a timeline they appear on. A voice's
  // reference recording is a use the same way — the file is kept alive by the
  // card naming it.
  for (const story of moka.stories ?? []) {
    add(story.brief.sourceAssetId, story.id);
    add(story.narrator?.referenceAssetId, story.id);
    for (const element of story.elements) {
      add(element.voice?.referenceAssetId, element.id);
      for (const take of element.main.takes) files(take, element.id);
      for (const take of element.turnaround?.takes ?? [])
        files(take, element.id);
    }
    for (const chapter of story.chapters) {
      for (const act of chapter.acts) {
        // A clip filmed in pieces keeps every piece in use, not only the one
        // it opens on: the shelf must not offer to collect the rest.
        for (const take of act.video.takes) files(take, act.id);
        for (const take of act.voice?.takes ?? []) files(take, act.id);
        for (const take of act.music?.takes ?? []) files(take, act.id);
        for (const keyframe of act.keyframes) {
          for (const take of keyframe.art.takes) files(take, keyframe.id);
          for (const take of keyframe.video.takes) files(take, keyframe.id);
        }
      }
    }
  }
  return refs;
}

/** Every slot a story holds, with the target that names it. */
function storySlots(
  story: StoryDocument,
): { target: StorySlotTarget; slot: StorySlot }[] {
  const places: { target: StorySlotTarget; slot: StorySlot }[] = [];
  for (const element of story.elements) {
    places.push({
      target: { kind: "element", elementId: element.id, view: "main" },
      slot: element.main,
    });
    if (element.turnaround) {
      places.push({
        target: { kind: "element", elementId: element.id, view: "turnaround" },
        slot: element.turnaround,
      });
    }
  }
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      places.push({
        target: { kind: "actVideo", chapterId: chapter.id, actId: act.id },
        slot: act.video,
      });
      if (act.voice) {
        places.push({
          target: { kind: "actVoice", chapterId: chapter.id, actId: act.id },
          slot: act.voice,
        });
      }
      if (act.music) {
        places.push({
          target: { kind: "actMusic", chapterId: chapter.id, actId: act.id },
          slot: act.music,
        });
      }
      for (const keyframe of act.keyframes) {
        places.push({
          target: {
            kind: "keyframe",
            chapterId: chapter.id,
            actId: act.id,
            keyframeId: keyframe.id,
          },
          slot: keyframe.art,
        });
        places.push({
          target: {
            kind: "keyframeVideo",
            chapterId: chapter.id,
            actId: act.id,
            keyframeId: keyframe.id,
          },
          slot: keyframe.video,
        });
        for (const take of keyframe.voices ?? []) {
          places.push({
            target: {
              kind: "lineVoice",
              chapterId: chapter.id,
              actId: act.id,
              keyframeId: keyframe.id,
              lineId: take.lineId,
            },
            slot: take.slot,
          });
        }
      }
    }
  }
  return places;
}

/**
 * Everything pointing at one file, told apart by kind.
 *
 * The same pointing-at that `collectAssetReferences` gathers, kept as whole
 * holders rather than ids, because what a delete does with each is different:
 * a card, a place's old drawing, and a voice's reference recording are taken
 * out of what holds them, and the rest are named. A place is one answer per
 * place and not per take — dropping a file from a slot lets every take holding
 * it go at once — and the place that is using the file is told from the ones
 * that are not, since only the latter may be emptied.
 */
export function assetHolders(moka: MokaFile, assetId: AssetId): AssetHolder[] {
  const holders: AssetHolder[] = [];
  for (const canvas of moka.canvas) {
    for (const node of canvas.nodes) {
      if (nodeAssetIds(node).includes(assetId)) {
        holders.push({ kind: "node", canvasId: canvas.id, nodeId: node.id });
      }
    }
  }
  for (const timeline of moka.timelines ?? []) {
    for (const clip of timeline.clips) {
      if (clip.assetId === assetId) {
        holders.push({
          kind: "clip",
          timelineId: timeline.id,
          timelineName: timeline.name,
          clipId: clip.id,
          clipLabel: clip.label,
        });
      }
    }
  }
  for (const story of moka.stories ?? []) {
    const where = { storyId: story.id, storyName: story.name };
    if (story.brief.sourceAssetId === assetId) {
      holders.push({ ...where, kind: "storyFile", what: "manuscript" });
    }
    if (story.narrator?.referenceAssetId === assetId) {
      holders.push({ ...where, kind: "voiceReference" });
    }
    for (const element of story.elements) {
      if (element.voice?.referenceAssetId === assetId) {
        holders.push({
          ...where,
          kind: "voiceReference",
          elementId: element.id,
        });
      }
    }
    for (const place of storySlots(story)) {
      const held = place.slot.takes.some((take) =>
        take.assetIds.includes(assetId),
      );
      if (!held) continue;
      const inUse = currentTake(place.slot)?.assetIds.includes(assetId);
      holders.push({
        ...where,
        kind: inUse === true ? "drawingInUse" : "drawing",
        target: place.target,
      });
    }
  }
  return holders;
}

export function allResources(moka: MokaFile): ResourceEntry[] {
  return PROJECT_ASSET_CATEGORIES.flatMap(
    (category) => moka.resources[category] ?? [],
  );
}

/**
 * The assets nothing on any canvas points at.
 *
 * A package asked to carry only what is placed leaves these behind, so the
 * question has to be able to say how many and how much room they take before
 * it is answered rather than after.
 */
export function unreferencedAssets(moka: MokaFile): ResourceEntry[] {
  const placed = collectAssetReferences(moka);
  return allResources(moka).filter((entry) => !placed.has(entry.id));
}

export function findResource(
  moka: MokaFile,
  assetId: string,
): ResourceEntry | undefined {
  return allResources(moka).find((r) => r.id === assetId);
}

/** The opening of a mention, and the whole of the token it starts. */
const MENTION_PREFIX = "@[node:";

export interface MentionSpan {
  start: number;
  end: number;
  nodeId: string;
}

/**
 * Every `@[node:<id>]` mention in a prompt, in the order they appear, with the
 * span the whole token occupies so a caller can replace exactly that much and
 * leave the prose around it alone.
 *
 * A token with no closing bracket ends the scan: what follows is prose that
 * happens to contain the opening, not a reference. A token naming nothing
 * (`@[node:]`) is still a token, and what to make of it is the caller's
 * business.
 */
export function mentionSpans(prompt: string): MentionSpan[] {
  const found: MentionSpan[] = [];
  let cursor = 0;
  for (;;) {
    const start = prompt.indexOf(MENTION_PREFIX, cursor);
    if (start < 0) break;
    const body = start + MENTION_PREFIX.length;
    const close = prompt.indexOf("]", body);
    if (close < 0) break;
    found.push({ start, end: close + 1, nodeId: prompt.slice(body, close) });
    cursor = close + 1;
  }
  return found;
}

export function mentionNodeIds(prompt: string): string[] {
  return mentionSpans(prompt)
    .map((span) => span.nodeId)
    .filter((nodeId) => nodeId !== "");
}

/**
 * True when `model` is shaped like a model configuration identifier: one
 * piece, no whitespace, and no legacy "channelId::modelId" separator — the
 * halves of an old reference name nothing now, so a document carrying one is
 * from before model configurations replaced channels.
 */
export function modelIdentifierShaped(model: string): boolean {
  return model !== "" && !model.includes("::") && !/\s/.test(model);
}

function generationIssues(
  canvas: CanvasDocument,
  node: WorkflowNode,
  nodeIds: Set<NodeId>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (code: string, message: string) => {
    issues.push({ code, message, canvasId: canvas.id, nodeId: node.id });
  };

  const data = node.data as {
    generation?: GenerationSpec;
    resultSlots?: ResultSlot[];
  };
  if ((data.resultSlots?.length ?? 0) > MAX_RESULT_SLOTS) {
    at(
      "RESULT_SLOT_LIMIT",
      i18n.t("errors:validate.resultSlotLimit", {
        title: node.title,
        count: MAX_RESULT_SLOTS,
      }),
    );
  }

  const spec = data.generation;
  if (!spec) return issues;

  if (!capabilityServes(spec.capability, node.kind)) {
    at(
      "GENERATION_CAPABILITY_MISMATCH",
      i18n.t("errors:validate.capabilityMismatch", {
        capability: spec.capability,
        kind: node.kind,
      }),
    );
  }
  if (spec.model !== "" && !modelIdentifierShaped(spec.model)) {
    at(
      "GENERATION_MODEL_MISSING",
      i18n.t("errors:validate.modelNotIdentifier", { model: spec.model }),
    );
  }
  if (spec.prompt.length > MAX_PROMPT_LENGTH) {
    at(
      "VALIDATION_FAILED",
      i18n.t("errors:validate.promptTooLong", { count: MAX_PROMPT_LENGTH }),
    );
  }

  const hasPromptEdge = canvas.edges.some(
    (edge) => edge.target.nodeId === node.id && edge.target.portId === "prompt",
  );
  if (
    spec.prompt.trim() === "" &&
    !hasPromptEdge &&
    spec.referenceNodeIds.length === 0
  ) {
    at(
      "GENERATION_PROMPT_EMPTY",
      i18n.t("errors:validate.promptEmpty", { title: node.title }),
    );
  }

  for (const id of mentionNodeIds(spec.prompt)) {
    if (id === node.id) {
      at(
        "MENTION_SELF_REFERENCE",
        i18n.t("errors:validate.mentionSelfReference"),
      );
    } else if (!nodeIds.has(id)) {
      at(
        "MENTION_NODE_NOT_FOUND",
        i18n.t("errors:validate.mentionNodeNotFound", { id }),
      );
    }
  }

  const allowed = GENERATION_PARAM_KEYS[spec.capability];
  if (allowed) {
    for (const key of Object.keys(spec.params)) {
      if (!allowed.includes(key)) {
        at(
          "VALIDATION_FAILED",
          i18n.t("errors:validate.unknownParameter", {
            key,
            capability: spec.capability,
          }),
        );
      }
    }
  }

  return issues;
}

/**
 * What is wrong with the conversations a canvas carries.
 *
 * A line naming a card that has since been deleted is not among them. The line
 * kept that card's title and kind for exactly this case, so what it says is
 * still what was asked about; only the card is gone, and saying so is the
 * reader's job rather than a fault in the document.
 */
function sessionIssues(canvas: CanvasDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const canvasId = canvas.id;
  const sessions = canvas.sessions ?? [];
  if (sessions.length > MAX_ASSISTANT_SESSIONS_PER_CANVAS) {
    issues.push({
      code: "VALIDATION_FAILED",
      message: i18n.t("errors:validate.canvasSessionLimit", {
        count: MAX_ASSISTANT_SESSIONS_PER_CANVAS,
      }),
      canvasId,
    });
  }
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: i18n.t("errors:validate.duplicateSessionId", {
          id: session.id,
        }),
        canvasId,
      });
    }
    seen.add(session.id);
    if (session.messages.length > MAX_ASSISTANT_MESSAGES_PER_SESSION) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: i18n.t("errors:validate.sessionMessageLimit", {
          title: session.title,
          count: MAX_ASSISTANT_MESSAGES_PER_SESSION,
        }),
        canvasId,
      });
    }
  }
  return issues;
}

export function validateCanvas(canvas: CanvasDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const canvasId = canvas.id;

  if (canvas.nodes.length > MAX_NODES_PER_CANVAS) {
    issues.push({
      code: "VALIDATION_FAILED",
      message: i18n.t("errors:validate.canvasNodeLimit", {
        count: MAX_NODES_PER_CANVAS,
      }),
      canvasId,
    });
  }
  if (canvas.edges.length > MAX_EDGES_PER_CANVAS) {
    issues.push({
      code: "VALIDATION_FAILED",
      message: i18n.t("errors:validate.canvasEdgeLimit", {
        count: MAX_EDGES_PER_CANVAS,
      }),
      canvasId,
    });
  }
  issues.push(...sessionIssues(canvas));

  const nodeIds = new Set<string>();
  for (const node of canvas.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: i18n.t("errors:validate.duplicateNodeId", { id: node.id }),
        canvasId,
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);
    if (!validateBounds(node.bounds)) {
      issues.push({
        code: "BOUNDS_INVALID",
        message: i18n.t("errors:validate.nodeBoundsInvalid", {
          title: node.title,
        }),
        canvasId,
        nodeId: node.id,
      });
    }
    const portIds = new Set<string>();
    for (const port of node.ports) {
      if (portIds.has(port.id)) {
        issues.push({
          code: "VALIDATION_FAILED",
          message: i18n.t("errors:validate.duplicatePortId", {
            portId: port.id,
            title: node.title,
          }),
          canvasId,
          nodeId: node.id,
          portId: port.id,
        });
      }
      portIds.add(port.id);
    }
  }

  for (const node of canvas.nodes) {
    issues.push(...generationIssues(canvas, node, nodeIds));
  }

  const edgeIds = new Set<string>();
  for (const edge of canvas.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: i18n.t("errors:validate.duplicateEdgeId", { id: edge.id }),
        canvasId,
        edgeId: edge.id,
      });
    }
    edgeIds.add(edge.id);
    const remaining = canvas.edges.filter((e) => e.id !== edge.id);
    const scopedCanvas = { ...canvas, edges: remaining };
    const result = validateEdgeCandidate(
      scopedCanvas,
      edge.source,
      edge.target,
    );
    if (!result.ok) {
      issues.push({
        code: result.code,
        message: result.message,
        canvasId,
        edgeId: edge.id,
        nodeId: edge.target.nodeId,
        portId: edge.target.portId,
      });
    }
  }

  const groupOf = new Map<NodeId, NodeId>();
  for (const group of canvas.groups) {
    const groupNode = findNode(canvas, group.groupId);
    if (!groupNode || groupNode.kind !== "group") {
      issues.push({
        code: "GROUP_INVALID",
        message: i18n.t("errors:validate.groupNodeMissing"),
        canvasId,
        nodeId: group.groupId,
      });
      continue;
    }
    const seen = new Set<NodeId>();
    for (const childId of group.childNodeIds) {
      if (childId === group.groupId) {
        issues.push({
          code: "GROUP_INVALID",
          message: i18n.t("errors:validate.groupContainsItself"),
          canvasId,
          nodeId: group.groupId,
        });
      }
      if (seen.has(childId)) {
        issues.push({
          code: "GROUP_INVALID",
          message: i18n.t("errors:validate.duplicateGroupMember"),
          canvasId,
          nodeId: childId,
        });
      }
      seen.add(childId);
      if (!nodeIds.has(childId)) {
        issues.push({
          code: "GROUP_INVALID",
          message: i18n.t("errors:validate.groupMemberMissing"),
          canvasId,
          nodeId: childId,
        });
      }
      if (groupOf.has(childId)) {
        issues.push({
          code: "GROUP_INVALID",
          message: i18n.t("errors:validate.nodeInTwoGroups"),
          canvasId,
          nodeId: childId,
        });
      }
      groupOf.set(childId, group.groupId);
    }
    if (group.childNodeIds.length < 2) {
      issues.push({
        code: "GROUP_INVALID",
        message: i18n.t("errors:validate.groupTooSmall"),
        canvasId,
        nodeId: group.groupId,
      });
    }
  }

  return issues;
}

/**
 * What a reader says about an asset, held to its sizes and its vocabulary.
 *
 * These are the only registry fields written by hand, so a document out of the
 * wild can carry an asset too tagged to read through, or an origin nothing here
 * recognises.
 */
function shelfIssues(entry: ResourceEntry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const say = (message: string) =>
    issues.push({ code: "VALIDATION_FAILED", message });
  if (entry.tags) {
    if (entry.tags.length > MAX_ASSET_TAGS) {
      say(
        i18n.t("errors:validate.assetTooManyTags", {
          name: entry.name,
          count: MAX_ASSET_TAGS,
        }),
      );
    }
    if (entry.tags.some((tag) => tag.length > MAX_ASSET_TAG_LENGTH)) {
      say(
        i18n.t("errors:validate.assetTagTooLong", {
          name: entry.name,
          count: MAX_ASSET_TAG_LENGTH,
        }),
      );
    }
  }
  if (entry.note && entry.note.length > MAX_ASSET_NOTE_LENGTH) {
    say(
      i18n.t("errors:validate.assetNoteTooLong", {
        name: entry.name,
        count: MAX_ASSET_NOTE_LENGTH,
      }),
    );
  }
  if (entry.keyword && entry.keyword.length > MAX_ASSET_KEYWORD_LENGTH) {
    say(
      i18n.t("errors:validate.assetSummaryTooLong", {
        name: entry.name,
        count: MAX_ASSET_KEYWORD_LENGTH,
      }),
    );
  }
  if (entry.origin !== undefined && !ASSET_ORIGINS.includes(entry.origin)) {
    say(
      i18n.t("errors:validate.assetOriginUnknown", {
        name: entry.name,
        origin: entry.origin,
      }),
    );
  }
  return issues;
}

/**
 * What is wrong with the canvas tree.
 *
 * A folder naming a parent that is not there is a fault in the document rather
 * than an empty drawer: the boards under it would sit somewhere no tree can
 * show, so it is said outright instead of being quietly read as a folder at the
 * project root. A name that leads round in a circle is a fault for the same
 * reason, and is named as one rather than reported as too deep.
 */
function folderIssues(moka: MokaFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const say = (message: string) =>
    issues.push({ code: "VALIDATION_FAILED", message });
  const folders = foldersOf(moka);
  if (folders.length > MAX_FOLDERS_PER_PROJECT) {
    say(
      i18n.t("errors:validate.folderLimit", {
        count: MAX_FOLDERS_PER_PROJECT,
      }),
    );
  }
  const ids = new Set(folders.map((folder) => folder.id));
  if (ids.size !== folders.length)
    say(i18n.t("errors:validate.duplicateFolderId"));
  for (const folder of folders) {
    if (folder.name.length === 0)
      say(i18n.t("errors:validate.folderNoName", { id: folder.id }));
    if (folder.name.length > MAX_FOLDER_NAME_LENGTH) {
      say(
        i18n.t("errors:validate.folderNameTooLong", {
          name: folder.name,
          count: MAX_FOLDER_NAME_LENGTH,
        }),
      );
    }
    if (folder.parentId !== undefined && !ids.has(folder.parentId)) {
      say(i18n.t("errors:validate.folderParentMissing", { name: folder.name }));
      continue;
    }
    if (holdsItself(moka, folder.id)) {
      say(i18n.t("errors:validate.folderInsideItself", { name: folder.name }));
      continue;
    }
    if (folderDepth(moka, folder.id) > MAX_FOLDER_DEPTH) {
      say(
        i18n.t("errors:validate.folderTooDeep", {
          name: folder.name,
          count: MAX_FOLDER_DEPTH,
        }),
      );
    }
  }
  for (const canvas of moka.canvas) {
    if (canvas.folderId !== undefined && !ids.has(canvas.folderId)) {
      issues.push({
        code: "FOLDER_NOT_FOUND",
        message: i18n.t("errors:validate.canvasFolderMissing", {
          name: canvas.name,
        }),
        canvasId: canvas.id,
      });
    }
  }
  return issues;
}

/** Whether walking up from a folder leads back to it. */
function holdsItself(moka: MokaFile, folderId: string): boolean {
  const seen = new Set<string>();
  let current = foldersOf(moka).find((folder) => folder.id === folderId);
  while (current?.parentId !== undefined) {
    if (seen.has(current.parentId)) return true;
    seen.add(current.parentId);
    const parentId = current.parentId;
    current = foldersOf(moka).find((folder) => folder.id === parentId);
  }
  return false;
}

/**
 * A story's own guardrails: the limits its commands keep it within, read
 * again over a document that may have been written by somebody else.
 *
 * The room reads a story it did not write — a package from another machine,
 * a file a newer build saved — and a story that says an impossible thing is
 * better reported than drawn.
 */
export function validateStory(story: StoryDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (code: string, message: string) => {
    issues.push({ code, message });
  };

  if (story.name.length === 0 || story.name.length > STORY_NAME_MAX)
    at("STORY_NAME_INVALID", i18n.t("errors:validate.storyNameInvalid"));
  if (story.schemaVersion > STORY_SCHEMA_VERSION)
    at("STORY_SCHEMA_NEWER", i18n.t("errors:validate.storySchemaNewer"));
  if (
    story.brief.totalDurationMs < MIN_TOTAL_DURATION_MS ||
    story.brief.totalDurationMs > MAX_TOTAL_DURATION_MS
  )
    at("VALIDATION_FAILED", i18n.t("errors:validate.storyDurationOutOfRange"));
  if (!STORY_ASPECTS.includes(story.brief.aspect))
    at("VALIDATION_FAILED", i18n.t("errors:validate.storyAspectUnknown"));
  if (story.chapters.length > MAX_CHAPTERS_PER_STORY)
    at("STORY_CHAPTER_LIMIT", i18n.t("errors:validate.storyChapterLimit"));
  if (story.elements.length > MAX_ELEMENTS_PER_STORY)
    at("STORY_ELEMENT_LIMIT", i18n.t("errors:validate.storyElementLimit"));
  if (
    !Number.isInteger(story.maxReferenceImages) ||
    story.maxReferenceImages < 0 ||
    story.maxReferenceImages > REFERENCE_IMAGES_MAX
  )
    at(
      "VALIDATION_FAILED",
      i18n.t("errors:validate.storyReferenceLimitOutOfRange"),
    );

  const slot = (held: StorySlot) => {
    if (held.takes.length > MAX_TAKES_PER_SLOT)
      at("STORY_SLOT_FULL", i18n.t("errors:validate.storySlotFull"));
  };
  for (const element of story.elements) {
    slot(element.main);
    if (element.turnaround) slot(element.turnaround);
  }
  for (const chapter of story.chapters) {
    if (chapter.acts.length > MAX_ACTS_PER_CHAPTER)
      at("STORY_ACT_LIMIT", i18n.t("errors:validate.storyActLimit"));
    for (const act of chapter.acts) {
      slot(act.video);
      if (act.keyframes.length > MAX_KEYFRAMES_PER_ACT)
        at(
          "STORY_KEYFRAME_LIMIT",
          i18n.t("errors:validate.storyKeyframeLimit"),
        );
      for (const keyframe of act.keyframes) {
        slot(keyframe.art);
        slot(keyframe.video);
        if (
          !Number.isInteger(keyframe.durationMs) ||
          keyframe.durationMs < MIN_KEYFRAME_MS ||
          keyframe.durationMs > MAX_KEYFRAME_MS
        )
          at(
            "VALIDATION_FAILED",
            i18n.t("errors:validate.storyShotDurationOutOfRange"),
          );
      }
    }
  }
  return issues;
}

export function validateMokaFile(moka: MokaFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(...folderIssues(moka));
  const canvasIds = new Set<string>();
  for (const canvas of moka.canvas) {
    if (canvasIds.has(canvas.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: i18n.t("errors:validate.duplicateCanvasId", {
          id: canvas.id,
        }),
        canvasId: canvas.id,
      });
    }
    canvasIds.add(canvas.id);
    issues.push(...validateCanvas(canvas));
  }

  const resourceIds = new Set<string>();
  for (const entry of allResources(moka)) {
    if (resourceIds.has(entry.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: i18n.t("errors:validate.duplicateResourceId", {
          id: entry.id,
        }),
      });
    }
    resourceIds.add(entry.id);
    if (!validateResourcePath(entry.path)) {
      issues.push({
        code: "PATH_ESCAPE",
        message: i18n.t("errors:validate.resourcePathEscapes", {
          path: entry.path,
        }),
      });
    }
    issues.push(...shelfIssues(entry));
  }

  for (const timeline of moka.timelines ?? []) {
    issues.push(...validateTimeline(timeline, moka));
  }

  const stories = moka.stories ?? [];
  if (stories.length > MAX_STORIES_PER_PROJECT)
    issues.push({
      code: "STORY_LIMIT_REACHED",
      message: i18n.t("errors:validate.storyLimitReached"),
    });
  const storyIds = new Set<string>();
  for (const story of stories) {
    if (storyIds.has(story.id))
      issues.push({
        code: "STORY_ID_EXISTS",
        message: i18n.t("errors:validate.duplicateStoryId", { id: story.id }),
      });
    storyIds.add(story.id);
    issues.push(...validateStory(story));
    // What the story laid down in the cutting room has to still be there:
    // a story pointing at a timeline nobody holds is one step five cannot
    // open, which is worth saying before the reader gets there.
    if (
      story.edit.timelineId !== undefined &&
      !(moka.timelines ?? []).some(
        (timeline) => timeline.id === story.edit.timelineId,
      )
    )
      issues.push({
        code: "STORY_TARGET_INVALID",
        message: i18n.t("errors:validate.storyTimelineMissing", {
          id: story.edit.timelineId,
        }),
      });
  }

  const refs = collectAssetReferences(moka);
  for (const assetId of refs.keys()) {
    if (!resourceIds.has(assetId)) {
      issues.push({
        code: "ASSET_MISSING",
        message: i18n.t("errors:validate.unregisteredAsset", {
          id: assetId,
        }),
      });
    }
  }
  return issues;
}
