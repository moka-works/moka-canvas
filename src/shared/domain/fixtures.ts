import {
  CANVAS_SCHEMA_VERSION,
  MAX_ACTS_PER_CHAPTER,
  MAX_CHAPTERS_PER_STORY,
  MAX_KEYFRAMES_PER_ACT,
  MOKA_FILE_VERSION,
  REFERENCE_IMAGES_DEFAULT,
} from "./constants";
import { createStory, derivePorts } from "./factories";
import type {
  AssistantMessage,
  MokaFile,
  ResourceEntry,
  ResultSlot,
  WorkflowEdge,
  WorkflowNode,
} from "./types";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";

function fixtureId(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

export function goldenNodeIds() {
  return {
    project: fixtureId(1),
    canvasMain: fixtureId(2),
    canvasSecond: fixtureId(3),
    text: fixtureId(10),
    image: fixtureId(11),
    operation: fixtureId(12),
    export: fixtureId(13),
    edgeTextOp: fixtureId(20),
    edgeOpExport: fixtureId(21),
    assetImage: fixtureId(30),
  };
}

export function buildGoldenMokaFile(): MokaFile {
  const ids = goldenNodeIds();

  const textNode: WorkflowNode = {
    id: ids.text,
    kind: "text",
    title: "Brief",
    bounds: { x: -320, y: -120, width: 280, height: 200 },
    zIndex: 0,
    ports: derivePorts("text"),
    data: { content: "A lantern floats over a quiet lake at dusk." },
    createdAt: T0,
    updatedAt: T0,
  };

  const imageNode: WorkflowNode = {
    id: ids.image,
    kind: "image",
    title: "Reference image",
    bounds: { x: -320, y: 160, width: 280, height: 220 },
    zIndex: 1,
    ports: derivePorts("image"),
    data: { assetId: ids.assetImage },
    createdAt: T0,
    updatedAt: T0,
  };

  const operationNode: WorkflowNode = {
    id: ids.operation,
    kind: "operation",
    title: "Generate frame",
    bounds: { x: 40, y: -120, width: 300, height: 220 },
    zIndex: 2,
    ports: derivePorts("operation"),
    data: {
      operationType: "deterministic.text",
      parameters: { style: "storyboard" },
      executorKey: "deterministic",
      resultSlots: [],
      resultNodeIds: [],
    },
    createdAt: T0,
    updatedAt: T0,
  };

  const exportNode: WorkflowNode = {
    id: ids.export,
    kind: "export",
    title: "Export",
    bounds: { x: 420, y: -120, width: 280, height: 180 },
    zIndex: 3,
    ports: derivePorts("export"),
    data: { format: "mp4", parameters: { resolution: "1080p" } },
    createdAt: T0,
    updatedAt: T0,
  };

  const edgeTextOp: WorkflowEdge = {
    id: ids.edgeTextOp,
    source: { nodeId: ids.text, portId: "out" },
    target: { nodeId: ids.operation, portId: "text" },
    createdAt: T0,
  };
  const edgeOpExport: WorkflowEdge = {
    id: ids.edgeOpExport,
    source: { nodeId: ids.operation, portId: "out" },
    target: { nodeId: ids.export, portId: "video" },
    createdAt: T0,
  };

  return {
    version: MOKA_FILE_VERSION,
    metadata: {
      id: ids.project,
      name: "Golden Fixture",
      description: "Shared cross-language fixture",
      revision: 3,
      createdAt: T0,
      updatedAt: T1,
    },
    resources: {
      images: [
        {
          id: ids.assetImage,
          name: "lake.png",
          path: "assets/images/lake-00000000.png",
          mime: "image/png",
          bytes: 2048,
          sha256:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          createdAt: T0,
          updatedAt: T0,
          probe: {
            mime: "image/png",
            bytes: 2048,
            sha256:
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            width: 64,
            height: 64,
          },
        },
      ],
      music: [],
      voice: [],
      texts: [],
      videos: [],
    },
    canvas: [
      {
        id: ids.canvasMain,
        name: "Canvas 1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        viewport: { x: 120.5, y: -40.25, zoom: 1.5 },
        nodes: [textNode, imageNode, operationNode, exportNode],
        edges: [edgeTextOp, edgeOpExport],
        groups: [],
        settings: { background: "dots", showMinimap: true, snapToGrid: true },
      },
      {
        id: ids.canvasSecond,
        name: "Canvas 2",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [],
        edges: [],
        groups: [],
        settings: {
          background: "lines",
          showMinimap: false,
          snapToGrid: false,
        },
      },
    ],
  };
}

export function generationNodeIds() {
  return {
    project: fixtureId(119),
    canvas: fixtureId(122),
    text: fixtureId(120),
    image: fixtureId(121),
    edge: fixtureId(123),
  };
}

export function batchNodeIds() {
  return {
    project: fixtureId(130),
    canvas: fixtureId(131),
    poster: fixtureId(132),
    second: fixtureId(133),
    third: fixtureId(134),
  };
}

const BATCH_ASSETS = ["asset-one", "asset-two", "asset-three"];

/** One answer of a batch, as the node holding it records it. */
function batchSlot(index: number, primary: boolean): ResultSlot {
  return {
    id: index === 0 ? "result" : `result-${index + 1}`,
    status: "succeeded",
    assetId: BATCH_ASSETS[index],
    isPrimary: primary,
  };
}

/**
 * A document as a generation that asked for three answers leaves it: the node
 * that asked shows the first and lists the cards the other two went onto, each
 * card holding its own copy of the answer it was made for.
 */
export function buildBatchMokaFile(): MokaFile {
  const ids = batchNodeIds();

  const poster: WorkflowNode = {
    id: ids.poster,
    kind: "image",
    title: "Poster",
    bounds: { x: 0, y: 0, width: 280, height: 220 },
    zIndex: 0,
    ports: derivePorts("image"),
    data: {
      assetId: BATCH_ASSETS[0],
      resultSlots: [
        batchSlot(0, true),
        batchSlot(1, false),
        batchSlot(2, false),
      ],
      resultNodeIds: [ids.second, ids.third],
    },
    createdAt: T0,
    updatedAt: T1,
  };

  const card = (id: string, index: number): WorkflowNode => ({
    id,
    kind: "image",
    title: `Poster ${index + 1}`,
    bounds: { x: 320 * index, y: 0, width: 280, height: 220 },
    zIndex: index,
    ports: derivePorts("image"),
    data: {
      assetId: BATCH_ASSETS[index],
      resultSlots: [{ ...batchSlot(index, true), id: "result" }],
    },
    createdAt: T0,
    updatedAt: T1,
  });

  const images: ResourceEntry[] = BATCH_ASSETS.map((assetId, index) => ({
    id: assetId,
    name: `poster-${index + 1}.png`,
    path: `assets/images/poster-${index + 1}.png`,
    createdAt: T1,
    updatedAt: T1,
    provenance: {
      runId: "run-batch",
      operationNodeId: ids.poster,
      createdAt: T1,
    },
  }));

  return {
    version: MOKA_FILE_VERSION,
    metadata: {
      id: ids.project,
      name: "Batch Fixture",
      revision: 1,
      createdAt: T0,
      updatedAt: T1,
    },
    resources: { images, music: [], voice: [], texts: [], videos: [] },
    canvas: [
      {
        id: ids.canvas,
        name: "Canvas 1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [poster, card(ids.second, 1), card(ids.third, 2)],
        edges: [],
        groups: [],
        settings: { background: "dots", showMinimap: true, snapToGrid: true },
      },
    ],
  };
}

/** A v2 document whose generative nodes carry specs, for 05/06 to reuse. */
export function buildGenerationMokaFile(): MokaFile {
  const ids = generationNodeIds();
  const textId = ids.text;
  const imageId = ids.image;
  const canvasId = ids.canvas;

  const textNode: WorkflowNode = {
    id: textId,
    kind: "text",
    title: "Brief",
    bounds: { x: 0, y: 0, width: 280, height: 200 },
    zIndex: 0,
    ports: derivePorts("text"),
    data: {
      content: "",
      generation: {
        capability: "text",
        mode: "generate",
        model: "",
        prompt: "Write a logline about a lantern over a lake.",
        inputMode: "upstream",
        params: { temperature: 0.7 },
        referenceNodeIds: [],
        updatedAt: T0,
      },
    },
    createdAt: T0,
    updatedAt: T0,
  };

  const imageNode: WorkflowNode = {
    id: imageId,
    kind: "image",
    title: "Poster",
    bounds: { x: 320, y: 0, width: 280, height: 220 },
    zIndex: 1,
    ports: derivePorts("image"),
    data: {
      generation: {
        capability: "image",
        mode: "generate",
        model: "painter",
        prompt: `Paint @[node:${textId}] as a poster.`,
        inputMode: "mentions",
        params: { size: "1:1", count: 2 },
        referenceNodeIds: [textId],
        updatedAt: T1,
      },
    },
    createdAt: T0,
    updatedAt: T1,
  };

  const edge: WorkflowEdge = {
    id: ids.edge,
    source: { nodeId: textId, portId: "out" },
    target: { nodeId: imageId, portId: "prompt" },
    createdAt: T0,
  };

  return {
    version: MOKA_FILE_VERSION,
    metadata: {
      id: ids.project,
      name: "Generation Fixture",
      revision: 1,
      createdAt: T0,
      updatedAt: T1,
    },
    resources: { images: [], music: [], voice: [], texts: [], videos: [] },
    canvas: [
      {
        id: canvasId,
        name: "Canvas 1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [textNode, imageNode],
        edges: [edge],
        groups: [],
        settings: { background: "dots", showMinimap: true, snapToGrid: true },
      },
    ],
  };
}

export function conversationIds() {
  return {
    session: fixtureId(40),
    asked: fixtureId(41),
    answered: fixtureId(42),
    failed: fixtureId(43),
    run: fixtureId(44),
  };
}

/**
 * The golden document with a conversation carried on its first canvas, and the
 * asset that conversation asked for naming it back.
 *
 * Each of the three lines fills in a different part of what a line can carry,
 * so one fixture pins the encoding of all of them: the asking names the card it
 * was about, the answer names the run it set going, and the failure says why it
 * failed and whether asking again could work. The second canvas carries no
 * conversations at all, which pins that the field is left off rather than left
 * empty.
 */
export function buildConversationMokaFile(): MokaFile {
  const ids = goldenNodeIds();
  const said = conversationIds();
  const moka = buildGoldenMokaFile();

  moka.resources.images[0].provenance = {
    runId: said.run,
    canvasId: ids.canvasMain,
    operationNodeId: ids.image,
    assistantSessionId: said.session,
    parameterSnapshot: { model: "painter" },
    createdAt: T1,
  };

  const asked: AssistantMessage = {
    id: said.asked,
    role: "user",
    text: "What is over the lake?",
    createdAt: T0,
    references: [
      {
        nodeId: ids.image,
        title: "Reference image",
        kind: "image",
        assetId: ids.assetImage,
      },
    ],
  };
  const answered: AssistantMessage = {
    id: said.answered,
    role: "assistant",
    text: "A lantern, drifting over it at dusk.",
    createdAt: T1,
    toolCalls: [
      {
        runId: said.run,
        nodeId: ids.image,
        summary: "Painted a poster of it",
      },
    ],
  };
  const failed: AssistantMessage = {
    id: said.failed,
    role: "error",
    text: "The painter did not answer.",
    createdAt: T1,
    failure: { code: "PROVIDER_UNAVAILABLE", retryable: true },
  };

  moka.canvas[0].sessions = [
    {
      id: said.session,
      title: "What is over the lake",
      messages: [asked, answered, failed],
      createdAt: T0,
      updatedAt: T1,
    },
  ];

  return moka;
}

function shelfIds() {
  return {
    assetText: fixtureId(45),
  };
}

/**
 * The golden document with what a reader says about its assets written down.
 *
 * One entry carries every part of the shelf — the words it is filed under, the
 * note, the keeper mark, where it came from, and what it is a picture of. The
 * other says one word and nothing else, which is what pins that a part nobody
 * spoke about is left off the document rather than left in as an empty answer.
 */
export function buildShelfMokaFile(): MokaFile {
  const shelf = shelfIds();
  const moka = buildGoldenMokaFile();

  const picture = moka.resources.images[0];
  picture.tags = ["lake", "dusk"];
  picture.note = "Kept for the opening shot.";
  picture.favorite = true;
  picture.origin = "brought";
  picture.keyword = "A lantern floats over a quiet lake at dusk.";

  moka.resources.texts.push({
    id: shelf.assetText,
    name: "opening-lines.md",
    path: "assets/texts/opening-lines-00000000.md",
    mime: "text/markdown",
    bytes: 46,
    createdAt: T0,
    updatedAt: T0,
    tags: ["opening"],
  });

  return moka;
}

export function treeIds() {
  return {
    folderDrafts: fixtureId(40),
    folderInside: fixtureId(41),
    folderKept: fixtureId(42),
  };
}

/**
 * The golden document with its canvases filed into a tree.
 *
 * One folder holds a board and a folder of its own, another holds nothing, and
 * one board is left at the project root — which is what pins that a canvas in a
 * folder says where it sits and a canvas in none carries no answer at all
 * rather than an empty one.
 */
export function buildTreeMokaFile(): MokaFile {
  const tree = treeIds();
  const moka = buildGoldenMokaFile();

  moka.folders = [
    {
      id: tree.folderDrafts,
      name: "Drafts",
      createdAt: T0,
    },
    {
      id: tree.folderInside,
      name: "Inside",
      parentId: tree.folderDrafts,
      createdAt: T1,
    },
    {
      id: tree.folderKept,
      name: "Kept",
      createdAt: T0,
    },
  ];
  moka.canvas = moka.canvas.map((canvas, index) =>
    index === 0 ? { ...canvas, folderId: tree.folderDrafts } : canvas,
  );
  return moka;
}

// ---------------------------------------------------------------------------
// The cutting room
// ---------------------------------------------------------------------------

/**
 * A project with one timeline: a four-second video clip on the video track, a
 * crossfade transition behind it onto a pulled-back follower, and the two
 * media assets the clips read. The seam is the shape every transition test
 * starts from: the follower pulled back by the window, exactly as the
 * document must hold it for the transition to be legal.
 */
export function timelineIds() {
  return {
    timeline: "timeline-1",
    videoTrack: "track-video",
    audioTrack: "track-audio",
    textTrack: "track-text",
    videoClip: "clip-video",
    followerClip: "clip-follower",
    transition: "transition-1",
    videoAsset: "asset-video-a",
    followerAsset: "asset-video-b",
  };
}

export function buildTimelineMokaFile(): MokaFile {
  const ids = timelineIds();
  const moka = buildGoldenMokaFile();
  moka.timelines = [
    {
      id: ids.timeline,
      name: "Timeline 1",
      schemaVersion: 1,
      settings: { fps: 30, width: 1920, height: 1080, background: "#000000" },
      tracks: [
        {
          id: ids.videoTrack,
          kind: "video",
          name: "Video 1",
          muted: false,
          hidden: false,
          locked: false,
          createdAt: T0,
        },
        {
          id: ids.audioTrack,
          kind: "audio",
          name: "Audio 1",
          muted: false,
          hidden: false,
          locked: false,
          createdAt: T0,
        },
        {
          id: ids.textTrack,
          kind: "text",
          name: "Text 1",
          muted: false,
          hidden: false,
          locked: false,
          createdAt: T0,
        },
      ],
      clips: [
        {
          id: ids.videoClip,
          trackId: ids.videoTrack,
          kind: "video",
          label: "opening.mp4",
          assetId: ids.videoAsset,
          startMs: 0,
          durationMs: 4_000,
          inPointMs: 0,
          outPointMs: 4_000,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          muted: false,
          opacity: 1,
          createdAt: T0,
          updatedAt: T0,
        },
      ],
      // The golden timeline carries no transitions, and the tests that want
      // one add it through the commands — a seam is a command's doing.
      transitions: [],
      createdAt: T0,
      updatedAt: T0,
    },
  ];
  moka.resources.videos.push(
    {
      id: ids.videoAsset,
      name: "opening.mp4",
      path: "assets/videos/opening-00000000.mp4",
      mime: "video/mp4",
      bytes: 480_000,
      createdAt: T0,
      updatedAt: T0,
      probe: {
        mime: "video/mp4",
        bytes: 480_000,
        sha256: "a".repeat(64),
        width: 1920,
        height: 1080,
        durationMs: 4_000,
        codecSummary: "avc1",
      },
    },
    {
      id: ids.followerAsset,
      name: "closing.mp4",
      path: "assets/videos/closing-00000000.mp4",
      mime: "video/mp4",
      bytes: 360_000,
      createdAt: T0,
      updatedAt: T0,
      probe: {
        mime: "video/mp4",
        bytes: 360_000,
        sha256: "b".repeat(64),
        width: 1920,
        height: 1080,
        durationMs: 3_000,
        codecSummary: "avc1",
      },
    },
  );
  return moka;
}

export function cutFixtureIds() {
  return {
    timeline: "timeline-cut",
    videoTrack: "track-cut-video",
    audioTrack: "track-cut-audio",
    textTrack: "track-cut-text",
    clipA: "clip-cut-a",
    clipB: "clip-cut-b",
    clipC: "clip-cut-c",
    clipD: "clip-cut-d",
    transition: "transition-cut",
    transition2: "transition-cut-2",
    videoAssetA: "asset-cut-video-a",
    videoAssetB: "asset-cut-video-b",
    audioAsset: "asset-cut-audio",
    imageAsset: "asset-cut-image",
  };
}

/**
 * A project with one cut timeline, carrying every shape a timeline can hold.
 *
 * The video track runs a graded, filtered, fading clip A into a pulled-back
 * follower B through a crossfade — the one overlap a track may hold, stored
 * as geometry — while the locked audio track runs a loud clip C and the text
 * track holds a stroked, plated-nothing caption D. Between them the fixture
 * pins the seams (R1), the track lock, the outline fields, the explicit null
 * background, and every clip kind across the two languages.
 */
export function buildCutMokaFile(): MokaFile {
  const ids = cutFixtureIds();
  const moka = buildGoldenMokaFile();
  const clipA = 4_000;
  const window = 500;

  moka.timelines = [
    {
      id: ids.timeline,
      name: "Timeline 1",
      schemaVersion: 1,
      settings: { fps: 30, width: 1920, height: 1080, background: "#000000" },
      tracks: [
        {
          id: ids.videoTrack,
          kind: "video",
          name: "Video 1",
          muted: false,
          hidden: false,
          locked: false,
          createdAt: T0,
        },
        {
          id: ids.audioTrack,
          kind: "audio",
          name: "Audio 1",
          muted: false,
          hidden: false,
          locked: true,
          createdAt: T0,
        },
        {
          id: ids.textTrack,
          kind: "text",
          name: "Text 1",
          muted: false,
          hidden: false,
          locked: false,
          createdAt: T1,
        },
      ],
      clips: [
        {
          id: ids.clipA,
          trackId: ids.videoTrack,
          kind: "video",
          label: "opening.mp4",
          assetId: ids.videoAssetA,
          startMs: 0,
          durationMs: clipA,
          inPointMs: 0,
          outPointMs: clipA,
          speed: 1,
          volume: 0.8,
          fadeInMs: 200,
          fadeOutMs: 300,
          muted: false,
          adjust: { brightness: 0.1, contrast: -0.2, saturation: 0.3 },
          filter: "warm",
          opacity: 0.9,
          createdAt: T0,
          updatedAt: T0,
        },
        {
          // The follower sits inside its window's pull-back, as R1 promises:
          // twice the pace over the material's opening four seconds.
          id: ids.clipB,
          trackId: ids.videoTrack,
          kind: "video",
          label: "closing.mp4",
          assetId: ids.videoAssetB,
          startMs: clipA - window,
          durationMs: 2_000,
          inPointMs: 0,
          outPointMs: 4_000,
          speed: 2,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          muted: true,
          opacity: 1,
          createdAt: T0,
          updatedAt: T1,
        },
        {
          id: ids.clipC,
          trackId: ids.audioTrack,
          kind: "audio",
          label: "score.mp3",
          assetId: ids.audioAsset,
          startMs: 0,
          durationMs: 8_000,
          inPointMs: 0,
          outPointMs: 8_000,
          speed: 1,
          volume: 1.4,
          fadeInMs: 0,
          fadeOutMs: 0,
          muted: false,
          opacity: 1,
          createdAt: T0,
          updatedAt: T0,
        },
        {
          id: ids.clipD,
          trackId: ids.textTrack,
          kind: "text",
          label: "A lantern over the lake",
          startMs: 0,
          durationMs: 2_000,
          inPointMs: 0,
          outPointMs: 2_000,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          muted: false,
          opacity: 1,
          text: {
            content: "A lantern over the lake",
            style: {
              fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
              fontSize: 64,
              color: "#ffffff",
              bold: true,
              italic: false,
              align: "center",
              position: "top",
              background: null,
              strokeWidth: 4,
              strokeColor: "#101010",
            },
          },
          createdAt: T0,
          updatedAt: T1,
        },
      ],
      transitions: [
        {
          id: ids.transition,
          afterClipId: ids.clipA,
          kind: "crossfade",
          durationMs: window,
          createdAt: T0,
        },
      ],
      createdAt: T0,
      updatedAt: T1,
    },
  ];
  moka.resources.videos.push(
    {
      id: ids.videoAssetA,
      name: "opening.mp4",
      path: "assets/videos/opening-00000000.mp4",
      mime: "video/mp4",
      bytes: 480_000,
      createdAt: T0,
      updatedAt: T0,
      probe: {
        mime: "video/mp4",
        bytes: 480_000,
        sha256: "c".repeat(64),
        width: 1920,
        height: 1080,
        durationMs: 4_000,
        codecSummary: "avc1",
      },
    },
    {
      id: ids.videoAssetB,
      name: "closing.mp4",
      path: "assets/videos/closing-00000000.mp4",
      mime: "video/mp4",
      bytes: 640_000,
      createdAt: T0,
      updatedAt: T0,
      probe: {
        mime: "video/mp4",
        bytes: 640_000,
        sha256: "d".repeat(64),
        width: 1920,
        height: 1080,
        durationMs: 4_000,
        codecSummary: "avc1",
      },
    },
  );
  moka.resources.music.push({
    id: ids.audioAsset,
    name: "score.mp3",
    path: "assets/music/score-00000000.mp3",
    mime: "audio/mpeg",
    bytes: 128_000,
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "audio/mpeg",
      bytes: 128_000,
      sha256: "e".repeat(64),
      durationMs: 8_000,
      sampleRate: 44_100,
      channels: 2,
      codecSummary: "mp3",
    },
  });
  moka.resources.images.push({
    id: ids.imageAsset,
    name: "plate.png",
    path: "assets/images/plate-00000000.png",
    mime: "image/png",
    bytes: 4_096,
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "image/png",
      bytes: 4_096,
      sha256: "f".repeat(64),
      width: 1920,
      height: 1080,
    },
  });
  return moka;
}

