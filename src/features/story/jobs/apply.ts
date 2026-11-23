/**
 * Writing a batch's answers into the story that asked for them.
 *
 * This is the one place a job's record meets the document. What it does is
 * planned first and applied once: every piece that answered is read into the
 * drafts a command takes, the drafts are merged with what the story already
 * holds, and the whole lot goes through the command pipeline as one step.
 *
 * A batch read in over several looks is one step just the same: the pieces one
 * look brings are recorded under the batch's own name, and a landing that finds
 * the one before it still on top of the stack joins it — so a reader who does
 * not like what came back undoes the batch, not twelve drawings.
 *
 * Applying an answer twice is not two answers. A place that already keeps the
 * drawing is left as it is, a chapter that already has the words is written the
 * same words, and a batch whose answers are all already there plans no command
 * at all: nothing is pushed onto the history, and the reader is not offered an
 * undo of a step that changed nothing. That is what makes reading a batch that
 * landed while nobody was looking safe — beside the record's own note that its
 * answer has been read in, which is what keeps an answer from being read a
 * second time at all.
 */

import { nowIso } from "../../../shared/domain/ids";
import type { DocumentCommand } from "../../../shared/domain/types";
import {
  applyElementAppearance,
  elementKey,
  foldPendingTakes,
  keyframeAt,
  mergeActs,
  mergeChaptersAt,
  mergeElements,
  recognizeKeyframeReferences,
  slotAt,
  syncChapterBoard,
  withTake,
  type ActDraft,
  type ChapterWrite,
  type StoryChapterDraft,
  type StoryElementDraft,
  type StoryGuess,
} from "../../../shared/domain/story";
import { chapterTargetMs } from "../../../shared/domain/factories";
import {
  parseChapter,
  parseElements,
  parseOutline,
  parseStoryboard,
} from "../../../shared/domain/parse/story";
import { parseStoryJson } from "../../../shared/domain/parse/json";
import type {
  StoryChapter,
  StoryDocument,
  StorySlot,
  StorySlotTarget,
  StoryTake,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import type { StoryJobItem, StoryJobRecord } from "../../../api/story";
import {
  ELEMENT_MERGE_ID,
  jobKey,
  videoCeiling,
  withRequiredReferences,
  type ElementReading,
  type ElementRepeat,
} from "./plan";
import { checkBoard, type BoardAnswer } from "./board";
import { applyContinuity } from "./continuity";

/** What the room knows about a batch that the record alone does not say. */
export interface ApplyContext {
  /**
   * Names an earlier part of this recognition already described: this part's
   * words are held for the merge rather than written over them.
   */
  holdDescriptionKeys?: Set<string>;
}

/** One answer that was succeeded but could not be read into the story. */
export interface UnreadableAnswer {
  id: string;
  kind: "outline" | "elements";
}

/** What reading one batch's answers did to the story. */
export interface ApplyReport {
  /** Pieces whose answers were written into the document. */
  applied: number;
  /** Pieces that had nothing to write: still running, failed, or gone. */
  skipped: number;
  /** What could not be written, in the reader's language. */
  notes: string[];
  /**
   * Answers that came home but could not be read. They are the ones a repair
   * ask can help with; a piece that failed has nothing to repair.
   */
  unreadable?: UnreadableAnswer[];
  /**
   * Whether the document refused the whole lot, so nothing of it was written.
   *
   * Read apart from a count of nought: nothing to write is the batch's own
   * answer being nothing new, and the room has had it; a refusal is an answer
   * the story asked for and did not get, and is one to ask for again.
   */
  refused?: boolean;
}

/** The label one batch's answers go into the history under. */
function historyLabel(record: StoryJobRecord): string {
  if (
    record.items.length > 0 &&
    record.items.every((item) => item.id.startsWith(ELEMENT_MERGE_ID))
  ) {
    return i18n.t("story:history.apply.elementsMerge");
  }
  return i18n.t(`story:history.apply.${record.kind}`);
}

/**
 * The story a batch was asked for, if the document still holds it.
 *
 * A story deleted while a batch was out is not an error and not a place to
 * write into: the pictures it drew are in the shelf, and the notes say the rest.
 */
function storyOf(record: StoryJobRecord): StoryDocument | undefined {
  const moka = useProjectStore.getState().moka;
  return (moka?.stories ?? []).find((story) => story.id === record.storyId);
}

/** The take a filed asset — or an act's filed pieces — is kept as. */
function takeOf(
  record: StoryJobRecord,
  item: StoryJobItem,
  assetIds: string[],
): StoryTake {
  const line = item.prompt.split("\n")[0]?.trim() ?? "";
  return {
    assetIds,
    jobId: record.id,
    itemId: item.id,
    ...(line === "" ? {} : { note: line.slice(0, 120) }),
    createdAt: nowIso(),
  };
}

function slotCommand(
  story: StoryDocument,
  target: StorySlotTarget,
  slot: StorySlot,
  read?: { text: string; voice: string },
): DocumentCommand[] {
  return [
    {
      type: "setStorySlot",
      storyId: story.id,
      target,
      slot,
      ...(read === undefined ? {} : { read }),
    },
  ];
}

/** Whether a piece is one drawing of a set asked for together. */
function multiArtItem(item: StoryJobItem): boolean {
  return (
    (item.copies ?? 1) > 1 &&
    (item.target.kind === "elementArt" || item.target.kind === "keyframeArt")
  );
}

export function pendingArtSetId(record: StoryJobRecord): string | undefined {
  const item = record.items.find(multiArtItem);
  return item === undefined ? undefined : (item.setId ?? record.id);
}

/**
 * Writes one ask's drawings into the place as a set waiting to be chosen
 * between, rather than as takes already kept.
 *
 * A set is one choice, so its drawings do not become the place's history one
 * by one: they wait here until the reader says which is the one, and only then
 * do all of them join the takes. A set still arriving is the same set, so a
 * second landing appends to it rather than starting over; a set the reader
 * ignored in favour of a newer ask is kept as ordinary takes first, so its
 * drawings are not lost from the place.
 */
function pendingArtCommands(
  story: StoryDocument,
  record: StoryJobRecord,
  items: StoryJobItem[],
  report: ApplyReport,
): DocumentCommand[] {
  const target = slotTargetOf(items[0]!);
  if (target === undefined) {
    report.skipped += items.length;
    return [];
  }
  const slot = slotAt(story, target);
  if (slot === undefined) {
    report.skipped += items.length;
    report.notes.push(
      i18n.t("story:jobs.targetGone", { label: jobKey(items[0]!.target) }),
    );
    return [];
  }
  const expected = Math.max(...items.map((item) => item.copies ?? 1));
  const setId = pendingArtSetId(record) ?? record.id;
  let base = slot;
  if (base.pending !== undefined && base.pending.jobId !== setId) {
    base = foldPendingTakes(base);
  }
  const candidates = [...(base.pending?.takes ?? [])];
  const known = new Set(
    candidates.flatMap((take) => take.assetIds.map((id) => `${id}`)),
  );
  let added = 0;
  for (const item of items) {
    const assetId = item.assetIds?.[0];
    if (assetId === undefined) {
      report.skipped += 1;
      continue;
    }
    if (known.has(assetId)) {
      report.skipped += 1;
      continue;
    }
    known.add(assetId);
    candidates.push(takeOf(record, item, [assetId]));
    added += 1;
  }
  if (added === 0) return [];
  report.applied += added;
  return slotCommand(story, target, {
    ...base,
    pending: {
      jobId: setId,
      count: Math.max(expected, base.pending?.count ?? 0),
      takes: candidates,
    },
  });
}

/**
 * Every place a story holds, with the target that names it.
 *
 * The same walk the document's own checks make, kept here for the one thing
 * reading a batch needs: finding the sets still waiting on a batch that has
 * ended.
 */
function storySlotPlaces(
  story: StoryDocument,
): Array<{ target: StorySlotTarget; slot: StorySlot }> {
  const places: Array<{ target: StorySlotTarget; slot: StorySlot }> = [];
  for (const element of story.elements) {
    places.push({
      target: { kind: "element", elementId: element.id, view: "main" },
      slot: element.main,
    });
    if (element.turnaround !== undefined) {
      places.push({
        target: { kind: "element", elementId: element.id, view: "turnaround" },
        slot: element.turnaround,
      });
    }
    for (const variant of element.variants ?? []) {
      places.push({
        target: {
          kind: "element",
          elementId: element.id,
          view: "main",
          variantId: variant.id,
        },
        slot: variant.main,
      });
      if (variant.turnaround !== undefined) {
        places.push({
          target: {
            kind: "element",
            elementId: element.id,
            view: "turnaround",
            variantId: variant.id,
          },
          slot: variant.turnaround,
        });
      }
    }
  }
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
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
      }
    }
  }
  return places;
}

