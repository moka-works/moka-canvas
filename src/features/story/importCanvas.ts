/**
 * The telling laid out as a board of its own.
 *
 * Everything the steps made is already in the shelf — the drawings, the clips,
 * the sound — so a board of the telling names those same files rather than
 * copying them, and the words the room wrote are written onto cards of their
 * own. Each card carries the ask the room made of its place, so a reader who
 * takes the work into the canvas keeps the words that were already sent and can
 * edit them or ask again from there; each wire is a relation the telling really
 * has, so a card is joined to what it was made from.
 *
 * The board a telling makes is one function of the document as it stands, so
 * what a test reads and what a reader is handed are the same board; making it,
 * opening it and stepping into the editor are the one call beside that, since
 * they are one thing the reader asked for.
 */

import {
  MIN_NODE_HEIGHT,
  ZOOM_MIN,
  createCanvas,
  createNode,
  emptyStorySlot,
  findResource,
  newId,
  nowIso,
  stripStoryMentions,
  validateEdgeCandidate,
  type AssetId,
  type CanvasDocument,
  type CanvasId,
  type GenerationSpec,
  type MokaFile,
  type NodeId,
  type StoryAct,
  type StoryDialogueLine,
  type StoryDocument,
  type StoryKeyframe,
  type Viewport,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../shared/domain";
import { currentTake, takeFile, voiceTakeOf } from "../../shared/domain/story";
import { i18n } from "../../shared/i18n";
import type { InputRole } from "../../api/generate";
import type { StoryJobItemDraft } from "../../api/story";
import { execute } from "../editor/commands/execute";
import { mentionToken } from "../editor/canvas/mentions";
import { openCanvas } from "../editor/interactions/canvasTree";
import { useAppStore } from "../editor/stores/appStore";
import {
  planActMusic,
  planActVideos,
  planActVoice,
  planElementArt,
  planKeyframeArt,
  planKeyframeVideos,
  planLineVoices,
  planOutline,
  planStoryboard,
  spokenLine,
} from "./jobs/plan";

/** How far apart the columns stand, and how wide every card is drawn. */
const COLUMN_PITCH = 400;
const CARD_WIDTH = 280;
/** The air between two rows, and the height a card without a shape takes. */
const ROW_GAP = 60;
const CARD_HEIGHT = 200;
/** The tallest a card drawn from a picture or a shot is allowed to be. */
const CARD_MAX_HEIGHT = 480;

/** Which column each kind of card stands in, counted from the premises. */
const PREMISE_COLUMN = 0;
const ELEMENT_COLUMN = 1;
const ELEMENT_ART_COLUMN = 2;
const TURNAROUND_COLUMN = 3;
const CHAPTER_COLUMN = 1;
const ACT_COLUMN = 2;
const SHOT_COLUMN = 3;
const FRAME_COLUMN = 4;
const CLIP_COLUMN = 5;

/**
 * The port an ask's material travels into, by the role the ask gave it.
 *
 * The story's records name the role rather than the port, since a role is what
 * a provider reads; the canvas names ports. This is the one place the two meet.
 */
const PORT_OF_ROLE: Record<InputRole, string> = {
  reference: "images",
  firstFrame: "firstFrame",
  lastFrame: "lastFrame",
  mask: "mask",
  controlVideo: "videos",
  controlAudio: "audios",
};

/** What a board of the telling would hold, for the button that offers one. */
export interface CanvasImportCounts {
  chapters: number;
  elements: number;
  pictures: number;
  clips: number;
  sounds: number;
}

/**
 * What the telling has made, counted the way the board is laid out.
 *
 * Only the take in use is counted, since that is what the board holds: a place
 * drawn four times is one card, and the takes a reader passed over stay in the
 * story where they were.
 */
export function canvasImportCounts(story: StoryDocument): CanvasImportCounts {
  let pictures = 0;
  let clips = 0;
  let sounds = 0;
  for (const element of story.elements) {
    if (currentTake(element.main) !== undefined) pictures += 1;
    if (
      element.turnaround !== undefined &&
      currentTake(element.turnaround) !== undefined
    ) {
      pictures += 1;
    }
  }
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      if (currentTake(act.video) !== undefined) clips += 1;
      // An act's lines read one by one are a card each, and only when none of
      // them has been read is the older reading of the whole act what the
      // board holds — the same rule the assembly sounds the act by.
      const spoken = readLines(act);
      if (spoken.length > 0) sounds += spoken.length;
      else if (currentTake(act.voice ?? emptyStorySlot()) !== undefined)
        sounds += 1;
      if (currentTake(act.music ?? emptyStorySlot()) !== undefined) sounds += 1;
      for (const keyframe of act.keyframes) {
        if (currentTake(keyframe.art) !== undefined) pictures += 1;
        if (currentTake(keyframe.video) !== undefined) clips += 1;
      }
    }
  }
  return {
    chapters: story.chapters.length,
    elements: story.elements.length,
    pictures,
    clips,
    sounds,
  };
}

