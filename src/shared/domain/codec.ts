import { Double, Long, deserialize, serialize } from "bson";
import {
  CANVAS_SCHEMA_VERSION,
  MOKA_FILE_VERSION,
  MOKA_MAGIC,
  PROJECT_ASSET_CATEGORIES,
  REFERENCE_IMAGES_DEFAULT,
  REFERENCE_IMAGES_MAX,
  STORY_SCHEMA_VERSION,
  TIMELINE_SCHEMA_VERSION,
  TRANSITION_KINDS,
} from "./constants";
import type {
  ProblemCode,
  ClipFilterPreset,
  TransitionKind,
} from "./constants";
import {
  STORY_ASPECTS,
  STORY_CAMERA_ANGLES,
  STORY_CAMERA_MOVES,
  STORY_ELEMENT_KINDS,
  STORY_FILM_ROLES,
  STORY_SHOT_GRANULARITIES,
  STORY_SHOT_SIZES,
} from "./types";
import { reconcilePorts } from "./factories";
import { newId } from "./ids";
import { STORY_STEPS, type StoryStep } from "./story";
import type {
  AssistantFailure,
  AssistantMessage,
  AssistantReference,
  AssistantRole,
  AssistantSession,
  AssistantToolCall,
  CanvasDocument,
  CanvasFolder,
  ClipAdjust,
  GroupMembership,
  MokaFile,
  NodeData,
  NodeKind,
  ProjectMetadata,
  ResourceEntry,
  ResultSlot,
  StoryAct,
  StoryBrief,
  StoryChapter,
  StoryDialogueLine,
  StoryDocument,
  StoryEdit,
  StoryElement,
  StoryKeyframe,
  StorySlot,
  StoryTake,
  StoryVoiceProfile,
  StoryVoiceTake,
  TextClipStyle,
  TimelineClip,
  TimelineDocument,
  TimelineTrack,
  TimelineTransition,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
import { validateResourcePath } from "./validate";

export class MokaCodecError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MokaCodecError";
  }
}

function asDouble(value: number): Double {
  return new Double(value);
}

function asLong(value: number): Long {
  return Long.fromNumber(value);
}

function unwrapNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (value instanceof Long) return value.toNumber();
  if (value instanceof Double) return value.valueOf();
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return undefined;
}

function encodeViewport(viewport: { x: number; y: number; zoom: number }) {
  return {
    x: asDouble(viewport.x),
    y: asDouble(viewport.y),
    zoom: asDouble(viewport.zoom),
  };
}

function encodeBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return {
    x: asDouble(bounds.x),
    y: asDouble(bounds.y),
    width: asDouble(bounds.width),
    height: asDouble(bounds.height),
  };
}

function encodeResultSlot(slot: ResultSlot): Record<string, unknown> {
  const doc: Record<string, unknown> = { id: slot.id, status: slot.status };
  if (slot.assetId !== undefined) doc.assetId = slot.assetId;
  if (slot.text !== undefined) doc.text = slot.text;
  if (slot.error !== undefined) doc.error = slot.error;
  doc.isPrimary = slot.isPrimary;
  return doc;
}

function encodeNodeData(kind: string, data: NodeData): Record<string, unknown> {
  const record = data as Record<string, unknown>;
  const doc: Record<string, unknown> = {};
  const put = (key: string) => {
    if (record[key] !== undefined) doc[key] = record[key];
  };
  switch (kind) {
    case "text":
      put("content");
      put("style");
      put("assetId");
      put("generation");
      break;
    case "image":
    case "audio":
    case "video":
      put("assetId");
      put("posterAssetId");
      put("audioCategory");
      put("generation");
      break;
    case "operation":
      put("operationType");
      put("parameters");
      put("executorKey");
      break;
    case "group":
      put("color");
      put("childNodeIds");
      break;
    case "export":
      put("format");
      put("parameters");
      break;
  }
  if (record.resultSlots !== undefined) {
    doc.resultSlots = (record.resultSlots as ResultSlot[]).map(
      encodeResultSlot,
    );
  }
  if (record.resultNodeIds !== undefined)
    doc.resultNodeIds = record.resultNodeIds;
  if (record.metadata !== undefined) doc.metadata = record.metadata;
  return doc;
}

function encodeNode(node: WorkflowNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    bounds: encodeBounds(node.bounds),
    zIndex: node.zIndex,
    ports: node.ports.map((port) => ({
      id: port.id,
      direction: port.direction,
      dataTypes: [...port.dataTypes],
      required: port.required,
      cardinality: port.cardinality,
      label: port.label,
    })),
    data: encodeNodeData(node.kind, node.data),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function encodeEdge(edge: WorkflowEdge): Record<string, unknown> {
  return {
    id: edge.id,
    source: { nodeId: edge.source.nodeId, portId: edge.source.portId },
    target: { nodeId: edge.target.nodeId, portId: edge.target.portId },
    createdAt: edge.createdAt,
  };
}

function encodeGroup(group: GroupMembership): Record<string, unknown> {
  return { groupId: group.groupId, childNodeIds: [...group.childNodeIds] };
}

function encodeReference(
  reference: AssistantReference,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    nodeId: reference.nodeId,
    title: reference.title,
    kind: reference.kind,
  };
  if (reference.assetId !== undefined) doc.assetId = reference.assetId;
  return doc;
}

function encodeToolCall(call: AssistantToolCall): Record<string, unknown> {
  const doc: Record<string, unknown> = { runId: call.runId };
  if (call.nodeId !== undefined) doc.nodeId = call.nodeId;
  doc.summary = call.summary;
  return doc;
}

function encodeMessage(message: AssistantMessage): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
  };
  if (message.references !== undefined)
    doc.references = message.references.map(encodeReference);
  if (message.toolCalls !== undefined)
    doc.toolCalls = message.toolCalls.map(encodeToolCall);
  if (message.failure !== undefined)
    doc.failure = {
      code: message.failure.code,
      retryable: message.failure.retryable,
    };
  return doc;
}

function encodeSession(session: AssistantSession): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    messages: session.messages.map(encodeMessage),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function encodeCanvas(canvas: CanvasDocument): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: canvas.id,
    name: canvas.name,
    schemaVersion: canvas.schemaVersion,
    viewport: encodeViewport(canvas.viewport),
    nodes: canvas.nodes.map(encodeNode),
    edges: canvas.edges.map(encodeEdge),
    groups: canvas.groups.map(encodeGroup),
    settings: {
      background: canvas.settings.background,
      showMinimap: canvas.settings.showMinimap,
      snapToGrid: canvas.settings.snapToGrid,
    },
  };
  if (canvas.sessions !== undefined)
    doc.sessions = canvas.sessions.map(encodeSession);
  if (canvas.folderId !== undefined) doc.folderId = canvas.folderId;
  return doc;
}

function encodeFolder(folder: CanvasFolder): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: folder.id,
    name: folder.name,
  };
  if (folder.parentId !== undefined) doc.parentId = folder.parentId;
  doc.createdAt = folder.createdAt;
  return doc;
}

// ---------------------------------------------------------------------------
// The cutting room
// ---------------------------------------------------------------------------

function encodeAdjust(adjust: ClipAdjust): Record<string, unknown> {
  return {
    brightness: asDouble(adjust.brightness),
    contrast: asDouble(adjust.contrast),
    saturation: asDouble(adjust.saturation),
  };
}