/**
 * Closes the sets a batch left open.
 *
 * A set that came home short — one drawing refused, the batch cancelled — is
 * one the reader can still choose from: what did arrive is made whole by
 * counting it as the whole set, rather than leaving a place that waits forever
 * for a drawing nobody is making. A set that came home with nothing is let go.
 */
export function settlePendingArt(
  record: StoryJobRecord,
  records: StoryJobRecord[] = [record],
): void {
  const setId = pendingArtSetId(record);
  if (setId === undefined) return;
  const at = records.findIndex((other) => other.id === record.id);
  // A later record may be finished on the server but not applied here yet.
  const waiting = records.some(
    (other, index) =>
      pendingArtSetId(other) === setId &&
      (other.status === "queued" ||
        other.status === "running" ||
        (index > at && other.readAt === undefined)),
  );
  if (waiting) return;
  const story = storyOf(record);
  if (story === undefined) return;
  const commands: DocumentCommand[] = [];
  for (const { target, slot } of storySlotPlaces(story)) {
    const pending = slot.pending;
    if (pending === undefined || pending.jobId !== setId) continue;
    if (pending.takes.length >= pending.count) continue;
    if (pending.takes.length === 0) {
      const rest = { ...slot };
      delete rest.pending;
      commands.push(...slotCommand(story, target, rest));
      continue;
    }
    commands.push(
      ...slotCommand(story, target, {
        ...slot,
        pending: { ...pending, count: pending.takes.length },
      }),
    );
  }
  if (commands.length > 0) execute(historyLabel(record), commands, record.id);
}

