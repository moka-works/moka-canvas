import type {
  BackgroundMode,
  DataType,
  NodeKind,
  PortDefinition,
  StoryAspect,
} from "./types";

export const MOKA_MAGIC = [0x4d, 0x4f, 0x4b, 0x41] as const;
export const MOKA_FILE_VERSION = "v1" as const;
// Version 3 split the audio capability into speech and music; the codec
// rewrites a v2 canvas's generation specs on decode.
export const CANVAS_SCHEMA_VERSION = 3;
export const PACKAGE_FORMAT_VERSION = 2;

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 5.0;
/** The three ways a canvas draws what is behind its nodes. */
export const BACKGROUND_MODES: readonly BackgroundMode[] = [
  "dots",
  "lines",
  "blank",
];
export const GRID_BASE_SPACING = 48;
export const GRID_FADE_ZOOM = 0.12;
export const LOW_DETAIL_ZOOM = 0.35;

export const COORDINATE_LIMIT = 1_000_000;
export const MAX_TITLE_LENGTH = 200;
export const MAX_CANVAS_NAME_LENGTH = 80;
export const MAX_PROJECT_NAME_LENGTH = 120;
export const MAX_TEXT_CONTENT_LENGTH = 50_000;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_RESULT_SLOTS = 16;
export const MAX_NODES_PER_CANVAS = 5_000;
export const MAX_EDGES_PER_CANVAS = 10_000;
export const MAX_CANVASES_PER_PROJECT = 64;
/** How many directories one project's canvas tree holds. */
export const MAX_FOLDERS_PER_PROJECT = 256;
export const MAX_FOLDER_NAME_LENGTH = 80;
/**
 * How deep a folder may sit in another.
 *
 * A ceiling on the tree rather than on the work: past this a reader is
 * navigating a filing system instead of choosing a board, and a document that
 * arrives deeper is refused rather than silently flattened.
 */
export const MAX_FOLDER_DEPTH = 8;
export const MAX_RESOURCES_PER_CATEGORY = 10_000;

/** How many conversations one canvas carries. */
export const MAX_ASSISTANT_SESSIONS_PER_CANVAS = 16;
/**
 * How many lines one conversation is kept to.
 *
 * A ceiling rather than a refusal: a conversation that ran past it would be one
 * nobody could read through, and the oldest lines are the ones to lose. Losing
 * them is said, and undoing the turn that pushed past it gives them back.
 */
export const MAX_ASSISTANT_MESSAGES_PER_SESSION = 200;
export const MAX_ASSISTANT_TITLE_LENGTH = 120;
/**
 * The most one line of a conversation holds, which is the most a text card
 * holds: an answer is offered the chance to become one, and an answer too long
 * for a card could not be put on the canvas whole.
 */
export const MAX_ASSISTANT_MESSAGE_LENGTH = MAX_TEXT_CONTENT_LENGTH;

/** The most pixels one picture tool will work on, coming or going. */
export const MAX_OPERATED_PIXELS = 40_000_000;
/** The most pieces one division makes. */
export const MAX_DIVISIONS = 64;
/** How far a picture may be turned, in degrees either way. */
export const MAX_TILT_DEGREES = 60;

export const CLICK_DRAG_THRESHOLD_PX = 3;
export const GROUP_DETACH_THRESHOLD_PX = 48;
export const MIN_NODE_WIDTH = 200;
export const MIN_NODE_HEIGHT = 120;
export const DEFAULT_NODE_WIDTH = 280;
export const DEFAULT_NODE_HEIGHT = 200;
export const CASCADE_DROP_OFFSET = 40;
export const FIT_VIEWPORT_USAGE = 0.6;
export const FIT_ANIMATION_MS = 450;

export const PROJECT_ASSET_CATEGORIES = [
  "images",
  "music",
  "voice",
  "texts",
  "videos",
] as const;
export type AssetCategory = (typeof PROJECT_ASSET_CATEGORIES)[number];