function encodeTextStyle(style: TextClipStyle): Record<string, unknown> {
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    color: style.color,
    bold: style.bold,
    italic: style.italic,
    align: style.align,
    position: style.position,
    background: style.background,
    strokeWidth: style.strokeWidth,
    strokeColor: style.strokeColor,
  };
}

function encodeClip(clip: TimelineClip): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: clip.id,
    trackId: clip.trackId,
    kind: clip.kind,
    label: clip.label,
    startMs: asLong(clip.startMs),
    durationMs: asLong(clip.durationMs),
    inPointMs: asLong(clip.inPointMs),
    outPointMs: asLong(clip.outPointMs),
    speed: asDouble(clip.speed),
    volume: asDouble(clip.volume),
    fadeInMs: asLong(clip.fadeInMs),
    fadeOutMs: asLong(clip.fadeOutMs),
    muted: clip.muted,
    opacity: asDouble(clip.opacity),
    createdAt: clip.createdAt,
    updatedAt: clip.updatedAt,
  };
  if (clip.assetId !== undefined) doc.assetId = clip.assetId;
  if (clip.adjust !== undefined) doc.adjust = encodeAdjust(clip.adjust);
  if (clip.filter !== undefined) doc.filter = clip.filter;
  if (clip.text !== undefined)
    doc.text = {
      content: clip.text.content,
      style: encodeTextStyle(clip.text.style),
    };
  return doc;
}

function encodeTrack(track: TimelineTrack): Record<string, unknown> {
  return {
    id: track.id,
    kind: track.kind,
    name: track.name,
    muted: track.muted,
    hidden: track.hidden,
    locked: track.locked,
    createdAt: track.createdAt,
  };
}

function encodeTransition(
  transition: TimelineTransition,
): Record<string, unknown> {
  return {
    id: transition.id,
    afterClipId: transition.afterClipId,
    kind: transition.kind,
    durationMs: asLong(transition.durationMs),
    createdAt: transition.createdAt,
  };
}

function encodeTimeline(timeline: TimelineDocument): Record<string, unknown> {
  return {
    id: timeline.id,
    name: timeline.name,
    schemaVersion: timeline.schemaVersion,
    settings: {
      fps: timeline.settings.fps,
      width: timeline.settings.width,
      height: timeline.settings.height,
      background: timeline.settings.background,
    },
    tracks: timeline.tracks.map(encodeTrack),
    clips: timeline.clips.map(encodeClip),
    transitions: timeline.transitions.map(encodeTransition),
    createdAt: timeline.createdAt,
    updatedAt: timeline.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// The story room
// ---------------------------------------------------------------------------

function encodeStoryTake(take: StoryTake): Record<string, unknown> {
  // A take names its files in a list whatever their number; a document written
  // when a take was a single file carries a lone assetId, and decodeStoryTake
  // reads that as the one-file list it means.
  const doc: Record<string, unknown> = {
    assetIds: [...take.assetIds],
    createdAt: take.createdAt,
  };
  if (take.jobId !== undefined) doc.jobId = take.jobId;
  if (take.itemId !== undefined) doc.itemId = take.itemId;
  if (take.note !== undefined) doc.note = take.note;
  return doc;
}

function encodeStorySlot(slot: StorySlot): Record<string, unknown> {
  return {
    takes: slot.takes.map(encodeStoryTake),
  };
}

function encodeStoryDialogue(line: StoryDialogueLine): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: line.id,
    speaker: line.speaker,
    text: line.text,
  };
  if (line.characterId !== undefined) doc.characterId = line.characterId;
  if (line.tone !== undefined) doc.tone = line.tone;
  return doc;
}

function encodeStoryKeyframe(keyframe: StoryKeyframe): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: keyframe.id,
    title: keyframe.title,
    shotSize: keyframe.shotSize,
    cameraMove: keyframe.cameraMove,
    angle: keyframe.angle,
    content: keyframe.content,
    dialogue: keyframe.dialogue.map(encodeStoryDialogue),
    durationMs: asLong(keyframe.durationMs),
    art: encodeStorySlot(keyframe.art),
    video: encodeStorySlot(keyframe.video),
  };
  // The plain role is written as silence, the way the Rust half reads it: a
  // board whose frames are all references keeps the shape it came in with.
  if (keyframe.filmRole !== undefined && keyframe.filmRole !== "reference") {
    doc.filmRole = keyframe.filmRole;
  }
  if (keyframe.voices !== undefined && keyframe.voices.length > 0) {
    doc.voices = keyframe.voices.map((take) => ({
      lineId: take.lineId,
      text: take.text,
      voice: take.voice,
      slot: encodeStorySlot(take.slot),
    }));
  }
  return doc;
}

function encodeStoryAct(act: StoryAct): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: act.id,
    title: act.title,
    summary: act.summary,
    characterIds: [...act.characterIds],
    propIds: [...act.propIds],
    sound: {
      music: act.sound.music,
      sfx: act.sound.sfx,
      ...(act.sound.ambience !== undefined
        ? { ambience: act.sound.ambience }
        : {}),
    },
    keyframes: act.keyframes.map(encodeStoryKeyframe),
    video: encodeStorySlot(act.video),
  };
  if (act.sceneId !== undefined) doc.sceneId = act.sceneId;
  // A slot that was never made is left out rather than written back empty:
  // the document says which of the two the reader has not asked for yet.
  if (act.voice !== undefined) doc.voice = encodeStorySlot(act.voice);
  if (act.music !== undefined) doc.music = encodeStorySlot(act.music);
  return doc;
}

function encodeStoryChapter(chapter: StoryChapter): Record<string, unknown> {
  return {
    id: chapter.id,
    title: chapter.title,
    synopsis: chapter.synopsis,
    targetDurationMs: asLong(chapter.targetDurationMs),
    acts: chapter.acts.map(encodeStoryAct),
  };
}

/**
 * One voice as the document carries it.
 *
 * Both words are written even when one is empty — an empty voice is a voice
 * handed to the next one, and leaving it off would say the profile was never
 * there — while a number nobody set is left off rather than written as
 * nothing, and so is a recording nobody named.
 */
function encodeStoryVoiceProfile(
  profile: StoryVoiceProfile,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    model: profile.model,
    voice: profile.voice,
  };
  if (profile.rate !== undefined) doc.rate = profile.rate;
  if (profile.pitch !== undefined) doc.pitch = profile.pitch;
  if (profile.instructions !== undefined)
    doc.instructions = profile.instructions;
  if (profile.referenceAssetId !== undefined)
    doc.referenceAssetId = profile.referenceAssetId;
  return doc;
}

function encodeStoryElement(element: StoryElement): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: element.id,
    kind: element.kind,
    name: element.name,
    description: element.description,
    chapterIds: [...element.chapterIds],
    main: encodeStorySlot(element.main),
  };
  if (element.turnaround !== undefined)
    doc.turnaround = encodeStorySlot(element.turnaround);
  if (element.voice !== undefined)
    doc.voice = encodeStoryVoiceProfile(element.voice);
  return doc;
}