// ---------------------------------------------------------------------------
// The story room
// ---------------------------------------------------------------------------

export function storyIds() {
  return {
    story: "story-1",
    chapterFirst: "chapter-first",
    chapterSecond: "chapter-second",
    act: "act-1",
    frameFirst: "frame-1",
    frameSecond: "frame-2",
    hero: "element-hero",
    partner: "element-partner",
    scene: "element-scene",
    prop: "element-prop",
    source: "asset-story-source",
    heroMain: "asset-hero-main",
    heroSheet: "asset-hero-sheet",
    partnerMain: "asset-partner-main",
    sceneMain: "asset-scene-main",
    frameArt: "asset-frame-art",
    actVideo: "asset-act-video",
    /** The line the first shot of the first act is made of. */
    lineFirst: "line-1",
  };
}

/** An image entry, sized the way the story room's own drawings are. */
function storyImage(id: string, name: string): ResourceEntry {
  return {
    id,
    name,
    path: `assets/images/${name}-00000000.png`,
    mime: "image/png",
    bytes: 120_000,
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "image/png",
      bytes: 120_000,
      sha256: "c".repeat(64),
      width: 1920,
      height: 1080,
    },
  };
}

function storyVideo(
  id: string,
  name: string,
  durationMs: number,
): ResourceEntry {
  return {
    id,
    name,
    path: `assets/videos/${name}-00000000.mp4`,
    mime: "video/mp4",
    bytes: 240_000,
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "video/mp4",
      bytes: 240_000,
      sha256: "d".repeat(64),
      width: 1920,
      height: 1080,
      durationMs,
      codecSummary: "avc1",
    },
  };
}