/**
 * What a line was read as: the words the board holds for it, and the tone the
 * ask carried.
 *
 * The words are read off the document rather than off the ask, because what a
 * take is filed under is the line it fills, and a line edited and edited back
 * is the same line. A take that was read before the line was rewritten is told
 * from the line by comparing the two, which is what makes "the words have
 * changed since this was read" something the card can say.
 */
function readOf(
  story: StoryDocument,
  item: StoryJobItem,
  target: StorySlotTarget,
): { text: string; voice: string } | undefined {
  if (target.kind !== "lineVoice") return undefined;
  const line = keyframeAt(story, target)?.dialogue.find(
    (held) => held.id === target.lineId,
  );
  const voice = item.params.voice;
  return {
    text: line?.text.trim() ?? "",
    voice: typeof voice === "string" ? voice : "",
  };
}

/** The place in the story a job target names, in the commands' own words. */
function slotTargetOf(item: StoryJobItem): StorySlotTarget | undefined {
  switch (item.target.kind) {
    case "elementArt":
      return {
        kind: "element",
        elementId: item.target.elementId,
        view: item.target.view,
        ...(item.target.variantId === undefined
          ? {}
          : { variantId: item.target.variantId }),
      };
    case "keyframeArt":
      return {
        kind: "keyframe",
        chapterId: item.target.chapterId,
        actId: item.target.actId,
        keyframeId: item.target.keyframeId,
      };
    case "actVideo":
      return {
        kind: "actVideo",
        chapterId: item.target.chapterId,
        actId: item.target.actId,
      };
    case "keyframeVideo":
      return {
        kind: "keyframeVideo",
        chapterId: item.target.chapterId,
        actId: item.target.actId,
        keyframeId: item.target.keyframeId,
      };
    case "voice":
      return {
        kind: "actVoice",
        chapterId: item.target.chapterId,
        actId: item.target.actId,
      };
    case "lineVoice":
      return {
        kind: "lineVoice",
        chapterId: item.target.chapterId,
        actId: item.target.actId,
        keyframeId: item.target.keyframeId,
        lineId: item.target.lineId,
      };
    case "music":
      return {
        kind: "actMusic",
        chapterId: item.target.chapterId,
        actId: item.target.actId,
      };
    case "outline":
    case "elements":
    case "storyboard":
    case "continuity":
    case "outlineRevision":
      return undefined;
  }
}

// -----------------------------------------------------------------------------
// The written steps
// -----------------------------------------------------------------------------

/**
 * What one piece's answer said, read the way both shapes of the outline ask
 * are read: a premise answers with the whole table, a manuscript's part with
 * one chapter of it.
 *
 * Read here rather than in the step so that the words a reader is shown when
 * an answer cannot be read are the same words the reading failed on, and a
 * reader fixing one by hand is judged by the same rules as the batch was.
 */
export interface OutlineReading {
  drafts?: StoryChapterDraft[];
  warnings: string[];
  /** Why it could not be read, when it could not. */
  error?: string;
}

export function readOutlineAnswer(text: string): OutlineReading {
  const read = parseStoryJson(text);
  if (!read.ok) return { warnings: [], error: read.error };
  const many = parseOutline(read.value);
  if (many.ok) return { drafts: many.value, warnings: many.warnings };
  const one = parseChapter(read.value);
  if (one.ok) return { drafts: [one.value], warnings: one.warnings };
  return { warnings: [], error: one.error };
}

/** What one elements answer said, as the reading of it came out. */
export interface ElementsReading {
  drafts?: StoryElementDraft[];
  warnings: string[];
  /** Why it could not be read, when it could not. */
  error?: string;
}