function encodeStoryBrief(brief: StoryBrief): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    idea: brief.idea,
    totalDurationMs: asLong(brief.totalDurationMs),
    aspect: brief.aspect,
    genre: brief.genre,
    style: brief.style,
  };
  if (brief.sourceAssetId !== undefined)
    doc.sourceAssetId = brief.sourceAssetId;
  if (brief.sourceName !== undefined) doc.sourceName = brief.sourceName;
  if (brief.sourceSplit !== undefined) doc.sourceSplit = brief.sourceSplit;
  return doc;
}

function encodeStoryEdit(edit: StoryEdit): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  if (edit.timelineId !== undefined) doc.timelineId = edit.timelineId;
  if (edit.clipByAct !== undefined)
    doc.clipByAct = edit.clipByAct.map((entry) => ({
      actId: entry.actId,
      clipId: entry.clipId,
      ...(entry.keyframeId !== undefined
        ? { keyframeId: entry.keyframeId }
        : {}),
    }));
  if (edit.assembledDigest !== undefined)
    doc.assembledDigest = edit.assembledDigest;
  return doc;
}

function encodeStory(story: StoryDocument): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: story.id,
    name: story.name,
    schemaVersion: story.schemaVersion,
    brief: encodeStoryBrief(story.brief),
    chapters: story.chapters.map(encodeStoryChapter),
    elements: story.elements.map(encodeStoryElement),
    shotGranularity: story.shotGranularity,
    maxReferenceImages: story.maxReferenceImages,
    confirmedSteps: [...story.confirmedSteps],
    edit: encodeStoryEdit(story.edit),
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
  };
  if (story.narrator !== undefined)
    doc.narrator = encodeStoryVoiceProfile(story.narrator);
  return doc;
}

function encodeProbe(
  probe: ResourceEntry["probe"],
): Record<string, unknown> | undefined {
  if (!probe) return undefined;
  const doc: Record<string, unknown> = {
    mime: probe.mime,
    bytes: asLong(probe.bytes),
    sha256: probe.sha256,
  };
  if (probe.width !== undefined) doc.width = probe.width;
  if (probe.height !== undefined) doc.height = probe.height;
  if (probe.durationMs !== undefined) doc.durationMs = asLong(probe.durationMs);
  if (probe.sampleRate !== undefined) doc.sampleRate = probe.sampleRate;
  if (probe.channels !== undefined) doc.channels = probe.channels;
  if (probe.codecSummary !== undefined) doc.codecSummary = probe.codecSummary;
  if (probe.posterAssetId !== undefined)
    doc.posterAssetId = probe.posterAssetId;
  return doc;
}

function encodeProvenance(
  provenance: ResourceEntry["provenance"],
): Record<string, unknown> | undefined {
  if (!provenance) return undefined;
  const doc: Record<string, unknown> = {};
  if (provenance.runId !== undefined) doc.runId = provenance.runId;
  if (provenance.canvasId !== undefined) doc.canvasId = provenance.canvasId;
  if (provenance.operationNodeId !== undefined)
    doc.operationNodeId = provenance.operationNodeId;
  if (provenance.assistantSessionId !== undefined)
    doc.assistantSessionId = provenance.assistantSessionId;
  if (provenance.storyJobId !== undefined)
    doc.storyJobId = provenance.storyJobId;
  if (provenance.storyId !== undefined) doc.storyId = provenance.storyId;
  if (provenance.inputAssetIds !== undefined)
    doc.inputAssetIds = [...provenance.inputAssetIds];
  if (provenance.parameterSnapshot !== undefined)
    doc.parameterSnapshot = provenance.parameterSnapshot;
  doc.createdAt = provenance.createdAt;
  return doc;
}

function encodeResource(entry: ResourceEntry): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: entry.id,
    name: entry.name,
    path: entry.path,
  };
  if (entry.mime !== undefined) doc.mime = entry.mime;
  if (entry.bytes !== undefined) doc.bytes = asLong(entry.bytes);
  if (entry.sha256 !== undefined) doc.sha256 = entry.sha256;
  doc.createdAt = entry.createdAt;
  doc.updatedAt = entry.updatedAt;
  const probe = encodeProbe(entry.probe);
  if (probe) doc.probe = probe;
  const provenance = encodeProvenance(entry.provenance);
  if (provenance) doc.provenance = provenance;
  if (entry.tags !== undefined) doc.tags = [...entry.tags];
  if (entry.note !== undefined) doc.note = entry.note;
  if (entry.favorite !== undefined) doc.favorite = entry.favorite;
  if (entry.origin !== undefined) doc.origin = entry.origin;
  if (entry.keyword !== undefined) doc.keyword = entry.keyword;
  return doc;
}

function encodeMetadata(metadata: ProjectMetadata): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: metadata.id,
    name: metadata.name,
  };
  if (metadata.description !== undefined)
    doc.description = metadata.description;
  if (metadata.coverPath !== undefined) doc.coverPath = metadata.coverPath;
  doc.revision = metadata.revision;
  doc.createdAt = metadata.createdAt;
  doc.updatedAt = metadata.updatedAt;
  return doc;
}

export function encodeMokaFile(moka: MokaFile, maxBytes?: number): Uint8Array {
  const doc: Record<string, unknown> = {
    version: moka.version,
    metadata: encodeMetadata(moka.metadata),
    resources: Object.fromEntries(
      PROJECT_ASSET_CATEGORIES.map((category) => [
        category,
        (moka.resources[category] ?? []).map(encodeResource),
      ]),
    ),
  };
  if (moka.folders !== undefined) doc.folders = moka.folders.map(encodeFolder);
  if (moka.timelines !== undefined)
    doc.timelines = moka.timelines.map(encodeTimeline);
  if (moka.stories !== undefined) doc.stories = moka.stories.map(encodeStory);
  doc.canvas = moka.canvas.map(encodeCanvas);
  const bson = serialize(doc);
  const bytes = new Uint8Array(4 + bson.length);
  bytes.set(MOKA_MAGIC, 0);
  bytes.set(bson, 4);
  if (maxBytes !== undefined && bytes.length > maxBytes) {
    throw new MokaCodecError(
      "MOKA_TOO_LARGE",
      `canvas.moka would be ${bytes.length} bytes, exceeding the ${maxBytes} byte limit`,
    );
  }
  return bytes;
}

function requireField<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new MokaCodecError(
      "MOKA_FIELD_MISSING",
      `canvas.moka is missing required field "${name}"`,
    );
  }
  return value;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  const field = requireField(value, name);
  if (typeof field !== "object" || Array.isArray(field)) {
    throw new MokaCodecError(
      "MOKA_FIELD_MISSING",
      `canvas.moka field "${name}" has the wrong shape`,
    );
  }
  return field as Record<string, unknown>;
}

function asArray(value: unknown, name: string): unknown[] {
  const field = requireField(value, name);
  if (!Array.isArray(field)) {
    throw new MokaCodecError(
      "MOKA_FIELD_MISSING",
      `canvas.moka field "${name}" has the wrong shape`,
    );
  }
  return field;
}