/** Whether the telling has generated anything for a board to hold. */
export function hasCanvasImport(story: StoryDocument): boolean {
  const counts = canvasImportCounts(story);
  return (
    counts.chapters > 0 ||
    counts.elements > 0 ||
    counts.pictures > 0 ||
    counts.clips > 0 ||
    counts.sounds > 0
  );
}

/** Where a card stands in the grid, before the rows have their heights. */
interface Seat {
  col: number;
  row: number;
}

/**
 * The board while it is being made: the cards and wires as they land, where
 * each card sits, which card shows each file, and what the telling calls it.
 */
interface Sheet {
  canvas: CanvasDocument;
  seats: Map<NodeId, Seat>;
  /** The tallest card of every row, which is what the next row clears. */
  heights: number[];
  /** The row the next card lands in. */
  row: number;
  /** The card showing each asset, so a wire can say where it comes from. */
  holder: Map<AssetId, NodeId>;
  /** What the telling calls the material in each picture it has a name for. */
  named: Map<AssetId, string>;
}

function newSheet(name: string, story: StoryDocument): Sheet {
  return {
    canvas: createCanvas(name),
    seats: new Map(),
    heights: [],
    row: 0,
    holder: new Map(),
    named: namedPictures(story),
  };
}

/** The next free row. */
function freeRow(sheet: Sheet): number {
  const row = sheet.row;
  sheet.row += 1;
  return row;
}

/** One row of air, so two runs of the telling do not read as one. */
function air(sheet: Sheet): void {
  freeRow(sheet);
}

function sit(
  sheet: Sheet,
  node: WorkflowNode,
  col: number,
  row: number,
): NodeId {
  sheet.canvas.nodes.push(node);
  sheet.seats.set(node.id, { col, row });
  sheet.heights[row] = Math.max(sheet.heights[row] ?? 0, node.bounds.height);
  return node.id;
}

/**
 * What the telling calls the material in each picture, where it has a name for
 * one: an element's drawing is the element, and its ask says so by name.
 */
function namedPictures(story: StoryDocument): Map<AssetId, string> {
  const named = new Map<AssetId, string>();
  for (const element of story.elements) {
    const main = takeFile(currentTake(element.main));
    if (main !== undefined && !named.has(main)) named.set(main, element.name);
  }
  return named;
}

/**
 * The ask's words with the materials it travelled with named as mentions.
 *
 * The room writes a picture into a prompt by naming it — a frame's ask lists
 * the cast it is drawn from, and names them in the sentence above the list —
 * but a board left with those names as prose has references nothing can read:
 * nothing under the field says what the sentence points at, and a run sends the
 * pictures without the sentence saying which is which. Every name the ask
 * travelled with becomes the mention of the card holding that picture, which is
 * how the canvas writes a reference — and what the field draws as the card's
 * own name beside the mark of what it is.
 *
 * The longest names go first, so a name that stands inside another is read as
 * the longer of the two rather than left as half a mention.
 */
function written(ask: StoryJobItemDraft, sheet: Sheet): string {
  const mentioned = new Map<string, NodeId>();
  for (const input of ask.inputs ?? []) {
    const name = sheet.named.get(input.assetId);
    const holder = sheet.holder.get(input.assetId);
    if (name !== undefined && holder !== undefined && !mentioned.has(name)) {
      mentioned.set(name, holder);
    }
  }
  let prompt = ask.prompt;
  const names = [...mentioned.keys()].sort(
    (one, other) => other.length - one.length,
  );
  for (const name of names) {
    prompt = prompt
      .split(name)
      .join(mentionToken(mentioned.get(name) as NodeId));
  }
  return prompt;
}