/** What each place assets are filed is called where a reader is told of it. */
export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = {
  images: "domain:assetCategory.images",
  music: "domain:assetCategory.music",
  voice: "domain:assetCategory.voice",
  texts: "domain:assetCategory.texts",
  videos: "domain:assetCategory.videos",
};

/**
 * Whether the project was handed the file or made it itself.
 *
 * What a generation, a tool, or a conversation produced is not said here:
 * `provenance` already names the run, node, or conversation behind an asset,
 * and saying it twice gives the two places a chance to disagree.
 */
export const ASSET_ORIGINS = ["brought", "filed"] as const;
export type AssetOrigin = (typeof ASSET_ORIGINS)[number];

/**
 * What each origin is called where a reader is told of it.
 *
 * An asset this project made is not labelled here: it says so through
 * `provenance`, and the shelf calls that "Made here" where it reads the entry.
 */
export const ASSET_ORIGIN_LABELS: Record<AssetOrigin, string> = {
  brought: "domain:assetOrigin.brought",
  filed: "domain:assetOrigin.filed",
};

/** How many words a reader may put on one asset to find it again. */
export const MAX_ASSET_TAGS = 24;
/** How long one of those words may be. */
export const MAX_ASSET_TAG_LENGTH = 32;
export const MAX_ASSET_NOTE_LENGTH = 2_000;

// ---------------------------------------------------------------------------
// The cutting room
// ---------------------------------------------------------------------------

export const TIMELINE_SCHEMA_VERSION = 1;
/** How many timelines one project's cutting room holds. */
export const MAX_TIMELINES_PER_PROJECT = 12;
/** How many tracks one timeline holds, video, audio, and text together. */
export const MAX_TRACKS_PER_TIMELINE = 8;
/** How many clips one timeline holds. */
export const MAX_CLIPS_PER_TIMELINE = 400;
/** How many transitions one timeline holds. */
export const MAX_TRANSITIONS_PER_TIMELINE = 100;
export const TIMELINE_NAME_MAX = 80;
/** How long a clip's label may run, which is a name rather than a text. */
export const CLIP_LABEL_MAX = 80;
/** The most one text clip may say, kept to the size a card may hold. */
export const MAX_TIMELINE_TEXT_CONTENT = 2_000;
/** How many clips one command may land, which is one step of history. */
export const MAX_CLIPS_PER_COMMAND = 50;
/** Clip timing bounds: milliseconds are whole and positive, speed and volume
 * live in their working ranges, and a clip shorter than this cannot be seen. */
export const MIN_CLIP_DURATION_MS = 100;
export const MIN_CLIP_SPEED = 0.25;
export const MAX_CLIP_SPEED = 4;
export const MAX_CLIP_VOLUME = 2;
/** Transition bounds, in the window two clips share. */
export const MIN_TRANSITION_MS = 200;
export const MAX_TRANSITION_MS = 2_000;
/** The timeline frame rates a document may be set to. */
export const TIMELINE_FPS_CHOICES = [24, 25, 30, 60] as const;
/** Resolution bounds for the timeline canvas, even numbers within these. */
export const TIMELINE_WIDTH_MIN = 720;
export const TIMELINE_WIDTH_MAX = 3840;
export const TIMELINE_HEIGHT_MIN = 480;
export const TIMELINE_HEIGHT_MAX = 2160;
/** The presets the inspector and the new-timeline dialog offer. */
export const TIMELINE_RESOLUTION_PRESETS = [
  { label: "720p HD", width: 1280, height: 720 },
  { label: "1080p Full HD", width: 1920, height: 1080 },
  { label: "1440p QHD", width: 2560, height: 1440 },
  { label: "4K UHD", width: 3840, height: 2160 },
] as const;
/** The eight ways two clips can meet. */
export const TRANSITION_KINDS = [
  "none",
  "crossfade",
  "dipToBlack",
  "dipToWhite",
  "slideLeft",
  "slideUp",
  "wipe",
  "zoomIn",
] as const;
/** The six preset looks a video clip can wear. */
export const CLIP_FILTER_PRESETS = [
  "none",
  "warm",
  "cool",
  "mono",
  "fade",
  "vivid",
] as const;
/** The duration an image clip gets when nobody says otherwise. */
export const DEFAULT_IMAGE_CLIP_MS = 4_000;
/** The duration a text clip gets when nobody says otherwise. */
export const DEFAULT_TEXT_CLIP_MS = 2_000;
/** The default transition offered by the seam between two clips. */
export const DEFAULT_TRANSITION_KIND: Exclude<TransitionKind, "none"> =
  "crossfade";
