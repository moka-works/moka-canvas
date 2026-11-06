/**
 * Cutting a manuscript into chapters at the places a model found.
 *
 * The model is asked only where chapters begin, never what they say. Its
 * answer is a handful of quotations, and this module finds those quotations in
 * the manuscript and cuts the text between them. The words between two cuts
 * become the chapter's own text: the document keeps the prose itself rather
 * than offsets into a file, so every chapter can be edited, inserted around,
 * and thrown away without the manuscript behind it.
 *
 * A manuscript larger than one ask is read in windows. A window's last chapter
 * is usually unfinished — the window had to end somewhere — so it is not kept:
 * the next window begins where that chapter begins and takes on more text,
 * which is what keeps a chapter from being cut twice or its text from being
 * sent twice.
 */

import type { StoryJobItemDraft } from "../../../api/story";
import {
  formatDuration,
  MAX_CHAPTERS_PER_STORY,
  type StoryChapterDraft,
  type StoryDocument,
} from "../../../shared/domain";
import type { SplitPointer } from "../../../shared/domain/parse/split";
import { parseSplitAnswer } from "../../../shared/domain/parse/split";
import {
  compactWindow,
  findQuote,
  isSourceHeading,
  windowEndAt,
} from "../../../shared/domain/storySource";
import { failureText } from "../../../shared/i18n/problems";
import { i18n } from "../../../shared/i18n";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  storySplitPrompt,
  storySplitRepairPrompt,
  storySplitSystemPrompt,
} from "../../../shared/prompts";
import { useStoryJobStore, waitForJob } from "../stores/storyJobStore";

/** How many times one window is asked for again before the cut is given up. */
export const SPLIT_ATTEMPTS = 3;

/** A cut that could not be made, with the reason a reader can act on. */
export class SplitFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitFailure";
  }
}

/** A cut the reader stopped, which is not a failure and needs no words. */
export class SplitCancelled extends Error {
  constructor() {
    super("the split was stopped");
    this.name = "SplitCancelled";
  }
}

/** How far a cut has got, for the step that is waiting on it. */
export interface SplitProgress {
  /** Which window of the manuscript the model is on, counted from one. */
  part: number;
  /** How many chapters have been placed in the table so far. */
  chapters: number;
}

export interface SplitOptions {
  /** How many chapters the telling is meant to have, when it has a number. */
  chapters: number;
  /** The most text one ask may carry, in characters. */
  budget: number;
  onProgress?: (progress: SplitProgress) => void;
}

/** One chapter the manuscript's own text holds. */
interface CutChapter {
  title: string;
  body: string;
  start: number;
  end: number;
}

/** One boundary the answer named, as it was found in the window. */
interface FoundBoundary {
  at: number;
  title: string;
  discard: boolean;
}

/** What a window's answer made of it. */
interface WindowReading {
  chapters: CutChapter[];
  tailStart?: number;
}

/** The line a chapter begins with, when it is short enough to be its title. */
function headingAt(window: string, at: number): string | undefined {
  const end = window.indexOf("\n", at);
  const line = window.slice(at, end === -1 ? window.length : end).trim();
  if (line === "") return undefined;
  if (isSourceHeading(line)) return line.slice(0, 120);
  return line.length <= 60 ? line : undefined;
}

/** The title a boundary carries, or the one its own text writes. */
function titleFor(
  window: string,
  boundary: FoundBoundary,
  number: number,
): string {
  if (boundary.title !== "") return boundary.title.slice(0, 120);
  return (
    headingAt(window, boundary.at) ??
    i18n.t("story:outline.untitled", { number })
  );
}

/**
 * The boundaries of a window's answer, as they stand in its text.
 *
 * The first part is the only one that may begin with front matter, and front
 * matter is the one boundary that is not located: it always begins at the
 * window's own start. A later part begins at a chapter by construction, so its
 * first chapter does too, whatever quotation the answer gave. A quotation that
 * cannot be found is left out and reported; the chapters around it still cut,
 * and the chapter it was meant to open is picked up by the next window.
 */
function locateBoundaries(
  window: string,
  pointers: SplitPointer[],
  options: { firstPart: boolean },
): { boundaries: FoundBoundary[]; missed: string[] } {
  const boundaries: FoundBoundary[] = [];
  const missed: string[] = [];
  const compact = compactWindow(window);
  let from = 0;
  let first = true;
  for (const pointer of pointers) {
    if (pointer.discard) {
      if (options.firstPart && first) {
        boundaries.push({ at: 0, title: pointer.title, discard: true });
        first = false;
      }
      continue;
    }
    if (first && pointer.start === undefined && pointer.before === undefined) {
      boundaries.push({ at: 0, title: pointer.title, discard: false });
      first = false;
      continue;
    }
    if (!options.firstPart && first) {
      // The window opens on a chapter: the chapter's own beginning is the
      // window's, whether or not the quotation could be found.
      boundaries.push({ at: 0, title: pointer.title, discard: false });
      first = false;
      continue;
    }
    first = false;
    let at: number | undefined;
    if (pointer.start !== undefined) {
      at = findQuote(window, pointer.start, from, compact);
    }
    if (at === undefined && pointer.before !== undefined) {
      const held = findQuote(window, pointer.before, from, compact);
      if (held !== undefined) {
        let next = held + pointer.before.trim().length;
        while (next < window.length && /\s/.test(window[next] ?? "")) next += 1;
        at = next;
      }
    }
    if (at === undefined || at <= from || at >= window.length) {
      missed.push(pointer.start ?? pointer.before ?? pointer.title);
      continue;
    }
    boundaries.push({ at, title: pointer.title, discard: false });
    from = at;
  }
  return { boundaries, missed };
}