/** The ask a card carries, as the spec a run reads it through. */
function specOf(
  ask: StoryJobItemDraft | undefined,
  sheet: Sheet,
): GenerationSpec | undefined {
  if (ask === undefined) return undefined;
  const prompt = written(ask, sheet);
  return {
    capability: ask.capability,
    mode: "generate",
    // Which model answered in the story room is this machine's own choice and
    // is kept beside the machine rather than in a document: a card carrying one
    // would name a model a reader elsewhere has never configured.
    model: "",
    prompt,
    // Everything wired into the card is what its ask was made of, so the card
    // is asked the way the room asked it — and where the ask's own words name
    // those pictures, the naming is what says so.
    inputMode: prompt === ask.prompt ? "upstream" : "mentions",
    params: {
      ...(ask.params ?? {}),
      // The standing instruction a written answer was asked under rides in the
      // parameters, which is the field of a text ask that a provider reads as
      // the framing of an answer.
      ...(ask.system === undefined ? {} : { instructions: ask.system }),
    },
    referenceNodeIds: [],
    updatedAt: nowIso(),
  };
}

/** A card of words, sitting where it is put. */
function words(
  sheet: Sheet,
  col: number,
  row: number,
  title: string,
  content: string,
  ask?: StoryJobItemDraft,
): NodeId {
  const node = createNode(
    "text",
    { x: 0, y: 0 },
    { title, width: CARD_WIDTH, height: CARD_HEIGHT },
  );
  const spec = specOf(ask, sheet);
  node.data = {
    content,
    ...(spec === undefined ? {} : { generation: spec }),
  };
  return sit(sheet, node, col, row);
}

/**
 * How tall a card of material is drawn: the shape of the file it holds, as far
 * as the file was measured, and a card of sound or words otherwise.
 */
function materialHeight(
  kind: "image" | "audio" | "video",
  assetId: AssetId,
  moka: MokaFile,
): number {
  if (kind === "audio") return CARD_HEIGHT;
  const probe = findResource(moka, assetId)?.probe;
  if (probe?.width === undefined || probe.height === undefined) {
    return CARD_HEIGHT;
  }
  const height = Math.round((CARD_WIDTH * probe.height) / probe.width);
  return Math.min(CARD_MAX_HEIGHT, Math.max(MIN_NODE_HEIGHT, height));
}

/** A card of material: the file the shelf already holds, and the ask that drew it. */
function material(
  sheet: Sheet,
  moka: MokaFile,
  col: number,
  row: number,
  kind: "image" | "audio" | "video",
  assetId: AssetId,
  title: string,
  ask?: StoryJobItemDraft,
  audioCategory?: "music" | "voice",
): NodeId | undefined {
  const entry = findResource(moka, assetId);
  if (entry === undefined) return undefined;
  const node = createNode(
    kind,
    { x: 0, y: 0 },
    { title, width: CARD_WIDTH, height: materialHeight(kind, assetId, moka) },
  );
  const spec = specOf(ask, sheet);
  node.data = {
    ...node.data,
    assetId,
    ...(kind === "audio" && audioCategory !== undefined
      ? { audioCategory }
      : {}),
    ...(spec === undefined ? {} : { generation: spec }),
  };
  const id = sit(sheet, node, col, row);
  sheet.holder.set(assetId, id);
  return id;
}

/** One wire, if the document would take it. */
function wire(sheet: Sheet, from: NodeId, to: NodeId, portId: string): void {
  const edge: WorkflowEdge = {
    id: newId(),
    source: { nodeId: from, portId: "out" },
    target: { nodeId: to, portId },
    createdAt: nowIso(),
  };
  if (!validateEdgeCandidate(sheet.canvas, edge.source, edge.target).ok) return;
  sheet.canvas.edges.push(edge);
}

/**
 * The wires an ask brought with it: every piece of material it was sent is a
 * wire into the port its role names.
 *
 * A material that is not on the board — a take since redrawn, a file the shelf
 * has lost — is a wire nobody can draw, and leaving it out is what keeps the
 * board from pointing at nothing.
 */
