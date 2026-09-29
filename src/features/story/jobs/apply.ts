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
  keyframeAt,
  mergeActs,
  mergeChaptersAt,
  mergeElements,
  slotAt,
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
import { jobKey } from "./plan";

/** What reading one batch's answers did to the story. */
export interface ApplyReport {
  /** Pieces whose answers were written into the document. */
  applied: number;
  /** Pieces that had nothing to write: still running, failed, or gone. */
  skipped: number;
  /** What could not be written, in the reader's language. */
  notes: string[];
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

function chaptersIn(item: StoryJobItem): StoryChapterDraft[] | undefined {
  return readOutlineAnswer(item.text ?? "").drafts;
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

/** What a board's answer said, as the reading of it came out. */
export interface BoardReading {
  drafts?: ActDraft[];
  warnings: string[];
  /** The cells the reading chose a framing, a movement or an angle for. */
  guesses: StoryGuess[];
  /** Why it could not be read, when it could not. */
  error?: string;
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
  });
  if (!parsed.ok) {
    return { warnings: [], guesses: [], error: parsed.error };
  }
  return {
    drafts: parsed.value,
    warnings: parsed.warnings,
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
  (read.drafts ?? []).forEach((draft, index) => {
    const act = chapter.acts[index];
    if (act !== undefined && draft.guessed !== undefined) {
      marks.set(act.id, draft.guessed);
    }
  });
  return marks;
}

/** The part of a manuscript an outline piece was asked for, when it was one. */
const PART = /^outline:(\d+)$/;

/** One part of a telling's chapters, when a reading was asked for one. */
const PART_ELEMENTS = /^elements:\d+$/;

/** The place in the table an outline piece's answer belongs. */
function partAt(itemId: string): number {
  const part = PART.exec(itemId);
  return part === null ? 0 : Number(part[1]) - 1;
}

/** Every chapter this piece's answer holds, at the places it asked for. */
function chapterWrites(item: StoryJobItem): ChapterWrite[] | undefined {
  const drafts = chaptersIn(item);
  if (drafts === undefined) return undefined;
  const first = partAt(item.id);
  return drafts.map((draft, index) => ({ at: first + index, draft }));
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
  const pieces = record.items.filter((item) => item.target.kind === "outline");
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
      report.notes.push(i18n.t("story:jobs.unreadableAnswer", { at: item.id }));
      continue;
    }
    read += 1;
    writes.push(...found);
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

/** The story's chapters as an answer a reader fixed by hand makes them. */
export function applyFixedOutline(
  story: StoryDocument,
  itemId: string,
  text: string,
): string | undefined {
  const read = readOutlineAnswer(text);
  if (read.drafts === undefined) {
    return read.error ?? i18n.t("story:parse.failed");
  }
  const writes = read.drafts.map((draft, index) => ({
    at: partAt(itemId) + index,
    draft,
  }));
  const chapters = spreadTargets(
    story,
    mergeChaptersAt(story.chapters, writes, PART.exec(itemId) === null),
  );
  const done = execute(i18n.t("story:history.apply.outline"), [
    { type: "setStoryChapters", storyId: story.id, chapters },
  ]);
  return done === null ? i18n.t("story:page.saveConflict") : undefined;
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
  options: { partial?: boolean } = {},
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

export function applyParsedActs(
  story: StoryDocument,
  chapterId: string,
  drafts: ActDraft[],
): DocumentCommand[] {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  if (chapter === undefined || drafts.length === 0) return [];
  return [
    {
      type: "setStoryActs",
      storyId: story.id,
      chapterId,
      acts: mergeActs(chapter.acts, drafts),
    },
  ];
}

/** What one piece of a batch asks the document to do, if anything. */
function commandsFor(
  story: StoryDocument,
  record: StoryJobRecord,
  item: StoryJobItem,
  report: ApplyReport,
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
      const read = readElementsAnswer(item.text ?? "");
      if (read.drafts === undefined) {
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
      });
    }
    case "storyboard": {
      const { chapterId } = item.target;
      const read = parseStoryJson(item.text ?? "");
      const chapter = story.chapters.find((held) => held.id === chapterId);
      const parsed = read.ok
        ? parseStoryboard(read.value, {
            elements: story.elements,
            targetDurationMs: chapter?.targetDurationMs ?? 0,
          })
        : undefined;
      if (parsed === undefined || !parsed.ok || chapter === undefined) {
        report.notes.push(
          i18n.t("story:jobs.unreadableAnswer", { at: item.id }),
        );
        return [];
      }
      report.applied += 1;
      return applyParsedActs(story, chapter.id, parsed.value);
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
export function applyJobResults(record: StoryJobRecord): ApplyReport {
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
  for (const item of record.items) {
    if (item.status !== "succeeded") {
      // A piece of an act's clip is counted where its act is read.
      if (item.target.kind !== "actVideo") report.skipped += 1;
      continue;
    }
    if (item.target.kind === "outline" || item.target.kind === "actVideo") {
      continue;
    }
    commands.push(...commandsFor(story, record, item, report));
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