function asString(value: unknown, name: string): string {
  const field = requireField(value, name);
  if (typeof field !== "string") {
    throw new MokaCodecError(
      "MOKA_FIELD_MISSING",
      `canvas.moka field "${name}" has the wrong shape`,
    );
  }
  return field;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function decodeViewport(value: unknown): {
  x: number;
  y: number;
  zoom: number;
} {
  const doc = asRecord(value, "viewport");
  return {
    x: requireField(unwrapNumber(doc.x), "viewport.x"),
    y: requireField(unwrapNumber(doc.y), "viewport.y"),
    zoom: requireField(unwrapNumber(doc.zoom), "viewport.zoom"),
  };
}

function decodeBounds(value: unknown) {
  const doc = asRecord(value, "bounds");
  return {
    x: requireField(unwrapNumber(doc.x), "bounds.x"),
    y: requireField(unwrapNumber(doc.y), "bounds.y"),
    width: requireField(unwrapNumber(doc.width), "bounds.width"),
    height: requireField(unwrapNumber(doc.height), "bounds.height"),
  };
}

function decodeLongField(value: unknown): number | undefined {
  const unwrapped = unwrapNumber(value);
  return unwrapped === undefined ? undefined : Math.trunc(unwrapped);
}

function decodeProbe(value: unknown): ResourceEntry["probe"] {
  if (value === undefined || value === null) return undefined;
  const doc = asRecord(value, "probe");
  return {
    mime: asString(doc.mime, "probe.mime"),
    bytes: requireField(decodeLongField(doc.bytes), "probe.bytes"),
    sha256: asString(doc.sha256, "probe.sha256"),
    width: decodeLongField(doc.width),
    height: decodeLongField(doc.height),
    durationMs: decodeLongField(doc.durationMs),
    sampleRate: decodeLongField(doc.sampleRate),
    channels: decodeLongField(doc.channels),
    codecSummary: optionalString(doc.codecSummary),
    posterAssetId: optionalString(doc.posterAssetId),
  };
}

function decodeProvenance(value: unknown): ResourceEntry["provenance"] {
  if (value === undefined || value === null) return undefined;
  const doc = asRecord(value, "provenance");
  return {
    runId: optionalString(doc.runId),
    canvasId: optionalString(doc.canvasId),
    operationNodeId: optionalString(doc.operationNodeId),
    assistantSessionId: optionalString(doc.assistantSessionId),
    storyJobId: optionalString(doc.storyJobId),
    storyId: optionalString(doc.storyId),
    inputAssetIds: Array.isArray(doc.inputAssetIds)
      ? (doc.inputAssetIds as string[])
      : undefined,
    parameterSnapshot:
      typeof doc.parameterSnapshot === "object" &&
      doc.parameterSnapshot !== null
        ? (doc.parameterSnapshot as Record<string, unknown>)
        : undefined,
    createdAt: asString(doc.createdAt, "provenance.createdAt"),
  };
}

function decodeResource(value: unknown): ResourceEntry {
  const doc = asRecord(value, "resources[]");
  const path = asString(doc.path, "resources[].path");
  if (!validateResourcePath(path)) {
    throw new MokaCodecError(
      "PATH_ESCAPE",
      `Resource path escapes the project root: ${path}`,
    );
  }
  const entry: ResourceEntry = {
    id: asString(doc.id, "resources[].id"),
    name: asString(doc.name, "resources[].name"),
    path,
    mime: optionalString(doc.mime),
    bytes: decodeLongField(doc.bytes),
    sha256: optionalString(doc.sha256),
    createdAt: asString(doc.createdAt, "resources[].createdAt"),
    updatedAt: asString(doc.updatedAt, "resources[].updatedAt"),
    probe: decodeProbe(doc.probe),
    provenance: decodeProvenance(doc.provenance),
    tags: Array.isArray(doc.tags) ? (doc.tags as string[]) : undefined,
    note: optionalString(doc.note),
    favorite: typeof doc.favorite === "boolean" ? doc.favorite : undefined,
    origin: optionalString(doc.origin) as ResourceEntry["origin"],
    keyword: optionalString(doc.keyword),
  };
  return entry;
}

function decodeNode(value: unknown): WorkflowNode {
  const doc = asRecord(value, "nodes[]");
  return {
    id: asString(doc.id, "nodes[].id"),
    kind: asString(doc.kind, "nodes[].kind") as WorkflowNode["kind"],
    title: asString(doc.title, "nodes[].title"),
    bounds: decodeBounds(doc.bounds),
    zIndex: Math.trunc(
      requireField(unwrapNumber(doc.zIndex), "nodes[].zIndex"),
    ),
    ports: asArray(doc.ports, "nodes[].ports").map((port) => {
      const record = asRecord(port, "ports[]");
      return {
        id: asString(record.id, "ports[].id"),
        direction: asString(record.direction, "ports[].direction") as
          "input" | "output",
        dataTypes: asArray(record.dataTypes, "ports[].dataTypes") as never,
        required: Boolean(record.required),
        cardinality: asString(record.cardinality, "ports[].cardinality") as
          "one" | "many",
        label: asString(record.label, "ports[].label"),
      };
    }),
    data: asRecord(doc.data, "nodes[].data") as never,
    createdAt: asString(doc.createdAt, "nodes[].createdAt"),
    updatedAt: asString(doc.updatedAt, "nodes[].updatedAt"),
  };
}

function decodeEdge(value: unknown): WorkflowEdge {
  const doc = asRecord(value, "edges[]");
  const source = asRecord(doc.source, "edges[].source");
  const target = asRecord(doc.target, "edges[].target");
  return {
    id: asString(doc.id, "edges[].id"),
    source: {
      nodeId: asString(source.nodeId, "edges[].source.nodeId"),
      portId: asString(source.portId, "edges[].source.portId"),
    },
    target: {
      nodeId: asString(target.nodeId, "edges[].target.nodeId"),
      portId: asString(target.portId, "edges[].target.portId"),
    },
    createdAt: asString(doc.createdAt, "edges[].createdAt"),
  };
}

function decodeReference(value: unknown): AssistantReference {
  const doc = asRecord(value, "references[]");
  return {
    nodeId: asString(doc.nodeId, "references[].nodeId"),
    title: asString(doc.title, "references[].title"),
    kind: asString(doc.kind, "references[].kind") as NodeKind,
    assetId: optionalString(doc.assetId),
  };
}

function decodeToolCall(value: unknown): AssistantToolCall {
  const doc = asRecord(value, "toolCalls[]");
  return {
    runId: asString(doc.runId, "toolCalls[].runId"),
    nodeId: optionalString(doc.nodeId),
    summary: asString(doc.summary, "toolCalls[].summary"),
  };
}

function decodeFailure(value: unknown): AssistantFailure | undefined {
  if (value === undefined || value === null) return undefined;
  const doc = asRecord(value, "failure");
  return {
    code: asString(doc.code, "failure.code") as ProblemCode,
    retryable: Boolean(doc.retryable),
  };
}

function decodeMessage(value: unknown): AssistantMessage {
  const doc = asRecord(value, "messages[]");
  return {
    id: asString(doc.id, "messages[].id"),
    role: asString(doc.role, "messages[].role") as AssistantRole,
    text: asString(doc.text, "messages[].text"),
    createdAt: asString(doc.createdAt, "messages[].createdAt"),
    references: Array.isArray(doc.references)
      ? doc.references.map(decodeReference)
      : undefined,
    toolCalls: Array.isArray(doc.toolCalls)
      ? doc.toolCalls.map(decodeToolCall)
      : undefined,
    failure: decodeFailure(doc.failure),
  };
}

function decodeSession(value: unknown): AssistantSession {
  const doc = asRecord(value, "sessions[]");
  return {
    id: asString(doc.id, "sessions[].id"),
    title: asString(doc.title, "sessions[].title"),
    messages: asArray(doc.messages, "sessions[].messages").map(decodeMessage),
    createdAt: asString(doc.createdAt, "sessions[].createdAt"),
    updatedAt: asString(doc.updatedAt, "sessions[].updatedAt"),
  };
}

/**
 * The conversations a canvas carries, or undefined when it carries none.
 *
 * Undefined and not an empty list, so that a document written before
 * conversations existed is read and written back as the bytes it arrived with.
 */
function decodeSessions(value: unknown): AssistantSession[] | undefined {
  if (value === undefined || value === null) return undefined;
  return asArray(value, "sessions").map(decodeSession);
}

function normalizeCanvas(canvas: CanvasDocument): CanvasDocument {
  // One schema version is read. An older document would have to be read
  // through rules this build no longer carries, and rewriting it would destroy
  // what an older build still understands; a newer one says the app was rolled
  // back over a document this build cannot know.
  if (canvas.schemaVersion !== CANVAS_SCHEMA_VERSION) {
    throw new MokaCodecError(
      "MOKA_VERSION_UNSUPPORTED",
      `canvas.moka schema version ${canvas.schemaVersion} is not supported (expected ${CANVAS_SCHEMA_VERSION})`,
    );
  }
  for (const node of canvas.nodes) {
    node.ports = reconcilePorts(node.kind, node.ports);
  }
  return canvas;
}

function decodeCanvas(value: unknown): CanvasDocument {
  const doc = asRecord(value, "canvas[]");
  const settings = asRecord(doc.settings, "canvas[].settings");
  return normalizeCanvas({
    id: asString(doc.id, "canvas[].id"),
    name: asString(doc.name, "canvas[].name"),
    schemaVersion: Math.trunc(
      requireField(unwrapNumber(doc.schemaVersion), "canvas[].schemaVersion"),
    ),
    viewport: decodeViewport(doc.viewport),
    nodes: asArray(doc.nodes, "canvas[].nodes").map(decodeNode),
    edges: asArray(doc.edges, "canvas[].edges").map(decodeEdge),
    groups: asArray(doc.groups, "canvas[].groups").map((group) => {
      const record = asRecord(group, "groups[]");
      return {
        groupId: asString(record.groupId, "groups[].groupId"),
        childNodeIds: asArray(
          record.childNodeIds,
          "groups[].childNodeIds",
        ) as string[],
      };
    }),
    settings: {
      background: asString(settings.background, "settings.background") as
        "dots" | "lines" | "blank",
      showMinimap: Boolean(settings.showMinimap),
      snapToGrid: Boolean(settings.snapToGrid),
    },
    sessions: decodeSessions(doc.sessions),
    folderId: optionalString(doc.folderId),
  });
}

/**
 * The folders a project has, or undefined when it has none.
 *
 * Undefined and not an empty list, so that a document written before folders
 * existed is read and written back as the bytes it arrived with.
 */
function decodeFolders(value: unknown): CanvasFolder[] | undefined {
  if (value === undefined || value === null) return undefined;
  return asArray(value, "folders").map((folder) => {
    const doc = asRecord(folder, "folders[]");
    return {
      id: asString(doc.id, "folders[].id"),
      name: asString(doc.name, "folders[].name"),
      parentId: optionalString(doc.parentId),
      createdAt: asString(doc.createdAt, "folders[].createdAt"),
    };
  });
}

// ---------------------------------------------------------------------------
// The cutting room
// ---------------------------------------------------------------------------

function decodeAdjust(value: unknown): ClipAdjust | undefined {
  if (value === undefined || value === null) return undefined;
  const doc = asRecord(value, "clips[].adjust");
  return {
    brightness: requireField(unwrapNumber(doc.brightness), "adjust.brightness"),
    contrast: requireField(unwrapNumber(doc.contrast), "adjust.contrast"),
    saturation: requireField(unwrapNumber(doc.saturation), "adjust.saturation"),
  };
}

const TEXT_STYLE_KEYS = [
  "fontFamily",
  "fontSize",
  "color",
  "bold",
  "italic",
  "align",
  "position",
  "background",
  "strokeWidth",
  "strokeColor",
] as const;

const TEXT_ALIGNS = ["left", "center", "right"] as const;
const TEXT_POSITIONS = ["top", "center", "bottom"] as const;

/**
 * One of the words an enum field may hold, refused the way the other
 * language's deserializer would refuse it: a reader and a writer that
 * disagree about what a stored word means must not both accept the file.
 */
function oneOf<T extends string>(
  values: readonly T[],
  value: string,
  what: string,
): T {
  if (!values.includes(value as T))
    throw new MokaCodecError(
      "MOKA_BSON_INVALID",
      `${what} "${value}" is not one this build reads`,
    );
  return value as T;
}

function decodeTextStyle(value: unknown): TextClipStyle {
  const doc = asRecord(value, "clips[].text.style");
  const style: Record<string, unknown> = {};
  for (const key of TEXT_STYLE_KEYS) {
    if (key === "background") {
      // Null is a value here — no backing plate — so the key is asked for
      // by its presence rather than by its value.
      if (!("background" in doc))
        throw new MokaCodecError(
          "MOKA_FIELD_MISSING",
          `canvas.moka is missing required field "text.style.background"`,
        );
      style.background = doc.background;
      continue;
    }
    style[key] = requireField(doc[key], `text.style.${key}`);
  }
  style.align = oneOf(TEXT_ALIGNS, style.align as string, "Text align");
  style.position = oneOf(
    TEXT_POSITIONS,
    style.position as string,
    "Text position",
  );
  return style as unknown as TextClipStyle;
}

const TRACK_KINDS = ["video", "audio", "text"] as const;

function decodeClip(value: unknown): TimelineClip {
  const doc = asRecord(value, "timelines[].clips[]");
  const clip: TimelineClip = {
    id: asString(doc.id, "clips[].id"),
    trackId: asString(doc.trackId, "clips[].trackId"),
    kind: oneOf(TRACK_KINDS, asString(doc.kind, "clips[].kind"), "Clip kind"),
    label: asString(doc.label, "clips[].label"),
    startMs: requireField(decodeLongField(doc.startMs), "clips[].startMs"),
    durationMs: requireField(
      decodeLongField(doc.durationMs),
      "clips[].durationMs",
    ),
    inPointMs: requireField(
      decodeLongField(doc.inPointMs),
      "clips[].inPointMs",
    ),
    outPointMs: requireField(
      decodeLongField(doc.outPointMs),
      "clips[].outPointMs",
    ),
    speed: requireField(unwrapNumber(doc.speed), "clips[].speed"),
    volume: requireField(unwrapNumber(doc.volume), "clips[].volume"),
    fadeInMs: requireField(decodeLongField(doc.fadeInMs), "clips[].fadeInMs"),
    fadeOutMs: requireField(
      decodeLongField(doc.fadeOutMs),
      "clips[].fadeOutMs",
    ),
    muted: Boolean(doc.muted),
    opacity: requireField(unwrapNumber(doc.opacity), "clips[].opacity"),
    createdAt: asString(doc.createdAt, "clips[].createdAt"),
    updatedAt: asString(doc.updatedAt, "clips[].updatedAt"),
  };
  if (doc.assetId !== undefined)
    clip.assetId = asString(doc.assetId, "clips[].assetId");
  if (doc.adjust !== undefined) clip.adjust = decodeAdjust(doc.adjust);
  if (doc.filter !== undefined) {
    const filter = asString(doc.filter, "clips[].filter") as ClipFilterPreset;
    clip.filter = filter;
  }
  if (doc.text !== undefined) {
    const textDoc = asRecord(doc.text, "clips[].text");
    clip.text = {
      content: asString(textDoc.content, "clips[].text.content"),
      style: decodeTextStyle(textDoc.style),
    };
  }
  return clip;
}

function decodeTrack(value: unknown): TimelineTrack {
  const doc = asRecord(value, "timelines[].tracks[]");
  return {
    id: asString(doc.id, "tracks[].id"),
    kind: oneOf(TRACK_KINDS, asString(doc.kind, "tracks[].kind"), "Track kind"),
    name: asString(doc.name, "tracks[].name"),
    muted: Boolean(doc.muted),
    hidden: Boolean(doc.hidden),
    locked: Boolean(doc.locked),
    createdAt: asString(doc.createdAt, "tracks[].createdAt"),
  };
}

function decodeTransition(value: unknown): TimelineTransition {
  const doc = asRecord(value, "timelines[].transitions[]");
  const kind = asString(doc.kind, "transitions[].kind") as TransitionKind;
  if (!TRANSITION_KINDS.includes(kind)) {
    throw new MokaCodecError(
      "MOKA_BSON_INVALID",
      `Transition kind "${kind}" is not one this build reads`,
    );
  }
  return {
    id: asString(doc.id, "transitions[].id"),
    afterClipId: asString(doc.afterClipId, "transitions[].afterClipId"),
    kind,
    durationMs: requireField(
      decodeLongField(doc.durationMs),
      "transitions[].durationMs",
    ),
    createdAt: asString(doc.createdAt, "transitions[].createdAt"),
  };
}

function decodeTimeline(value: unknown): TimelineDocument {
  const doc = asRecord(value, "timelines[]");
  const settings = asRecord(doc.settings, "timelines[].settings");
  const schemaVersion = Math.trunc(
    requireField(unwrapNumber(doc.schemaVersion), "timelines[].schemaVersion"),
  );
  if (schemaVersion > TIMELINE_SCHEMA_VERSION) {
    throw new MokaCodecError(
      "MOKA_VERSION_UNSUPPORTED",
      `Timeline schema version ${schemaVersion} is not supported (expected ${TIMELINE_SCHEMA_VERSION} or earlier)`,
    );
  }
  return {
    id: asString(doc.id, "timelines[].id"),
    name: asString(doc.name, "timelines[].name"),
    schemaVersion,
    settings: {
      fps: Math.trunc(
        requireField(unwrapNumber(settings.fps), "timelines[].settings.fps"),
      ),
      width: Math.trunc(
        requireField(
          unwrapNumber(settings.width),
          "timelines[].settings.width",
        ),
      ),
      height: Math.trunc(
        requireField(
          unwrapNumber(settings.height),
          "timelines[].settings.height",
        ),
      ),
      background: asString(
        settings.background,
        "timelines[].settings.background",
      ),
    },
    tracks: asArray(doc.tracks, "timelines[].tracks").map(decodeTrack),
    clips: asArray(doc.clips, "timelines[].clips").map(decodeClip),
    transitions: asArray(doc.transitions, "timelines[].transitions").map(
      decodeTransition,
    ),
    createdAt: asString(doc.createdAt, "timelines[].createdAt"),
    updatedAt: asString(doc.updatedAt, "timelines[].updatedAt"),
  };
}

/**
 * The timelines a project has cut, or undefined when it has cut none.
 *
 * Undefined and not an empty list, so that a document written before the
 * cutting room existed is read and written back as the bytes it arrived with.
 */
function decodeTimelines(value: unknown): TimelineDocument[] | undefined {
  if (value === undefined || value === null) return undefined;
  return asArray(value, "timelines").map(decodeTimeline);
}

/**
 * One of the words an enum field holds, or the fallback when it holds another.
 *
 * A board is words a model wrote and a reader edited, and a word this build
 * does not know is not a reason to refuse the whole project: the shot is read
 * as the plainest thing it could be, which is what a reader looking at one
 * odd row would have assumed anyway. Words whose meaning changes what is done
 * with them — a track's kind, a transition — are refused instead.
 */
function fallbackOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fallback;
}