/**
 * A project with one telling, walked as far as the fourth step.
 *
 * Every shape a story holds is here at least once: a premise lifted out of an
 * uploaded manuscript, two episodes of which one is boarded, four elements of
 * which only the hero is drawn twice, a shot with words in it, an act with a
 * clip, and an assembly that names a real timeline. The tests that want a
 * step taken further take it themselves, through the commands.
 */
export function buildStoryMokaFile(): MokaFile {
  const ids = storyIds();
  const moka = buildTimelineMokaFile();
  moka.resources.images.push(
    storyImage(ids.heroMain, "hero-main"),
    storyImage(ids.heroSheet, "hero-sheet"),
    storyImage(ids.partnerMain, "partner-main"),
    storyImage(ids.sceneMain, "scene-main"),
    storyImage(ids.frameArt, "frame-art"),
  );
  moka.resources.videos.push(storyVideo(ids.actVideo, "act-video", 5_000));
  moka.resources.texts.push({
    id: ids.source,
    name: "novel.txt",
    path: "assets/texts/novel-00000000.txt",
    mime: "text/plain",
    bytes: 40_000,
    createdAt: T0,
    updatedAt: T0,
  });

  moka.stories = [
    {
      id: ids.story,
      name: "雨夜列车",
      schemaVersion: 1,
      brief: {
        idea: "末班列车上，两个陌生人交换了各自要说的话。",
        sourceAssetId: ids.source,
        sourceName: "novel.txt",
        sourceSplit: true,
        totalDurationMs: 120_000,
        aspect: "16:9",
        genre: "对白剧情",
        style: "现代都市风",
      },
      chapters: [
        {
          id: ids.chapterFirst,
          title: "第一章 站台",
          synopsis: "他在站台上等一班已经停运的列车。",
          targetDurationMs: 60_000,
          acts: [
            {
              id: ids.act,
              title: "第 1 幕 空站台",
              summary: "站台上的灯一盏一盏亮起来。",
              characterIds: [ids.hero, ids.partner],
              sceneId: ids.scene,
              propIds: [ids.prop],
              sound: {
                music: "低音提琴，缓慢",
                sfx: "雨声",
                ambience: "空站台",
              },
              keyframes: [
                {
                  id: ids.frameFirst,
                  title: "#1",
                  shotSize: "wide",
                  cameraMove: "pushIn",
                  angle: "eyeLevel",
                  content: "雨中的站台，`林`立在灯下。",
                  dialogue: [
                    {
                      id: ids.lineFirst,
                      characterId: ids.hero,
                      speaker: "林",
                      text: "车已经停运了。",
                      tone: "平静",
                    },
                  ],
                  durationMs: 2_000,
                  art: {
                    takes: [
                      {
                        assetIds: [ids.frameArt],
                        jobId: "job-1",
                        itemId: `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
                        note: "按关键帧生成",
                        createdAt: T0,
                      },
                    ],
                  },
                  video: { takes: [] },
                },
                {
                  id: ids.frameSecond,
                  title: "#2",
                  shotSize: "close",
                  cameraMove: "static",
                  angle: "overTheShoulder",
                  content: "`周`转过身来。",
                  dialogue: [],
                  durationMs: 3_000,
                  art: { takes: [] },
                  video: { takes: [] },
                },
              ],
              video: {
                takes: [
                  {
                    assetIds: [ids.actVideo],
                    jobId: "job-2",
                    itemId: `actVideo:${ids.chapterFirst}:${ids.act}`,
                    note: "按幕生成，5.0s",
                    createdAt: T0,
                  },
                ],
              },
            },
          ],
        },
        {
          id: ids.chapterSecond,
          title: "第二章 车厢",
          synopsis: "车厢比站台更暗。",
          targetDurationMs: 60_000,
          acts: [],
        },
      ],
      elements: [
        {
          id: ids.hero,
          kind: "character",
          name: "林",
          description: "四十岁上下，深色大衣，说话很慢。",
          chapterIds: [ids.chapterFirst],
          main: {
            takes: [{ assetIds: [ids.heroMain], createdAt: T0 }],
          },
          turnaround: {
            takes: [{ assetIds: [ids.heroSheet], createdAt: T0 }],
          },
        },
        {
          id: ids.partner,
          kind: "character",
          name: "周",
          description: "年轻，背着旧书包。",
          chapterIds: [ids.chapterFirst],
          main: {
            takes: [{ assetIds: [ids.partnerMain], createdAt: T0 }],
          },
          turnaround: { takes: [] },
        },
        {
          id: ids.scene,
          kind: "scene",
          name: "末班车车厢",
          description: "空车厢，灯管忽明忽暗。",
          chapterIds: [ids.chapterFirst],
          main: {
            takes: [{ assetIds: [ids.sceneMain], createdAt: T0 }],
          },
        },
        {
          id: ids.prop,
          kind: "prop",
          name: "旧车票",
          description: "边角磨圆的硬纸车票。",
          chapterIds: [],
          main: { takes: [] },
        },
      ],
      shotGranularity: "act",
      maxReferenceImages: REFERENCE_IMAGES_DEFAULT,
      // Settled through the third step: the telling is being boarded, and the
      // prop's drawing and the second episode's board are still to come.
      confirmedSteps: ["idea", "outline", "elements"],
      edit: {
        timelineId: timelineIds().timeline,
        clipByAct: [
          {
            actId: ids.act,
            clipId: timelineIds().videoClip,
          },
        ],
      },
      createdAt: T0,
      updatedAt: T1,
    },
  ];
  return moka;
}

/** A project holding one story that has been given a name and nothing else. */
export function buildEmptyStory(name = "新的故事"): MokaFile {
  const moka = buildGoldenMokaFile();
  moka.stories = [createStory(name)];
  return moka;
}

/**
 * A telling at every ceiling at once: sixty episodes, thirty acts each, and
 * twelve shots in every act. Built on demand, since it is twenty-one thousand
 * shots and no test wants two of them.
 */
export function buildLongStory(): MokaFile {
  const moka = buildEmptyStory("很长的一篇");
  const story = moka.stories![0];
  story.chapters = Array.from({ length: MAX_CHAPTERS_PER_STORY }, (_, c) => ({
    id: `chapter-${c}`,
    title: `第 ${c + 1} 章`,
    synopsis: "梗概",
    targetDurationMs: 60_000,
    acts: Array.from({ length: MAX_ACTS_PER_CHAPTER }, (_, a) => ({
      id: `act-${c}-${a}`,
      title: `第 ${a + 1} 幕`,
      summary: "内容",
      characterIds: [],
      propIds: [],
      sound: { music: "", sfx: "" },
      keyframes: Array.from({ length: MAX_KEYFRAMES_PER_ACT }, (_, k) => ({
        id: `frame-${c}-${a}-${k}`,
        title: `#${k + 1}`,
        shotSize: "medium" as const,
        cameraMove: "static" as const,
        angle: "eyeLevel" as const,
        content: "画面",
        dialogue: [],
        durationMs: 1_000,
        art: { takes: [] },
        video: { takes: [] },
      })),
      video: { takes: [] },
    })),
  }));
  return moka;
}