function wireAsk(
  sheet: Sheet,
  ask: StoryJobItemDraft | undefined,
  to: NodeId,
): void {
  for (const input of ask?.inputs ?? []) {
    const from = sheet.holder.get(input.assetId);
    if (from === undefined) continue;
    wire(sheet, from, to, PORT_OF_ROLE[input.role]);
  }
}

/**
 * The words of a shot: what it shows, and the lines said in it.
 *
 * The backticks around a mentioned name are the room's own mark, not the
 * telling's words, so the card is written without them.
 */
function shotWords(keyframe: StoryKeyframe): string {
  const lines = keyframe.dialogue
    .map((line) => spokenLine(line))
    .filter((line) => line !== "");
  return [stripStoryMentions(keyframe.content).trim(), ...lines]
    .filter((part) => part !== "")
    .join("\n");
}

/** The cast, each with the words that describe it and the drawings beside them. */
function elementsBand(
  sheet: Sheet,
  moka: MokaFile,
  story: StoryDocument,
): void {
  for (const element of story.elements) {
    const row = freeRow(sheet);
    const described = words(
      sheet,
      ELEMENT_COLUMN,
      row,
      element.name,
      element.description,
    );
    const main = takeFile(currentTake(element.main));
    const drawn =
      main === undefined
        ? undefined
        : material(
            sheet,
            moka,
            ELEMENT_ART_COLUMN,
            row,
            "image",
            main,
            `${element.name} · ${i18n.t("story:import.main")}`,
            planElementArt(story, [{ elementId: element.id, view: "main" }])[0],
          );
    if (drawn !== undefined) wire(sheet, described, drawn, "prompt");
    const turnaround = takeFile(
      currentTake(element.turnaround ?? emptyStorySlot()),
    );
    const sheeted =
      turnaround === undefined
        ? undefined
        : material(
            sheet,
            moka,
            TURNAROUND_COLUMN,
            row,
            "image",
            turnaround,
            `${element.name} · ${i18n.t("story:import.turnaround")}`,
            planElementArt(story, [
              { elementId: element.id, view: "turnaround" },
            ])[0],
          );
    if (sheeted !== undefined) {
      // The turn-around is drawn from the one picture of the character there
      // is, which is the whole reason it is not drawn before that one.
      if (drawn !== undefined) wire(sheet, drawn, sheeted, "images");
    }
  }
}

/** One act's own clip and its sound, beside the act they belong to. */
function actSoundBand(
  sheet: Sheet,
  moka: MokaFile,
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  actCard: NodeId,
  row: number,
  place: string,
): void {
  // The clip first, then the sound under it, in the order the story room reads
  // them; each stands in its own column of the act's row. A clip filmed in
  // pieces is one card a piece, in the order the pieces play, since that is how
  // the board makes the film again: one ask after another.
  const clipAsks = planActVideos(story, chapterId, [act.id]);
  const spoken = readLines(act);
  const pieces: Array<{
    kind: "audio" | "video";
    assetId: AssetId | undefined;
    ask: StoryJobItemDraft | undefined;
    title: string;
    category?: "music" | "voice";
  }> = [
    ...(currentTake(act.video)?.assetIds ?? []).map((assetId, at) => ({
      kind: "video" as const,
      assetId,
      ask: clipAsks[at],
      title: `${place} · ${i18n.t("story:import.clip")}`,
    })),
    // The lines read aloud, one card a line: each was asked for on its own, so
    // each is a card of its own carrying its own ask — a board of a telling
    // read in the voices of its characters says which line is which.
    ...spoken.map((reading) => ({
      kind: "audio" as const,
      assetId: reading.assetId,
      ask: planLineVoices(story, chapterId, act.id, [reading.line.id])[0],
      title: `${place} · ${i18n.t("story:import.voiceLine", {
        at: reading.at,
      })}${reading.line.speaker.trim() === "" ? "" : ` · ${reading.line.speaker.trim()}`}`,
      category: "voice" as const,
    })),
    // A reading of the whole act, made before its lines had voices of their
    // own, is one card and said to be what it is.
    ...(spoken.length > 0
      ? []
      : [
          {
            kind: "audio" as const,
            assetId: takeFile(currentTake(act.voice ?? emptyStorySlot())),
            ask: planActVoice(story, chapterId, act.id)[0],
            title: `${place} · ${i18n.t("story:import.voice")}`,
            category: "voice" as const,
          },
        ]),
    {
      kind: "audio",
      assetId: takeFile(currentTake(act.music ?? emptyStorySlot())),
      ask: planActMusic(story, chapterId, act.id)[0],
      title: `${place} · ${i18n.t("story:import.score")}`,
      category: "music",
    },
  ];
  let col = FRAME_COLUMN;
  for (const piece of pieces) {
    if (piece.assetId === undefined) continue;
    const card = material(
      sheet,
      moka,
      col,
      row,
      piece.kind,
      piece.assetId,
      piece.title,
      piece.ask,
      piece.category,
    );
    if (card === undefined) continue;
    col += 1;
    wire(sheet, actCard, card, "prompt");
    wireAsk(sheet, piece.ask, card);
  }
}