/**
 * How many reference pictures a frame may carry, as a document holds it.
 *
 * A document written before the limit existed says nothing, and the default is
 * what it meant; one that says a number no command would accept is read as the
 * nearest bound rather than refusing the whole story.
 */
function decodeReferenceImages(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(REFERENCE_IMAGES_MAX, Math.max(0, value))
    : REFERENCE_IMAGES_DEFAULT;
}

function decodeStoryTake(value: unknown): StoryTake {
  const doc = asRecord(value, "stories[].takes[]");
  // The list is what a take is; a document from when a take was a single file
  // carries it as a lone assetId, which is the one-file list it means.
  const assetIds =
    doc.assetIds === undefined
      ? [asString(doc.assetId, "takes[].assetId")]
      : asArray(doc.assetIds, "takes[].assetIds").map((held) =>
          asString(held, "takes[].assetIds[]"),
        );
  const take: StoryTake = {
    assetIds,
    createdAt: asString(doc.createdAt, "takes[].createdAt"),
  };
  if (doc.jobId !== undefined) take.jobId = optionalString(doc.jobId);
  if (doc.itemId !== undefined) take.itemId = optionalString(doc.itemId);
  if (doc.note !== undefined) take.note = optionalString(doc.note);
  return take;
}

function decodeStorySlot(value: unknown): StorySlot {
  const doc = asRecord(value, "stories[].slots[]");
  return {
    takes: asArray(doc.takes, "slots[].takes").map(decodeStoryTake),
  };
}