export const DEFAULT_TRANSITION_MS = 500;

export type TransitionKind = (typeof TRANSITION_KINDS)[number];
export type ClipFilterPreset = (typeof CLIP_FILTER_PRESETS)[number];
/**
 * What an asset is a picture of, in words — the summary a search reads.
 *
 * Kept to the size of a prompt rather than a document: it is meant to be the
 * ask an asset came from, or the opening of the text it holds.
 */
export const MAX_ASSET_KEYWORD_LENGTH = 2_000;

export const MODEL_CAPABILITIES = [
  "text",
  "image",
  "speech",
  "music",
  "video",
  "asr",
] as const;
export type Capability = (typeof MODEL_CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return MODEL_CAPABILITIES.includes(value as Capability);
}

/**
 * The scenarios a request may turn out to be, per capability.
 *
 * A provider that names a different model — or serves it at a different
 * address — per scenario says so with sub-models, and one of these is what a
 * sub-model answers for. Which scenario a request is follows from the
 * pictures it carries and the mode it asks in.
 */
export const MODEL_SCENES = [
  "textToVideo",
  "imageToVideo",
  "firstLastFrame",
  "referenceToVideo",
  "textToImage",
  "imageEdit",
] as const;
export type ModelScene = (typeof MODEL_SCENES)[number];

/** The scenarios each capability's configurations may route on. */
export const SCENES_OF_CATEGORY: Record<Capability, readonly ModelScene[]> = {
  text: [],
  image: ["textToImage", "imageEdit"],
  speech: [],
  music: [],
  video: ["textToVideo", "imageToVideo", "firstLastFrame", "referenceToVideo"],
  asr: [],
};

/** The words each scenario is shown as. */
export const MODEL_SCENE_LABELS: Record<ModelScene, string> = {
  textToVideo: "domain:modelScene.textToVideo",
  imageToVideo: "domain:modelScene.imageToVideo",
  firstLastFrame: "domain:modelScene.firstLastFrame",
  referenceToVideo: "domain:modelScene.referenceToVideo",
  textToImage: "domain:modelScene.textToImage",
  imageEdit: "domain:modelScene.imageEdit",
};

export function isModelScene(value: unknown): value is ModelScene {
  return MODEL_SCENES.includes(value as ModelScene);
}

/**
 * The kinds of card a project holds.
 *
 * Left out of the kinds a card is filed under is recognition: it reads a
 * recording and answers with words, so nothing is ever filed under it. It is a
 * kind of model rather than a kind of material, which is why a shelf, a lens
 * and a node never offer it.
 */
export const ASSET_KINDS = ["text", "image", "audio", "video"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * What a card of each kind is called, in the words the matching node already
 * goes by.
 *
 * A kind is not a capability: the sound a card holds may have been made by
 * either sound capability, and what a reader needs named there is the card,
 * not the model behind it.
 */
export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  text: "domain:nodeTitle.text",
  image: "domain:nodeTitle.image",
  audio: "domain:nodeTitle.audio",
  video: "domain:nodeTitle.video",
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  text: "domain:capability.text",
  image: "domain:capability.image",
  speech: "domain:capability.speech",
  music: "domain:capability.music",
  video: "domain:capability.video",
  asr: "domain:capability.asr",
};

/** The executor a generation node's step is handed to. */
export const PROVIDER_EXECUTOR_KEY = "provider";

export const MAX_MODEL_ID_LENGTH = 96;
export const MAX_MODEL_NAME_LENGTH = 120;
export const MAX_IMAGES_PER_RUN = 10;
export const MAX_VIDEO_SECONDS = 600;
export const MIN_AUDIO_SPEED = 0.25;
export const MAX_AUDIO_SPEED = 4;