/**
 * The lines of an act that have been read aloud, one reading each.
 *
 * A line with no take is not a card: the board holds what the telling made,
 * and a line nobody has read made nothing. The number a reading carries is its
 * place among the act's said lines rather than among the readings, so a card
 * for the third line stays the third line when the ones before it are read.
 */
function readLines(
  act: StoryAct,
): Array<{ line: StoryDialogueLine; assetId: AssetId; at: number }> {
  const readings: Array<{
    line: StoryDialogueLine;
    assetId: AssetId;
    at: number;
  }> = [];
  let said = 0;
  for (const keyframe of act.keyframes) {
    for (const line of keyframe.dialogue) {
      if (line.text.trim() === "") continue;
      said += 1;
      const assetId = takeFile(
        currentTake(voiceTakeOf(keyframe, line.id)?.slot ?? emptyStorySlot()),
      );
      if (assetId === undefined) continue;
      readings.push({ line, assetId, at: said });
    }
  }
  return readings;
}

/** The telling itself: the premise, and every episode's acts and shots under it. */
function tellingBand(
  sheet: Sheet,
  moka: MokaFile,
  story: StoryDocument,
  premise: NodeId | undefined,
): void {
  story.chapters.forEach((chapter, chapterAt) => {
    const chapterRow = freeRow(sheet);
    const chapterCard = words(
      sheet,
      CHAPTER_COLUMN,
      chapterRow,
      `${chapterAt + 1}. ${chapter.title}`,
      chapter.synopsis,
      planStoryboard(story, [chapter.id])[0],
    );
    if (premise !== undefined) wire(sheet, premise, chapterCard, "prompt");

    chapter.acts.forEach((act, actAt) => {
      const place = `${chapterAt + 1}.${actAt + 1}`;
      const actRow = freeRow(sheet);
      const actCard = words(
        sheet,
        ACT_COLUMN,
        actRow,
        `${place} ${act.title}`,
        act.summary,
      );
      wire(sheet, chapterCard, actCard, "prompt");

      act.keyframes.forEach((keyframe, shotAt) => {
        const shotPlace = `${place}.${shotAt + 1}`;
        const shotRow = freeRow(sheet);
        const shotCard = words(
          sheet,
          SHOT_COLUMN,
          shotRow,
          shotPlace,
          shotWords(keyframe),
        );
        wire(sheet, actCard, shotCard, "prompt");

        const target = {
          chapterId: chapter.id,
          actId: act.id,
          keyframeId: keyframe.id,
        };
        const art = takeFile(currentTake(keyframe.art));
        const artAsk = planKeyframeArt(story, [target])[0];
        const frame =
          art === undefined
            ? undefined
            : material(
                sheet,
                moka,
                FRAME_COLUMN,
                shotRow,
                "image",
                art,
                `${shotPlace} · ${i18n.t("story:import.frame")}`,
                artAsk,
              );
        if (frame !== undefined) {
          wire(sheet, shotCard, frame, "prompt");
          wireAsk(sheet, artAsk, frame);
        }

        const clip = takeFile(currentTake(keyframe.video));
        const clipAsk = planKeyframeVideos(story, chapter.id, act.id, [
          keyframe.id,
        ])[0];
        const filmed =
          clip === undefined
            ? undefined
            : material(
                sheet,
                moka,
                CLIP_COLUMN,
                shotRow,
                "video",
                clip,
                `${shotPlace} · ${i18n.t("story:import.clip")}`,
                clipAsk,
              );
        if (filmed !== undefined) {
          wire(sheet, shotCard, filmed, "prompt");
          wireAsk(sheet, clipAsk, filmed);
        }
      });

      actSoundBand(sheet, moka, story, chapter.id, act, actCard, actRow, place);
    });
  });
}