function decodeStoryDialogue(value: unknown): StoryDialogueLine {
  const doc = asRecord(value, "keyframes[].dialogue[]");
  const line: StoryDialogueLine = {
    // A line written before lines had names is given one as it is read: the
    // document is saved whole, so the name lands on disk with the next save
    // and every read after that sees the same one.
    id: doc.id === undefined ? newId() : asString(doc.id, "dialogue[].id"),
    speaker: asString(doc.speaker, "dialogue[].speaker"),
    text: asString(doc.text, "dialogue[].text"),
  };
  if (doc.characterId !== undefined)
    line.characterId = optionalString(doc.characterId);
  if (doc.tone !== undefined) line.tone = optionalString(doc.tone);
  return line;
}

function decodeStoryKeyframe(value: unknown): StoryKeyframe {
  const doc = asRecord(value, "stories[].keyframes[]");
  const keyframe: StoryKeyframe = {
    id: asString(doc.id, "keyframes[].id"),
    title: asString(doc.title, "keyframes[].title"),
    shotSize: fallbackOneOf(STORY_SHOT_SIZES, doc.shotSize, "medium"),
    cameraMove: fallbackOneOf(STORY_CAMERA_MOVES, doc.cameraMove, "static"),
    angle: fallbackOneOf(STORY_CAMERA_ANGLES, doc.angle, "eyeLevel"),
    content: asString(doc.content, "keyframes[].content"),
    dialogue: asArray(doc.dialogue, "keyframes[].dialogue").map(
      decodeStoryDialogue,
    ),
    durationMs: requireField(
      decodeLongField(doc.durationMs),
      "keyframes[].durationMs",
    ),
    art: decodeStorySlot(doc.art),
    video: decodeStorySlot(doc.video),
  };
  // A frame nobody has said anything about stays a frame nobody has said
  // anything about: reference is what the absence means, and the word is
  // written down only when some other one was.
  if (doc.filmRole !== undefined) {
    keyframe.filmRole = fallbackOneOf(
      STORY_FILM_ROLES,
      doc.filmRole,
      "reference",
    );
  }
  const voices = decodeStoryVoices(doc.voices);
  if (voices !== undefined) keyframe.voices = voices;
  return keyframe;
}