// -----------------------------------------------------------------------------
// The story room
// -----------------------------------------------------------------------------

export const STORY_SCHEMA_VERSION = 1;
export const MAX_STORIES_PER_PROJECT = 20;
export const STORY_NAME_MAX = 60;
/** The premise's own ceiling, of the same size as a node's prompt. */
export const STORY_IDEA_MAX = 20_000;
/** How much manuscript a story will hold, measured in characters. */
export const STORY_SOURCE_TEXT_MAX = 2_000_000;
export const MAX_CHAPTERS_PER_STORY = 60;
export const MAX_ELEMENTS_PER_STORY = 200;
/** How many drawings one place keeps before the oldest is let go. */
export const MAX_TAKES_PER_SLOT = 12;
export const MAX_ACTS_PER_CHAPTER = 30;
export const MAX_KEYFRAMES_PER_ACT = 12;
/**
 * How many reference pictures one frame's ask carries when the story says
 * nothing: the bound the shape that draws with references is happiest with.
 *
 * The pictures themselves are the shot's own mentions, which name a place's
 * element one by one; this is how many of them fit in one ask. An image
 * service takes a bounded set — the shapes that draw with references take
 * three to nine — and a request over the bound is refused whole rather than
 * drawn with the first of them, so the story says how many of the mentioned
 * pictures travel and the rest are left to the words.
 */
export const REFERENCE_IMAGES_DEFAULT = 3;
/** The most reference pictures one frame's ask may be set to carry. */
export const REFERENCE_IMAGES_MAX = 9;
export const MIN_KEYFRAME_MS = 400;
export const MAX_KEYFRAME_MS = 60_000;
export const MIN_TOTAL_DURATION_MS = 30_000;
export const MAX_TOTAL_DURATION_MS = 8 * 60 * 60 * 1000;
/** How many places one job may be asked for at once; the room splits the rest. */
export const MAX_ITEMS_PER_STORY_JOB = 40;
/**
 * How much of a telling one ask may carry, in characters, when the reader has
 * not said. A manuscript is cut into the parts a chapter is written from, and
 * the chapters are read for their cast a part at a time; both boundaries are
 * the reader's to move, since how much a model can hold is a property of the
 * deployment rather than of the telling.
 */
export const STORY_SPLIT_CHARS_DEFAULT = 12_000;
export const STORY_READ_CHARS_DEFAULT = 8_000;
/**
 * What either boundary may be set to. The ceiling leaves room for the
 * instructions that travel with the telling's own words, since the whole
 * prompt is what a batch is measured against.
 */
export const STORY_CHARS_MIN = 1_000;
export const STORY_CHARS_MAX = 16_000;
/**
 * The words each of the story room's enums is said in, the way
 * `CAPABILITY_LABELS` says a capability: the table is the label's address, and
 * the catalogue holds the sentence.
 */
export const SHOT_SIZE_LABELS: Record<string, string> = {
  extremeClose: "domain:shotSize.extremeClose",
  close: "domain:shotSize.close",
  mediumClose: "domain:shotSize.mediumClose",
  medium: "domain:shotSize.medium",
  mediumFull: "domain:shotSize.mediumFull",
  full: "domain:shotSize.full",
  wide: "domain:shotSize.wide",
  extremeWide: "domain:shotSize.extremeWide",
};

export const CAMERA_MOVE_LABELS: Record<string, string> = {
  static: "domain:cameraMove.static",
  handheld: "domain:cameraMove.handheld",
  pushIn: "domain:cameraMove.pushIn",
  pullOut: "domain:cameraMove.pullOut",
  panLeft: "domain:cameraMove.panLeft",
  panRight: "domain:cameraMove.panRight",
  tiltUp: "domain:cameraMove.tiltUp",
  tiltDown: "domain:cameraMove.tiltDown",
  trackLeft: "domain:cameraMove.trackLeft",
  trackRight: "domain:cameraMove.trackRight",
  arc: "domain:cameraMove.arc",
  craneUp: "domain:cameraMove.craneUp",
  zoomIn: "domain:cameraMove.zoomIn",
  zoomOut: "domain:cameraMove.zoomOut",
};

