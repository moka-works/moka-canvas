/**
 * Reading the chapter boundaries a split answer names.
 *
 * The answer is not the chapters: it is where each begins and where it ends.
 * Every position it gives is a quotation from the manuscript that the planner
 * then finds in the text, so an answer that paraphrased one has to be
 * corrected rather than trusted — which is what the warnings and the missing
 * lists are for.
 */

import { parseStoryJson, type ParseResult } from "./json";

/** One chapter the answer says begins at a quoted place. */
export interface SplitPointer {
  /** The number the manuscript gives it; nought is matter before chapter one. */
  number?: number;
  title: string;
  /** The first characters of the chapter, as the answer copied them. */
  start?: string;
  /** The last characters of the chapter, as the answer copied them. */
  end?: string;
  /** The last characters of the chapter before it. */
  before?: string;
  /** Whether this is front matter to leave out rather than a chapter. */
  discard: boolean;
}

export interface SplitAnswer {
  pointers: SplitPointer[];
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function words(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/**
 * The boundaries an answer names, or why it named none.
 *
 * A malformed entry is said out loud and left out; the rest are kept, since a
 * table with one unreadable chapter is still a table, and the chapter it left
 * out is the one the planner will ask about again.
 */
export function parseSplitAnswer(text: string): ParseResult<SplitAnswer> {
  const read = parseStoryJson(text);
  if (!read.ok) return read;
  const raw = Array.isArray(read.value)
    ? read.value
    : isObject(read.value) && Array.isArray(read.value.chapters)
      ? read.value.chapters
      : isObject(read.value)
        ? [read.value]
        : undefined;
  if (raw === undefined) {
    return {
      ok: false,
      error: "the answer was not a list of chapter boundaries",
      raw: text,
    };
  }

  const warnings: string[] = [];
  const pointers: SplitPointer[] = [];
  raw.forEach((entry, index) => {
    if (!isObject(entry)) {
      warnings.push(`boundary ${index + 1} was not an object`);
      return;
    }
    const start = words(entry.start);
    const end = words(entry.end);
    const before = words(entry.before);
    // The first chapter of a part may begin where the part begins, and there
    // is nothing to quote: it is the part's own opening.
    if (start === undefined && before === undefined && pointers.length > 0) {
      warnings.push(
        `boundary ${index + 1} quoted neither its beginning nor the text before it`,
      );
      return;
    }
    const held = number(entry.number);
    const discard = entry.discard === true || held === 0;
    pointers.push({
      ...(held === undefined ? {} : { number: held }),
      title: words(entry.title) ?? "",
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      ...(before === undefined ? {} : { before }),
      discard,
    });
  });
  if (pointers.length === 0) {
    return {
      ok: false,
      error: "the answer named no chapter boundary",
      raw: text,
    };
  }
  return { ok: true, value: { pointers, warnings }, warnings };
}