/**
 * Where every card stands, once the whole sheet is known.
 *
 * A row is as tall as the tallest card in it, so a column of pictures of
 * different shapes never runs into the row below — and a band of the telling
 * is one place to read rather than a scatter of cards.
 *
 * The board also says where it wants to be looked at from: a telling laid out
 * this way is taller and wider than a window, so it opens framed as a whole
 * rather than onto a corner of itself with the rest off the edge.
 */
function place(sheet: Sheet): CanvasDocument {
  if (sheet.canvas.nodes.length === 0) return sheet.canvas;
  const tops: number[] = [];
  let at = 0;
  for (let row = 0; row < sheet.row; row += 1) {
    tops.push(at);
    at += (sheet.heights[row] ?? 0) + ROW_GAP;
  }
  const nodes = sheet.canvas.nodes.map((node) => {
    const seat = sheet.seats.get(node.id);
    if (seat === undefined) return node;
    return {
      ...node,
      bounds: {
        x: seat.col * COLUMN_PITCH,
        y: tops[seat.row] ?? 0,
        width: node.bounds.width,
        height: node.bounds.height,
      },
    };
  });
  return { ...sheet.canvas, nodes, viewport: framedViewport(nodes) };
}

/** The window a board is framed for when it is opened the first time. */
const FRAMED_VIEW = { width: 1280, height: 800 };
const FRAMED_PADDING = 120;

/** The camera that holds the whole board, and never magnifies a small one. */
function framedViewport(nodes: WorkflowNode[]): Viewport {
  const minX = Math.min(...nodes.map((node) => node.bounds.x));
  const minY = Math.min(...nodes.map((node) => node.bounds.y));
  const width =
    Math.max(...nodes.map((node) => node.bounds.x + node.bounds.width)) - minX;
  const height =
    Math.max(...nodes.map((node) => node.bounds.y + node.bounds.height)) - minY;
  const zoom = Math.max(
    ZOOM_MIN,
    Math.min(
      1,
      (FRAMED_VIEW.width - FRAMED_PADDING * 2) / Math.max(1, width),
      (FRAMED_VIEW.height - FRAMED_PADDING * 2) / Math.max(1, height),
    ),
  );
  return { x: minX + width / 2, y: minY + height / 2, zoom };
}

/**
 * The board the telling makes: what the steps have generated so far, in the
 * order the telling tells it, each card wired to what it came from.
 */
export function planStoryCanvas(
  story: StoryDocument,
  moka: MokaFile,
  name: string,
): CanvasDocument {
  const sheet = newSheet(name, story);
  if (story.elements.length > 0) {
    elementsBand(sheet, moka, story);
    air(sheet);
  }
  const idea = story.brief.idea.trim();
  const premise =
    idea === ""
      ? undefined
      : words(
          sheet,
          PREMISE_COLUMN,
          freeRow(sheet),
          i18n.t("story:import.premise"),
          idea,
          planOutline(story, {
            mode: "expand",
            chapters: Math.max(1, story.chapters.length),
          })[0],
        );
  tellingBand(sheet, moka, story, premise);
  return place(sheet);
}

/**
 * The same board, added to the project and opened.
 *
 * Which canvas is added, opened and switched to is one thing the reader asked
 * for, so it is done here rather than in the button: a refusal — a canvas too
 * full for the document — toasts its reason and leaves the reader where they
 * were, with the story they were working on still in front of them.
 */
export function importStoryToCanvas(
  story: StoryDocument,
  moka: MokaFile,
  name: string,
): CanvasId | null {
  const canvas = planStoryCanvas(story, moka, name);
  const applied = execute(i18n.t("story:history.importCanvas"), [
    { type: "addCanvas", canvas },
  ]);
  if (applied === null) return null;
  openCanvas(canvas.id);
  useAppStore.getState().setPhase("editing");
  useAppStore.getState().pushToast(
    "success",
    i18n.t("story:import.canvas.done", {
      count: canvas.nodes.length,
      name: canvas.name,
    }),
  );
  return canvas.id;
}