export const CAMERA_ANGLE_LABELS: Record<string, string> = {
  eyeLevel: "domain:cameraAngle.eyeLevel",
  high: "domain:cameraAngle.high",
  low: "domain:cameraAngle.low",
  overhead: "domain:cameraAngle.overhead",
  dutch: "domain:cameraAngle.dutch",
  overTheShoulder: "domain:cameraAngle.overTheShoulder",
  pointOfView: "domain:cameraAngle.pointOfView",
};

export const ELEMENT_KIND_LABELS: Record<string, string> = {
  character: "domain:elementKind.character",
  scene: "domain:elementKind.scene",
  prop: "domain:elementKind.prop",
};

/** How a drawn frame is used when the act is shot. */
export const FILM_ROLE_LABELS: Record<string, string> = {
  reference: "domain:filmRole.reference",
  firstFrame: "domain:filmRole.firstFrame",
  firstLastFrame: "domain:filmRole.firstLastFrame",
};

/**
 * A frame is written with the ratio itself, which cannot be a key of its own:
 * dots and a colon are the catalogue's own punctuation, so each one is filed
 * under a name instead.
 */
export const ASPECT_LABELS: Record<string, string> = {
  "16:9": "domain:aspect.wide169",
  "9:16": "domain:aspect.tall916",
  "1:1": "domain:aspect.square",
  "4:3": "domain:aspect.classic43",
  "21:9": "domain:aspect.scope219",
};

/** How many lines one shot may be spoken with. */
export const MAX_DIALOGUE_LINES_PER_KEYFRAME = 12;
export const MAX_DIALOGUE_LINE_LENGTH = 500;
/** What a voice named in a story may be called, and what it may say of itself. */
export const VOICE_MODEL_MAX = 120;
export const VOICE_NAME_MAX = 120;
export const VOICE_INSTRUCTIONS_MAX = 500;
/** The pace and pitch a character may claim, the bounds the preferences hold to. */
export const VOICE_RATE_MIN = 0.5;
export const VOICE_RATE_MAX = 2;
export const VOICE_PITCH_MIN = 0.5;
export const VOICE_PITCH_MAX = 2;
/** The running time a story starts from: two minutes, one short telling. */
export const DEFAULT_STORY_DURATION_MS = 120_000;
/** The frame a story starts from, which most screens are watched on. */
export const DEFAULT_STORY_ASPECT: StoryAspect = "16:9";
/** How long a shot is held when the board does not say. */
export const DEFAULT_KEYFRAME_MS = 3_000;
/** About how long one episode runs, which is how a total is cut into them. */
export const DEFAULT_CHAPTER_MS = 60_000;

export function port(
  id: string,
  direction: "input" | "output",
  dataTypes: DataType[],
  label: string,
  options?: { required?: boolean; cardinality?: "one" | "many" },
): PortDefinition {
  return {
    id,
    direction,
    dataTypes,
    required: options?.required ?? false,
    cardinality: options?.cardinality ?? "one",
    label,
  };
}

/**
 * The one port table both languages share by convention: codecs correct
 * decoded nodes against it, so a stored document never drifts from the
 * ports its kind offers.
 */