/**
 * The chapters a window's boundaries make of it, and where the next window
 * begins.
 *
 * A chapter is complete once another boundary follows it; the segment after
 * the last boundary is the one the window ended inside, and is not code for
 * anything but "read this again". Front matter is dropped rather than kept.
 * The title's own heading line is taken off the chapter's text because the
 * title is already carrying it — the words are the same words, written once.
 */
function cutWindow(
  window: string,
  windowStart: number,
  boundaries: FoundBoundary[],
  final: boolean,
): WindowReading {
  const chapters: CutChapter[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    if (boundary === undefined || boundary.discard) continue;
    const next = boundaries[index + 1];
    const start = boundary.at;
    const end = next?.at ?? window.length;
    if (end <= start) continue;
    // The last segment of a window that is not the manuscript's end is the
    // chapter the window stopped inside: the next window takes it from its
    // beginning rather than this one keeping half of it.
    if (next === undefined && !final) continue;
    let body = window.slice(start, end);
    let from = start;
    let to = end;
    const lineEnd = body.indexOf("\n");
    const firstLine = (lineEnd === -1 ? body : body.slice(0, lineEnd)).trim();
    const title = titleFor(window, boundary, chapters.length + 1);
    // Only a line the manuscript writes as a heading is taken off the text:
    // a title the model invented that happens to repeat the first line is a
    // title, not a heading, and cutting it away would lose the chapter's words.
    if (firstLine === title.trim() && isSourceHeading(firstLine)) {
      body = lineEnd === -1 ? "" : body.slice(lineEnd + 1);
      from = start + (lineEnd === -1 ? body.length : lineEnd + 1);
    }
    const leading = body.length - body.trimStart().length;
    const trailing = body.length - body.trimEnd().length;
    from += leading;
    to -= trailing;
    body = body.trim();
    if (body === "") continue;
    chapters.push({
      title,
      body,
      start: windowStart + from,
      end: windowStart + to,
    });
  }
  const last = boundaries[boundaries.length - 1];
  return {
    chapters,
    ...(final || last === undefined
      ? {}
      : { tailStart: windowStart + last.at }),
  };
}

/** Whether a window found a chapter that begins after its first character. */
function madeProgress(boundaries: FoundBoundary[]): boolean {
  return boundaries.some((boundary) => !boundary.discard && boundary.at > 0);
}

/**
 * Cuts one manuscript into chapters, asking the model only where they begin.
 *
 * Each window is asked for in turn, and the next one is planned from what the
 * one before it left unfinished. A quotation the model got wrong is asked
 * about again with the text beside it; after {@link SPLIT_ATTEMPTS} tries the
 * cut is given up on with the reason, rather than writing a table out of cuts
 * nobody can find.
 */