/**
 * What the element reading of one answer came out as.
 *
 * Read here rather than in the step so that what the batch writes into the
 * story and what the step shows a reader about it come from the one reading.
 */
export function readElementsAnswer(text: string): ElementsReading {
  const read = parseStoryJson(text);
  if (!read.ok) return { warnings: [], error: read.error };
  const parsed = parseElements(read.value);
  if (!parsed.ok) return { warnings: [], error: parsed.error };
  return { drafts: parsed.value, warnings: parsed.warnings };
}

/** One part of a telling's elements reading: `elements:1`, `elements:2`… */
const ELEMENT_PART = /^elements:(\d+)$/;

function partOf(record: StoryJobRecord): number {
  const found = record.items
    .map((item) => ELEMENT_PART.exec(item.id))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  return found.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...found);
}

/**
 * The names this recognition's parts described more than once.
 *
 * The parts are read in the order they were asked for, and each name keeps its
 * appearances in that order: the first part's words come first, and a part
 * that said the same default and forms again adds nothing. A name only one part returned
 * to is not a repeat and earns no merge ask — the cast already keeps it as the
 * one part described it.
 */
export function collectElementRepeats(
  records: StoryJobRecord[],
): ElementRepeat[] {
  const groups = new Map<string, ElementRepeat>();
  const order: string[] = [];
  const ordered = [...records].sort(
    (one, other) => partOf(one) - partOf(other),
  );
  for (const record of ordered) {
    for (const item of record.items) {
      if (item.status !== "succeeded" || ELEMENT_PART.exec(item.id) === null) {
        continue;
      }
      const read = readElementsAnswer(item.text ?? "");
      for (const draft of read.drafts ?? []) {
        const key = elementKey(draft.kind, draft.name);
        let group = groups.get(key);
        if (group === undefined) {
          group = { kind: draft.kind, name: draft.name, readings: [] };
          groups.set(key, group);
          order.push(key);
        }
        const reading: ElementReading = {
          description: draft.description,
          ...(draft.forms === undefined ? {} : { forms: draft.forms }),
        };
        if (
          !group.readings.some(
            (held) => JSON.stringify(held) === JSON.stringify(reading),
          )
        ) {
          group.readings.push(reading);
        }
      }
    }
  }
  return order
    .map((key) => groups.get(key))
    .filter(
      (group): group is ElementRepeat =>
        group !== undefined && group.readings.length >= 2,
    );
}

/**
 * What a board's answer said, as the reading of it came out.
 *
 * The answer as it was written travels beside the drafts because a board can
 * lose an act or a shot in the reading, and a lost shot is exactly what the
 * story may not quietly keep.
 */
export interface BoardReading extends BoardAnswer {
  /** The cells the reading chose a framing, a movement or an angle for. */
  guesses: StoryGuess[];
}

/**
 * What one board's answer said, read the way the batch read it.
 *
 * The step shows the board it was given: what the reading had to warn about,
 * and which cells it chose a framing for because the answer offered one nobody
 * knows. Reading it here rather than in the step keeps the one reading — what
 * a repaired answer is judged by and what a reader is shown come from the same
 * place.
 */
export function readBoardAnswer(
  story: StoryDocument,
  item: StoryJobItem,
): BoardReading {
  const read = parseStoryJson(item.text ?? "");
  if (!read.ok) return { warnings: [], guesses: [], error: read.error };
  const target = item.target;
  const chapter =
    target.kind === "storyboard"
      ? story.chapters.find((held) => held.id === target.chapterId)
      : undefined;
  const parsed = parseStoryboard(read.value, {
    elements: story.elements,
    targetDurationMs: chapter?.targetDurationMs ?? 0,
    maxVideoSeconds: videoCeiling(),
  });
  if (!parsed.ok) {
    return { warnings: [], guesses: [], error: parsed.error };
  }
  return {
    drafts: parsed.value,
    warnings: parsed.warnings,
    raw: read.value,
    guesses: parsed.value.flatMap((act) => act.guessed ?? []),
  };
}

/**
 * The cells of a chapter's board that the reading chose rather than read.
 *
 * Read off the batch that wrote the board rather than kept in the document: a
 * mark is about an answer, not about a board, and a board the reader has since
 * edited by hand is a board they have already looked at. Acts are matched by
 * their place, which is the order the answer wrote them in.
 */
