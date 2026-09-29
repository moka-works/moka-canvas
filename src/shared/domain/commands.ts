import {
  BACKGROUND_MODES,
  CANVAS_SCHEMA_VERSION,
  MAX_ACTS_PER_CHAPTER,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  MAX_ASSISTANT_MESSAGES_PER_SESSION,
  MAX_ASSISTANT_SESSIONS_PER_CANVAS,
  MAX_ASSISTANT_TITLE_LENGTH,
  MAX_CANVAS_NAME_LENGTH,
  MAX_CANVASES_PER_PROJECT,
  MAX_CHAPTERS_PER_STORY,
  MAX_CLIPS_PER_COMMAND,
  MAX_CLIPS_PER_TIMELINE,
  MAX_DIALOGUE_LINES_PER_KEYFRAME,
  MAX_DIALOGUE_LINE_LENGTH,
  MAX_EDGES_PER_CANVAS,
  MAX_ELEMENTS_PER_STORY,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME_LENGTH,
  MAX_FOLDERS_PER_PROJECT,
  MAX_KEYFRAMES_PER_ACT,
  MAX_KEYFRAME_MS,
  MAX_NODES_PER_CANVAS,
  MAX_STORIES_PER_PROJECT,
  MAX_TAKES_PER_SLOT,
  MAX_TIMELINES_PER_PROJECT,
  MAX_TITLE_LENGTH,
  MAX_TOTAL_DURATION_MS,
  MAX_TRACKS_PER_TIMELINE,
  MAX_TRANSITIONS_PER_TIMELINE,
  MIN_KEYFRAME_MS,
  MIN_TOTAL_DURATION_MS,
  REFERENCE_IMAGES_MAX,
  STORY_IDEA_MAX,
  STORY_NAME_MAX,
  STORY_SCHEMA_VERSION,
  TIMELINE_FPS_CHOICES,
  TIMELINE_HEIGHT_MAX,
  TIMELINE_HEIGHT_MIN,
  TIMELINE_NAME_MAX,
  TIMELINE_WIDTH_MAX,
  TIMELINE_WIDTH_MIN,
  TIMELINE_SCHEMA_VERSION,
  VOICE_INSTRUCTIONS_MAX,
  VOICE_MODEL_MAX,
  VOICE_NAME_MAX,
  VOICE_PITCH_MAX,
  VOICE_PITCH_MIN,
  VOICE_RATE_MAX,
  VOICE_RATE_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./constants";
import {
  STORY_ASPECTS,
  STORY_ELEMENT_KINDS,
  STORY_SHOT_GRANULARITIES,
} from "./types";
import type {
  AssistantSession,
  CanvasDocument,
  CanvasFolder,
  DocumentCommand,
  DocumentSettings,
  FolderId,
  MokaFile,
  NodeId,
  StoryAct,
  StoryChapter,
  StoryDocument,
  StoryElement,
  StoryKeyframe,
  StorySlot,
  StorySlotTarget,
  StoryVoiceProfile,
  TimelineClip,
  TimelineDocument,
  TimelineId,
  TimelineSettings,
  TimelineTrack,
  TrackId,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
import {
  canvasFolderOf,
  canvasSiblingIndex,
  childFolders,
  descendantFolderIds,
  folderById,
  folderCanvases,
  folderDepth,
  folderSiblingIndex,
  foldersOf,
  subtreeDepth,
} from "./folders";
import {
  checkClip,
  checkHexColor,
  checkNoOverlap,
  checkTimeline,
  checkTransitionLanding,
  checkTransitionRestoration,
  followerOf,
  invertClipPatch,
  mergeClipPatch,
  trackAccepts,
  transitionsOfSeams,
} from "./timeline";
import { emptyStorySlot } from "./factories";
import { STORY_STEPS, storyVoiceTake, voiceTakeOf } from "./story";
import { findNode, validateBounds, validateEdgeCandidate } from "./validate";
import { i18n } from "../i18n";

export class CommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CommandError";
  }
}

export function emptyCanvas(id: string, name: string): CanvasDocument {
  return {
    id,
    name,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    groups: [],
    settings: { background: "dots", showMinimap: true, snapToGrid: true },
  };
}

export function nextCanvasName(moka: MokaFile): string {
  const used = new Set(moka.canvas.map((c) => c.name));
  let n = moka.canvas.length + 1;
  while (used.has(i18n.t("domain:canvas.defaultName", { n }))) n += 1;
  return i18n.t("domain:canvas.defaultName", { n });
}

function canvasOf(moka: MokaFile, canvasId: string): CanvasDocument {
  const canvas = moka.canvas.find((c) => c.id === canvasId);
  if (!canvas)
    throw new CommandError(
      "CANVAS_NOT_FOUND",
      i18n.t("errors:command.canvasNotFound"),
    );
  return canvas;
}

function replaceCanvas(moka: MokaFile, canvas: CanvasDocument): MokaFile {
  return {
    ...moka,
    canvas: moka.canvas.map((c) => (c.id === canvas.id ? canvas : c)),
  };
}

/**
 * A project carrying these folders, or carrying the field not at all when it
 * has none.
 *
 * A tree emptied of its folders writes what it would have written had nobody
 * ever tidied it, which is the honest reading of it: there is nothing to show
 * and an empty list would claim a drawer was made.
 */
function withFolders(moka: MokaFile, folders: CanvasFolder[]): MokaFile {
  return { ...moka, folders: folders.length > 0 ? folders : undefined };
}

/**
 * Puts `item` into `list` at the place `index` names among `peers`.
 *
 * The two lists a tree is made of are each a slice of one flat list, so a place
 * among siblings has to be turned back into a place in the flat list: before the
 * sibling it was asked to land ahead of, after the last of them when it was
 * asked for the end, and at the end of everything when it has no siblings at
 * all — where among none it lands cannot be seen.
 *
 * `peers` must already exclude the item, which is what a move does first.
 */
function spliceAmong<T>(list: T[], peers: T[], index: number, item: T): T[] {
  const at = Math.min(Math.max(index, 0), peers.length);
  const next = [...list];
  if (at < peers.length) {
    next.splice(next.indexOf(peers[at]), 0, item);
  } else if (peers.length > 0) {
    next.splice(next.indexOf(peers[peers.length - 1]) + 1, 0, item);
  } else {
    next.push(item);
  }
  return next;
}

function folderOf(
  moka: MokaFile,
  folderId: FolderId | null | undefined,
): FolderId | null {
  if (folderId === null || folderId === undefined) return null;
  if (!folderById(moka, folderId)) {
    throw new CommandError(
      "FOLDER_NOT_FOUND",
      i18n.t("errors:command.folderNotFound"),
    );
  }
  return folderId;
}

function checkFolderName(name: string) {
  if (name.length === 0) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.folderNameEmpty"),
    );
  }
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.folderNameTooLong"),
    );
  }
}

/**
 * Whether a folder put here would take the tree past the depth it is kept to.
 *
 * Measured over the document as it would be, so what the folder carries under
 * it counts as well as the folder itself: a drawer with two levels in it needs
 * two levels of room where it is dropped.
 */
function checkFolderDepth(candidate: MokaFile, folderId: FolderId) {
  const depth =
    folderDepth(candidate, folderId) + subtreeDepth(candidate, folderId) - 1;
  if (depth > MAX_FOLDER_DEPTH) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.foldersNestAtMost", { depth: MAX_FOLDER_DEPTH }),
    );
  }
}

function sessionOf(
  canvas: CanvasDocument,
  sessionId: string,
): AssistantSession {
  const session = canvas.sessions?.find((s) => s.id === sessionId);
  if (!session)
    throw new CommandError(
      "SESSION_NOT_FOUND",
      i18n.t("errors:command.sessionNotFound"),
    );
  return session;
}

/**
 * A canvas carrying these conversations, or carrying the field not at all when
 * there are none.
 *
 * A canvas emptied of its conversations writes what it would have written had
 * nobody ever asked it anything, which is the honest reading of it: there is
 * nothing left to say about, and an empty list would claim a place was made.
 */
function withSessions(
  canvas: CanvasDocument,
  sessions: AssistantSession[],
): CanvasDocument {
  return { ...canvas, sessions: sessions.length > 0 ? sessions : undefined };
}

function withSession(
  canvas: CanvasDocument,
  session: AssistantSession,
): CanvasDocument {
  const sessions = canvas.sessions ?? [];
  return withSessions(
    canvas,
    sessions.map((s) => (s.id === session.id ? session : s)),
  );
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

// ---------------------------------------------------------------------------
// The cutting room: the shelf the timeline commands sit on. What a timeline
// may hold, and where a seam sits, lives in timeline.ts — the same rules the
// document validator reads, so a command and a validation cannot disagree.
// ---------------------------------------------------------------------------

/**
 * The timelines a project carries, or carrying the field not at all when it
 * has none — the same honest reading the folders give an empty tree.
 */
function withTimelines(
  moka: MokaFile,
  timelines: TimelineDocument[],
): MokaFile {
  return { ...moka, timelines: timelines.length > 0 ? timelines : undefined };
}

function timelineOf(moka: MokaFile, timelineId: TimelineId): TimelineDocument {
  const timeline = (moka.timelines ?? []).find((t) => t.id === timelineId);
  if (!timeline)
    throw new CommandError(
      "TIMELINE_NOT_FOUND",
      i18n.t("errors:command.timelineNotFound"),
    );
  return timeline;
}

function replaceTimeline(moka: MokaFile, timeline: TimelineDocument): MokaFile {
  return withTimelines(
    moka,
    (moka.timelines ?? []).map((t) => (t.id === timeline.id ? timeline : t)),
  );
}

function checkTimelineName(name: string) {
  if (name.length === 0)
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.timelineNameEmpty"),
    );
  if (name.length > TIMELINE_NAME_MAX)
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.timelineNameTooLong"),
    );
}

function isEven(value: number): boolean {
  return Number.isInteger(value) && Math.trunc(value) % 2 === 0;
}

function validateTimelineSettings(settings: Partial<TimelineSettings>) {
  if (
    settings.fps !== undefined &&
    !TIMELINE_FPS_CHOICES.includes(settings.fps as never)
  )
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.frameRateNotAllowed"),
    );
  if (settings.width !== undefined) {
    if (
      settings.width < TIMELINE_WIDTH_MIN ||
      settings.width > TIMELINE_WIDTH_MAX ||
      !isEven(settings.width)
    )
      throw new CommandError(
        "VALIDATION_FAILED",
        i18n.t("errors:command.widthOutOfRange"),
      );
  }
  if (settings.height !== undefined) {
    if (
      settings.height < TIMELINE_HEIGHT_MIN ||
      settings.height > TIMELINE_HEIGHT_MAX ||
      !isEven(settings.height)
    )
      throw new CommandError(
        "VALIDATION_FAILED",
        i18n.t("errors:command.heightOutOfRange"),
      );
  }
  if (settings.background !== undefined) checkHexColor(settings.background);
}