export async function runManuscriptSplit(
  story: StoryDocument,
  text: string,
  options: SplitOptions,
): Promise<StoryChapterDraft[]> {
  const assetId = story.brief.sourceAssetId;
  if (assetId === undefined) {
    throw new SplitFailure(i18n.t("story:outline.splitNoSource"));
  }
  // The manuscript is read once, from the project's own copy, and the text is
  // written into the chapters. A file outside the project is still refused:
  // the copy on the shelf is the one the reader filed, and a path the project
  // does not control can change under the cut.
  const entry = useProjectStore
    .getState()
    .moka?.resources.texts.find((held) => held.id === assetId);
  const inside =
    entry !== undefined &&
    entry.path.startsWith("assets/") &&
    !entry.path.split(/[\\/]/).includes("..");
  if (!inside) {
    throw new SplitFailure(i18n.t("story:outline.splitSourceOutside"));
  }
  const budget = Math.max(1_000, Math.floor(options.budget));
  const wanted = Math.max(1, Math.floor(options.chapters));
  const minutes = Math.max(1, Math.round(story.brief.chapterMs / 60_000));
  const total = formatDuration(story.brief.totalDurationMs);
  const chapters: CutChapter[] = [];
  let cursor = 0;
  let part = 0;

  while (cursor < text.length) {
    part += 1;
    if (part > 1_000) {
      throw new SplitFailure(i18n.t("story:outline.splitTooManyParts"));
    }
    const end = windowEndAt(text, cursor, budget);
    const window = text.slice(cursor, end);
    const final = end >= text.length;
    // The count is the telling's, not the window's: a window holding a tenth
    // of the manuscript is asked for about a tenth of the chapters, so the
    // whole comes out near the number the reader set rather than the whole
    // count in every batch.
    const expected = Math.max(
      1,
      Math.round((wanted * (end - cursor)) / Math.max(1, text.length)),
    );
    let reading: WindowReading | undefined;
    let reason = "";

    for (let attempt = 1; attempt <= SPLIT_ATTEMPTS; attempt += 1) {
      const prompt =
        attempt === 1
          ? storySplitPrompt({
              text: window,
              part,
              chapters: expected,
              minutes,
              total,
            })
          : storySplitRepairPrompt({
              text: window,
              part,
              chapters: expected,
              minutes,
              total,
              missing: [reason],
            });
      const item: StoryJobItemDraft = {
        id: `outline:split:${part}`,
        target: { kind: "outline" },
        capability: "text",
        system: storySplitSystemPrompt(),
        prompt,
      };
      const record = await useStoryJobStore
        .getState()
        .start(story.id, "outline", [item]);
      if (record === null) {
        const said = useStoryJobStore.getState().error;
        throw new SplitFailure(
          said ?? i18n.t("story:outline.splitFailed", { reason: "—" }),
        );
      }
      const settled = await waitForJob(record.id);
      if (settled.status === "cancelled") throw new SplitCancelled();
      const answer = settled.items[0];
      if (answer === undefined || answer.status !== "succeeded") {
        throw new SplitFailure(
          failureText(answer ?? {}) ??
            i18n.t("story:outline.splitFailed", {
              reason: i18n.t("story:outline.splitNoAnswer"),
            }),
        );
      }
      const parsed = parseSplitAnswer(answer.text ?? "");
      if (!parsed.ok) {
        reason = parsed.error;
        continue;
      }
      const located = locateBoundaries(window, parsed.value.pointers, {
        firstPart: cursor === 0,
      });
      // A quotation that was not found is asked about again rather than
      // silently folding its chapter into the one before it. The last attempt
      // takes what it can find: a cut with one chapter missing a boundary is
      // still a cut, and the next window will see the text it left behind.
      if (located.missed.length > 0 && attempt < SPLIT_ATTEMPTS) {
        reason = located.missed[0] ?? i18n.t("story:outline.splitNoBoundary");
        continue;
      }
      if (
        !madeProgress(located.boundaries) &&
        !(final && located.boundaries.some((held) => !held.discard))
      ) {
        reason =
          located.missed[0] ??
          parsed.value.warnings[0] ??
          i18n.t("story:outline.splitNoBoundary");
        continue;
      }
      reading = cutWindow(window, cursor, located.boundaries, final);
      break;
    }

    if (reading === undefined) {
      throw new SplitFailure(
        i18n.t("story:outline.splitFailed", {
          reason:
            reason === "" ? i18n.t("story:outline.splitNoBoundary") : reason,
        }),
      );
    }

    for (const chapter of reading.chapters) {
      if (chapters.length >= MAX_CHAPTERS_PER_STORY) {
        // The table has no room for another chapter: its text is laid on the
        // last chapter rather than lost, since the manuscript is not thrown
        // away for outgrowing the telling.
        const last = chapters[chapters.length - 1];
        if (last !== undefined) {
          last.end = chapter.end;
          last.body = `${last.body}\n\n${chapter.body}`;
        }
        continue;
      }
      chapters.push(chapter);
    }

    if (final) break;
    const tail = reading.tailStart;
    if (tail === undefined || tail <= cursor) {
      throw new SplitFailure(
        i18n.t("story:outline.splitFailed", {
          reason: i18n.t("story:outline.splitNoBoundary"),
        }),
      );
    }
    cursor = tail;
    options.onProgress?.({ part: part + 1, chapters: chapters.length });
  }

  if (chapters.length === 0) {
    throw new SplitFailure(i18n.t("story:outline.splitNoChapters"));
  }
  const drafts = withDurations(chapters, story.brief.totalDurationMs);
  return drafts.map((chapter) => ({
    title: chapter.title,
    synopsis: chapter.body,
    targetDurationMs: chapter.targetDurationMs,
  }));
}

/** The chapters' running times, shared out by how much of the text each holds. */
function withDurations(
  chapters: CutChapter[],
  totalDurationMs: number,
): Array<CutChapter & { targetDurationMs: number }> {
  const lengths = chapters.map((chapter) =>
    Math.max(1, Array.from(chapter.body).length),
  );
  const sum = lengths.reduce((held, length) => held + length, 0);
  let spent = 0;
  return chapters.map((chapter, index) => {
    const last = index === chapters.length - 1;
    const ms = last
      ? Math.max(1, totalDurationMs - spent)
      : Math.max(
          1,
          Math.round((totalDurationMs * (lengths[index] ?? 1)) / sum),
        );
    spent += ms;
    return { ...chapter, targetDurationMs: ms };
  });
}