export function chapterGuesses(
  story: StoryDocument,
  chapterId: string,
  jobs: StoryJobRecord[],
): Map<string, StoryGuess[]> {
  const marks = new Map<string, StoryGuess[]>();
  const chapter = story.chapters.find((held) => held.id === chapterId);
  if (chapter === undefined) return marks;
  // The batches are newest first, and the board as it stands came from the
  // newest answer that could be read into it.
  const written = jobs
    .filter((job) => job.kind === "storyboard")
    .flatMap((job) => job.items)
    .find(
      (item) =>
        item.target.kind === "storyboard" &&
        item.target.chapterId === chapterId &&
        item.status === "succeeded" &&
        (item.text ?? "").trim() !== "",
    );
  if (written === undefined) return marks;
  const read = readBoardAnswer(story, written);
  // A bridge is not one of the acts the board answered about, so the answer's
  // acts are matched to the chapter's ordinary ones in order.
  const acts = chapter.acts.filter((act) => act.transition === undefined);
  (read.drafts ?? []).forEach((draft, index) => {
    const act = acts[index];
    if (act !== undefined && draft.guessed !== undefined) {
      marks.set(act.id, draft.guessed);
    }
  });
  return marks;
}

/**
 * The place in the table an outline piece's answer belongs.
 *
 * `outline` is the whole table, `outline:N` is the Nth part of a manuscript
 * cut one chapter at a time, and `outline:rewrite:N` is the Nth chapter asked
 * for again — all three name a place, so the reading is the same.
 */
const PART = /^outline:(?:rewrite:)?(\d+)$/;

/** One part of a telling's chapters, when a reading was asked for one. */
const PART_ELEMENTS = /^elements:\d+$/;

/** The place in the table an outline piece's answer belongs. */
function partAt(itemId: string): number {
  const part = PART.exec(itemId);
  return part === null ? 0 : Number(part[1]) - 1;
}

/** Every chapter this piece's answer holds, at the places it asked for. */
function chapterWrites(item: StoryJobItem):
  | {
      writes: ChapterWrite[];
      warnings: string[];
    }
  | undefined {
  const read = readOutlineAnswer(item.text ?? "");
  if (read.drafts === undefined) return undefined;
  const first = partAt(item.id);
  return {
    writes: read.drafts.map((draft, index) => ({ at: first + index, draft })),
    warnings: read.warnings,
  };
}

/**
 * The chapters a batch of outline answers makes of the story.
 *
 * Every piece that answered is read, and the whole lot goes into the table at
 * once: a manuscript's parts are chapters of one telling, so writing them one
 * command at a time would leave the story holding whichever part came home
 * last.
 */
function outlineCommands(
  story: StoryDocument,
  record: StoryJobRecord,
  report: ApplyReport,
): DocumentCommand[] {
  const pieces = record.items.filter(
    (item) =>
      item.target.kind === "outline" &&
      // A manuscript's cut is found by {@link runManuscriptSplit} from its own
      // records: its answer names boundaries rather than chapters, and is not
      // a table to write.
      !item.id.startsWith("outline:split:"),
  );
  if (pieces.length === 0) return [];
  // One ask for every chapter answers with the table itself, and the chapters
  // it left out are dropped; a manuscript's parts each answer for their own
  // place, and the places nobody answered for are left as they stand.
  const whole = pieces.some((item) => PART.exec(item.id) === null);
  const writes: ChapterWrite[] = [];
  let read = 0;
  for (const item of pieces) {
    if (item.status !== "succeeded") continue;
    const found = chapterWrites(item);
    if (found === undefined) {
      report.unreadable = [
        ...(report.unreadable ?? []),
        { id: item.id, kind: "outline" },
      ];
      report.notes.push(i18n.t("story:jobs.unreadableAnswer", { at: item.id }));
      continue;
    }
    if (found.warnings.length > 0) {
      report.notes.push(
        i18n.t("story:jobs.answerNotes", {
          at: item.id,
          notes: found.warnings.join(" "),
        }),
      );
    }
    read += 1;
    writes.push(...found.writes);
  }
  if (writes.length === 0) return [];
  const chapters = spreadTargets(
    story,
    mergeChaptersAt(story.chapters, writes, whole),
  );
  // The table these answers make is the table the story already holds: reading
  // the same batch again is not a second telling, and having nothing to write
  // is not a step of the history.
  if (sameChapters(chapters, story.chapters)) {
    report.skipped += read;
    return [];
  }
  report.applied += read;
  return [{ type: "setStoryChapters", storyId: story.id, chapters }];
}

/** Whether two chapter tables say the same thing, word for word. */
function sameChapters(one: StoryChapter[], other: StoryChapter[]): boolean {
  return JSON.stringify(one) === JSON.stringify(other);
}

/**
 * A chapter the answer gave no running time for takes an even share of the
 * telling, which is what the outline step offered before the model was asked.
 */
