import { newId, nowIso } from "./ids";
import { i18n } from "../i18n";
import {
  CANVAS_SCHEMA_VERSION,
  DEFAULT_CHAPTER_MS,
  DEFAULT_IMAGE_CLIP_MS,
  DEFAULT_KEYFRAME_MS,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  DEFAULT_STORY_ASPECT,
  DEFAULT_STORY_DURATION_MS,
  DEFAULT_TEXT_CLIP_MS,
  EXTENSION_EXECUTOR_KEY,
  GENERATION_PARAM_KEYS,
  MIN_NODE_HEIGHT,
  MOKA_FILE_VERSION,
  NODE_PORTS,
  PROVIDER_EXECUTOR_KEY,
  REFERENCE_IMAGES_DEFAULT,
  STORY_SCHEMA_VERSION,
  TIMELINE_SCHEMA_VERSION,
  isCapability,
} from "./constants";
import type { Capability, TransitionKind } from "./constants";
import type { DirectorScene } from "./director";
import type {
  AssistantSession,
  CanvasDocument,
  ExtensionDefinition,
  ExtensionNodeData,
  GenerationInputMode,
  GenerationMode,
  GenerationSpec,
  MokaFile,
  NodeId,
  NodeKind,
  PortDefinition,
  Rect,
  ResourceEntry,
  ResourceRegistry,
  StoryAct,
  StoryBrief,
  StoryCameraAngle,
  StoryCameraMove,
  StoryChapter,
  StoryDocument,
  StoryElement,
  StoryElementKind,
  StoryKeyframe,
  StorySlot,
  StoryShotSize,
  TextClipStyle,
  TimelineClip,
  TimelineDocument,
  TimelineSettings,
  TimelineTrack,
  WorkflowNode,
} from "./types";

export function emptyResources(): ResourceRegistry {
  return {
    images: [],
    music: [],
    voice: [],
    texts: [],
    videos: [],
    models: [],
  };
}

export function createCanvas(name: string): CanvasDocument {
  return {
    id: newId(),
    name,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    groups: [],
    settings: { background: "dots", showMinimap: true, snapToGrid: true },
  };
}

export function createSession(title: string): AssistantSession {
  const now = nowIso();
  return { id: newId(), title, messages: [], createdAt: now, updatedAt: now };
}

// ---------------------------------------------------------------------------
// The cutting room
// ---------------------------------------------------------------------------

/** The three rows a new timeline starts with, named the way tabs read them. */
export function defaultTimelineTracks(): TimelineTrack[] {
  const now = nowIso();
  const row = (kind: TimelineTrack["kind"], name: string): TimelineTrack => ({
    id: newId(),
    kind,
    name,
    muted: false,
    hidden: false,
    locked: false,
    createdAt: now,
  });
  return [
    row("video", i18n.t("clip:defaults.trackVideo", { n: 1 })),
    row("audio", i18n.t("clip:defaults.trackAudio", { n: 1 })),
    row("text", i18n.t("clip:defaults.trackText", { n: 1 })),
  ];
}

/**
 * A timeline born empty but for its rows, named like a canvas is: one more
 * than the count, and past any name already taken.
 *
 * The frame is the one 1080p30 working default unless the ask names its own,
 * which is what the new-timeline dialog does: a cut being started for a
 * particular screen says so then, and a cut made without being asked for gets
 * the frame that suits most screens.
 */