function syncGroupNodeData(canvas: CanvasDocument): CanvasDocument {
  const byId = new Map(canvas.groups.map((g) => [g.groupId, g]));
  let changed = false;
  const nodes = canvas.nodes.map((node) => {
    if (node.kind !== "group") return node;
    const membership = byId.get(node.id);
    const current = (node.data as { childNodeIds?: NodeId[] }).childNodeIds;
    const next = membership?.childNodeIds ?? [];
    if (JSON.stringify(current) === JSON.stringify(next)) return node;
    changed = true;
    return {
      ...node,
      data: { ...(node.data as object), childNodeIds: next } as never,
    };
  });
  return changed ? { ...canvas, nodes } : canvas;
}

function applyOne(
  moka: MokaFile,
  command: DocumentCommand,
): { next: MokaFile; inverse: DocumentCommand[] } {
  switch (command.type) {
    case "updateProjectMetadata": {
      const name = command.name.trim();
      if (name.length === 0)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.projectNameEmpty"),
        );
      const description = command.description.trim();
      const previous = moka.metadata;
      return {
        next: {
          ...moka,
          metadata: {
            ...previous,
            name,
            description: description.length === 0 ? undefined : description,
          },
        },
        inverse: [
          {
            type: "updateProjectMetadata",
            name: previous.name,
            description: previous.description ?? "",
          },
        ],
      };
    }

    case "addNode": {
      const canvas = canvasOf(moka, command.canvasId);
      if (findNode(canvas, command.node.id))
        throw new CommandError(
          "CONFLICT",
          i18n.t("errors:command.nodeIdExists"),
        );
      if (canvas.nodes.length + 1 > MAX_NODES_PER_CANVAS)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.nodeLimitReached"),
        );
      if (!validateBounds(command.node.bounds))
        throw new CommandError(
          "BOUNDS_INVALID",
          i18n.t("errors:command.nodeBoundsInvalid"),
        );
      if (command.node.title.length > MAX_TITLE_LENGTH)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.nodeTitleTooLong"),
        );
      const next: CanvasDocument = {
        ...canvas,
        nodes: [...canvas.nodes, command.node],
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "removeNodes",
            canvasId: command.canvasId,
            nodeIds: [command.node.id],
          },
        ],
      };
    }

    case "updateNode": {
      const canvas = canvasOf(moka, command.canvasId);
      const node = findNode(canvas, command.nodeId);
      if (!node)
        throw new CommandError(
          "NODE_NOT_FOUND",
          i18n.t("errors:command.nodeNotFound"),
        );
      if (
        command.patch.title !== undefined &&
        command.patch.title.length > MAX_TITLE_LENGTH
      )
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.nodeTitleTooLong"),
        );
      const inversePatch: Record<string, unknown> = {};
      if (command.patch.title !== undefined) inversePatch.title = node.title;
      if (command.patch.zIndex !== undefined) inversePatch.zIndex = node.zIndex;
      if (command.patch.data !== undefined) inversePatch.data = node.data;
      const updated: WorkflowNode = {
        ...node,
        ...(command.patch.title !== undefined
          ? { title: command.patch.title }
          : {}),
        ...(command.patch.zIndex !== undefined
          ? { zIndex: command.patch.zIndex }
          : {}),
        ...(command.patch.data !== undefined
          ? { data: command.patch.data }
          : {}),
      };
      const next: CanvasDocument = {
        ...canvas,
        nodes: canvas.nodes.map((n) => (n.id === node.id ? updated : n)),
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "updateNode",
            canvasId: command.canvasId,
            nodeId: node.id,
            patch: inversePatch as never,
          },
        ],
      };
    }

    case "moveNodes": {
      const canvas = canvasOf(moka, command.canvasId);
      const previous: Record<NodeId, { x: number; y: number }> = {};
      const nodes = canvas.nodes.map((node) => {
        const position = command.positions[node.id];
        if (!position) return node;
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
          throw new CommandError(
            "BOUNDS_INVALID",
            i18n.t("errors:command.positionNotFinite"),
          );
        previous[node.id] = { x: node.bounds.x, y: node.bounds.y };
        return {
          ...node,
          bounds: { ...node.bounds, x: position.x, y: position.y },
        };
      });
      const next = syncGroupNodeData({ ...canvas, nodes });
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "moveNodes",
            canvasId: command.canvasId,
            positions: previous,
          },
        ],
      };
    }

    case "resizeNode": {
      const canvas = canvasOf(moka, command.canvasId);
      const node = findNode(canvas, command.nodeId);
      if (!node)
        throw new CommandError(
          "NODE_NOT_FOUND",
          i18n.t("errors:command.nodeNotFound"),
        );
      if (!validateBounds(command.bounds))
        throw new CommandError(
          "BOUNDS_INVALID",
          i18n.t("errors:command.boundsInvalid"),
        );
      const previous = { ...node.bounds };
      const next: CanvasDocument = {
        ...canvas,
        nodes: canvas.nodes.map((n) =>
          n.id === node.id ? { ...n, bounds: { ...command.bounds } } : n,
        ),
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "resizeNode",
            canvasId: command.canvasId,
            nodeId: node.id,
            bounds: previous,
          },
        ],
      };
    }

    case "removeNodes": {
      const canvas = canvasOf(moka, command.canvasId);
      const removing = new Set(command.nodeIds);
      const removedNodes = canvas.nodes.filter((n) => removing.has(n.id));
      if (removedNodes.length !== removing.size)
        throw new CommandError(
          "NODE_NOT_FOUND",
          i18n.t("errors:command.someNodesNotFound"),
        );
      const removedEdges = canvas.edges.filter(
        (e) => removing.has(e.source.nodeId) || removing.has(e.target.nodeId),
      );
      const previousGroups = canvas.groups;

      let nodes = canvas.nodes.filter((n) => !removing.has(n.id));
      let edges = canvas.edges.filter(
        (e) => !removing.has(e.source.nodeId) && !removing.has(e.target.nodeId),
      );
      let groups = canvas.groups
        .filter((g) => !removing.has(g.groupId))
        .map((g) => ({
          ...g,
          childNodeIds: g.childNodeIds.filter((id) => !removing.has(id)),
        }));

      // Groups that drop below two members dissolve; their group nodes go too.
      const dissolved = new Set<string>();
      for (const g of groups) {
        if (g.childNodeIds.length < 2) dissolved.add(g.groupId);
      }
      if (dissolved.size > 0) {
        const dissolvedNodes = nodes.filter(
          (n) => n.kind === "group" && dissolved.has(n.id),
        );
        for (const n of dissolvedNodes) removedNodes.push(n);
        const dissolvedEdges = edges.filter(
          (e) =>
            dissolved.has(e.source.nodeId) || dissolved.has(e.target.nodeId),
        );
        for (const e of dissolvedEdges) removedEdges.push(e);
        nodes = nodes.filter((n) => !dissolved.has(n.id));
        edges = edges.filter(
          (e) =>
            !dissolved.has(e.source.nodeId) && !dissolved.has(e.target.nodeId),
        );
        groups = groups.filter((g) => !dissolved.has(g.groupId));
      }

      const next = syncGroupNodeData({ ...canvas, nodes, edges, groups });
      const inverse: DocumentCommand[] = [];
      const orderedRemoved = canvas.nodes.filter((n) =>
        removedNodes.some((r) => r.id === n.id),
      );
      for (const node of orderedRemoved) {
        inverse.push({ type: "addNode", canvasId: command.canvasId, node });
      }
      for (const edge of removedEdges) {
        inverse.push({ type: "addEdge", canvasId: command.canvasId, edge });
      }
      for (const group of previousGroups) {
        const current = groups.find((g) => g.groupId === group.groupId);
        if (
          !current ||
          JSON.stringify(current.childNodeIds) !==
            JSON.stringify(group.childNodeIds)
        ) {
          inverse.push({
            type: "setGroupMembership",
            canvasId: command.canvasId,
            groupId: group.groupId,
            childNodeIds: group.childNodeIds,
          });
        }
      }
      return { next: replaceCanvas(moka, next), inverse };
    }

    case "addEdge": {
      const canvas = canvasOf(moka, command.canvasId);
      if (canvas.edges.some((e) => e.id === command.edge.id))
        throw new CommandError(
          "CONFLICT",
          i18n.t("errors:command.edgeIdExists"),
        );
      if (canvas.edges.length + 1 > MAX_EDGES_PER_CANVAS)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.edgeLimitReached"),
        );
      const result = validateEdgeCandidate(
        canvas,
        command.edge.source,
        command.edge.target,
      );
      if (!result.ok) throw new CommandError(result.code, result.message);
      const next: CanvasDocument = {
        ...canvas,
        edges: [...canvas.edges, command.edge],
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "removeEdges",
            canvasId: command.canvasId,
            edgeIds: [command.edge.id],
          },
        ],
      };
    }

    case "removeEdges": {
      const canvas = canvasOf(moka, command.canvasId);
      const removing = new Set(command.edgeIds);
      const removed: WorkflowEdge[] = canvas.edges.filter((e) =>
        removing.has(e.id),
      );
      if (removed.length !== removing.size)
        throw new CommandError(
          "EDGE_NOT_FOUND",
          i18n.t("errors:command.someEdgesNotFound"),
        );
      const next: CanvasDocument = {
        ...canvas,
        edges: canvas.edges.filter((e) => !removing.has(e.id)),
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: removed.map((edge) => ({
          type: "addEdge",
          canvasId: command.canvasId,
          edge,
        })),
      };
    }

    case "setGroupMembership": {
      const canvas = canvasOf(moka, command.canvasId);
      const groupNode = findNode(canvas, command.groupId);
      if (!groupNode || groupNode.kind !== "group")
        throw new CommandError(
          "GROUP_INVALID",
          i18n.t("errors:command.groupNodeNotFound"),
        );
      const unique = new Set(command.childNodeIds);
      if (unique.size !== command.childNodeIds.length)
        throw new CommandError(
          "GROUP_INVALID",
          i18n.t("errors:command.duplicateGroupMember"),
        );
      if (unique.has(command.groupId))
        throw new CommandError(
          "GROUP_INVALID",
          i18n.t("errors:command.groupContainsItself"),
        );
      for (const id of unique) {
        const child = findNode(canvas, id);
        if (!child)
          throw new CommandError(
            "NODE_NOT_FOUND",
            i18n.t("errors:command.memberNotFound"),
          );
        if (child.kind === "group")
          throw new CommandError(
            "GROUP_INVALID",
            i18n.t("errors:command.nestedGroupsUnsupported"),
          );
      }
      const previous =
        canvas.groups.find((g) => g.groupId === command.groupId)
          ?.childNodeIds ?? [];
      const others = canvas.groups.filter((g) => g.groupId !== command.groupId);

      const inverse: DocumentCommand[] = [];
      let working: CanvasDocument;
      if (command.childNodeIds.length >= 2) {
        working = {
          ...canvas,
          groups: [
            ...others,
            { groupId: command.groupId, childNodeIds: command.childNodeIds },
          ],
        };
      } else {
        // Dissolve: drop the membership, the group node, and its edges.
        const removedEdges = canvas.edges.filter(
          (e) =>
            e.source.nodeId === command.groupId ||
            e.target.nodeId === command.groupId,
        );
        inverse.push({
          type: "addNode",
          canvasId: command.canvasId,
          node: groupNode,
        });
        for (const edge of removedEdges) {
          inverse.push({ type: "addEdge", canvasId: command.canvasId, edge });
        }
        working = {
          ...canvas,
          groups: others,
          nodes: canvas.nodes.filter((n) => n.id !== command.groupId),
          edges: canvas.edges.filter(
            (e) =>
              e.source.nodeId !== command.groupId &&
              e.target.nodeId !== command.groupId,
          ),
        };
      }
      inverse.push({
        type: "setGroupMembership",
        canvasId: command.canvasId,
        groupId: command.groupId,
        childNodeIds: previous,
      });
      const next = syncGroupNodeData(working);
      return { next: replaceCanvas(moka, next), inverse };
    }

    case "setViewport": {
      const canvas = canvasOf(moka, command.canvasId);
      const viewport = {
        x: command.viewport.x,
        y: command.viewport.y,
        zoom: clampZoom(command.viewport.zoom),
      };
      if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y))
        throw new CommandError(
          "BOUNDS_INVALID",
          i18n.t("errors:command.viewportNotFinite"),
        );
      const previous = { ...canvas.viewport };
      return {
        next: replaceCanvas(moka, { ...canvas, viewport }),
        inverse: [
          {
            type: "setViewport",
            canvasId: command.canvasId,
            viewport: previous,
          },
        ],
      };
    }

    case "setCanvasSettings": {
      const canvas = canvasOf(moka, command.canvasId);
      const settings: DocumentSettings = {
        ...canvas.settings,
        ...command.settings,
      };
      if (!BACKGROUND_MODES.includes(settings.background))
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.backgroundModeUnknown"),
        );
      if (typeof settings.showMinimap !== "boolean")
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.minimapNotBoolean"),
        );
      if (typeof settings.snapToGrid !== "boolean")
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.snapNotBoolean"),
        );
      const previous = { ...canvas.settings };
      return {
        next: replaceCanvas(moka, { ...canvas, settings }),
        inverse: [
          {
            type: "setCanvasSettings",
            canvasId: command.canvasId,
            settings: previous,
          },
        ],
      };
    }

    case "addSession": {
      const canvas = canvasOf(moka, command.canvasId);
      const sessions = canvas.sessions ?? [];
      if (sessions.some((s) => s.id === command.session.id))
        throw new CommandError(
          "CONFLICT",
          i18n.t("errors:command.sessionIdExists"),
        );
      if (sessions.length + 1 > MAX_ASSISTANT_SESSIONS_PER_CANVAS)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.sessionLimitReached"),
        );
      if (command.session.title.length === 0)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.sessionTitleEmpty"),
        );
      if (command.session.title.length > MAX_ASSISTANT_TITLE_LENGTH)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.sessionTitleTooLong"),
        );
      if (command.session.messages.length > MAX_ASSISTANT_MESSAGES_PER_SESSION)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.sessionMessageLimitReached"),
        );
      const index = Math.min(
        Math.max(command.index ?? sessions.length, 0),
        sessions.length,
      );
      const list = [...sessions];
      list.splice(index, 0, command.session);
      return {
        next: replaceCanvas(moka, withSessions(canvas, list)),
        inverse: [
          {
            type: "removeSession",
            canvasId: command.canvasId,
            sessionId: command.session.id,
          },
        ],
      };
    }

    case "renameSession": {
      const canvas = canvasOf(moka, command.canvasId);
      const session = sessionOf(canvas, command.sessionId);
      if (command.title.length === 0)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.sessionTitleEmpty"),
        );
      if (command.title.length > MAX_ASSISTANT_TITLE_LENGTH)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.sessionTitleTooLong"),
        );
      const previous = session.title;
      // What a conversation is called is not something said in it, so renaming
      // leaves the moment something was last said alone: the newest conversation
      // is found by it, and a rename would otherwise make this one that.
      return {
        next: replaceCanvas(
          moka,
          withSession(canvas, { ...session, title: command.title }),
        ),
        inverse: [
          {
            type: "renameSession",
            canvasId: command.canvasId,
            sessionId: command.sessionId,
            title: previous,
          },
        ],
      };
    }

    case "removeSession": {
      const canvas = canvasOf(moka, command.canvasId);
      const sessions = canvas.sessions ?? [];
      const index = sessions.findIndex((s) => s.id === command.sessionId);
      if (index < 0)
        throw new CommandError(
          "SESSION_NOT_FOUND",
          i18n.t("errors:command.sessionNotFound"),
        );
      return {
        next: replaceCanvas(
          moka,
          withSessions(
            canvas,
            sessions.filter((s) => s.id !== command.sessionId),
          ),
        ),
        inverse: [
          {
            type: "addSession",
            canvasId: command.canvasId,
            session: sessions[index],
            index,
          },
        ],
      };
    }

    case "appendMessages": {
      const canvas = canvasOf(moka, command.canvasId);
      const session = sessionOf(canvas, command.sessionId);
      if (command.messages.length === 0)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.nothingToAppend"),
        );
      const known = new Set(session.messages.map((message) => message.id));
      for (const message of command.messages) {
        if (known.has(message.id))
          throw new CommandError(
            "CONFLICT",
            i18n.t("errors:command.messageIdExists"),
          );
        known.add(message.id);
        if (message.text.length > MAX_ASSISTANT_MESSAGE_LENGTH)
          throw new CommandError(
            "VALIDATION_FAILED",
            i18n.t("errors:command.messageTooLong"),
          );
      }

      const messages = [...session.messages];
      const at = Math.min(
        Math.max(command.at ?? messages.length, 0),
        messages.length,
      );
      messages.splice(at, 0, ...command.messages);

      // The oldest lines go to keep a conversation a length that can still be
      // read through. They go from the document and not only from the screen, so
      // the undo that takes the new lines back gives these back too, each at the
      // place it held: putting them back oldest first lands them where they were.
      const overflow = messages.length - MAX_ASSISTANT_MESSAGES_PER_SESSION;
      const dropped = overflow > 0 ? messages.splice(0, overflow) : [];
      const kept = new Set(messages.map((message) => message.id));
      const appended = command.messages
        .map((message) => message.id)
        .filter((id) => kept.has(id));

      const inverse: DocumentCommand[] = [];
      if (appended.length > 0) {
        inverse.push({
          type: "removeMessages",
          canvasId: command.canvasId,
          sessionId: session.id,
          messageIds: appended,
        });
      }
      for (const [position, message] of dropped.entries()) {
        inverse.push({
          type: "appendMessages",
          canvasId: command.canvasId,
          sessionId: session.id,
          messages: [message],
          at: position,
        });
      }

      const spokenAt = messages.at(-1)?.createdAt;
      return {
        next: replaceCanvas(
          moka,
          withSession(canvas, {
            ...session,
            messages,
            updatedAt:
              spokenAt !== undefined && spokenAt > session.updatedAt
                ? spokenAt
                : session.updatedAt,
          }),
        ),
        inverse,
      };
    }

    case "removeMessages": {
      const canvas = canvasOf(moka, command.canvasId);
      const session = sessionOf(canvas, command.sessionId);
      const removing = new Set(command.messageIds);
      const removed = session.messages.filter((message) =>
        removing.has(message.id),
      );
      if (removed.length !== removing.size)
        throw new CommandError(
          "MESSAGE_NOT_FOUND",
          i18n.t("errors:command.someMessagesNotFound"),
        );
      const held = new Map(
        session.messages.map((message, position) => [message.id, position]),
      );
      return {
        next: replaceCanvas(
          moka,
          withSession(canvas, {
            ...session,
            messages: session.messages.filter(
              (message) => !removing.has(message.id),
            ),
          }),
        ),
        // Each line goes back to the place it held, oldest first, which is the
        // order that lands them all where they were.
        inverse: removed.map((message) => ({
          type: "appendMessages" as const,
          canvasId: command.canvasId,
          sessionId: command.sessionId,
          messages: [message],
          at: held.get(message.id),
        })),
      };
    }

    case "addCanvas": {
      if (moka.canvas.length + 1 > MAX_CANVASES_PER_PROJECT)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.canvasLimitReached"),
        );
      if (moka.canvas.some((c) => c.id === command.canvas.id))
        throw new CommandError(
          "CONFLICT",
          i18n.t("errors:command.canvasIdExists"),
        );
      // A canvas born into a folder names it, so the folder has to be there:
      // one that is not would leave the board somewhere no tree can show it.
      folderOf(moka, command.canvas.folderId ?? null);
      const index = Math.min(
        Math.max(command.index ?? moka.canvas.length, 0),
        moka.canvas.length,
      );
      const list = [...moka.canvas];
      list.splice(index, 0, command.canvas);
      return {
        next: { ...moka, canvas: list },
        inverse: [{ type: "removeCanvas", canvasId: command.canvas.id }],
      };
    }

    case "renameCanvas": {
      const canvas = canvasOf(moka, command.canvasId);
      if (command.name.length === 0)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.canvasNameEmpty"),
        );
      if (command.name.length > MAX_CANVAS_NAME_LENGTH)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.canvasNameTooLong"),
        );
      const previous = canvas.name;
      return {
        next: replaceCanvas(moka, { ...canvas, name: command.name }),
        inverse: [
          { type: "renameCanvas", canvasId: command.canvasId, name: previous },
        ],
      };
    }

    case "reorderCanvas": {
      const index = moka.canvas.findIndex((c) => c.id === command.canvasId);
      if (index < 0)
        throw new CommandError(
          "CANVAS_NOT_FOUND",
          i18n.t("errors:command.canvasNotFound"),
        );
      const target = Math.min(
        Math.max(command.index, 0),
        moka.canvas.length - 1,
      );
      const list = [...moka.canvas];
      const [moved] = list.splice(index, 1);
      list.splice(target, 0, moved);
      return {
        next: { ...moka, canvas: list },
        inverse: [{ type: "reorderCanvas", canvasId: command.canvasId, index }],
      };
    }

    case "removeCanvas": {
      const index = moka.canvas.findIndex((c) => c.id === command.canvasId);
      if (index < 0)
        throw new CommandError(
          "CANVAS_NOT_FOUND",
          i18n.t("errors:command.canvasNotFound"),
        );
      if (moka.canvas.length <= 1)
        throw new CommandError(
          "CANVAS_REQUIRED",
          i18n.t("errors:command.lastCanvasCannotBeRemoved"),
        );
      const removed = moka.canvas[index];
      const list = moka.canvas.filter((c) => c.id !== command.canvasId);
      return {
        next: { ...moka, canvas: list },
        inverse: [{ type: "addCanvas", canvas: removed, index }],
      };
    }

    case "addFolder": {
      const folders = foldersOf(moka);
      if (folders.length + 1 > MAX_FOLDERS_PER_PROJECT)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.folderLimitReached"),
        );
      if (folders.some((folder) => folder.id === command.folder.id))
        throw new CommandError(
          "CONFLICT",
          i18n.t("errors:command.folderIdExists"),
        );
      checkFolderName(command.folder.name);
      const parentId = folderOf(moka, command.folder.parentId ?? null);
      const placed = { ...command.folder, parentId: parentId ?? undefined };
      const siblings = childFolders(moka, parentId);
      const next = spliceAmong(
        folders,
        siblings,
        command.index ?? siblings.length,
        placed,
      );
      const candidate = withFolders(moka, next);
      checkFolderDepth(candidate, placed.id);
      return {
        next: candidate,
        inverse: [{ type: "removeFolder", folderId: placed.id }],
      };
    }

    case "renameFolder": {
      const folder = folderById(moka, command.folderId);
      if (!folder)
        throw new CommandError(
          "FOLDER_NOT_FOUND",
          i18n.t("errors:command.folderNotFound"),
        );
      checkFolderName(command.name);
      const previous = folder.name;
      return {
        next: withFolders(
          moka,
          foldersOf(moka).map((item) =>
            item.id === folder.id ? { ...item, name: command.name } : item,
          ),
        ),
        inverse: [
          {
            type: "renameFolder",
            folderId: folder.id,
            name: previous,
          },
        ],
      };
    }

    case "moveFolder": {
      const folders = foldersOf(moka);
      const folder = folderById(moka, command.folderId);
      if (!folder)
        throw new CommandError(
          "FOLDER_NOT_FOUND",
          i18n.t("errors:command.folderNotFound"),
        );
      const parentId = folderOf(moka, command.parentId);
      if (parentId === folder.id)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.folderIntoItself"),
        );
      if (descendantFolderIds(moka, folder.id).includes(parentId ?? ""))
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.folderIntoDescendant"),
        );
      const previousParent = folder.parentId ?? null;
      const previousIndex = folderSiblingIndex(moka, folder.id);
      const without = folders.filter((item) => item.id !== folder.id);
      const siblings = without.filter(
        (item) => (item.parentId ?? null) === parentId,
      );
      const moved: CanvasFolder = {
        ...folder,
        parentId: parentId ?? undefined,
      };
      const next = spliceAmong(without, siblings, command.index, moved);
      const candidate = withFolders(moka, next);
      checkFolderDepth(candidate, folder.id);
      return {
        next: candidate,
        inverse: [
          {
            type: "moveFolder",
            folderId: folder.id,
            parentId: previousParent,
            index: previousIndex,
          },
        ],
      };
    }

    case "removeFolder": {
      const folders = foldersOf(moka);
      const position = folders.findIndex(
        (item) => item.id === command.folderId,
      );
      if (position < 0)
        throw new CommandError(
          "FOLDER_NOT_FOUND",
          i18n.t("errors:command.folderNotFound"),
        );
      const removed = folders[position];
      const parentId = removed.parentId ?? null;
      const previousIndex = folderSiblingIndex(moka, removed.id);
      // What the folder held is not held by nothing: its folders and its
      // canvases go up into the folder that held it, which is what makes
      // tidying the tree something a reader can do without risking a board.
      const heldFolders = childFolders(moka, removed.id).map(
        (folder, index) => ({ folder, index }),
      );
      const heldCanvases = folderCanvases(moka, removed.id).map(
        (canvas, index) => ({ canvas, index }),
      );
      const heldCanvasIds = new Set(
        heldCanvases.map(({ canvas }) => canvas.id),
      );
      // Each folder it held takes its place in the list, in the order they were
      // read, so what a drawer held stays where the drawer was rather than going
      // to the end of the shelf it was poured into.
      const nextFolders = folders.flatMap((item) =>
        item.id === removed.id
          ? heldFolders.map(({ folder }) => ({
              ...folder,
              parentId: parentId ?? undefined,
            }))
          : [item],
      );
      const nextCanvases = moka.canvas.map((canvas) =>
        heldCanvasIds.has(canvas.id)
          ? { ...canvas, folderId: parentId ?? undefined }
          : canvas,
      );
      const inverse: DocumentCommand[] = [
        { type: "addFolder", folder: removed, index: previousIndex },
      ];
      for (const { folder, index } of heldFolders) {
        inverse.push({
          type: "moveFolder",
          folderId: folder.id,
          parentId: removed.id,
          index,
        });
      }
      for (const { canvas, index } of heldCanvases) {
        inverse.push({
          type: "moveCanvas",
          canvasId: canvas.id,
          folderId: removed.id,
          index,
        });
      }
      return {
        next: { ...withFolders(moka, nextFolders), canvas: nextCanvases },
        inverse,
      };
    }

    case "moveCanvas": {
      const canvas = canvasOf(moka, command.canvasId);
      const folderId = folderOf(moka, command.folderId);
      const previousFolder = canvasFolderOf(canvas);
      const previousIndex = canvasSiblingIndex(moka, canvas.id);
      const without = moka.canvas.filter((c) => c.id !== canvas.id);
      const peers = without.filter((c) => (c.folderId ?? null) === folderId);
      const moved: CanvasDocument = {
        ...canvas,
        folderId: folderId ?? undefined,
      };
      return {
        next: {
          ...moka,
          canvas: spliceAmong(without, peers, command.index, moved),
        },
        inverse: [
          {
            type: "moveCanvas",
            canvasId: canvas.id,
            folderId: previousFolder,
            index: previousIndex,
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // The cutting room
    // -----------------------------------------------------------------------

    case "addTimeline": {
      const timelines = moka.timelines ?? [];
      if (timelines.length + 1 > MAX_TIMELINES_PER_PROJECT)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.timelineLimitReached"),
        );
      if (timelines.some((t) => t.id === command.timeline.id))
        throw new CommandError(
          "CONFLICT",
          i18n.t("errors:command.timelineIdExists"),
        );
      checkTimelineName(command.timeline.name);
      if (command.timeline.schemaVersion > TIMELINE_SCHEMA_VERSION)
        throw new CommandError(
          "MOKA_VERSION_UNSUPPORTED",
          i18n.t("errors:command.timelineSchemaNewer"),
        );
      const index = Math.min(
        Math.max(command.index ?? timelines.length, 0),
        timelines.length,
      );
      const list = [...timelines];
      list.splice(index, 0, command.timeline);
      return {
        next: withTimelines(moka, list),
        inverse: [{ type: "removeTimeline", timelineId: command.timeline.id }],
      };
    }

    case "removeTimeline": {
      const timelines = moka.timelines ?? [];
      const index = timelines.findIndex((t) => t.id === command.timelineId);
      if (index < 0)
        throw new CommandError(
          "TIMELINE_NOT_FOUND",
          i18n.t("errors:command.timelineNotFound"),
        );
      const removed = timelines[index];
      const list = timelines.filter((t) => t.id !== command.timelineId);
      return {
        next: withTimelines(moka, list),
        // Put back whole, at the place it was read: a timeline is a document
        // in its own right, so what it held comes back with it.
        inverse: [{ type: "addTimeline", timeline: removed, index }],
      };
    }

    case "renameTimeline": {
      const timeline = timelineOf(moka, command.timelineId);
      checkTimelineName(command.name);
      const previous = timeline.name;
      return {
        next: replaceTimeline(moka, { ...timeline, name: command.name }),
        inverse: [
          {
            type: "renameTimeline",
            timelineId: command.timelineId,
            name: previous,
          },
        ],
      };
    }

    case "updateTimelineSettings": {
      const timeline = timelineOf(moka, command.timelineId);
      validateTimelineSettings(command.settings);
      const previous: Partial<TimelineSettings> = {};
      for (const key of ["fps", "width", "height", "background"] as const) {
        if (command.settings[key] !== undefined) {
          (previous as Record<string, unknown>)[key] = timeline.settings[key];
        }
      }
      const settings: TimelineSettings = {
        ...timeline.settings,
        ...command.settings,
      };
      // The whole timeline is re-validated under the new frame: nothing stored
      // depends on the frame yet, but a document that says an impossible thing
      // under its own settings is refused here rather than on the exporter's
      // doorstep.
      return {
        next: replaceTimeline(moka, { ...timeline, settings }),
        inverse: [
          {
            type: "updateTimelineSettings",
            timelineId: command.timelineId,
            settings: previous,
          },
        ],
      };
    }

    case "addTrack": {
      const timeline = timelineOf(moka, command.timelineId);
      if (timeline.tracks.length + 1 > MAX_TRACKS_PER_TIMELINE)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.trackLimitReached"),
        );
      if (timeline.tracks.some((t) => t.id === command.track.id))
        throw new CommandError(
          "CONFLICT",
          i18n.t("errors:command.trackIdExists"),
        );
      if (
        command.track.name.length === 0 ||
        command.track.name.length > TIMELINE_NAME_MAX
      )
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.trackNameInvalid"),
        );
      const index = Math.min(
        Math.max(command.index ?? timeline.tracks.length, 0),
        timeline.tracks.length,
      );
      const tracks = [...timeline.tracks];
      tracks.splice(index, 0, command.track);
      return {
        next: replaceTimeline(moka, { ...timeline, tracks }),
        inverse: [
          {
            type: "removeTrack",
            timelineId: command.timelineId,
            trackId: command.track.id,
          },
        ],
      };
    }

    case "removeTrack": {
      const timeline = timelineOf(moka, command.timelineId);
      const index = timeline.tracks.findIndex((t) => t.id === command.trackId);
      if (index < 0)
        throw new CommandError(
          "TRACK_NOT_FOUND",
          i18n.t("errors:command.trackNotFound"),
        );
      // A track holding clips is not taken out: the clips are work, and a
      // caller that wants the row gone moves them first.
      if (timeline.clips.some((clip) => clip.trackId === command.trackId))
        throw new CommandError(
          "TRACK_NOT_EMPTY",
          i18n.t("errors:command.trackNotEmpty"),
        );
      const removed = timeline.tracks[index];
      const tracks = timeline.tracks.filter((t) => t.id !== command.trackId);
      return {
        next: replaceTimeline(moka, { ...timeline, tracks }),
        inverse: [
          {
            type: "addTrack",
            timelineId: command.timelineId,
            track: removed,
            index,
          },
        ],
      };
    }

    case "updateTrack": {
      const timeline = timelineOf(moka, command.timelineId);
      const track = timeline.tracks.find((t) => t.id === command.trackId);
      if (!track)
        throw new CommandError(
          "TRACK_NOT_FOUND",
          i18n.t("errors:command.trackNotFound"),
        );
      if (
        command.patch.name !== undefined &&
        (command.patch.name.length === 0 ||
          command.patch.name.length > TIMELINE_NAME_MAX)
      )
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.trackNameInvalid"),
        );
      const previous: Partial<
        Pick<TimelineTrack, "name" | "muted" | "hidden" | "locked">
      > = {};
      if (command.patch.name !== undefined) previous.name = track.name;
      if (command.patch.muted !== undefined) previous.muted = track.muted;
      if (command.patch.hidden !== undefined) previous.hidden = track.hidden;
      if (command.patch.locked !== undefined) previous.locked = track.locked;
      const tracks = timeline.tracks.map((t) =>
        t.id === track.id ? { ...t, ...command.patch } : t,
      );
      return {
        next: replaceTimeline(moka, { ...timeline, tracks }),
        inverse: [
          {
            type: "updateTrack",
            timelineId: command.timelineId,
            trackId: track.id,
            patch: previous,
          },
        ],
      };
    }

    case "addClips": {
      const timeline = timelineOf(moka, command.timelineId);
      if (command.clips.length === 0)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.nothingToAdd"),
        );
      if (command.clips.length > MAX_CLIPS_PER_COMMAND)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.oneStepLandsAtMost", {
            count: MAX_CLIPS_PER_COMMAND,
          }),
        );
      if (timeline.clips.length + command.clips.length > MAX_CLIPS_PER_TIMELINE)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.clipLimitReached"),
        );
      const known = new Set(timeline.clips.map((clip) => clip.id));
      for (const clip of command.clips) {
        if (known.has(clip.id))
          throw new CommandError(
            "CONFLICT",
            i18n.t("errors:command.clipIdExists"),
          );
        known.add(clip.id);
        checkClip(moka, timeline, clip);
      }
      const seams = command.seams ?? [];
      // Restored seams are read against the clips as this command leaves
      // them: a seam's leader may be a clip already on the timeline or one
      // this batch is landing, and its geometry must already hold — this
      // path restores a pull-back, it does not make one (R6).
      const world: TimelineDocument = {
        ...timeline,
        clips: [...timeline.clips, ...command.clips],
      };
      const seamIds = new Set(timeline.transitions.map((t) => t.id));
      const seamLeaders = new Set(
        timeline.transitions.map((t) => t.afterClipId),
      );
      for (const seam of seams) {
        if (seamIds.has(seam.id))
          throw new CommandError(
            "CONFLICT",
            i18n.t("errors:command.transitionIdExists"),
          );
        seamIds.add(seam.id);
        if (seamLeaders.has(seam.afterClipId))
          throw new CommandError(
            "CONFLICT",
            i18n.t("errors:command.seamTaken"),
          );
        seamLeaders.add(seam.afterClipId);
        checkTransitionRestoration(world, seam);
      }
      checkNoOverlap(timeline, command.clips, { seams });
      const clips = [...timeline.clips, ...command.clips];
      return {
        next: replaceTimeline(moka, {
          ...timeline,
          clips,
          transitions: [...timeline.transitions, ...seams],
        }),
        // No transition can point at a clip that did not exist, so there is
        // nothing here to restore beside the clips and seams themselves.
        inverse: [
          {
            type: "removeClips",
            timelineId: command.timelineId,
            clipIds: command.clips.map((clip) => clip.id),
          },
        ],
      };
    }

    case "removeClips": {
      const timeline = timelineOf(moka, command.timelineId);
      const removing = new Set(command.clipIds);
      const removed = timeline.clips.filter((clip) => removing.has(clip.id));
      if (removed.length !== removing.size)
        throw new CommandError(
          "CLIP_NOT_FOUND",
          i18n.t("errors:command.someClipsNotFound"),
        );
      // Each seam transition goes with its seam, and both seams a removed
      // clip touched — the one ahead of it and the one behind it — go.
      const removedTransitions = transitionsOfSeams(timeline, command.clipIds);
      const clips = timeline.clips.filter((clip) => !removing.has(clip.id));
      const transitionIds = new Set(
        removedTransitions.map((transition) => transition.id),
      );
      const transitions = timeline.transitions.filter(
        (transition) => !transitionIds.has(transition.id),
      );
      return {
        next: replaceTimeline(moka, { ...timeline, clips, transitions }),
        inverse: [
          // The clips and their seams come back in one command, in the
          // geometry they were stored in. Restoring the clips alone would
          // put the follower in the bare overlap the seam is made of, and
          // the first step of a two-step restore would be refused there.
          {
            type: "addClips",
            timelineId: command.timelineId,
            clips: removed,
            ...(removedTransitions.length > 0
              ? { seams: removedTransitions }
              : {}),
          },
        ],
      };
    }

    case "updateClips": {
      const timeline = timelineOf(moka, command.timelineId);
      if (command.patches.length === 0)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.nothingToUpdate"),
        );
      if (command.patches.length > MAX_CLIPS_PER_COMMAND)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.oneStepTouchesAtMost", {
            count: MAX_CLIPS_PER_COMMAND,
          }),
        );
      const byId = new Map(timeline.clips.map((clip) => [clip.id, clip]));
      const updated = new Map<string, TimelineClip>();
      const inverses: DocumentCommand[] = [];
      for (const { clipId, patch } of command.patches) {
        const clip = byId.get(clipId);
        if (!clip)
          throw new CommandError(
            "CLIP_NOT_FOUND",
            i18n.t("errors:command.clipNotFound"),
          );
        if (updated.has(clipId))
          throw new CommandError(
            "CONFLICT",
            i18n.t("errors:command.clipPatchedTwice"),
          );
        const next = checkClip(moka, timeline, mergeClipPatch(clip, patch));
        updated.set(clipId, next);
        // The inverse patch carries back what this one moved, and nothing
        // else — undoing a volume change does not touch the text the same
        // step edited, and a field this patch brought in goes with a null.
        inverses.push({
          type: "updateClips",
          timelineId: command.timelineId,
          patches: [{ clipId, patch: invertClipPatch(clip, patch) }],
        });
      }
      const clips = timeline.clips.map((clip) => updated.get(clip.id) ?? clip);
      // The whole timeline as it would be, so a clip stretched onto a
      // neighbour is CLIP_OVERLAP and one that tears a seam is
      // TRANSITION_SEAM — the same re-check the move ends on (R5, R7).
      checkTimeline(moka, { ...timeline, clips });
      return {
        next: replaceTimeline(moka, { ...timeline, clips }),
        inverse: inverses.reverse(),
      };
    }

    case "moveClips": {
      const timeline = timelineOf(moka, command.timelineId);
      if (command.moves.length === 0)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.nothingToMove"),
        );
      if (command.moves.length > MAX_CLIPS_PER_COMMAND)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.oneStepMovesAtMost", {
            count: MAX_CLIPS_PER_COMMAND,
          }),
        );
      const byId = new Map(timeline.clips.map((clip) => [clip.id, clip]));
      // Last one wins for a clip moved twice in one command, and the undo
      // remembers where the clip started.
      const moved = new Map<string, TimelineClip>();
      const positions: Record<string, { startMs: number; trackId: string }> =
        {};
      for (const { clipId, startMs, trackId } of command.moves) {
        const clip = byId.get(clipId);
        if (!clip)
          throw new CommandError(
            "CLIP_NOT_FOUND",
            i18n.t("errors:command.clipNotFound"),
          );
        const targetTrackId = trackId ?? clip.trackId;
        const target = timeline.tracks.find((t) => t.id === targetTrackId);
        if (!target)
          throw new CommandError(
            "TRACK_NOT_FOUND",
            i18n.t("errors:command.clipTrackNotFound"),
          );
        if (!trackAccepts(target, clip.kind))
          throw new CommandError(
            "VALIDATION_FAILED",
            i18n.t("errors:command.clipOnWrongTrack", {
              kind: clip.kind,
              trackKind: target.kind,
            }),
          );
        if (!Number.isInteger(startMs) || startMs < 0)
          throw new CommandError(
            "VALIDATION_FAILED",
            i18n.t("errors:command.clipStartNotWholeMs"),
          );
        if (!positions[clipId])
          positions[clipId] = { startMs: clip.startMs, trackId: clip.trackId };
        moved.set(clipId, { ...clip, startMs, trackId: targetTrackId });
      }
      const clips = timeline.clips.map((clip) => moved.get(clip.id) ?? clip);
      // The whole timeline as it would be: a move onto a held place is
      // CLIP_OVERLAP, and one that leaves a transition's clips no longer
      // making its seam is TRANSITION_SEAM (R5, R7). Moving both ends of a
      // seam by the same shift moves the seam along with them.
      checkTimeline(moka, { ...timeline, clips });
      return {
        next: replaceTimeline(moka, { ...timeline, clips }),
        inverse: [
          {
            type: "moveClips",
            timelineId: command.timelineId,
            moves: Object.entries(positions).map(([clipId, held]) => {
              const move: {
                clipId: string;
                startMs: number;
                trackId?: TrackId;
              } = { clipId, startMs: held.startMs };
              if (moved.get(clipId)!.trackId !== held.trackId)
                move.trackId = held.trackId;
              return move;
            }),
          },
        ],
      };
    }

    case "addTransitions": {
      const timeline = timelineOf(moka, command.timelineId);
      if (command.transitions.length === 0)
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.nothingToAdd"),
        );
      if (
        timeline.transitions.length + command.transitions.length >
        MAX_TRANSITIONS_PER_TIMELINE
      )
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.transitionLimitReached"),
        );
      const known = new Set(timeline.transitions.map((t) => t.id));
      const seamLeaders = new Set(
        timeline.transitions.map((t) => t.afterClipId),
      );
      // The batch reads the timeline as the command entered it: a chain
      // being reassembled has every follower still butted until this command
      // pulls them back, one after the other, as it installs the records.
      for (const transition of command.transitions) {
        if (known.has(transition.id))
          throw new CommandError(
            "CONFLICT",
            i18n.t("errors:command.transitionIdExists"),
          );
        known.add(transition.id);
        if (seamLeaders.has(transition.afterClipId))
          throw new CommandError(
            "CONFLICT",
            i18n.t("errors:command.seamTaken"),
          );
        seamLeaders.add(transition.afterClipId);
        checkTransitionLanding(timeline, transition);
      }
      // Install the records and pull each follower back as the timeline
      // stands at that point, so each seam of a chain is measured against
      // the geometry the seams before it left behind.
      let pulled: TimelineDocument = timeline;
      for (const transition of command.transitions) {
        const leader = pulled.clips.find(
          (clip) => clip.id === transition.afterClipId,
        )!;
        const follower = followerOf(pulled, leader)!;
        const startMs =
          leader.startMs + leader.durationMs - transition.durationMs;
        pulled = {
          ...pulled,
          clips: pulled.clips.map((clip) =>
            clip.id === follower.id ? { ...clip, startMs } : clip,
          ),
        };
      }
      const next: TimelineDocument = {
        ...pulled,
        transitions: [...timeline.transitions, ...command.transitions],
      };
      checkTimeline(moka, next);
      return {
        next: replaceTimeline(moka, next),
        inverse: [
          {
            type: "removeTransitions",
            timelineId: command.timelineId,
            transitionIds: command.transitions.map((t) => t.id),
          },
        ],
      };
    }

    case "removeTransitions": {
      const timeline = timelineOf(moka, command.timelineId);
      const byId = new Map(timeline.transitions.map((t) => [t.id, t]));
      const removing = new Set(command.transitionIds);
      if (removing.size !== command.transitionIds.length)
        throw new CommandError(
          "CONFLICT",
          i18n.t("errors:command.transitionNamedTwice"),
        );
      // Release each follower back against its leader, one seam at a time in
      // the order the ids are given: a chain comes apart left to right,
      // because taking a seam out right to left would move its follower into
      // one that is still pulled back.
      let working = timeline;
      for (const transitionId of command.transitionIds) {
        const transition = byId.get(transitionId);
        if (!transition)
          throw new CommandError(
            "TRANSITION_NOT_FOUND",
            i18n.t("errors:command.someTransitionsNotFound"),
          );
        const leader = working.clips.find(
          (clip) => clip.id === transition.afterClipId,
        );
        const follower = leader ? followerOf(working, leader) : undefined;
        if (!leader || !follower)
          throw new CommandError(
            "TRANSITION_NOT_FOUND",
            i18n.t("errors:command.seamMissing"),
          );
        const startMs = leader.startMs + leader.durationMs;
        working = {
          ...working,
          clips: working.clips.map((clip) =>
            clip.id === follower.id ? { ...clip, startMs } : clip,
          ),
        };
      }
      const removed = command.transitionIds.map((id) => byId.get(id)!);
      const next: TimelineDocument = {
        ...working,
        transitions: working.transitions.filter(
          (transition) => !removing.has(transition.id),
        ),
      };
      // What the releases leave behind has to be a state the document may
      // hold: a follower running into the clip behind it is CLIP_OVERLAP,
      // and a seam torn out from under the seam behind it is
      // TRANSITION_SEAM. Seams this same batch released are no longer on the
      // timeline, so they are not among what this reads (R4, R7).
      checkTimeline(moka, next);
      return {
        next: replaceTimeline(moka, next),
        // Same order in, same order out: the pull-backs replay left to right.
        inverse: [
          {
            type: "addTransitions",
            timelineId: command.timelineId,
            transitions: removed,
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // The story room
    // -----------------------------------------------------------------------

    case "addStory": {
      const stories = moka.stories ?? [];
      if (stories.length + 1 > MAX_STORIES_PER_PROJECT)
        throw new CommandError(
          "STORY_LIMIT_REACHED",
          i18n.t("errors:command.storyLimitReached"),
        );
      if (stories.some((held) => held.id === command.story.id))
        throw new CommandError(
          "STORY_ID_EXISTS",
          i18n.t("errors:command.storyIdExists"),
        );
      checkStory(command.story);
      const index = Math.min(
        Math.max(command.index ?? stories.length, 0),
        stories.length,
      );
      const list = [...stories];
      list.splice(index, 0, command.story);
      return {
        next: withStories(moka, list),
        inverse: [{ type: "removeStory", storyId: command.story.id }],
      };
    }

    case "removeStory": {
      const stories = moka.stories ?? [];
      const index = stories.findIndex((held) => held.id === command.storyId);
      if (index < 0)
        throw new CommandError(
          "STORY_NOT_FOUND",
          i18n.t("errors:command.storyNotFound"),
        );
      const removed = stories[index];
      return {
        next: withStories(
          moka,
          stories.filter((held) => held.id !== command.storyId),
        ),
        // Put back whole, at the place it was read: a story is a document in
        // its own right, so everything settled in it comes back with it.
        inverse: [{ type: "addStory", story: removed, index }],
      };
    }

    case "renameStory": {
      const story = storyOf(moka, command.storyId);
      checkStoryName(command.name);
      const previous = story.name;
      return {
        next: replaceStory(moka, { ...story, name: command.name }),
        inverse: [
          { type: "renameStory", storyId: command.storyId, name: previous },
        ],
      };
    }

    case "updateStoryBrief": {
      const story = storyOf(moka, command.storyId);
      const brief = { ...story.brief };
      const previous: typeof command.patch = {};
      // A key that is present moves, and a key carrying null goes: the two
      // rules are one rule, which is what makes the inverse of a patch exact.
      for (const key of Object.keys(
        command.patch,
      ) as (keyof typeof command.patch)[]) {
        const value = command.patch[key];
        (previous as Record<string, unknown>)[key] = story.brief[key] ?? null;
        if (value === null || value === undefined)
          delete (brief as Record<string, unknown>)[key];
        else (brief as Record<string, unknown>)[key] = value;
      }
      checkStoryBrief(brief);
      return {
        next: replaceStory(moka, { ...story, brief }),
        inverse: [
          {
            type: "updateStoryBrief",
            storyId: command.storyId,
            patch: previous,
          },
        ],
      };
    }

    case "updateStoryGranularity": {
      const story = storyOf(moka, command.storyId);
      if (!STORY_SHOT_GRANULARITIES.includes(command.shotGranularity))
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.storyGranularityUnknown"),
        );
      const previous = story.shotGranularity;
      return {
        next: replaceStory(moka, {
          ...story,
          shotGranularity: command.shotGranularity,
        }),
        inverse: [
          {
            type: "updateStoryGranularity",
            storyId: command.storyId,
            shotGranularity: previous,
          },
        ],
      };
    }

    case "updateStoryReferenceLimit": {
      const story = storyOf(moka, command.storyId);
      if (
        !Number.isInteger(command.maxReferenceImages) ||
        command.maxReferenceImages < 0 ||
        command.maxReferenceImages > REFERENCE_IMAGES_MAX
      )
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.storyReferenceLimitInvalid"),
        );
      const previous = story.maxReferenceImages;
      return {
        next: replaceStory(moka, {
          ...story,
          maxReferenceImages: command.maxReferenceImages,
        }),
        inverse: [
          {
            type: "updateStoryReferenceLimit",
            storyId: command.storyId,
            maxReferenceImages: previous,
          },
        ],
      };
    }

    case "confirmStoryStep": {
      const story = storyOf(moka, command.storyId);
      if (!STORY_STEPS.includes(command.step))
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.storyStepUnknown"),
        );
      const held = new Set(story.confirmedSteps);
      if (command.confirmed) held.add(command.step);
      else held.delete(command.step);
      // Kept in telling order rather than in the order the presses came, so a
      // document that was confirmed step by step reads as the telling does.
      const confirmedSteps = STORY_STEPS.filter((step) => held.has(step));
      return {
        next: replaceStory(moka, { ...story, confirmedSteps }),
        inverse: [
          {
            type: "confirmStoryStep",
            storyId: command.storyId,
            step: command.step,
            confirmed: !command.confirmed,
          },
        ],
      };
    }

    case "setStoryChapters": {
      const story = storyOf(moka, command.storyId);
      if (command.chapters.length > MAX_CHAPTERS_PER_STORY)
        throw new CommandError(
          "STORY_CHAPTER_LIMIT",
          i18n.t("errors:command.storyChapterLimit"),
        );
      const held = new Map(
        story.chapters.map((chapter) => [chapter.id, chapter]),
      );
      // A chapter that stands where it stood keeps its board: re-writing an
      // outline is not a reason to throw away what was shot from it.
      const chapters = command.chapters.map((chapter) => {
        const before = held.get(chapter.id);
        return { ...chapter, acts: before ? before.acts : [] };
      });
      const next: StoryDocument = { ...story, chapters };
      checkStory(next);
      return {
        next: replaceStory(moka, next),
        inverse: [
          {
            type: "setStoryChapters",
            storyId: command.storyId,
            chapters: story.chapters,
          },
        ],
      };
    }

    case "setStoryElements": {
      const story = storyOf(moka, command.storyId);
      if (command.elements.length > MAX_ELEMENTS_PER_STORY)
        throw new CommandError(
          "STORY_ELEMENT_LIMIT",
          i18n.t("errors:command.storyElementLimit"),
        );
      const held = new Map(
        story.elements.map((element) => [element.id, element]),
      );
      // The drawings and the voice stay with the element they were made for;
      // what a new reading brings is its words.
      const elements: StoryElement[] = command.elements.map((element) => {
        const before = held.get(element.id);
        if (!before) return element;
        return {
          ...element,
          main: before.main,
          ...(before.turnaround !== undefined
            ? { turnaround: before.turnaround }
            : {}),
          // The voice is one of the reader's answers about a character, so a
          // re-listing that says nothing of it leaves the voice standing.
          ...(element.voice === undefined && before.voice !== undefined
            ? { voice: before.voice }
            : {}),
        };
      });
      const next: StoryDocument = { ...story, elements };
      checkStory(next);
      return {
        next: replaceStory(moka, next),
        inverse: [
          {
            type: "setStoryElements",
            storyId: command.storyId,
            elements: story.elements,
          },
        ],
      };
    }

    case "updateStoryElement": {
      const story = storyOf(moka, command.storyId);
      const element = story.elements.find(
        (held) => held.id === command.elementId,
      );
      if (!element)
        throw new CommandError(
          "STORY_TARGET_INVALID",
          i18n.t("errors:command.storyElementNotFound"),
        );
      if (command.patch.name !== undefined) {
        const name = command.patch.name.trim();
        if (name.length === 0 || name.length > STORY_NAME_MAX)
          throw new CommandError(
            "STORY_NAME_INVALID",
            i18n.t("errors:command.storyNameEmpty"),
          );
      }
      if (command.patch.kind !== undefined) {
        if (!STORY_ELEMENT_KINDS.includes(command.patch.kind))
          throw new CommandError(
            "VALIDATION_FAILED",
            i18n.t("errors:command.storyElementKindUnknown"),
          );
      }
      if (command.patch.description !== undefined) {
        if (command.patch.description.length > STORY_IDEA_MAX)
          throw new CommandError(
            "VALIDATION_FAILED",
            i18n.t("errors:command.storyDescriptionTooLong"),
          );
      }
      if (command.patch.chapterIds !== undefined) {
        const known = new Set(story.chapters.map((chapter) => chapter.id));
        if (command.patch.chapterIds.some((id) => !known.has(id)))
          throw new CommandError(
            "STORY_TARGET_INVALID",
            i18n.t("errors:command.storyChapterNotFound"),
          );
      }
      if (command.patch.voice !== undefined && command.patch.voice !== null)
        checkVoiceProfile(command.patch.voice);
      const previous: typeof command.patch = {};
      for (const key of Object.keys(
        command.patch,
      ) as (keyof typeof command.patch)[]) {
        // An optional field the element does not hold is written back as an
        // explicit clearing, so that undoing the first voice left on a
        // character takes it off again rather than leaving it standing.
        (previous as Record<string, unknown>)[key] = element[key] ?? null;
      }
      const next: StoryDocument = {
        ...story,
        elements: story.elements.map((held) => {
          if (held.id !== command.elementId) return held;
          // Field by field rather than a spread, because a voice may be taken
          // away rather than set: a voice taken away is taken off the element
          // rather than left holding nothing, since the two say different
          // things about a character.
          const merged: StoryElement = { ...held };
          if (command.patch.name !== undefined)
            merged.name = command.patch.name;
          if (command.patch.kind !== undefined)
            merged.kind = command.patch.kind;
          if (command.patch.description !== undefined)
            merged.description = command.patch.description;
          if (command.patch.chapterIds !== undefined)
            merged.chapterIds = command.patch.chapterIds;
          if (command.patch.voice === null) delete merged.voice;
          else if (command.patch.voice !== undefined)
            merged.voice = command.patch.voice;
          return merged;
        }),
      };
      return {
        next: replaceStory(moka, next),
        inverse: [
          {
            type: "updateStoryElement",
            storyId: command.storyId,
            elementId: command.elementId,
            patch: previous,
          },
        ],
      };
    }

    case "updateStoryNarrator": {
      const story = storyOf(moka, command.storyId);
      if (command.narrator !== null) checkVoiceProfile(command.narrator);
      const previous = story.narrator ?? null;
      const next: StoryDocument = { ...story };
      // A telling left without a voice of its own leaves the field off rather
      // than holding nothing: what it says then is that nobody has said.
      if (command.narrator === null) delete next.narrator;
      else next.narrator = command.narrator;
      return {
        next: replaceStory(moka, next),
        inverse: [
          {
            type: "updateStoryNarrator",
            storyId: command.storyId,
            narrator: previous,
          },
        ],
      };
    }

    case "setStoryActs": {
      const story = storyOf(moka, command.storyId);
      const chapter = chapterOf(story, command.chapterId);
      if (command.acts.length > MAX_ACTS_PER_CHAPTER)
        throw new CommandError(
          "STORY_ACT_LIMIT",
          i18n.t("errors:command.storyActLimit"),
        );
      const heldActs = new Map(chapter.acts.map((act) => [act.id, act]));
      // A reference to an element that is no longer in the story is kept as
      // it was written: the room draws it greyed out and says so, which is
      // more use than a board that quietly lost the character it names.
      const acts: StoryAct[] = command.acts.map((act) => {
        if (act.keyframes.length > MAX_KEYFRAMES_PER_ACT)
          throw new CommandError(
            "STORY_KEYFRAME_LIMIT",
            i18n.t("errors:command.storyKeyframeLimit"),
          );
        const cleaned: StoryAct = {
          ...act,
          characterIds: [...new Set(act.characterIds)],
          propIds: [...new Set(act.propIds)],
        };
        const before = heldActs.get(act.id);
        if (!before) return cleaned;
        const heldFrames = new Map(
          before.keyframes.map((keyframe) => [keyframe.id, keyframe]),
        );
        return {
          ...cleaned,
          video: before.video,
          keyframes: cleaned.keyframes.map((keyframe) => {
            const frame = heldFrames.get(keyframe.id);
            if (!frame) return keyframe;
            return { ...keyframe, art: frame.art, video: frame.video };
          }),
        };
      });
      const chapters = story.chapters.map((held) =>
        held.id === command.chapterId ? { ...held, acts } : held,
      );
      return {
        next: replaceStory(moka, { ...story, chapters }),
        inverse: [
          {
            type: "setStoryActs",
            storyId: command.storyId,
            chapterId: command.chapterId,
            acts: chapter.acts,
          },
        ],
      };
    }

    case "updateStoryAct": {
      const story = storyOf(moka, command.storyId);
      const chapter = chapterOf(story, command.chapterId);
      const act = actOf(chapter, command.actId);
      if (command.patch.sound !== undefined) checkActSound(command.patch.sound);
      const previous: typeof command.patch = {};
      for (const key of Object.keys(
        command.patch,
      ) as (keyof typeof command.patch)[]) {
        (previous as Record<string, unknown>)[key] = act[key] ?? null;
      }
      const chapters = story.chapters.map((held) =>
        held.id === command.chapterId
          ? {
              ...held,
              acts: held.acts.map((heldAct) => {
                if (heldAct.id !== command.actId) return heldAct;
                // Field by field rather than a spread, because one of these
                // fields may be taken away rather than set: an act keeps a
                // scene only while the patch still names one.
                const next: StoryAct = { ...heldAct };
                if (command.patch.title !== undefined)
                  next.title = command.patch.title;
                if (command.patch.summary !== undefined)
                  next.summary = command.patch.summary;
                if (command.patch.characterIds !== undefined)
                  next.characterIds = command.patch.characterIds;
                if (command.patch.sceneId === null) delete next.sceneId;
                else if (command.patch.sceneId !== undefined)
                  next.sceneId = command.patch.sceneId;
                if (command.patch.propIds !== undefined)
                  next.propIds = command.patch.propIds;
                if (command.patch.sound !== undefined)
                  next.sound = command.patch.sound;
                return next;
              }),
            }
          : held,
      );
      return {
        next: replaceStory(moka, { ...story, chapters }),
        inverse: [
          {
            type: "updateStoryAct",
            storyId: command.storyId,
            chapterId: command.chapterId,
            actId: command.actId,
            patch: previous,
          },
        ],
      };
    }

    case "updateStoryKeyframe": {
      const story = storyOf(moka, command.storyId);
      const chapter = chapterOf(story, command.chapterId);
      const act = actOf(chapter, command.actId);
      const keyframe = keyframeOf(act, command.keyframeId);
      if (command.patch.durationMs !== undefined) {
        if (!isKeyframeMs(command.patch.durationMs))
          throw new CommandError(
            "VALIDATION_FAILED",
            i18n.t("errors:command.storyShotDurationOutOfRange"),
          );
      }
      if (command.patch.dialogue !== undefined)
        checkDialogue(command.patch.dialogue);
      const previous: typeof command.patch = {};
      for (const key of Object.keys(
        command.patch,
      ) as (keyof typeof command.patch)[]) {
        (previous as Record<string, unknown>)[key] = keyframe[key];
      }
      const chapters = story.chapters.map((held) =>
        held.id === command.chapterId
          ? {
              ...held,
              acts: held.acts.map((heldAct) =>
                heldAct.id === command.actId
                  ? {
                      ...heldAct,
                      keyframes: heldAct.keyframes.map((heldFrame) =>
                        heldFrame.id === command.keyframeId
                          ? { ...heldFrame, ...command.patch }
                          : heldFrame,
                      ),
                    }
                  : heldAct,
              ),
            }
          : held,
      );
      return {
        next: replaceStory(moka, { ...story, chapters }),
        inverse: [
          {
            type: "updateStoryKeyframe",
            storyId: command.storyId,
            chapterId: command.chapterId,
            actId: command.actId,
            keyframeId: command.keyframeId,
            patch: previous,
          },
        ],
      };
    }

    case "setStorySlot": {
      const story = storyOf(moka, command.storyId);
      const previous = slotOf(story, command.target);
      const slot = checkStorySlot(command.slot);
      if (command.read !== undefined) checkVoiceRead(command.read);
      // What the entry said before this write, so that the undo of replacing
      // one reading with another brings the old words and their tone back.
      const before =
        command.target.kind === "lineVoice"
          ? storyVoiceTake(story, command.target)
          : undefined;
      const read =
        command.target.kind === "lineVoice"
          ? (command.read ?? {
              text: before?.text ?? "",
              voice: before?.voice ?? "",
            })
          : undefined;
      return {
        next: replaceStory(moka, withSlot(story, command.target, slot, read)),
        inverse: [
          {
            type: "setStorySlot",
            storyId: command.storyId,
            target: command.target,
            slot: previous,
            ...(before === undefined
              ? {}
              : { read: { text: before.text, voice: before.voice } }),
          },
        ],
      };
    }

    case "setStoryEdit": {
      const story = storyOf(moka, command.storyId);
      // Only a named timeline is checked: a null is an assembly being taken
      // away, which names nothing and so points at nothing that must exist.
      if (
        typeof command.patch.timelineId === "string" &&
        !(moka.timelines ?? []).some(
          (timeline) => timeline.id === command.patch.timelineId,
        )
      )
        throw new CommandError(
          "TIMELINE_NOT_FOUND",
          i18n.t("errors:command.timelineNotFound"),
        );
      // A digest is what the room writes down about an assembly it made: a
      // document carrying anything else is not one this pipeline wrote.
      if (
        typeof command.patch.assembledDigest === "string" &&
        !/^[0-9a-f]{8}$/.test(command.patch.assembledDigest)
      )
        throw new CommandError(
          "VALIDATION_FAILED",
          i18n.t("errors:command.storyDigestShape"),
        );
      const previous: typeof command.patch = {};
      const edit = { ...story.edit };
      for (const key of Object.keys(
        command.patch,
      ) as (keyof typeof command.patch)[]) {
        const value = command.patch[key];
        (previous as Record<string, unknown>)[key] = story.edit[key] ?? null;
        if (value === null || value === undefined)
          delete (edit as Record<string, unknown>)[key];
        else (edit as Record<string, unknown>)[key] = value;
      }
      const next: StoryDocument = { ...story, edit };
      return {
        next: replaceStory(moka, next),
        inverse: [
          { type: "setStoryEdit", storyId: command.storyId, patch: previous },
        ],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The story room. What a story is, and what a step may settle, lives in
// story.ts — the same functions the room and the job client read, so a
// command and the interface cannot disagree about what an outline is.
// ---------------------------------------------------------------------------

/**
 * The stories a project carries, or carrying the field not at all when it has
 * none — the same honest reading the timelines give an unused cutting room.
 */
function withStories(moka: MokaFile, stories: StoryDocument[]): MokaFile {
  return { ...moka, stories: stories.length > 0 ? stories : undefined };
}

function storyOf(moka: MokaFile, storyId: string): StoryDocument {
  const story = (moka.stories ?? []).find((held) => held.id === storyId);
  if (!story)
    throw new CommandError(
      "STORY_NOT_FOUND",
      i18n.t("errors:command.storyNotFound"),
    );
  return story;
}

/**
 * Puts a changed story back as it was handed over.
 *
 * The story's own `updatedAt` is the caller's to move, the way a timeline's
 * is: what a command does is put the fields it was given where they belong,
 * and one date that changed on every undo as well as every edit would say
 * less than the edits do.
 */
function replaceStory(moka: MokaFile, story: StoryDocument): MokaFile {
  return withStories(
    moka,
    (moka.stories ?? []).map((held) => (held.id === story.id ? story : held)),
  );
}

function checkStoryName(name: string) {
  if (name.length === 0)
    throw new CommandError(
      "STORY_NAME_INVALID",
      i18n.t("errors:command.storyNameEmpty"),
    );
  if (name.length > STORY_NAME_MAX)
    throw new CommandError(
      "STORY_NAME_INVALID",
      i18n.t("errors:command.storyNameTooLong"),
    );
}

function chapterOf(story: StoryDocument, chapterId: string): StoryChapter {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  if (!chapter)
    throw new CommandError(
      "STORY_TARGET_INVALID",
      i18n.t("errors:command.storyChapterNotFound"),
    );
  return chapter;
}

function actOf(chapter: StoryChapter, actId: string): StoryAct {
  const act = chapter.acts.find((held) => held.id === actId);
  if (!act)
    throw new CommandError(
      "STORY_TARGET_INVALID",
      i18n.t("errors:command.storyActNotFound"),
    );
  return act;
}

function keyframeOf(act: StoryAct, keyframeId: string): StoryKeyframe {
  const keyframe = act.keyframes.find((held) => held.id === keyframeId);
  if (!keyframe)
    throw new CommandError(
      "STORY_TARGET_INVALID",
      i18n.t("errors:command.storyKeyframeNotFound"),
    );
  return keyframe;
}

/** The slot a target names, or a refusal when the story no longer holds it. */
function slotOf(story: StoryDocument, target: StorySlotTarget): StorySlot {
  switch (target.kind) {
    case "element": {
      const element = story.elements.find(
        (held) => held.id === target.elementId,
      );
      if (!element)
        throw new CommandError(
          "STORY_TARGET_INVALID",
          i18n.t("errors:command.storyElementNotFound"),
        );
      if (target.view === "main") return element.main;
      if (!element.turnaround)
        throw new CommandError(
          "STORY_TARGET_INVALID",
          i18n.t("errors:command.storyElementNotFound"),
        );
      return element.turnaround;
    }
    case "keyframe":
      return keyframeOf(
        actOf(chapterOf(story, target.chapterId), target.actId),
        target.keyframeId,
      ).art;
    case "lineVoice": {
      const keyframe = keyframeOf(
        actOf(chapterOf(story, target.chapterId), target.actId),
        target.keyframeId,
      );
      return voiceTakeOf(keyframe, target.lineId)?.slot ?? emptyStorySlot();
    }
    case "keyframeVideo":
      return keyframeOf(
        actOf(chapterOf(story, target.chapterId), target.actId),
        target.keyframeId,
      ).video;
    case "actVideo":
      return actOf(chapterOf(story, target.chapterId), target.actId).video;
    // A slot that is not there has never been made: it is read as empty rather
    // than refused, so a take can be written into it like any other.
    case "actVoice":
      return (
        actOf(chapterOf(story, target.chapterId), target.actId).voice ??
        emptyStorySlot()
      );
    case "actMusic":
      return (
        actOf(chapterOf(story, target.chapterId), target.actId).music ??
        emptyStorySlot()
      );
  }
}

/** Puts a slot back where it came from, leaving the rest of the story alone. */
function withSlot(
  story: StoryDocument,
  target: StorySlotTarget,
  slot: StorySlot,
  read?: { text: string; voice: string },
): StoryDocument {
  const write = (chapters: StoryChapter[]): StoryDocument => ({
    ...story,
    chapters,
  });
  switch (target.kind) {
    case "element":
      return {
        ...story,
        elements: story.elements.map((element) => {
          if (element.id !== target.elementId) return element;
          return target.view === "main"
            ? { ...element, main: slot }
            : { ...element, turnaround: slot };
        }),
      };
    case "keyframe":
      return write(
        story.chapters.map((chapter) => {
          if (chapter.id !== target.chapterId) return chapter;
          return {
            ...chapter,
            acts: chapter.acts.map((act) => {
              if (act.id !== target.actId) return act;
              return {
                ...act,
                keyframes: act.keyframes.map((keyframe) =>
                  keyframe.id === target.keyframeId
                    ? { ...keyframe, art: slot }
                    : keyframe,
                ),
              };
            }),
          };
        }),
      );
    case "keyframeVideo":
      return write(
        story.chapters.map((chapter) => {
          if (chapter.id !== target.chapterId) return chapter;
          return {
            ...chapter,
            acts: chapter.acts.map((act) => {
              if (act.id !== target.actId) return act;
              return {
                ...act,
                keyframes: act.keyframes.map((keyframe) =>
                  keyframe.id === target.keyframeId
                    ? { ...keyframe, video: slot }
                    : keyframe,
                ),
              };
            }),
          };
        }),
      );
    case "actVideo":
      return write(
        story.chapters.map((chapter) => {
          if (chapter.id !== target.chapterId) return chapter;
          return {
            ...chapter,
            acts: chapter.acts.map((act) =>
              act.id === target.actId ? { ...act, video: slot } : act,
            ),
          };
        }),
      );
    case "actVoice":
      return write(
        story.chapters.map((chapter) => {
          if (chapter.id !== target.chapterId) return chapter;
          return {
            ...chapter,
            acts: chapter.acts.map((act) =>
              act.id === target.actId ? withSoundSlot(act, "voice", slot) : act,
            ),
          };
        }),
      );
    case "actMusic":
      return write(
        story.chapters.map((chapter) => {
          if (chapter.id !== target.chapterId) return chapter;
          return {
            ...chapter,
            acts: chapter.acts.map((act) =>
              act.id === target.actId ? withSoundSlot(act, "music", slot) : act,
            ),
          };
        }),
      );
    case "lineVoice":
      return write(
        story.chapters.map((chapter) => {
          if (chapter.id !== target.chapterId) return chapter;
          return {
            ...chapter,
            acts: chapter.acts.map((act) => {
              if (act.id !== target.actId) return act;
              return {
                ...act,
                keyframes: act.keyframes.map((keyframe) =>
                  keyframe.id === target.keyframeId
                    ? withVoiceTake(keyframe, target.lineId, slot, read)
                    : keyframe,
                ),
              };
            }),
          };
        }),
      );
  }
}

/**
 * One line's take kept on its shot, whole.
 *
 * A slot that has come to hold nothing takes the whole entry with it: the two
 * would say different things about a line nobody has read yet, and the undo of
 * the first reading has to put the document back the way it was — without the
 * entry, not with an empty one. What the line was read as is kept beside the
 * takes, so the card can say the words the recording holds even after the
 * line beside them was rewritten.
 */
function withVoiceTake(
  keyframe: StoryKeyframe,
  lineId: string,
  slot: StorySlot,
  read?: { text: string; voice: string },
): StoryKeyframe {
  const held = keyframe.voices ?? [];
  const before = voiceTakeOf(keyframe, lineId);
  const rest = held.filter((take) => take.lineId !== lineId);
  if (slot.takes.length === 0) {
    if (before === undefined) return keyframe;
    const without: StoryKeyframe = { ...keyframe };
    if (rest.length === 0) delete without.voices;
    else without.voices = rest;
    return without;
  }
  // The takes stand in the order their lines do on the board, so two rooms
  // holding the same reading write the same document; a take whose line has
  // left the shot is not on the board to be ordered by, and comes last.
  const order = new Map(keyframe.dialogue.map((line, at) => [line.id, at]));
  const voices = [
    ...rest,
    {
      lineId,
      text: read?.text ?? before?.text ?? "",
      voice: read?.voice ?? before?.voice ?? "",
      slot,
    },
  ].sort(
    (one, other) =>
      (order.get(one.lineId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(other.lineId) ?? Number.MAX_SAFE_INTEGER),
  );
  return { ...keyframe, voices };
}

/**
 * One of an act's two sound slots, written where it belongs.
 *
 * An empty slot is written as no slot at all: the two would say different
 * things about a place a reader has not asked about yet, and the undo of the
 * first take ever made for an act has to put the document back the way it was
 * — which is without the slot, not with an empty one.
 */
function withSoundSlot(
  act: StoryAct,
  field: "voice" | "music",
  slot: StorySlot,
): StoryAct {
  if (slot.takes.length === 0) {
    const kept: StoryAct = { ...act };
    delete kept[field];
    return kept;
  }
  return { ...act, [field]: slot };
}

/**
 * A slot a caller may file: the takes trimmed to what one place keeps, with
 * the oldest let go first, and no drawing kept twice.
 */
function checkStorySlot(slot: StorySlot): StorySlot {
  const seen = new Set<string>();
  const takes = slot.takes.filter((take) => {
    // A take is kept once, by the files it is: a drawing filed again is the
    // same drawing, and an act filmed in pieces filed again is the same pieces.
    const key = take.assetIds.join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    takes:
      takes.length > MAX_TAKES_PER_SLOT
        ? takes.slice(takes.length - MAX_TAKES_PER_SLOT)
        : takes,
  };
}

function isKeyframeMs(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_KEYFRAME_MS &&
    value <= MAX_KEYFRAME_MS
  );
}

/** A sound is written whole: the two parts it is made of, and an optional air. */
function checkActSound(sound: StoryAct["sound"]) {
  if (typeof sound.music !== "string" || typeof sound.sfx !== "string")
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storySoundInvalid"),
    );
  if (sound.ambience !== undefined && typeof sound.ambience !== "string")
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storySoundInvalid"),
    );
}

/**
 * The voice a character or a narrator is given: a model and a tone named
 * within reason, and a pace and pitch the providers all accept.
 */
function checkVoiceProfile(voice: StoryVoiceProfile) {
  if (
    voice.model.length > VOICE_MODEL_MAX ||
    voice.voice.length > VOICE_NAME_MAX ||
    (voice.instructions?.length ?? 0) > VOICE_INSTRUCTIONS_MAX
  )
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storyVoiceTooLong"),
    );
  if (
    voice.rate !== undefined &&
    (!Number.isFinite(voice.rate) ||
      voice.rate < VOICE_RATE_MIN ||
      voice.rate > VOICE_RATE_MAX)
  )
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storyVoiceRate"),
    );
  if (
    voice.pitch !== undefined &&
    (!Number.isFinite(voice.pitch) ||
      voice.pitch < VOICE_PITCH_MIN ||
      voice.pitch > VOICE_PITCH_MAX)
  )
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storyVoicePitch"),
    );
}