function spreadTargets(
  story: StoryDocument,
  chapters: StoryChapter[],
): StoryChapter[] {
  const share = chapterTargetMs(story.brief.totalDurationMs, chapters.length);
  return chapters.map((chapter) =>
    chapter.targetDurationMs > 0
      ? chapter
      : { ...chapter, targetDurationMs: share },
  );
}

/**
 * The elements an answer found, written onto the story.
 *
 * A piece numbered `elements:N` read only a part of the chapters, so what it
 * found is added to the cast rather than standing for it: a character read out
 * of the first twenty chapters is not undone by a second ask that never saw
 * them.
 */
export function applyParsedElements(
  story: StoryDocument,
  drafts: StoryElementDraft[],
  options: { partial?: boolean; holdDescriptionKeys?: Set<string> } = {},
): DocumentCommand[] {
  if (drafts.length === 0) return [];
  return [
    {
      type: "setStoryElements",
      storyId: story.id,
      elements: mergeElements(story.elements, drafts, story.chapters, options),
    },
  ];
}

/** What one merge ask wrote, and what it could not find to write on. */
export interface MergedDescriptionWrite {
  commands: DocumentCommand[];
  /** Descriptions that changed, which is the work the ask actually did. */
  changed: number;
  /** Names the cast no longer holds, which are left out rather than recreated. */
  missing: string[];
}

/**
 * The descriptions one merge ask wrote over the ones on file.
 *
 * A merge changes appearance words and adds missing forms: the element keeps
 * its id, its drawings, its voice and the chapters already added up locally. A
 * name that no longer matches anything — renamed or taken out while the parts
 * were being read — is left alone rather than written back as a new element.
 */
export function applyMergedDescriptions(
  story: StoryDocument,
  drafts: StoryElementDraft[],
): MergedDescriptionWrite {
  const byKey = new Map<string, StoryElementDraft>();
  for (const draft of drafts) {
    const key = elementKey(draft.kind, draft.name);
    if (!byKey.has(key)) byKey.set(key, draft);
  }
  const held = new Set(
    story.elements.map((element) => elementKey(element.kind, element.name)),
  );
  let changed = 0;
  const elements = story.elements.map((element) => {
    const draft = byKey.get(elementKey(element.kind, element.name));
    if (draft === undefined) return element;
    const written = applyElementAppearance(element, draft);
    if (JSON.stringify(written) === JSON.stringify(element)) return element;
    changed += 1;
    return written;
  });
  const missing = [...byKey]
    .filter(([key]) => !held.has(key))
    .map(([, draft]) => draft.name);
  if (changed === 0) return { commands: [], changed: 0, missing };
  return {
    commands: [{ type: "setStoryElements", storyId: story.id, elements }],
    changed,
    missing,
  };
}

export function applyParsedActs(
  story: StoryDocument,
  chapterId: string,
  drafts: ActDraft[],
): DocumentCommand[] {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  if (chapter === undefined || drafts.length === 0) return [];
  // The names a board writes into a shot's words are that shot's references:
  // they are recognized into its list as the board is written, so the list and
  // the words are two views of one thing from the first moment.
  const acts = mergeActs(chapter.acts, drafts).map((act) => ({
    ...act,
    keyframes: act.keyframes.map((keyframe) =>
      withRequiredReferences(act, recognizeKeyframeReferences(story, keyframe)),
    ),
  }));
  return [
    {
      type: "setStoryActs",
      storyId: story.id,
      chapterId,
      acts,
    },
  ];
}

/** A chapter's board and the outline it was written from, as one write. */
export function boardCommands(
  story: StoryDocument,
  chapterId: string,
  drafts: ActDraft[],
): DocumentCommand[] {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  if (chapter === undefined) return [];
  const written = applyParsedActs(story, chapterId, drafts);
  if (written.length === 0) return written;
  // The board was written from the outline as it stands, so the chapter's
  // board revision follows it. A proposal for the board it replaces is moot,
  // and is settled where the reader rewrites the board.
  return [
    ...written,
    {
      type: "setStoryChapters",
      storyId: story.id,
      chapters: story.chapters.map((held) =>
        held.id === chapter.id ? syncChapterBoard(held) : held,
      ),
    },
  ];
}

