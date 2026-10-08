import type {
  AssetCategory,
  AssetOrigin,
  Capability,
  ClipFilterPreset,
  ProblemCode,
  TransitionKind,
} from "./constants";
import type { StoryStep } from "./story";

export type ProjectId = string;
export type CanvasId = string;
export type FolderId = string;
export type NodeId = string;
export type EdgeId = string;
export type AssetId = string;
export type RunId = string;
export type SessionId = string;
export type MessageId = string;
export type TimelineId = string;
export type TrackId = string;
export type ClipId = string;
export type TransitionId = string;
export type IsoTimestamp = string;
export type ProjectRelativePath = string;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectMetadata {
  id: ProjectId;
  name: string;
  description?: string;
  coverPath?: ProjectRelativePath;
  revision: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ResourceEntry {
  id: AssetId;
  name: string;
  path: ProjectRelativePath;
  mime?: string;
  bytes?: number;
  sha256?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  probe?: AssetProbe;
  provenance?: AssetProvenance;
  /**
   * What a reader says about the asset, so the shelf can be searched by it.
   *
   * All of it came in without a schema version of its own: an entry stored
   * before these existed leaves them off rather than leaves them empty, so
   * reading such a project and writing it back gives the bytes it arrived with.
   */
  tags?: string[];
  note?: string;
  favorite?: boolean;
  origin?: AssetOrigin;
  /** What it is a picture of, in words: the ask it came from or the text it holds. */
  keyword?: string;
}

export interface AssetProbe {
  mime: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  codecSummary?: string;
  posterAssetId?: AssetId;
}

export interface AssetProvenance {
  runId?: RunId;
  canvasId?: CanvasId;
  operationNodeId?: NodeId;
  /**
   * The conversation that asked for this, when one did.
   *
   * Like a run, it is a reference only the machine that made it can honour:
   * conversations travel with a full backup and not with a package of the work.
   */
  assistantSessionId?: SessionId;
  /**
   * The story job whose item drew this, and the story it was drawn for.
   *
   * The pair is what a reader follows backwards from a picture to the step
   * that asked for it: a job records the words it was asked with, and the
   * story names the place in the document the answer was filed under.
   */
  storyJobId?: string;
  storyId?: string;
  inputAssetIds?: AssetId[];
  parameterSnapshot?: Record<string, unknown>;
  createdAt: IsoTimestamp;
}

export type ResourceRegistry = Record<AssetCategory, ResourceEntry[]>;

export type BackgroundMode = "dots" | "lines" | "blank";

/**
 * A directory in the project's canvas tree.
 *
 * Folders hold canvases and other folders, and hold nothing else: they are a
 * way of arranging the boards a project has rather than a container of its
 * own, so a folder carries no nodes and no assets. The parent is left off
 * rather than named for a folder at the project root, which is what a document
 * written before folders existed says about every canvas in it.
 */
export interface CanvasFolder {
  id: FolderId;
  name: string;
  /** The folder holding this one; absent means the project root. */
  parentId?: FolderId;
  createdAt: IsoTimestamp;
}

export interface DocumentSettings {
  background: BackgroundMode;
  showMinimap: boolean;
  snapToGrid: boolean;
}

export interface CanvasDocument {
  id: CanvasId;
  name: string;
  schemaVersion: number;
  viewport: Viewport;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: GroupMembership[];
  settings: DocumentSettings;
  /**
   * The conversations had over this canvas.
   *
   * Left off rather than left empty on a document written before conversations
   * existed, so that reading such a document and writing it back gives the bytes
   * it arrived with. It came in without a schema version of its own for the same
   * reason: nothing stored had to change to make room for it.
   */
  sessions?: AssistantSession[];
  /**
   * The folder this canvas sits in, when it sits in one.
   *
   * Left off rather than named for a canvas at the project root, so a document
   * written before folders existed is read and written back as the bytes it
   * arrived with. It came in without a schema version of its own for the same
   * reason as the conversations beside it.
   */
  folderId?: FolderId;
}

export interface GroupMembership {
  groupId: NodeId;
  childNodeIds: NodeId[];
}

// ---------------------------------------------------------------------------
// The cutting room: one project's timelines
// ---------------------------------------------------------------------------

/** What a track holds, which is also what a clip of that kind may land on. */
export type TrackKind = "video" | "audio" | "text";
/** Clip kinds are the same set: a clip is a track's content. */
export type ClipKind = TrackKind;

/**
 * One row of a timeline.
 *
 * The order of the list is the order the rows draw in: an upper video track
 * draws over a lower one, and an audio or text row sits wherever the reader
 * put it. Muting is sound and hiding is picture, and the two say nothing
 * about each other: a hidden track's sound still mixes in, and a muted one's
 * picture still draws. Locking is neither — it only keeps the editor from
 * moving the row's clips, and the document itself holds no rule about it.
 */
export interface TimelineTrack {
  id: TrackId;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  createdAt: IsoTimestamp;
}

/**
 * The visual grade a video clip wears. Absent means untouched.
 *
 * Each axis is a fraction of the range the picture allows, so a quarter is
 * the same intent whatever the exporter or the previewer calls it.
 */
export interface ClipAdjust {
  /** -1..1, darkening to lightening. */
  brightness: number;
  /** -1..1, flatter to punchier. */
  contrast: number;
  /** -1..1, drained to loud. */
  saturation: number;
}

/** How a text clip is written, in pixels on the timeline's own canvas. */
export interface TextClipStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  position: "top" | "center" | "bottom";
  /** #rrggbb, or null for no backing plate. */
  background: string | null;
  /** Outline width in timeline pixels; 0 is no outline. */
  strokeWidth: number;
  /** #rrggbb; always present, harmless at zero width. */
  strokeColor: string;
}