export function createTimeline(
  name: string,
  settings?: Partial<TimelineSettings>,
): TimelineDocument {
  const now = nowIso();
  return {
    id: newId(),
    name,
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    settings: {
      fps: settings?.fps ?? 30,
      width: settings?.width ?? 1920,
      height: settings?.height ?? 1080,
      background: settings?.background ?? "#000000",
    },
    tracks: defaultTimelineTracks(),
    clips: [],
    transitions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function nextTimelineName(moka: MokaFile): string {
  const used = new Set((moka.timelines ?? []).map((t) => t.name));
  const name = (n: number) => i18n.t("clip:defaults.timelineName", { n });
  let n = (moka.timelines ?? []).length + 1;
  while (used.has(name(n))) n += 1;
  return name(n);
}

/**
 * A clip of an asset's material, reading the whole of it.
 *
 * An image gets the duration nobody said otherwise for, since its material has
 * no length of its own to read; audio and video get what the probe measured.
 */
export function createClipFromAsset(
  asset: ResourceEntry,
  trackId: string,
  startMs: number,
): TimelineClip {
  const kind = asset.mime?.startsWith("video/")
    ? "video"
    : asset.mime?.startsWith("audio/")
      ? "audio"
      : "image";
  const durationMs =
    kind === "image"
      ? DEFAULT_IMAGE_CLIP_MS
      : (asset.probe?.durationMs ?? DEFAULT_IMAGE_CLIP_MS);
  const now = nowIso();
  return {
    id: newId(),
    trackId,
    kind: kind === "image" ? "video" : kind,
    label: asset.name,
    assetId: asset.id,
    startMs,
    durationMs,
    inPointMs: 0,
    outPointMs: durationMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The style a text clip is born with: plain white words on no plate and no
 * outline. Black is the outline colour it would wear if one were asked for,
 * so a reader who turns the width up sees words on a bright picture at once.
 */
export function defaultTextStyle(): TextClipStyle {
  return {
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    fontSize: 48,
    color: "#ffffff",
    bold: false,
    italic: false,
    align: "center",
    position: "bottom",
    background: null,
    strokeWidth: 0,
    strokeColor: "#000000",
  };
}

export function createTextClip(
  content: string,
  trackId: string,
  startMs: number,
  durationMs: number = DEFAULT_TEXT_CLIP_MS,
): TimelineClip {
  const now = nowIso();
  return {
    id: newId(),
    trackId,
    kind: "text",
    label: content.length > 24 ? `${content.slice(0, 24)}…` : content,
    startMs,
    durationMs,
    inPointMs: 0,
    outPointMs: durationMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    text: { content, style: defaultTextStyle() },
    createdAt: now,
    updatedAt: now,
  };
}

export function createTransition(
  afterClipId: string,
  kind: TransitionKind,
  durationMs: number,
): TimelineDocument["transitions"][number] {
  return { id: newId(), afterClipId, kind, durationMs, createdAt: nowIso() };
}

export function createProject(name: string): MokaFile {
  const now = nowIso();
  return {
    version: MOKA_FILE_VERSION,
    metadata: {
      id: newId(),
      name,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    },
    resources: emptyResources(),
    canvas: [createCanvas(i18n.t("domain:canvas.defaultName", { n: 1 }))],
  };
}

/**
 * The ports of a kind as a document carries them. A label the table states as
 * a translation key is read into the current language, so what lands in the
 * document is the word a reader sees rather than the key behind it.
 */
function translatedPort(port: PortDefinition): PortDefinition {
  return {
    ...port,
    label: port.label.startsWith("domain:") ? i18n.t(port.label) : port.label,
    dataTypes: [...port.dataTypes],
  };
}

export function derivePorts(kind: NodeKind): PortDefinition[] {
  return NODE_PORTS[kind].map(translatedPort);
}

/**
 * Ports are derived data: the table wins for every port it knows, and
 * stored ports the table does not list are kept verbatim after it.
 */
export function reconcilePorts(
  kind: NodeKind,
  stored: PortDefinition[],
): PortDefinition[] {
  const derived = derivePorts(kind);
  const known = new Set(derived.map((p) => p.id));
  const extras = stored.filter((p) => !known.has(p.id)).map(translatedPort);
  return [...derived, ...extras];
}

const NODE_TITLES: Record<NodeKind, string> = {
  text: "domain:nodeTitle.text",
  image: "domain:nodeTitle.image",
  audio: "domain:nodeTitle.audio",
  video: "domain:nodeTitle.video",
  operation: "domain:nodeTitle.operation",
  group: "domain:nodeTitle.group",
  export: "domain:nodeTitle.export",
  extension: "domain:nodeTitle.extension",
  director: "domain:nodeTitle.director",
};

export function defaultDataForKind(kind: NodeKind): WorkflowNode["data"] {
  switch (kind) {
    case "text":
      return { content: "" };
    case "image":
    case "video":
      return {};
    case "audio":
      return { audioCategory: "music" };
    case "operation":
      return {
        operationType: "deterministic.text",
        parameters: {},
        executorKey: "deterministic",
        resultSlots: [],
        resultNodeIds: [],
      };
    case "group":
      return { color: "#3b82f6", childNodeIds: [] };
    case "export":
      return { format: "mp4", parameters: {} };
    case "extension":
      // A real extension node is made by `createExtensionNode`, which has a
      // definition to read. This placeholder only keeps the exhaustive switch
      // honest and is never inserted by the menu.
      return {
        extension: {
          extensionId: "",
          definitionVersion: 0,
          apiVersion: 0,
          contractHash: "",
          bindings: {},
        },
        parameters: {},
        resultSlots: [],
        resultNodeIds: [],
      };
    case "director":
      // A real director card is made by `createDirectorNode`, which has a
      // scene to point at. The empty id keeps the exhaustive switch honest.
      return { director: { sceneId: "" } };
  }
}

/**
 * The capability a node of that kind asks in, or null for the kinds that never
 * carry a generation spec.
 *
 * A sound node asks in either sound capability; this answers with the one a
 * fresh ask is made in, and an ask already made carries its own.
 */
export function generationCapabilityFor(kind: NodeKind): Capability | null {
  if (
    kind === "operation" ||
    kind === "group" ||
    kind === "export" ||
    kind === "extension" ||
    kind === "director"
  ) {
    return null;
  }
  return kind === "audio" ? "speech" : kind;
}

/**
 * Whether a node of that kind may ask for this capability: the kind says how
 * the node is drawn, its spec says what it wants, and sound is the one kind
 * two capabilities serve.
 */
export function capabilityServes(
  capability: Capability,
  kind: NodeKind,
): boolean {
  if (kind === "audio")
    return capability === "speech" || capability === "music";
  if (kind === "text" || kind === "image" || kind === "video") {
    return capability === kind;
  }
  return false;
}

/**
 * The params an ask of that capability keeps, the rest dropped.
 *
 * Each capability reads a vocabulary of its own, so a key carried over from
 * another one would only travel to a converter that refuses it. Asked when an
 * ask changes capability, and when a document written before speech and music
 * were separated is read.
 */
export function paramsForCapability(
  capability: Capability,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = GENERATION_PARAM_KEYS[capability];
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => allowed.includes(key)),
  );
}

export function defaultGenerationSpec(kind: NodeKind): GenerationSpec | null {
  const capability = generationCapabilityFor(kind);
  if (!capability) return null;
  return {
    capability,
    mode: "generate",
    model: "",
    prompt: "",
    inputMode: "upstream",
    params: {},
    referenceNodeIds: [],
    updatedAt: nowIso(),
  };
}

/**
 * The bounds a node takes when it is asked for a shape, around the centre it
 * already has.
 *
 * The width is kept and the height follows it, so a node asked for a shape
 * stays where it was put across the canvas. A shape too wide to leave the node
 * as short as a node may be widens it instead: the ask has to be drawable, and
 * a rectangle below the smallest size would be refused by the document.
 */
export function boundsForShape(bounds: Rect, shape: string): Rect | null {
  const ratio = proportionOf(shape);
  if (!ratio) return null;
  let width = bounds.width;
  let height = Math.round(width / ratio);
  if (height < MIN_NODE_HEIGHT) {
    height = MIN_NODE_HEIGHT;
    width = Math.round(height * ratio);
  }
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
    width,
    height,
  };
}

/**
 * The width over the height a shape states, or null when it states none.
 *
 * Both ways of stating one are read: a proportion is what a node is asked for,
 * and a size in pixels is what a provider answers with, and the shape of an
 * answer is the shape of the ask.
 */
function proportionOf(shape: string): number | null {
  const sides = shape.trim().toLowerCase().split(/[:x]/);
  if (sides.length !== 2) return null;
  const width = Number(sides[0]);
  const height = Number(sides[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return width / height;
}

/**
 * The executor a node's step would be handed to, or null when a run could do
 * nothing with it.
 *
 * The server answers this from the same rule. Asking it here too is what keeps
 * a Run button from being offered for a node the server would only refuse.
 */
export function executorKeyForNode(node: WorkflowNode): string | null {
  const data = node.data as {
    executorKey?: string;
    generation?: GenerationSpec;
  };
  switch (node.kind) {
    case "operation":
      return data.executorKey ?? "";
    case "text":
    case "image":
    case "audio":
    case "video":
      return data.generation ? PROVIDER_EXECUTOR_KEY : null;
    case "extension":
      return EXTENSION_EXECUTOR_KEY;
    default:
      return null;
  }
}

const GENERATION_MODES: readonly GenerationMode[] = [
  "generate",
  "edit",
  "extend",
  "question",
];

const GENERATION_INPUT_MODES: readonly GenerationInputMode[] = [
  "upstream",
  "manual",
  "mentions",
];

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  or: T,
): T {
  return allowed.includes(value as T) ? (value as T) : or;
}

function words(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identifiers(value: unknown): NodeId[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is NodeId => typeof entry === "string")
    : [];
}

/**
 * The spec a snapshot says was asked for, or null when it does not describe one
 * for this kind of node.
 *
 * A snapshot comes out of a document, which another version may have written or
 * a hand may have edited, so what it says is read rather than cast: a spec
 * carrying a capability that is not one would sit on the node looking sound and
 * only be refused once a run reached it. Asking again is then the snapshot whole
 * plus a fresh timestamp, since a snapshot records what to ask for and not when
 * it was asked for.
 */
export function generationSpecFromSnapshot(
  snapshot: Record<string, unknown> | undefined,
  kind: NodeKind,
): GenerationSpec | null {
  const asked = snapshot?.capability;
  if (!snapshot || !isCapability(asked) || !capabilityServes(asked, kind)) {
    return null;
  }
  if (typeof snapshot.prompt !== "string") return null;
  return {
    capability: asked,
    mode: oneOf(snapshot.mode, GENERATION_MODES, "generate"),
    model: typeof snapshot.model === "string" ? snapshot.model : "",
    prompt: snapshot.prompt,
    inputMode: oneOf(snapshot.inputMode, GENERATION_INPUT_MODES, "upstream"),
    params: words(snapshot.params),
    referenceNodeIds: identifiers(snapshot.referenceNodeIds),
    updatedAt: nowIso(),
  };
}

/** A label in the reader's language, or the definition's own name. */
function localizedLabel(
  labels: Record<string, string>,
  fallback: string,
  locale: string,
): string {
  const chosen = labels[locale];
  return chosen && chosen.trim() ? chosen : fallback;
}

/** The ports an extension node copies from its definition when inserted. */
export function extensionPorts(
  definition: ExtensionDefinition,
  locale = "en",
): PortDefinition[] {
  return [...definition.inputs, ...definition.outputs].map((port) => ({
    id: port.id,
    direction: port.direction,
    dataTypes: [...port.dataTypes],
    required: port.required,
    cardinality: port.cardinality,
    label: localizedLabel(port.labels, port.label, locale),
  }));
}

/** The parameter values a node is born with: each declared default. */
export function extensionParameterDefaults(
  definition: ExtensionDefinition,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const parameter of definition.parameters) {
    if (parameter.default !== undefined) {
      values[parameter.key] = parameter.default;
    }
  }
  return values;
}

/**
 * A node inserted from an installed definition.
 *
 * The ports are copied onto the node here, once, because the canvas draws and
 * wires from the node's own snapshot: a definition that is removed or upgraded
 * afterwards leaves the old node looking and wiring the way it did. Bindings
 * start empty rather than being filled with defaults silently; the panel
 * offers the models and the reader chooses.
 */
export function createExtensionNode(
  definition: ExtensionDefinition,
  at: { x: number; y: number },
  locale = "en",
): WorkflowNode {
  const now = nowIso();
  const data: ExtensionNodeData = {
    extension: {
      extensionId: definition.id,
      definitionVersion: definition.version,
      apiVersion: definition.apiVersion,
      contractHash: definition.contractHash,
      bindings: {},
    },
    parameters: extensionParameterDefaults(definition),
    resultSlots: [],
    resultNodeIds: [],
  };
  return {
    id: newId(),
    kind: "extension",
    title: localizedLabel(definition.labels, definition.displayName, locale),
    bounds: {
      x: at.x,
      y: at.y,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    },
    zIndex: 0,
    ports: extensionPorts(definition, locale),
    data,
    createdAt: now,
    updatedAt: now,
  };
}

export function createNode(
  kind: NodeKind,
  at: { x: number; y: number },
  options?: {
    title?: string;
    width?: number;
    height?: number;
    generate?: boolean;
  },
): WorkflowNode {
  const now = nowIso();
  const data = defaultDataForKind(kind);
  if (options?.generate) {
    const spec = defaultGenerationSpec(kind);
    if (spec) (data as { generation?: GenerationSpec }).generation = spec;
  }
  return {
    id: newId(),
    kind,
    title: options?.title ?? i18n.t(NODE_TITLES[kind]),
    bounds: {
      x: at.x,
      y: at.y,
      width: options?.width ?? DEFAULT_NODE_WIDTH,
      height: options?.height ?? DEFAULT_NODE_HEIGHT,
    },
    zIndex: 0,
    ports: derivePorts(kind),
    data,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A card for a scene already staged.
 *
 * The scene and the card are made together, in that order, because the card
 * without its scene would be a card that opens onto nothing. The two are
 * wider than a media card: the framing preview and the status line have to
 * share the face.
 */
export function createDirectorNode(
  scene: DirectorScene,
  at: { x: number; y: number },
): WorkflowNode {
  const now = nowIso();
  return {
    id: newId(),
    kind: "director",
    title: scene.title,
    bounds: { x: at.x, y: at.y, width: 500, height: 320 },
    zIndex: 0,
    ports: derivePorts("director"),
    data: { director: { sceneId: scene.id } },
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// The story room
// ---------------------------------------------------------------------------

/** A place nothing has been drawn for yet. */
export function emptyStorySlot(): StorySlot {
  return { takes: [] };
}

export function createStoryBrief(patch: Partial<StoryBrief> = {}): StoryBrief {
  return {
    idea: patch.idea ?? "",
    ...(patch.sourceAssetId !== undefined
      ? { sourceAssetId: patch.sourceAssetId }
      : {}),
    ...(patch.sourceName !== undefined ? { sourceName: patch.sourceName } : {}),
    ...(patch.sourceSplit !== undefined
      ? { sourceSplit: patch.sourceSplit }
      : {}),
    totalDurationMs: patch.totalDurationMs ?? DEFAULT_STORY_DURATION_MS,
    aspect: patch.aspect ?? DEFAULT_STORY_ASPECT,
    genre: patch.genre ?? "",
    style: patch.style ?? "",
  };
}

/** A story with a premise and nothing made of it yet. */
export function createStory(
  name: string,
  brief: Partial<StoryBrief> = {},
): StoryDocument {
  const now = nowIso();
  return {
    id: newId(),
    name,
    schemaVersion: STORY_SCHEMA_VERSION,
    brief: createStoryBrief(brief),
    chapters: [],
    elements: [],
    shotGranularity: "act",
    maxReferenceImages: REFERENCE_IMAGES_DEFAULT,
    confirmedSteps: [],
    edit: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function nextStoryName(moka: MokaFile): string {
  const used = new Set((moka.stories ?? []).map((story) => story.name));
  const name = (n: number) => i18n.t("story:defaults.name", { n });
  let n = (moka.stories ?? []).length + 1;
  while (used.has(name(n))) n += 1;
  return name(n);
}

/** An episode of a telling, with nothing said about it yet. */
export function createChapter(title: string, synopsis = ""): StoryChapter {
  return {
    id: newId(),
    title,
    synopsis,
    targetDurationMs: 0,
    acts: [],
  };
}

/** Something the story is made of, with no drawing of it yet. */
export function createElement(
  kind: StoryElementKind,
  name: string,
  description = "",
  chapterIds: string[] = [],
): StoryElement {
  return {
    id: newId(),
    kind,
    name,
    description,
    chapterIds,
    main: emptyStorySlot(),
    ...(kind === "character" ? { turnaround: emptyStorySlot() } : {}),
  };
}

/** One stretch of story, with no board written for it yet. */
export function createAct(title: string, summary = ""): StoryAct {
  return {
    id: newId(),
    title,
    summary,
    characterIds: [],
    propIds: [],
    sound: { music: "", sfx: "" },
    keyframes: [],
    video: emptyStorySlot(),
  };
}

/** One shot of a board, named by its place: the first is "#1". */
export function createKeyframe(
  index: number,
  shotSize: StoryShotSize = "medium",
  cameraMove: StoryCameraMove = "static",
  angle: StoryCameraAngle = "eyeLevel",
): StoryKeyframe {
  return {
    id: newId(),
    title: `#${index + 1}`,
    shotSize,
    cameraMove,
    angle,
    content: "",
    dialogue: [],
    durationMs: DEFAULT_KEYFRAME_MS,
    art: emptyStorySlot(),
    video: emptyStorySlot(),
  };
}

/**
 * How many episodes a running time is cut into when nobody says otherwise:
 * about a minute each, which is as long as one telling can hold a viewer
 * before it wants a new one.
 */
export function defaultChapterCount(totalDurationMs: number): number {
  return Math.max(1, Math.round(totalDurationMs / DEFAULT_CHAPTER_MS));
}

/** What each episode is asked to run for, the total shared out evenly. */
export function chapterTargetMs(
  totalDurationMs: number,
  chapterCount: number,
): number {
  if (chapterCount <= 0) return totalDurationMs;
  return Math.round(totalDurationMs / chapterCount);
}