/** What one piece of a batch asks the document to do, if anything. */
function commandsFor(
  story: StoryDocument,
  record: StoryJobRecord,
  item: StoryJobItem,
  report: ApplyReport,
  context?: ApplyContext,
): DocumentCommand[] {
  const target = slotTargetOf(item);
  if (target !== undefined) {
    const assetId = item.assetIds?.[0];
    const slot = slotAt(story, target);
    if (assetId === undefined || slot === undefined) {
      report.skipped += 1;
      report.notes.push(
        i18n.t("story:jobs.targetGone", { label: jobKey(item.target) }),
      );
      return [];
    }
    if (slot.takes.some((held) => held.assetIds.includes(assetId))) {
      // The place already keeps this drawing: reading the answer again is not
      // another take, and the batch has nothing left to write for it.
      report.skipped += 1;
      return [];
    }
    report.applied += 1;
    return slotCommand(
      story,
      target,
      withTake(slot, takeOf(record, item, [assetId])),
      readOf(story, item, target),
    );
  }

  switch (item.target.kind) {
    case "elements": {
      if (item.id.startsWith(ELEMENT_MERGE_ID)) {
        const read = readElementsAnswer(item.text ?? "");
        if (read.drafts === undefined) {
          report.notes.push(
            i18n.t("story:jobs.unreadableAnswer", { at: item.id }),
          );
          return [];
        }
        if (read.warnings.length > 0) {
          report.notes.push(
            i18n.t("story:jobs.answerNotes", {
              at: item.id,
              notes: read.warnings.join(" "),
            }),
          );
        }
        const written = applyMergedDescriptions(story, read.drafts);
        if (written.missing.length > 0) {
          report.skipped += written.missing.length;
          report.notes.push(
            i18n.t("story:jobs.mergeMissing", {
              names: written.missing.join(", "),
            }),
          );
        }
        report.applied += written.changed;
        return written.commands;
      }
      const read = readElementsAnswer(item.text ?? "");
      if (read.drafts === undefined) {
        report.unreadable = [
          ...(report.unreadable ?? []),
          { id: item.id, kind: "elements" },
        ];
        report.notes.push(
          i18n.t("story:jobs.unreadableAnswer", { at: item.id }),
        );
        return [];
      }
      // Said where the answer is read in and not only beside the element list:
      // a group of the answer nothing was read from is exactly the loss a
      // reader cannot see in the document.
      if (read.warnings.length > 0) {
        report.notes.push(
          i18n.t("story:jobs.answerNotes", {
            at: item.id,
            notes: read.warnings.join(" "),
          }),
        );
      }
      report.applied += 1;
      return applyParsedElements(story, read.drafts, {
        partial: PART_ELEMENTS.test(item.id),
        holdDescriptionKeys: context?.holdDescriptionKeys,
      });
    }
    case "storyboard": {
      const { chapterId } = item.target;
      const chapter = story.chapters.find((held) => held.id === chapterId);
      if (chapter === undefined) {
        report.notes.push(
          i18n.t("story:jobs.unreadableAnswer", { at: item.id }),
        );
        return [];
      }
      const read = readBoardAnswer(story, item);
      const check = checkBoard(story, chapter, read);
      if (read.drafts === undefined || check.errors.length > 0) {
        // The answer is kept on its record and asked about again with these
        // differences; writing a board the story cannot use is worse than
        // writing none.
        report.skipped += 1;
        report.notes.push(
          i18n.t("story:jobs.boardRejected", {
            at: item.id,
            reasons: check.errors.join("; "),
          }),
        );
        return [];
      }
      const written = boardCommands(story, chapter.id, read.drafts);
      if (written.length === 0) return written;
      report.applied += 1;
      return written;
    }
    case "continuity": {
      const { chapterId } = item.target;
      const chapter = story.chapters.find((held) => held.id === chapterId);
      if (chapter === undefined) {
        report.skipped += 1;
        report.notes.push(i18n.t("story:jobs.targetGone", { label: item.id }));
        return [];
      }
      const applied = applyContinuity(story, chapter, item);
      if (applied.stale === true) {
        report.skipped += 1;
        report.notes.push(i18n.t("story:jobs.continuityStale"));
        return [];
      }
      if (applied.error !== undefined) {
        report.skipped += 1;
        report.notes.push(
          i18n.t("story:jobs.continuityRejected", { reason: applied.error }),
        );
        return [];
      }
      if (applied.changed === 0) {
        report.skipped += 1;
        report.notes.push(i18n.t("story:jobs.continuityNone"));
        return [];
      }
      report.applied += 1;
      report.notes.push(
        (applied.summary ?? "").trim() === ""
          ? i18n.t("story:jobs.continuitySummary", {
              count: applied.changed,
            })
          : i18n.t("story:jobs.continuitySummarySaid", {
              count: applied.changed,
              summary: applied.summary,
            }),
      );
      return applied.commands;
    }
    default:
      return [];
  }
}

/** The part an act's piece is, counted from one; an act asked for whole is one. */
function actPart(itemId: string, base: string): number {
  const rest = itemId.slice(base.length);
  const match = /^:(\d+)$/.exec(rest);
  return match === null ? 1 : Number(match[1]);
}