/** What a text clip says and how it is set. */
export interface TextClipData {
  content: string;
  style: TextClipStyle;
}

/**
 * A piece of material placed on a timeline.
 *
 * `startMs` is where it sits and `durationMs` is how long it runs there, so a
 * sped-up clip is shorter on the timeline than the material it reads.
 * `inPointMs`/`outPointMs` are the material's own clock, and the identity
 * `durationMs * speed === outPointMs - inPointMs` holds everywhere: a clip
 * that breaks it is refused rather than played back wrongly. An image or a
 * text clip has no material clock of its own, so its in point is 0 and its
 * out point is its duration.
 */
export interface TimelineClip {
  id: ClipId;
  trackId: TrackId;
  kind: ClipKind;
  /** What the timeline reads on the clip; the asset's name by default. */
  label: string;
  /** The material the clip reads; a text clip names none. */
  assetId?: AssetId;
  startMs: number;
  durationMs: number;
  inPointMs: number;
  outPointMs: number;
  /** 0.25..4, 1 being the material's own pace. */
  speed: number;
  /** 0..2, 1 being the material's own level. Video clips carry audio too. */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  muted: boolean;
  /** Visual grade; absent means the clip is untouched. */
  adjust?: ClipAdjust;
  /** Preset look; absent and "none" mean the same untouched thing. */
  filter?: ClipFilterPreset;
  /** 0..1, for a clip on an upper video track drawing over the one below. */
  opacity: number;
  /** Present exactly on text clips. */
  text?: TextClipData;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * How two neighbouring clips meet.
 *
 * A transition sits on the seam after `afterClipId`: its window is the tail of
 * that clip and the head of the clip that follows it on the same track, and
 * the two play together through the window. The follower's start is moved
 * back by the window's length when the transition is added, so the overlap
 * is in the document's geometry rather than implied here — and while the
 * record exists, `follower.startMs === leader.endMs − durationMs` is a
 * promise the document holds. It is the one overlap of clips a track may
 * carry; any other overlap is refused.
 */
export interface TimelineTransition {
  id: TransitionId;
  afterClipId: ClipId;
  kind: TransitionKind;
  durationMs: number;
  createdAt: IsoTimestamp;
}

/** The frame the cutting room works at and the colour it cuts to. */
export interface TimelineSettings {
  fps: number;
  width: number;
  height: number;
  background: string;
}

/**
 * One timeline: the tracks, the clips on them, and the transitions on their
 * seams.
 *
 * Clips hold their own `trackId` rather than sitting in per-track lists, so a
 * clip moved between rows is one field's change and the rows are an order the
 * reader chose, not one the document has to keep in two places.
 */
export interface TimelineDocument {
  id: TimelineId;
  name: string;
  schemaVersion: number;
  settings: TimelineSettings;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  transitions: TimelineTransition[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** Who a line of a conversation is from: the reader, a model, or a failure. */
export type AssistantRole = "user" | "assistant" | "error";

/**
 * A card a line was asked about, as that line remembered it.
 *
 * The title and the kind are kept beside the id because the card may be gone by
 * the time the line is read again, and a line that can say only "a card that no
 * longer exists" tells nobody what was asked about.
 */
export interface AssistantReference {
  nodeId: NodeId;
  title: string;
  kind: NodeKind;
  assetId?: AssetId;
}

/** A run a line set going, noted so the line can say what it started. */
export interface AssistantToolCall {
  runId: RunId;
  nodeId?: NodeId;
  summary: string;
}

/** Why a line that failed failed, and whether asking again could work. */
export interface AssistantFailure {
  code: ProblemCode;
  retryable: boolean;
}

export interface AssistantMessage {
  id: MessageId;
  role: AssistantRole;
  text: string;
  createdAt: IsoTimestamp;
  references?: AssistantReference[];
  toolCalls?: AssistantToolCall[];
  failure?: AssistantFailure;
}

/**
 * One conversation about one canvas, carried by the canvas itself.
 *
 * A canvas holds its own and never another's: what was asked about the cards on
 * this board belongs to this board, so opening a document opens onto the
 * conversations that were had over it.
 */
export interface AssistantSession {
  id: SessionId;
  title: string;
  messages: AssistantMessage[];
  createdAt: IsoTimestamp;
  /**
   * When something was last said, which is how the newest conversation is found.
   *
   * Only ever moves forward: taking a line back does not put this back with it,
   * since a conversation just taken back out of is still the one to open onto.
   */
  updatedAt: IsoTimestamp;
}

export type NodeKind =
  "text" | "image" | "audio" | "video" | "operation" | "group" | "export";

export type DataType =
  "text" | "image" | "audio" | "video" | "timeline" | "artifact";

export interface PortDefinition {
  id: string;
  direction: "input" | "output";
  dataTypes: DataType[];
  required: boolean;
  cardinality: "one" | "many";
  label: string;
}

export interface ResultSlot {
  id: string;
  status: "empty" | "pending" | "succeeded" | "failed";
  assetId?: AssetId;
  text?: string;
  error?: string;
  isPrimary: boolean;
}

export type GenerationMode = "generate" | "edit" | "extend" | "question";

export type GenerationInputMode = "upstream" | "manual" | "mentions";

/**
 * What a node asks a provider to make. Absent on nodes created before the
 * generation features and on nodes the user never configured.
 */
export interface GenerationSpec {
  capability: Capability;
  mode: GenerationMode;
  /** A model configuration id; empty means fall back to the category default. */
  model: string;
  prompt: string;
  inputMode: GenerationInputMode;
  params: Record<string, unknown>;
  referenceNodeIds: NodeId[];
  updatedAt: IsoTimestamp;
}

export interface TextNodeStyle {
  fontSize?: number;
  align?: "left" | "center" | "right";
}

export interface TextNodeData {
  content: string;
  style?: TextNodeStyle;
  assetId?: AssetId;
  resultSlots?: ResultSlot[];
  generation?: GenerationSpec;
}

export interface MediaNodeData {
  assetId?: AssetId;
  posterAssetId?: AssetId;
  audioCategory?: "music" | "voice";
  resultSlots?: ResultSlot[];
  /**
   * Child nodes holding the results past the first, when one generation asked
   * for several. This node keeps the primary result itself.
   */
  resultNodeIds?: NodeId[];
  metadata?: Record<string, unknown>;
  generation?: GenerationSpec;
}

export interface OperationNodeData {
  operationType: string;
  parameters: Record<string, unknown>;
  executorKey: string;
  resultSlots?: ResultSlot[];
  resultNodeIds?: NodeId[];
}

export interface GroupNodeData {
  color: string;
  childNodeIds: NodeId[];
}

export interface ExportNodeData {
  format: string;
  parameters: Record<string, unknown>;
}

export type NodeData =
  | TextNodeData
  | MediaNodeData
  | OperationNodeData
  | GroupNodeData
  | ExportNodeData;

export interface WorkflowNode {
  id: NodeId;
  kind: NodeKind;
  title: string;
  bounds: Rect;
  zIndex: number;
  ports: PortDefinition[];
  data: NodeData;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface EdgeEndpoint {
  nodeId: NodeId;
  portId: string;
}

export interface WorkflowEdge {
  id: EdgeId;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
  createdAt: IsoTimestamp;
}

export interface MokaFile {
  version: "v1";
  metadata: ProjectMetadata;
  resources: ResourceRegistry;
  /**
   * The directories of the canvas tree, in the order the tree reads them.
   *
   * Left off rather than left empty on a document that has no folders, which is
   * every document written before they existed: a project with a flat list of
   * canvases says so by carrying nothing here.
   */
  folders?: CanvasFolder[];
  /**
   * The project's timelines, in the order the cutting room's tabs read them.
   *
   * Left off rather than left empty on a document that has no timelines,
   * which is every document written before the cutting room existed: a
   * project that has cut nothing says so by carrying nothing here, and an
   * older build reading a newer document skips the field it does not know
   * rather than failing on it.
   */
  timelines?: TimelineDocument[];
  /**
   * The stories this project has told, in the order the story room's list
   * reads them.
   *
   * Left off rather than left empty on a document that tells none: a project
   * that has never opened the story room says so by carrying nothing here,
   * and an older build reading a newer document skips the field it does not
   * know rather than failing on it.
   */
  stories?: StoryDocument[];
  canvas: CanvasDocument[];
}

// -----------------------------------------------------------------------------
// The story room: a premise told, chapter by chapter, into a finished film.
//
// The five steps are one document: the brief the whole of it rests on, the
// chapters it was divided into, the elements every picture is drawn from, the
// boards that name each shot, and the timeline the whole was assembled into.
// A step's own working state — which job is running, which item failed — is
// not here: this is what was decided, not what is being tried.
// -----------------------------------------------------------------------------

/** What a reader settled on before a word was written. */
export interface StoryBrief {
  /** The premise, as typed, or lifted out of an uploaded manuscript. */
  idea: string;
  /** The uploaded manuscript's place in the shelf, when one was uploaded. */
  sourceAssetId?: AssetId;
  /** The uploaded file's name, only ever shown to say where the words came from. */
  sourceName?: string;
  /** Whether the manuscript has been divided into chapters already. */
  sourceSplit?: boolean;
  /** How long the whole telling is meant to run, in milliseconds. */
  totalDurationMs: number;
  /** The frame the finished film is cut to. */
  aspect: StoryAspect;
  /** The genre, in the reader's own words. */
  genre: string;
  /** The look, in the reader's own words; every picture prompt carries it. */
  style: string;
}

export const STORY_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "21:9"] as const;
export type StoryAspect = (typeof STORY_ASPECTS)[number];

export const STORY_ELEMENT_KINDS = ["character", "scene", "prop"] as const;
export type StoryElementKind = (typeof STORY_ELEMENT_KINDS)[number];

/**
 * Every take a place in the story has been given.
 *
 * A place is redrawn rather than overwritten: the earlier takes stay, the
 * newest is the one in use, and a reader who liked the third better than the
 * fourth can say so by keeping it. Nothing here is agreed to one place at a
 * time — what a reader settles is the step the place stands in, whole.
 */
export interface StorySlot {
  takes: StoryTake[];
}

/**
 * One filming of one place: the files it is made of, and where the ask for
 * them is written down.
 *
 * Usually one file. An act longer than one clip may be is filmed in pieces and
 * kept as the pieces, in the order they play, because that is what the provider
 * could make of it: the card plays them one after another and the assembly lays
 * them down end to end.
 */
export interface StoryTake {
  /** The files, in the order they play; never empty. */
  assetIds: AssetId[];
  /** The job item that drew it, so a redraw can tell its own work from a reader's. */
  jobId?: string;
  itemId?: string;
  /** What the ask said, in a line, for a reader deciding which take to keep. */
  note?: string;
  createdAt: IsoTimestamp;
}

export const STORY_SHOT_SIZES = [
  "extremeClose",
  "close",
  "mediumClose",
  "medium",
  "mediumFull",
  "full",
  "wide",
  "extremeWide",
] as const;
export type StoryShotSize = (typeof STORY_SHOT_SIZES)[number];

export const STORY_CAMERA_MOVES = [
  "static",
  "handheld",
  "pushIn",
  "pullOut",
  "panLeft",
  "panRight",
  "tiltUp",
  "tiltDown",
  "trackLeft",
  "trackRight",
  "arc",
  "craneUp",
  "zoomIn",
  "zoomOut",
] as const;
export type StoryCameraMove = (typeof STORY_CAMERA_MOVES)[number];

export const STORY_CAMERA_ANGLES = [
  "eyeLevel",
  "high",
  "low",
  "overhead",
  "dutch",
  "overTheShoulder",
  "pointOfView",
] as const;
export type StoryCameraAngle = (typeof STORY_CAMERA_ANGLES)[number];

/**
 * What a drawn frame is for when the act is shot.
 *
 * `firstFrame` opens a video of its own, `firstLastFrame` pairs with the frame
 * after it as the ends of one video, and `reference` joins the run of
 * references around it. Absent means `reference`, which is what a board that
 * has never heard of roles means.
 */
export const STORY_FILM_ROLES = [
  "reference",
  "firstFrame",
  "firstLastFrame",
] as const;
export type StoryFilmRole = (typeof STORY_FILM_ROLES)[number];

/**
 * A line of dialogue.
 *
 * A line is known by a name of its own because things are kept for one line at
 * a time: the take a line was read aloud in, whether it is being read just
 * now, and whether the words have been edited since. Position would not do —
 * a line inserted above would move every take below it onto the wrong words.
 *
 * The speaker's name is kept beside the reference, so a line still reads after
 * its character has been taken out of the story.
 */
export interface StoryDialogueLine {
  id: string;
  characterId?: string;
  speaker: string;
  text: string;
  /** How the line is delivered; the voicing pass reads it. */
  tone?: string;
}

/** One row of a board: a single shot held for a while. */
export interface StoryKeyframe {
  id: string;
  title: string;
  shotSize: StoryShotSize;
  cameraMove: StoryCameraMove;
  angle: StoryCameraAngle;
  /** How the frame is used when the act is shot; absent means `reference`. */
  filmRole?: StoryFilmRole;
  /** What this shot shows. */
  content: string;
  dialogue: StoryDialogueLine[];
  durationMs: number;
  /** The frame drawn for this shot. */
  art: StorySlot;
  /** This shot's own clip, when the story is boarded a shot at a time. */
  video: StorySlot;
  /**
   * The lines of this shot read aloud, each in its own speaker's voice. A
   * line that was read then edited keeps its take — it is what was said, and
   * the card says so — and a line taken out of the shot leaves its take an
   * orphan, which the assembly no longer lays down.
   */
  voices?: StoryVoiceTake[];
}

/** What an act sounds like. */
export interface StoryActSound {
  music: string;
  sfx: string;
  ambience?: string;
}

/**
 * An act: one stretch of story, and the unit a clip is made of.
 *
 * Everything in it stays the reader's to edit for as long as the telling is
 * being worked on: a board is argued with rather than sealed, and what a
 * picture or a clip was made from is allowed to move on afterwards.
 */
export interface StoryAct {
  id: string;
  title: string;
  summary: string;
  /** The characters in this act, by the element ids step three settled on. */
  characterIds: string[];
  sceneId?: string;
  propIds: string[];
  sound: StoryActSound;
  keyframes: StoryKeyframe[];
  /** The act's whole clip, when the story is boarded an act at a time. */
  video: StorySlot;
  /**
   * The lines of this act read aloud, in one voice, and the music and sound
   * under it. Optional because a telling made before either was asked for is
   * still a telling: a slot that is not there has simply never been made.
   */
  voice?: StorySlot;
  music?: StorySlot;
}

/** A chapter — one episode of the telling. */
export interface StoryChapter {
  id: string;
  title: string;
  synopsis: string;
  /** What this episode is meant to run for; the brief's total shares out evenly. */
  targetDurationMs: number;
  /** The board for this episode, made in step four. */
  acts: StoryAct[];
}

/**
 * The voice one character — or the telling itself — is read in.
 *
 * A field left empty is handed to the next voice behind it: the character's own
 * settings stand over the telling's, which stand over what the machine is set
 * to, so naming only a voice on a character still says what is wanted of them.
 * The model is a configuration id on this machine, kept the way a card's ask
 * keeps the one it was asked of: a model this machine has not got is not a
 * reason to lose the voice, only to say so and read with what is behind it.
 */
export interface StoryVoiceProfile {
  /** A speech model configuration id; empty hands the choice to the next voice. */
  model: string;
  /** The voice the provider knows — `longxiaochun`, `alloy`; empty for its default. */
  voice: string;
  /** How fast and how high, where this voice is not the machine's own. */
  rate?: number;
  pitch?: number;
  /** How this one reads, on top of the telling's own direction. */
  instructions?: string;
  /**
   * A recording this voice is copied from, when it is heard rather than
   * named. A voice has two ways of being said — a name the provider knows
   * and a piece of sound to imitate — and this is the second.
   */
  referenceAssetId?: AssetId;
}

/** Something the story is made of: a character, a place, a thing. */
export interface StoryElement {
  id: string;
  kind: StoryElementKind;
  name: string;
  description: string;
  /** The chapters this was noticed in; empty when the outline did not say. */
  chapterIds: string[];
  main: StorySlot;
  /** The full-length turn-around view, which only a character is drawn with. */
  turnaround?: StorySlot;
  /** The voice this one speaks in; only a character is read aloud. */
  voice?: StoryVoiceProfile;
}

export const STORY_SHOT_GRANULARITIES = ["act", "keyframe"] as const;
export type StoryShotGranularity = (typeof STORY_SHOT_GRANULARITIES)[number];

/** What step five assembled the story into. */
export interface StoryEdit {
  /** The timeline the acts were laid down on. */
  timelineId?: TimelineId;
  /**
   * Which clips this story's assembly put on that timeline.
   *
   * Kept so a re-assembly overwrites its own work and nothing else: clips a
   * reader moved there by hand, or a different story laid down, are not this
   * story's to take away.
   */
  clipByAct?: Array<{ actId: string; keyframeId?: string; clipId: ClipId }>;
  /**
   * What the timeline was laid down from, as one short reading of it.
   *
   * The telling changes after it is assembled — a line re-read, a shot refilmed
   * — and what is on the timeline is then behind it. This is how the room
   * notices: the film card plans the assembly the telling would make now and
   * compares. A document written before this existed carries none, which reads
   * as "behind", and the next assembly writes it.
   */
  assembledDigest?: string;
}

export interface StoryDocument {
  id: string;
  name: string;
  schemaVersion: number;
  brief: StoryBrief;
  chapters: StoryChapter[];
  elements: StoryElement[];
  /** Whether a clip is made of a whole act or of each of its shots. */
  shotGranularity: StoryShotGranularity;
  /**
   * How many of a frame's mentioned reference pictures its ask may carry.
   *
   * The mentions in a shot's content name the elements whose drawings travel
   * with it, in the order they are named; this is how many of them fit in one
   * ask, past which the rest are left to the words.
   */
  maxReferenceImages: number;
  /**
   * The steps of the telling that have been settled, in telling order.
   *
   * A step is settled when the reader presses its own confirm and the step has
   * everything it needs — every chapter written, every element drawn, every act
   * filmed. This is the whole of the room's gatekeeping: the step after a
   * settled one is open, and nothing else opens it.
   */
  confirmedSteps: StoryStep[];
  /**
   * The telling's own voice: the one a line is read in when its speaker is not
   * a character of the cast, and what every character's own voice stands over.
   */
  narrator?: StoryVoiceProfile;
  edit: StoryEdit;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * A place in a story that holds a slot, as a command names it.
 *
 * The same vocabulary the job targets are written in, one level down: a job
 * asks for a drawing at a place, a command files the answer there.
 */
export type StorySlotTarget =
  | { kind: "element"; elementId: string; view: "main" | "turnaround" }
  | {
      kind: "keyframe";
      chapterId: string;
      actId: string;
      keyframeId: string;
    }
  | { kind: "actVideo"; chapterId: string; actId: string }
  | {
      kind: "keyframeVideo";
      chapterId: string;
      actId: string;
      keyframeId: string;
    }
  /** The act's lines read aloud — one clip for the whole act, not one a shot. */
  | { kind: "actVoice"; chapterId: string; actId: string }
  /** One line of dialogue read on its own, in the voice its speaker has. */
  | {
      kind: "lineVoice";
      chapterId: string;
      actId: string;
      keyframeId: string;
      lineId: string;
    }
  /** The music and sound under an act, asked for as one piece. */
  | { kind: "actMusic"; chapterId: string; actId: string };

/**
 * One line of dialogue read aloud, and what it says.
 *
 * Kept per line rather than per act because every character speaks in their
 * own voice: the words as they were read — which is how a line edited since
 * is told from one that has not been — and the tone it was read in, so the
 * card can say whose voice it is without reading the voice chain again.
 */
export interface StoryVoiceTake {
  /** The line it reads, by the line's own name. */
  lineId: string;
  /** The words the ask carried, which the line's current words are read against. */
  text: string;
  /** The tone it was read in; empty is the model's own default. */
  voice: string;
  slot: StorySlot;
}

/**
 * Something pointing at a file, told apart by what letting the file go would
 * take.
 *
 * A card and a place's old drawing are the two a delete can take out of what
 * holds them; the drawing a place is using, a clip cut into a timeline, and a
 * story's manuscript are the ones it cannot — those are named to the reader
 * instead, since the way out of them is a change somewhere else.
 */
export type AssetHolder =
  | { kind: "node"; canvasId: CanvasId; nodeId: NodeId }
  /** A drawing a story place keeps but is not using. */
  | {
      kind: "drawing";
      storyId: string;
      storyName: string;
      target: StorySlotTarget;
    }
  /** The drawing a story place is using, which cannot be taken from it. */
  | {
      kind: "drawingInUse";
      storyId: string;
      storyName: string;
      target: StorySlotTarget;
    }
  /** A clip on a timeline reading the file as its material. */
  | {
      kind: "clip";
      timelineId: TimelineId;
      timelineName: string;
      clipId: ClipId;
      clipLabel: string;
    }
  /** A story's manuscript. */
  | {
      kind: "storyFile";
      storyId: string;
      storyName: string;
      what: "manuscript";
    };

/** A story place keeping a file only as a drawing it is not using. */
export type AssetDrawing = Extract<AssetHolder, { kind: "drawing" }>;

/** The fields a caller may move on an element, for `updateStoryElement`. */
export interface StoryElementPatch {
  name?: string;
  kind?: StoryElementKind;
  description?: string;
  /** The chapters it was noticed in, whole; a chapter the story has not got is refused. */
  chapterIds?: string[];
  /** The voice it speaks in, whole; a null takes it away. */
  voice?: StoryVoiceProfile | null;
}

/**
 * The fields a caller may move on an act, for `updateStoryAct`.
 *
 * A field left off is not touched; `sceneId: null` is how a scene is taken
 * away, since JSON cannot spell "this key goes away" any other way. Every
 * patch that arrives through the document pipeline is JSON, so the merge rule
 * and the undo rule are one rule: what a patch carries moves, what a patch
 * carries as null goes.
 */
export interface StoryActPatch {
  title?: string;
  summary?: string;
  characterIds?: string[];
  sceneId?: string | null;
  propIds?: string[];
  sound?: StoryActSound;
}

/** The fields a caller may move on a shot, for `updateStoryKeyframe`. */
export interface StoryKeyframePatch {
  title?: string;
  shotSize?: StoryShotSize;
  cameraMove?: StoryCameraMove;
  angle?: StoryCameraAngle;
  filmRole?: StoryFilmRole;
  content?: string;
  dialogue?: StoryDialogueLine[];
  durationMs?: number;
}

/**
 * The fields a caller may move on the brief, for `updateStoryBrief`.
 *
 * The three fields that may be absent take a null the same way an act's scene
 * does: a manuscript a reader took away is not a manuscript that was never
 * there, and the undo of adding one has to be able to say so.
 */
export interface StoryBriefPatch {
  idea?: string;
  sourceAssetId?: AssetId | null;
  sourceName?: string | null;
  sourceSplit?: boolean | null;
  totalDurationMs?: number;
  aspect?: StoryAspect;
  genre?: string;
  style?: string;
}

/** The fields a caller may move on the assembly, for `setStoryEdit`. */
export interface StoryEditPatch {
  timelineId?: TimelineId | null;
  clipByAct?: Array<{
    actId: string;
    keyframeId?: string;
    clipId: ClipId;
  }> | null;
  assembledDigest?: string | null;
}

export interface NodePatch {
  title?: string;
  zIndex?: number;
  data?: NodeData;
}

/**
 * The fields a caller may move on a clip.
 *
 * A field left off is not touched; `adjust: null` is how a grade is cleared,
 * since JSON cannot spell "this key goes away" any other way. Every patch
 * that arrives through the document pipeline is JSON, so the merge rule and
 * the undo rule are one rule: what a patch carries moves, what a patch
 * carries as null goes.
 */
export type ClipPatch = Partial<Omit<TimelineClip, "adjust">> & {
  adjust?: ClipAdjust | null;
};

/** A change to one clip, named by id, for `updateClips`. */
export interface ClipPatchEntry {
  clipId: ClipId;
  patch: ClipPatch;
}

export type DocumentCommand =
  /**
   * The project's own words: what it is called and what it is about. The two
   * are set together, which is how the settings form submits them, so the
   * undo of an edit puts back exactly what was there; an empty description is
   * no description at all.
   */
  | {
      type: "updateProjectMetadata";
      name: string;
      description: string;
    }
  | { type: "addNode"; canvasId: CanvasId; node: WorkflowNode }
  | {
      type: "updateNode";
      canvasId: CanvasId;
      nodeId: NodeId;
      patch: NodePatch;
    }
  | {
      type: "moveNodes";
      canvasId: CanvasId;
      positions: Record<NodeId, Point>;
    }
  | { type: "resizeNode"; canvasId: CanvasId; nodeId: NodeId; bounds: Rect }
  | { type: "removeNodes"; canvasId: CanvasId; nodeIds: NodeId[] }
  | { type: "addEdge"; canvasId: CanvasId; edge: WorkflowEdge }
  | { type: "removeEdges"; canvasId: CanvasId; edgeIds: EdgeId[] }
  | {
      type: "setGroupMembership";
      canvasId: CanvasId;
      groupId: NodeId;
      childNodeIds: NodeId[];
    }
  | { type: "setViewport"; canvasId: CanvasId; viewport: Viewport }
  /**
   * A change to how the canvas itself is shown. Only what is named moves, so a
   * caller changing the background leaves the minimap preference where it was.
   */
  | {
      type: "setCanvasSettings";
      canvasId: CanvasId;
      settings: Partial<DocumentSettings>;
    }
  /**
   * A canvas's conversations. Lines are added and taken away rather than the
   * list rewritten, so a turn carries only what it said: a conversation is kept
   * to a length that can be read through, and sending the whole of one across
   * for every line would cost more than the line.
   */
  | {
      type: "addSession";
      canvasId: CanvasId;
      session: AssistantSession;
      index?: number;
    }
  | {
      type: "renameSession";
      canvasId: CanvasId;
      sessionId: SessionId;
      title: string;
    }
  | { type: "removeSession"; canvasId: CanvasId; sessionId: SessionId }
  /**
   * `at` is where the lines land in the list as it stands when the command is
   * applied, and is the tail when left off. It exists for the undo of a
   * conversation that had to let its oldest lines go to make room.
   */
  | {
      type: "appendMessages";
      canvasId: CanvasId;
      sessionId: SessionId;
      messages: AssistantMessage[];
      at?: number;
    }
  | {
      type: "removeMessages";
      canvasId: CanvasId;
      sessionId: SessionId;
      messageIds: MessageId[];
    }
  | { type: "addCanvas"; canvas: CanvasDocument; index?: number }
  | { type: "renameCanvas"; canvasId: CanvasId; name: string }
  | { type: "reorderCanvas"; canvasId: CanvasId; index: number }
  | { type: "removeCanvas"; canvasId: CanvasId }
  /**
   * The canvas tree.
   *
   * A folder is added whole, its parent named on it rather than beside it, and
   * `index` is the place it takes among that parent's folders. What a canvas
   * sits in is moved by `moveCanvas`, whose `index` is the place it takes among
   * the canvases of the folder it lands in — both are read within their own
   * siblings, since the tree holds folders and canvases as two lists.
   */
  | { type: "addFolder"; folder: CanvasFolder; index?: number }
  | { type: "renameFolder"; folderId: FolderId; name: string }
  | {
      type: "moveFolder";
      folderId: FolderId;
      parentId: FolderId | null;
      index: number;
    }
  /**
   * Takes a folder out of the tree and leaves what it held where a reader can
   * still reach it: its folders and its canvases move up into the folder that
   * held it, at the place it held among its own siblings. Nothing on a canvas
   * is deleted by tidying the tree, so a folder let go of by mistake is one
   * undo from being as it was, boards and all.
   */
  | { type: "removeFolder"; folderId: FolderId }
  | {
      type: "moveCanvas";
      canvasId: CanvasId;
      folderId: FolderId | null;
      index: number;
    }
  // -------------------------------------------------------------------------
  // The cutting room. Every command names the timeline it works on, and none
  // of them reaches into the canvases: the two halves of a document do not
  // borrow each other's geometry.
  // -------------------------------------------------------------------------
  /** A timeline is added whole — its tracks, clips, and transitions included. */
  | { type: "addTimeline"; timeline: TimelineDocument; index?: number }
  | { type: "removeTimeline"; timelineId: TimelineId }
  | { type: "renameTimeline"; timelineId: TimelineId; name: string }
  /**
   * A change to the timeline's own frame: only what is named moves, so a
   * reader changing the frame rate leaves the resolution where it was.
   */
  | {
      type: "updateTimelineSettings";
      timelineId: TimelineId;
      settings: Partial<TimelineSettings>;
    }
  /** A track is added empty; its clips arrive by `addClips` naming it. */
  | {
      type: "addTrack";
      timelineId: TimelineId;
      track: TimelineTrack;
      index?: number;
    }
  /**
   * Takes a track out only when it holds nothing: taking a track and its clips
   * in one go is a deletion the reader did not watch, so the caller is asked to
   * clear the row first.
   */
  | { type: "removeTrack"; timelineId: TimelineId; trackId: TrackId }
  /** Only what is named moves, so renaming a track leaves its mute where it was. */
  | {
      type: "updateTrack";
      timelineId: TimelineId;
      trackId: TrackId;
      patch: Partial<
        Pick<TimelineTrack, "name" | "muted" | "hidden" | "locked">
      >;
    }
  /**
   * Clips land together — a division or a paste arrives as many clips in one
   * step of history, and one seam's transition is taken out with the clip it
   * belongs to by `removeClips`, never by this command.
   *
   * `seams` restores transitions together with the clips they join, in one
   * step: the undo of a removal must not pass through the bare overlap a
   * landed seam would otherwise be. Restored seams are read as already in
   * place — nothing is pulled back — while `addTransitions` is the command
   * that makes a seam, pulling the follower itself.
   */
  | {
      type: "addClips";
      timelineId: TimelineId;
      clips: TimelineClip[];
      seams?: TimelineTransition[];
    }
  | { type: "removeClips"; timelineId: TimelineId; clipIds: ClipId[] }
  /**
   * A change to what a clip is or how it plays. Only the fields the patch
   * carries move, so changing a clip's volume leaves its text alone; a clip
   * whose patch moves or stretches it is re-checked against its neighbours,
   * since two clips cannot hold the same place on a track.
   */
  | {
      type: "updateClips";
      timelineId: TimelineId;
      patches: ClipPatchEntry[];
    }
  /**
   * Only where a clip sits: `startMs` on the timeline's clock and, when the
   * clip is named for a different track, the `trackId` it lands on. A move
   * re-checks against the clips already on the track it lands on.
   */
  | {
      type: "moveClips";
      timelineId: TimelineId;
      moves: { clipId: ClipId; startMs: number; trackId?: TrackId }[];
    }
  /**
   * A transition lands on a seam: the clip it follows must have a neighbour
   * behind it and the two must be butted, and the command pulls the follower
   * back by the window's length itself so the overlap the window plays is
   * the geometry the document then holds. A batch is listed left to right
   * along the track.
   */
  | {
      type: "addTransitions";
      timelineId: TimelineId;
      transitions: TimelineTransition[];
    }
  /**
   * Transitions come off their seams and the followers take their places
   * back. A batch is listed left to right along the track, and seams this
   * batch itself undoes do not count against it; what remains broken — a
   * follower running into the clip behind it, or a seam the release tears
   * out from under another — is refused.
   */
  | {
      type: "removeTransitions";
      timelineId: TimelineId;
      transitionIds: TransitionId[];
    }
  // -------------------------------------------------------------------------
  // The story room. Everything here names the story it works on and nothing
  // else: a story is a document of its own, and the steps that fill it in do
  // not reach into the canvases or the cutting room.
  // -------------------------------------------------------------------------
  /** A story arrives whole — its brief, and whatever the steps have settled. */
  | { type: "addStory"; story: StoryDocument; index?: number }
  /**
   * Takes a story out of the project.
   *
   * What it assembled is left standing: the timeline it wrote stays in the
   * cutting room with its clips, because a film a reader can still watch is
   * not this command's to throw away. What goes is the record of the story
   * having made it.
   */
  | { type: "removeStory"; storyId: string }
  | { type: "renameStory"; storyId: string; name: string }
  /**
   * A change to what the whole telling rests on. Only the fields the patch
   * carries move, and nothing already made is remade: a longer running time
   * changes what the next generation is asked for, not the boards that
   * already exist.
   */
  | { type: "updateStoryBrief"; storyId: string; patch: StoryBriefPatch }
  /** Only the granularity moves; clips already made are kept as they are. */
  | {
      type: "updateStoryGranularity";
      storyId: string;
      shotGranularity: StoryShotGranularity;
    }
  /** Only the picture limit moves; frames already drawn are kept as they are. */
  | {
      type: "updateStoryReferenceLimit";
      storyId: string;
      maxReferenceImages: number;
    }
  /**
   * One step of the telling, settled.
   *
   * Pressing a step's own confirm is what opens the step after it, and taking
   * the confirmation back is what the undo of that press writes. What a step
   * needs before it may be settled is the room's own reading of the document
   * and is not repeated here: this records the reader's word, not the check
   * behind it.
   */
  | {
      type: "confirmStoryStep";
      storyId: string;
      step: StoryStep;
      confirmed: boolean;
    }
  /**
   * The outline, whole.
   *
   * A chapter arriving with an id the story already knows keeps its board and
   * everything that was settled on it, and only its words are replaced; a
   * chapter that is not in the new list takes its board with it. The caller
   * is expected to have said as much before asking, since what is dropped
   * here is not read back.
   */
  | { type: "setStoryChapters"; storyId: string; chapters: StoryChapter[] }
  /**
   * The cast, whole.
   *
   * An element arriving with a known id keeps its drawings and the reader's
   * answers about them; one that is not in the new list is taken out of the
   * story, though the pictures it was drawn in stay in the shelf.
   */
  | { type: "setStoryElements"; storyId: string; elements: StoryElement[] }
  | {
      type: "updateStoryElement";
      storyId: string;
      elementId: string;
      patch: StoryElementPatch;
    }
  /**
   * The telling's own voice, whole, or nothing where it had one.
   *
   * Kept on the telling rather than on the cast because it belongs to nobody:
   * a line whose speaker is not a character of the story is read in this one.
   */
  | {
      type: "updateStoryNarrator";
      storyId: string;
      narrator: StoryVoiceProfile | null;
    }
  /**
   * One episode's board, whole.
   *
   * An act arriving with a known id keeps its frames, its clip, and the
   * reader's answers; one that leaves the list is dropped with them.
   */
  | {
      type: "setStoryActs";
      storyId: string;
      chapterId: string;
      acts: StoryAct[];
    }
  /** Only the fields the patch carries move; a sound is replaced as one thing. */
  | {
      type: "updateStoryAct";
      storyId: string;
      chapterId: string;
      actId: string;
      patch: StoryActPatch;
    }
  | {
      type: "updateStoryKeyframe";
      storyId: string;
      chapterId: string;
      actId: string;
      keyframeId: string;
      patch: StoryKeyframePatch;
    }
  /**
   * One place's takes, whole.
   *
   * Whole rather than one take added at a time, because keeping an older take
   * and dropping the newest is as ordinary as the reverse: what a reader
   * settled on is the order and the content of this list, and the undo of a
   * redraw puts the list back as it was.
   */
  | {
      type: "setStorySlot";
      storyId: string;
      target: StorySlotTarget;
      slot: StorySlot;
      /**
       * What a line was read as, for a `lineVoice` target: the words the ask
       * carried, and the tone it was read in. Left off for every other place,
       * which keeps a drawing — no words of its own to keep.
       */
      read?: { text: string; voice: string };
    }
  /** What the story was assembled into, whole. */
  | { type: "setStoryEdit"; storyId: string; patch: StoryEditPatch };

export interface SelfCheckIssue {
  assetId: AssetId;
  name: string;
  expectedPath: ProjectRelativePath;
  reason: "missing" | "changed" | "empty";
  referencingNodes: { canvasId: CanvasId; nodeId: NodeId; title: string }[];
}

export interface SelfCheckReport {
  ok: boolean;
  issues: SelfCheckIssue[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  canvasId?: CanvasId;
  nodeId?: NodeId;
  portId?: string;
  edgeId?: EdgeId;
  timelineId?: TimelineId;
  trackId?: TrackId;
  clipId?: ClipId;
  transitionId?: TransitionId;
}

export type RunStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface RunStepRecord {
  nodeId: NodeId;
  status: RunStatus;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  error?: string;
  /** What kind of trouble the step hit, and the values behind it. */
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
  outputAssetIds?: AssetId[];
  outputText?: string;
  /**
   * The handle a step that runs as an upstream job is polled by. This process
   * issued it, so it names no provider.
   */
  taskId?: string;
  taskCreatedAt?: IsoTimestamp;
  /** 0 to 1. Absent means nobody reported one, which is not the same as 0. */
  progress?: number;
}

export interface RunRecord {
  id: RunId;
  projectId: ProjectId;
  canvasId: CanvasId;
  requestedNodeIds: NodeId[];
  status: RunStatus;
  executorKey: string;
  graphHash: string;
  parameters: Record<string, unknown>;
  retryOfRunId?: RunId;
  /**
   * The conversation that asked for this, when a conversation did.
   *
   * What the assets this run files are traced back to, which is why the record
   * holds it: a card made on somebody's behalf has to be told whose.
   */
  assistantSessionId?: SessionId;
  steps: RunStepRecord[];
  error?: string;
  /** The trouble the run ended on, as the step that hit it classified it. */
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
  cancelRequested: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type WorkflowValue =
  | { type: "text"; text: string; source: ValueProvenance }
  | {
      type: "image" | "audio" | "video";
      assetId: AssetId;
      source: ValueProvenance;
    }
  | {
      type: "artifact";
      assetId: AssetId;
      mediaType?: DataType;
      source: ValueProvenance;
    };

export interface ValueProvenance {
  nodeId: NodeId;
  portId: string;
}