export const NODE_PORTS: Record<NodeKind, PortDefinition[]> = {
  text: [
    port("prompt", "input", ["text"], "domain:port.prompt", {
      cardinality: "many",
    }),
    port("images", "input", ["image"], "domain:port.images", {
      cardinality: "many",
    }),
    port("audio", "input", ["audio"], "domain:port.audio"),
    port("video", "input", ["video"], "domain:port.video"),
    port("out", "output", ["text"], "domain:port.text"),
  ],
  image: [
    port("prompt", "input", ["text"], "domain:port.prompt", {
      cardinality: "many",
    }),
    port("images", "input", ["image"], "domain:port.images", {
      cardinality: "many",
    }),
    port("mask", "input", ["image"], "domain:port.mask"),
    port("out", "output", ["image"], "domain:port.image"),
  ],
  audio: [
    port("prompt", "input", ["text"], "domain:port.prompt", {
      cardinality: "many",
    }),
    port("out", "output", ["audio"], "domain:port.audio"),
  ],
  video: [
    port("prompt", "input", ["text"], "domain:port.prompt", {
      cardinality: "many",
    }),
    port("images", "input", ["image"], "domain:port.images", {
      cardinality: "many",
    }),
    port("firstFrame", "input", ["image"], "domain:port.firstFrame"),
    port("lastFrame", "input", ["image"], "domain:port.lastFrame"),
    port("videos", "input", ["video"], "domain:port.videos", {
      cardinality: "many",
    }),
    port("audios", "input", ["audio"], "domain:port.audios", {
      cardinality: "many",
    }),
    port("out", "output", ["video"], "domain:port.video"),
  ],
  operation: [
    port("text", "input", ["text"], "domain:port.text", {
      cardinality: "many",
    }),
    port("images", "input", ["image"], "domain:port.images", {
      cardinality: "many",
    }),
    port("audio", "input", ["audio"], "domain:port.audio"),
    port("video", "input", ["video"], "domain:port.video"),
    port(
      "out",
      "output",
      ["text", "image", "audio", "video"],
      "domain:port.result",
      {
        cardinality: "many",
      },
    ),
  ],
  group: [],
  export: [
    port("video", "input", ["video"], "domain:port.video"),
    port("audio", "input", ["audio"], "domain:port.audio"),
    port("out", "output", ["artifact"], "domain:port.artifact"),
  ],
};

export const MOKA_FRAGMENT_MIME = "application/x-moka-canvas-fragment+json";
export const FRAGMENT_SCHEMA_VERSION = 1;

/**
 * The parameter keys an ask of each capability may carry: the ones its
 * converters read, which the global preferences fill some of. Unknown keys are
 * rejected. The server keeps the same keys in the same order
 * (`generation_param_keys` in `src-tauri/src/domain/validate.rs`, which a Rust
 * test compares against this list).
 */
export const GENERATION_PARAM_KEYS: Record<Capability, readonly string[]> = {
  text: ["temperature", "maxTokens", "reasoningEffort", "instructions"],
  image: ["size", "quality", "background", "count"],
  speech: [
    "voice",
    "format",
    "speed",
    "instructions",
    "sampleRate",
    "volume",
    "rate",
    "pitch",
  ],
  music: ["format", "instrumental", "lyrics", "gender", "watermark"],
  video: [
    "seconds",
    "resolution",
    "ratio",
    "generateAudio",
    "watermark",
    "mode",
  ],
  asr: ["language", "channelId", "speakerCount", "disfluency", "speakerLabel"],
};

/**
 * The shapes a picture or a shot can be asked for, stated as a proportion.
 *
 * A shape is also the shape of the node waiting for it, which is why it is not
 * stated in pixels: the pixels are each provider's own answer to the same ask.
 */
export const GENERATION_SHAPES = [
  "1:1",
  "3:4",
  "4:3",
  "16:9",
  "9:16",
  "21:9",
] as const;

export const IMAGE_QUALITIES = ["auto", "low", "medium", "high"] as const;
export const IMAGE_BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
export const VIDEO_RESOLUTIONS = ["480", "720", "1080"] as const;

/**
 * What a video does with the pictures it is given: `auto` reads them as the
 * frames of the shot, and `reference` as its subject or style.
 */
export const VIDEO_IMAGE_MODES = ["auto", "reference"] as const;