/**
 * The lines of a shot read aloud, as a document carries them.
 *
 * A line's take is kept by the line's own name, so a telling written before
 * lines had names has no takes to read: one that names nothing would be a
 * take no line could ever be told apart by.
 */
function decodeStoryVoices(value: unknown): StoryVoiceTake[] | undefined {
  if (value === undefined) return undefined;
  const takes = asArray(value, "keyframes[].voices").flatMap((entry) => {
    const doc = asRecord(entry, "keyframes[].voices[]");
    const lineId = optionalString(doc.lineId);
    if (lineId === undefined || lineId === "") return [];
    return [
      {
        lineId,
        text: asString(doc.text, "voices[].text"),
        voice: optionalString(doc.voice) ?? "",
        slot: decodeStorySlot(doc.slot),
      },
    ];
  });
  return takes.length === 0 ? undefined : takes;
}

function decodeStoryAct(value: unknown): StoryAct {
  const doc = asRecord(value, "stories[].acts[]");
  const sound = asRecord(doc.sound ?? {}, "acts[].sound");
  const act: StoryAct = {
    id: asString(doc.id, "acts[].id"),
    title: asString(doc.title, "acts[].title"),
    summary: asString(doc.summary, "acts[].summary"),
    characterIds: asArray(doc.characterIds ?? [], "acts[].characterIds").map(
      (id) => asString(id, "acts[].characterIds[]"),
    ),
    propIds: asArray(doc.propIds ?? [], "acts[].propIds").map((id) =>
      asString(id, "acts[].propIds[]"),
    ),
    sound: {
      music: optionalString(sound.music) ?? "",
      sfx: optionalString(sound.sfx) ?? "",
      ...(sound.ambience !== undefined
        ? { ambience: optionalString(sound.ambience) }
        : {}),
    },
    keyframes: asArray(doc.keyframes ?? [], "acts[].keyframes").map(
      decodeStoryKeyframe,
    ),
    video: decodeStorySlot(doc.video),
  };
  if (doc.sceneId !== undefined) act.sceneId = optionalString(doc.sceneId);
  if (doc.voice !== undefined) act.voice = decodeStorySlot(doc.voice);
  if (doc.music !== undefined) act.music = decodeStorySlot(doc.music);
  return act;
}

function decodeStoryChapter(value: unknown): StoryChapter {
  const doc = asRecord(value, "stories[].chapters[]");
  return {
    id: asString(doc.id, "chapters[].id"),
    title: asString(doc.title, "chapters[].title"),
    synopsis: asString(doc.synopsis, "chapters[].synopsis"),
    targetDurationMs: requireField(
      decodeLongField(doc.targetDurationMs),
      "chapters[].targetDurationMs",
    ),
    acts: asArray(doc.acts ?? [], "chapters[].acts").map(decodeStoryAct),
  };
}

function decodeStoryElement(value: unknown): StoryElement {
  const doc = asRecord(value, "stories[].elements[]");
  const element: StoryElement = {
    id: asString(doc.id, "elements[].id"),
    kind: fallbackOneOf(STORY_ELEMENT_KINDS, doc.kind, "prop"),
    name: asString(doc.name, "elements[].name"),
    description: asString(doc.description, "elements[].description"),
    chapterIds: asArray(doc.chapterIds ?? [], "elements[].chapterIds").map(
      (id) => asString(id, "elements[].chapterIds[]"),
    ),
    main: decodeStorySlot(doc.main),
  };
  if (doc.turnaround !== undefined)
    element.turnaround = decodeStorySlot(doc.turnaround);
  if (doc.voice !== undefined)
    element.voice = decodeStoryVoiceProfile(doc.voice, "elements[].voice");
  return element;
}

/**
 * One voice, as a document carries it.
 *
 * The two words that say who reads and in what voice are read as written — a
 * voice left out is handed to the next one, which is a different answer from a
 * voice holding nothing — while the two numbers are read only when they are
 * numbers: a pace nobody could measure is not a pace to read at. A recording
 * is read only when it is named, and a voice that names none is handed on
 * with nothing to copy.
 */
function decodeStoryVoiceProfile(
  value: unknown,
  where: string,
): StoryVoiceProfile {
  const doc = asRecord(value, where);
  const profile: StoryVoiceProfile = {
    model: optionalString(doc.model) ?? "",
    voice: optionalString(doc.voice) ?? "",
  };
  if (typeof doc.rate === "number" && Number.isFinite(doc.rate))
    profile.rate = doc.rate;
  if (typeof doc.pitch === "number" && Number.isFinite(doc.pitch))
    profile.pitch = doc.pitch;
  const instructions = optionalString(doc.instructions);
  if (instructions !== undefined) profile.instructions = instructions;
  const reference = optionalString(doc.referenceAssetId);
  if (reference !== undefined) profile.referenceAssetId = reference;
  return profile;
}

function decodeStoryBrief(value: unknown): StoryBrief {
  const doc = asRecord(value, "stories[].brief");
  const brief: StoryBrief = {
    idea: asString(doc.idea, "brief.idea"),
    totalDurationMs: requireField(
      decodeLongField(doc.totalDurationMs),
      "brief.totalDurationMs",
    ),
    aspect: fallbackOneOf(STORY_ASPECTS, doc.aspect, "16:9"),
    genre: asString(doc.genre, "brief.genre"),
    style: asString(doc.style, "brief.style"),
  };
  if (doc.sourceAssetId !== undefined)
    brief.sourceAssetId = optionalString(doc.sourceAssetId);
  if (doc.sourceName !== undefined)
    brief.sourceName = optionalString(doc.sourceName);
  if (doc.sourceSplit !== undefined)
    brief.sourceSplit = Boolean(doc.sourceSplit);
  return brief;
}

function decodeStoryEdit(value: unknown): StoryEdit {
  const doc = asRecord(value ?? {}, "stories[].edit");
  const edit: StoryEdit = {};
  if (doc.timelineId !== undefined)
    edit.timelineId = optionalString(doc.timelineId);
  if (doc.clipByAct !== undefined) {
    edit.clipByAct = asArray(doc.clipByAct, "edit.clipByAct").map((entry) => {
      const row = asRecord(entry, "edit.clipByAct[]");
      const held: { actId: string; keyframeId?: string; clipId: string } = {
        actId: asString(row.actId, "clipByAct[].actId"),
        clipId: asString(row.clipId, "clipByAct[].clipId"),
      };
      if (row.keyframeId !== undefined)
        held.keyframeId = optionalString(row.keyframeId);
      return held;
    });
  }
  if (doc.assembledDigest !== undefined)
    edit.assembledDigest = optionalString(doc.assembledDigest);
  return edit;
}