/**
 * The clips a batch of filmed acts makes of the story.
 *
 * Every piece of one act is read as one clip, in the order it was asked for:
 * an act longer than one clip may be is filmed in several, and a sequence with
 * a piece missing is not a shorter act but a broken one — the film would run to
 * something the board never planned — so an act whose pieces did not all come
 * back writes nothing, and the room goes on offering the whole of it again.
 */
function actVideoCommands(
  story: StoryDocument,
  record: StoryJobRecord,
  report: ApplyReport,
): DocumentCommand[] {
  const pieces = record.items.filter((item) => item.target.kind === "actVideo");
  if (pieces.length === 0) return [];
  const commands: DocumentCommand[] = [];
  const acts = new Map<string, StoryJobItem[]>();
  for (const item of pieces) {
    const target = item.target;
    if (target.kind !== "actVideo") continue;
    const key = `${target.chapterId}:${target.actId}`;
    acts.set(key, [...(acts.get(key) ?? []), item]);
  }
  for (const held of acts.values()) {
    const target = slotTargetOf(held[0]);
    if (target === undefined || target.kind !== "actVideo") continue;
    const base = jobKey(held[0].target);
    const ordered = [...held].sort(
      (one, other) => actPart(one.id, base) - actPart(other.id, base),
    );
    if (ordered.some((item) => item.status !== "succeeded")) {
      // Counted as skipped with the rest of the batch: the pieces that did
      // answer are on the shelf, and the clip they were to make is not.
      report.skipped += ordered.length;
      continue;
    }
    const slot = slotAt(story, target);
    const files = ordered.map((item) => item.assetIds?.[0]);
    if (slot === undefined || files.some((file) => file === undefined)) {
      report.skipped += ordered.length;
      report.notes.push(i18n.t("story:jobs.targetGone", { label: base }));
      continue;
    }
    const take = takeOf(record, ordered[0], files as string[]);
    if (
      slot.takes.some(
        (kept) =>
          kept.assetIds.length === take.assetIds.length &&
          kept.assetIds.every((file, at) => file === take.assetIds[at]),
      )
    ) {
      // The place already keeps this clip: reading the answer again is not
      // another take.
      report.skipped += ordered.length;
      continue;
    }
    report.applied += ordered.length;
    commands.push(...slotCommand(story, target, withTake(slot, take)));
  }
  return commands;
}

/**
 * Writes a batch's answers into the story, and answers with what it wrote.
 *
 * Only pieces that succeeded are read: a piece that failed, was cancelled, or
 * is still going has nothing to write, and the room shows why where the piece
 * is rather than in here.
 */
export function applyJobResults(
  record: StoryJobRecord,
  context?: ApplyContext,
): ApplyReport {
  // A revision is a proposal, not an answer: the reader applies it from its
  // preview, so a look never writes it in.
  if (record.kind === "outlineRevision") {
    return { applied: 0, skipped: record.items.length, notes: [] };
  }
  const story = storyOf(record);
  if (story === undefined) {
    return {
      applied: 0,
      skipped: record.items.length,
      notes: [i18n.t("story:jobs.storyGone")],
    };
  }

  const report: ApplyReport = { applied: 0, skipped: 0, notes: [] };
  // A batch's chapters are one table, so they are read as one before anything
  // is written: `outlineCommands` reads every piece that answered and returns
  // the single command the table is written with.
  const commands: DocumentCommand[] = outlineCommands(story, record, report);
  // An act's pieces are one clip for the same reason, and are read the same way.
  commands.push(...actVideoCommands(story, record, report));
  // A place's drawings asked for together are one choice, so they are read as
  // one set rather than as takes landing one by one.
  const sets = new Map<string, StoryJobItem[]>();
  for (const item of record.items) {
    if (item.status !== "succeeded" || !multiArtItem(item)) continue;
    const key = jobKey(item.target);
    sets.set(key, [...(sets.get(key) ?? []), item]);
  }
  for (const items of sets.values()) {
    commands.push(...pendingArtCommands(story, record, items, report));
  }
  for (const item of record.items) {
    if (item.status !== "succeeded") {
      // A piece of an act's clip is counted where its act is read.
      if (item.target.kind !== "actVideo") report.skipped += 1;
      continue;
    }
    if (
      item.target.kind === "outline" ||
      item.target.kind === "actVideo" ||
      multiArtItem(item)
    ) {
      continue;
    }
    commands.push(...commandsFor(story, record, item, report, context));
  }

  if (commands.length === 0) return report;
  const applied = execute(historyLabel(record), commands, record.id);
  if (applied === null) {
    // The document refused the change, which is the save conflict saying so.
    return {
      applied: 0,
      skipped: record.items.length,
      notes: [...report.notes, i18n.t("story:page.saveConflict")],
      refused: true,
    };
  }
  return report;
}