/**
 * What a line was read as, held to the bounds the line itself is: the words a
 * recording holds are as long as the words a shot may be written with, and the
 * tone is a name like any other.
 */
function checkVoiceRead(read: { text: string; voice: string }) {
  if (read.text.length > MAX_DIALOGUE_LINE_LENGTH)
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storyDialogueTooLong"),
    );
  if (read.voice.length > VOICE_NAME_MAX)
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storyVoiceTooLong"),
    );
}

/** What may be said in one shot: a few lines, each of them with words in it. */
function checkDialogue(lines: StoryKeyframe["dialogue"]) {
  if (lines.length > MAX_DIALOGUE_LINES_PER_KEYFRAME)
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storyDialogueTooLong"),
    );
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.text.trim().length === 0)
      throw new CommandError(
        "VALIDATION_FAILED",
        i18n.t("errors:command.storyDialogueEmpty"),
      );
    // A line is what the things kept for it are filed under, so two lines
    // sharing a name would be two lines with one take between them.
    if (line.id.trim().length === 0 || seen.has(line.id))
      throw new CommandError(
        "VALIDATION_FAILED",
        i18n.t("errors:command.storyDialogueUnnamed"),
      );
    seen.add(line.id);
    if (
      line.text.length > MAX_DIALOGUE_LINE_LENGTH ||
      line.speaker.length === 0
    )
      throw new CommandError(
        "VALIDATION_FAILED",
        i18n.t("errors:command.storyDialogueTooLong"),
      );
  }
}