/**
 * The steps an older document had settled, read from the answers it kept.
 *
 * A story written before the room confirmed whole steps said the same thing
 * one place at a time: a chapter agreed to, a description agreed to, a clip
 * agreed to. Reading those back is what keeps a telling someone had finished
 * standing where they left it rather than at the first step of five.
 */
function decodeSteps(
  value: unknown,
  doc: Record<string, unknown>,
): StoryStep[] {
  if (value !== undefined) {
    return STORY_STEPS.filter((step) =>
      asArray(value, "stories[].confirmedSteps").some((held) => held === step),
    );
  }
  const steps: StoryStep[] = [];
  const brief = asRecord(doc.brief ?? {}, "stories[].brief");
  if (
    String(brief.idea ?? "").trim() !== "" ||
    brief.sourceAssetId !== undefined
  ) {
    steps.push("idea");
  }
  const chapters = asArray(doc.chapters ?? [], "stories[].chapters");
  if (
    chapters.length > 0 &&
    chapters.every((held) =>
      Boolean(asRecord(held, "chapters[]").synopsisConfirmed),
    )
  ) {
    steps.push("outline");
  }
  const elements = asArray(doc.elements ?? [], "stories[].elements");
  if (
    elements.length > 0 &&
    elements.every((held) => {
      const element = asRecord(held, "elements[]");
      if (!element.descriptionConfirmed) return false;
      if (!asRecord(element.main ?? {}, "elements[].main").confirmed)
        return false;
      return (
        element.turnaround === undefined ||
        Boolean(asRecord(element.turnaround, "elements[].turnaround").confirmed)
      );
    })
  ) {
    steps.push("elements");
  }
  const acts = chapters.flatMap((held) =>
    asArray(asRecord(held, "chapters[]").acts ?? [], "chapters[].acts"),
  );
  if (
    acts.length > 0 &&
    acts.every((held) => {
      const act = asRecord(held, "acts[]");
      const files = asArray(
        asRecord(act.video ?? {}, "acts[].video").takes ?? [],
        "acts[].video.takes",
      );
      return Boolean(act.videoConfirmed) && files.length > 0;
    })
  ) {
    steps.push("storyboard");
  }
  return steps;
}

function decodeStory(value: unknown): StoryDocument {
  const doc = asRecord(value, "stories[]");
  const schemaVersion = Math.trunc(
    requireField(unwrapNumber(doc.schemaVersion), "stories[].schemaVersion"),
  );
  if (schemaVersion > STORY_SCHEMA_VERSION) {
    throw new MokaCodecError(
      "MOKA_VERSION_UNSUPPORTED",
      `Story schema version ${schemaVersion} is not supported (expected ${STORY_SCHEMA_VERSION} or earlier)`,
    );
  }
  const story: StoryDocument = {
    id: asString(doc.id, "stories[].id"),
    name: asString(doc.name, "stories[].name"),
    schemaVersion,
    brief: decodeStoryBrief(doc.brief),
    chapters: asArray(doc.chapters ?? [], "stories[].chapters").map(
      decodeStoryChapter,
    ),
    elements: asArray(doc.elements ?? [], "stories[].elements").map(
      decodeStoryElement,
    ),
    shotGranularity: fallbackOneOf(
      STORY_SHOT_GRANULARITIES,
      doc.shotGranularity,
      "act",
    ),
    maxReferenceImages: decodeReferenceImages(doc.maxReferenceImages),
    confirmedSteps: decodeSteps(doc.confirmedSteps, doc),
    edit: decodeStoryEdit(doc.edit),
    createdAt: asString(doc.createdAt, "stories[].createdAt"),
    updatedAt: asString(doc.updatedAt, "stories[].updatedAt"),
  };
  if (doc.narrator !== undefined)
    story.narrator = decodeStoryVoiceProfile(
      doc.narrator,
      "stories[].narrator",
    );
  return story;
}

/**
 * The stories a project has told, or undefined when it has told none.
 *
 * Undefined and not an empty list, for the reason the timelines give: a
 * document written before the story room existed is read and written back as
 * the bytes it arrived with.
 */
function decodeStories(value: unknown): StoryDocument[] | undefined {
  if (value === undefined || value === null) return undefined;
  return asArray(value, "stories").map(decodeStory);
}

export function decodeMokaFile(bytes: Uint8Array): MokaFile {
  if (bytes.length < 5) {
    throw new MokaCodecError(
      "MOKA_BSON_INVALID",
      "canvas.moka is too small to be valid",
    );
  }
  for (let i = 0; i < 4; i += 1) {
    if (bytes[i] !== MOKA_MAGIC[i]) {
      throw new MokaCodecError(
        "MOKA_MAGIC_INVALID",
        "canvas.moka does not start with the MOKA magic bytes",
      );
    }
  }
  let doc: Record<string, unknown>;
  try {
    doc = deserialize(bytes.subarray(4)) as Record<string, unknown>;
  } catch (error) {
    throw new MokaCodecError(
      "MOKA_BSON_INVALID",
      `canvas.moka contains invalid BSON: ${(error as Error).message}`,
    );
  }

  const version = asString(doc.version, "version");
  if (version !== MOKA_FILE_VERSION) {
    throw new MokaCodecError(
      "MOKA_VERSION_UNSUPPORTED",
      `canvas.moka version "${version}" is not supported (expected "v1")`,
    );
  }

  const metadataDoc = asRecord(doc.metadata, "metadata");
  const metadata: ProjectMetadata = {
    id: asString(metadataDoc.id, "metadata.id"),
    name: asString(metadataDoc.name, "metadata.name"),
    description: optionalString(metadataDoc.description),
    coverPath: optionalString(metadataDoc.coverPath),
    revision: Math.trunc(
      requireField(unwrapNumber(metadataDoc.revision), "metadata.revision"),
    ),
    createdAt: asString(metadataDoc.createdAt, "metadata.createdAt"),
    updatedAt: asString(metadataDoc.updatedAt, "metadata.updatedAt"),
  };

  const resourcesDoc = asRecord(doc.resources, "resources");
  const resources = Object.fromEntries(
    PROJECT_ASSET_CATEGORIES.map((category) => [
      category,
      asArray(resourcesDoc[category] ?? [], `resources.${category}`).map(
        decodeResource,
      ),
    ]),
  ) as MokaFile["resources"];

  const canvas = asArray(doc.canvas, "canvas").map(decodeCanvas);
  const folders = decodeFolders(doc.folders);
  const timelines = decodeTimelines(doc.timelines);
  const stories = decodeStories(doc.stories);

  return {
    version: MOKA_FILE_VERSION,
    metadata,
    resources,
    ...(folders !== undefined ? { folders } : {}),
    ...(timelines !== undefined ? { timelines } : {}),
    ...(stories !== undefined ? { stories } : {}),
    canvas,
  };
}