export const AUDIO_FORMATS = [
  "mp3",
  "wav",
  "opus",
  "aac",
  "flac",
  "pcm",
] as const;
export const REASONING_EFFORTS = [
  "auto",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const HISTORY_LIMIT = 50;

export const PROBLEM_CODES = [
  "GRAPH_CYCLE",
  "PORT_TYPE_MISMATCH",
  "CARDINALITY_VIOLATION",
  "SELF_LOOP",
  "PORT_NOT_FOUND",
  "NODE_NOT_FOUND",
  "EDGE_NOT_FOUND",
  "CANVAS_NOT_FOUND",
  "FOLDER_NOT_FOUND",
  "TIMELINE_NOT_FOUND",
  "TRACK_NOT_FOUND",
  "TRACK_NOT_EMPTY",
  "CLIP_NOT_FOUND",
  "CLIP_OVERLAP",
  "TRANSITION_NOT_FOUND",
  "TRANSITION_SEAM",
  "GROUP_INVALID",
  "SESSION_NOT_FOUND",
  "MESSAGE_NOT_FOUND",
  "BOUNDS_INVALID",
  "ASSET_INVALID",
  "ASSET_MISSING",
  "ASSET_IN_USE",
  "PATH_ESCAPE",
  "MOKA_MAGIC_INVALID",
  "MOKA_BSON_INVALID",
  "MOKA_VERSION_UNSUPPORTED",
  "MOKA_FIELD_MISSING",
  "MOKA_TOO_LARGE",
  "REVISION_CONFLICT",
  "VALIDATION_FAILED",
  "PROJECT_NOT_OPEN",
  "PROJECT_NOT_FOUND",
  "CANVAS_REQUIRED",
  "EXECUTOR_DISABLED",
  "RUN_NOT_FOUND",
  "RUN_NOT_CANCELLABLE",
  "PACKAGE_INVALID",
  "CONFIG_METADATA_DIR_INVALID",
  "CONFIG_METADATA_STORE_UNSUPPORTED",
  "CONFIG_METADATA_KEY_MISSING",
  "METADATA_UNAVAILABLE",
  "METADATA_CONFLICT",
  "METADATA_WRITE_FAILED",
  "METADATA_SCHEMA_UNSUPPORTED",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_KEY_MISSING",
  "PROVIDER_AUTH",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_BAD_REQUEST",
  "PROVIDER_TIMEOUT",
  "PROVIDER_NO_OUTPUT",
  "MODEL_CAPABILITY_MISMATCH",
  "MODEL_VOICE_REQUIRED",
  "GENERATION_CAPABILITY_MISMATCH",
  "GENERATION_MODEL_MISSING",
  "GENERATION_PROMPT_EMPTY",
  "MENTION_NODE_NOT_FOUND",
  "MENTION_SELF_REFERENCE",
  "RESULT_SLOT_LIMIT",
  "GENERATION_CANCELLED",
  "GENERATION_OUTPUT_TOO_LARGE",
  "TASK_NOT_FOUND",
  "TASK_EXPIRED",
  "STORY_NOT_FOUND",
  "STORY_LIMIT_REACHED",
  "STORY_NAME_INVALID",
  "STORY_SCHEMA_NEWER",
  "STORY_ID_EXISTS",
  "STORY_CHAPTER_LIMIT",
  "STORY_ELEMENT_LIMIT",
  "STORY_ACT_LIMIT",
  "STORY_KEYFRAME_LIMIT",
  "STORY_SLOT_FULL",
  "STORY_TARGET_INVALID",
  "STORY_JOB_NOT_FOUND",
  "STORY_JOB_NOT_CANCELLABLE",
  "STORY_JOB_BUSY",
  "STORY_JOB_ITEM_LIMIT",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "INTERNAL",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/**
 * The troubles a reader repairs in Settings rather than by asking again.
 *
 * A model that is not there, one that holds no key, a credential the provider
 * refused, and a model that cannot do what was asked of it: every one of them
 * comes back the same way however many times it is asked, so a report of one
 * offers the place the fix is instead of another try.
 */
export const CONFIGURATION_PROBLEM_CODES = [
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_KEY_MISSING",
  "PROVIDER_AUTH",
  "MODEL_CAPABILITY_MISMATCH",
  "MODEL_SCENE_UNCONFIGURED",
  "MODEL_VOICE_REQUIRED",
  "GENERATION_CAPABILITY_MISMATCH",
  "GENERATION_MODEL_MISSING",
  "EXECUTOR_DISABLED",
] as const;