/** A story's own guardrails, read before anything of it is written down. */
function checkStory(story: StoryDocument) {
  checkStoryName(story.name);
  if (story.schemaVersion > STORY_SCHEMA_VERSION)
    throw new CommandError(
      "STORY_SCHEMA_NEWER",
      i18n.t("errors:command.storySchemaNewer"),
    );
  if (story.chapters.length > MAX_CHAPTERS_PER_STORY)
    throw new CommandError(
      "STORY_CHAPTER_LIMIT",
      i18n.t("errors:command.storyChapterLimit"),
    );
  if (story.elements.length > MAX_ELEMENTS_PER_STORY)
    throw new CommandError(
      "STORY_ELEMENT_LIMIT",
      i18n.t("errors:command.storyElementLimit"),
    );
  for (const chapter of story.chapters) {
    if (chapter.acts.length > MAX_ACTS_PER_CHAPTER)
      throw new CommandError(
        "STORY_ACT_LIMIT",
        i18n.t("errors:command.storyActLimit"),
      );
    for (const act of chapter.acts) {
      if (act.keyframes.length > MAX_KEYFRAMES_PER_ACT)
        throw new CommandError(
          "STORY_KEYFRAME_LIMIT",
          i18n.t("errors:command.storyKeyframeLimit"),
        );
    }
  }
  checkStoryBrief(story.brief);
}

function checkStoryBrief(brief: StoryDocument["brief"]) {
  if (
    brief.totalDurationMs < MIN_TOTAL_DURATION_MS ||
    brief.totalDurationMs > MAX_TOTAL_DURATION_MS
  )
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storyDurationOutOfRange"),
    );
  if (!STORY_ASPECTS.includes(brief.aspect))
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("errors:command.storyAspectUnknown"),
    );
}

export function applyCommands(
  moka: MokaFile,
  commands: DocumentCommand[],
): { next: MokaFile; inverse: DocumentCommand[] } {
  let current = moka;
  const inverses: DocumentCommand[] = [];
  for (const command of commands) {
    const { next, inverse } = applyOne(current, command);
    current = next;
    inverses.unshift(...inverse);
  }
  return { next: current, inverse: inverses };
}
