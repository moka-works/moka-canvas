/**
 * Reading a written answer into the drafts a command takes.
 *
 * The shapes are the ones the prompts ask for, and what comes back is read the
 * way an editor would read it: a chapter without a title is a chapter that was
 * not written, a shot nobody can see is a shot that was not boarded, and
 * everything else is kept, trimmed, and said out loud if it had to be bent.
 * The rule underneath all of it is that a partly-good answer is applied partly
 * rather than thrown away — eight chapters with one bad line are eight chapters
 * — while an answer that says nothing at all is not applied and not pretended
 * about either.
 *
 * Nothing here invents a name, a chapter, or a place. A cast list naming
 * somebody the story does not have drops that name and warns: a reference
 * nobody can draw is not a reference, and a shot drawn with a stranger in it
 * is worse than a shot drawn from the words alone.
 *
 * Warnings are English sentences rather than translated ones, as the server's
 * own problem messages are: they name what the model wrote — a chapter number,
 * a word that was not read — and they are read beside the answer they came from.
 */

import {
  MAX_ACTS_PER_CHAPTER,
  MAX_KEYFRAMES_PER_ACT,
  MAX_KEYFRAME_MS,
  MIN_KEYFRAME_MS,
} from "../constants";
import type { StoryChapterDraft, StoryElementDraft } from "../story";
import { elementKey, mergeElementDrafts } from "../story";
import type { ActDraft, KeyframeDraft, StoryGuess } from "../story";
import type { StoryActSound, StoryElement, StoryElementKind } from "../types";
import { matchCameraAngle, matchCameraMove, matchShotSize } from "./aliases";
import type { ParseResult } from "./json";

/** How much of an answer one field may keep, past which it is cut. */
const SYNOPSIS_MAX = 2000;
const DESCRIPTION_MAX = 2000;
const SUMMARY_MAX = 2000;
const CONTENT_MAX = 1000;
const TITLE_MAX = 200;

/** A failure is about the shape; the answer's own words stay with the caller. */
function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error, raw: "" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text a field holds, or nothing when it holds no words. */
function words(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The same words, cut to what a field may keep. */
function cut(
  value: string,
  max: number,
  what: string,
  warnings: string[],
): string {
  if (value.length <= max) return value;
  warnings.push(`${what} was longer than ${max} characters and was cut`);
  return value.slice(0, max);
}

/**
 * The list a shape asked for, from the key the shape names or from the answer
 * itself: a model that answers with a bare array meant the array.
 */
function listFrom(value: unknown, key: string): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return undefined;
  const held = value[key];
  return Array.isArray(held) ? held : undefined;
}

/**
 * The length an answer gave, in milliseconds.
 *
 * A number is milliseconds, as the shape says; a string may carry its unit, and
 * one that does not is read as milliseconds unless it is small enough that only
 * seconds make sense — `3` is three seconds, `3000` is three.
 */
function readDuration(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = words(value);
  if (text === undefined) return undefined;
  const held = /^(\d+(?:\.\d+)?)\s*(ms|毫秒|milliseconds?)?$/.exec(text);
  if (held) {
    const amount = Number(held[1]);
    if (!Number.isFinite(amount)) return undefined;
    return held[2] !== undefined
      ? amount
      : amount < 100
        ? amount * 1000
        : amount;
  }
  const seconds = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|秒)$/.exec(text);
  if (seconds) return Number(seconds[1]) * 1000;
  return undefined;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The whole number of milliseconds a shot is held for, inside the bounds. */
function shotLength(value: number): number {
  return Math.round(clamp(value, MIN_KEYFRAME_MS, MAX_KEYFRAME_MS));
}

// -----------------------------------------------------------------------------
// The outline
// -----------------------------------------------------------------------------

/** The chapters an outline answer holds. */
export function parseOutline(value: unknown): ParseResult<StoryChapterDraft[]> {
  const raw = listFrom(value, "chapters");
  if (raw === undefined) return fail("the answer was not a list of chapters");

  const warnings: string[] = [];
  const chapters: StoryChapterDraft[] = [];
  raw.forEach((entry, index) => {
    const at = index + 1;
    if (!isObject(entry)) {
      warnings.push(`chapter ${at} was not an object`);
      return;
    }
    const title = words(entry.title);
    const synopsis = words(entry.synopsis);
    if (title === undefined || synopsis === undefined) {
      warnings.push(
        `chapter ${at} had no ${title === undefined ? "title" : "synopsis"} and was left out`,
      );
      return;
    }
    chapters.push({
      title: cut(title, TITLE_MAX, `chapter ${at}'s title`, warnings),
      synopsis: cut(
        synopsis,
        SYNOPSIS_MAX,
        `chapter ${at}'s synopsis`,
        warnings,
      ),
    });
  });

  if (chapters.length === 0)
    return fail("no chapter of the outline had both a title and a synopsis");
  return { ok: true, value: chapters, warnings };
}

/** The one chapter a part of a manuscript was written into. */
export function parseChapter(
  value: unknown,
): ParseResult<{ title: string; synopsis: string }> {
  if (!isObject(value))
    return fail("the answer was not a chapter with a title and a synopsis");
  const warnings: string[] = [];
  const title = words(value.title);
  const synopsis = words(value.synopsis);
  if (title === undefined || synopsis === undefined)
    return fail(
      `the chapter had no ${title === undefined ? "title" : "synopsis"}`,
    );
  return {
    ok: true,
    value: {
      title: cut(title, TITLE_MAX, "the chapter's title", warnings),
      synopsis: cut(synopsis, SYNOPSIS_MAX, "the chapter's synopsis", warnings),
    },
    warnings,
  };
}

// -----------------------------------------------------------------------------
// The elements
// -----------------------------------------------------------------------------

const KINDS: StoryElementKind[] = ["character", "scene", "prop"];
const GROUPS: Record<StoryElementKind, string> = {
  character: "characters",
  scene: "scenes",
  prop: "props",
};

/**
 * The other names an answer gives the three groups.
 *
 * A model that answered `places` and `things` has not answered wrongly — it
 * used the words the ask described them with — and a reading that kept only
 * what it recognized would lose two thirds of it without a word. The shape's
 * own names win where both are there: what was asked for is what was meant.
 */
const ALSO_NAMED: Record<StoryElementKind, string[]> = {
  character: ["people"],
  scene: ["places", "locations"],
  prop: ["things", "items", "objects"],
};

/** The list an answer gave for one kind, under whichever of its names. */
function namedGroup(
  value: Record<string, unknown>,
  kind: StoryElementKind,
): { name: string; entries: unknown[] } | undefined {
  for (const name of [GROUPS[kind], ...ALSO_NAMED[kind]]) {
    const entries = value[name];
    if (Array.isArray(entries)) return { name, entries };
  }
  return undefined;
}

/**
 * The characters, places and things an answer names.
 *
 * An answer that is one flat list is read as characters, since a model that
 * answers with a list has stopped saying which is which and the caller can
 * still tell them apart by what it finds in the story.
 *
 * A group under a name none of the three is known by is not read, and is not
 * passed over in silence either: half an answer read as a whole one is how a
 * telling ends up with its cast and nothing to draw behind them.
 */
export function parseElements(
  value: unknown,
): ParseResult<StoryElementDraft[]> {
  const warnings: string[] = [];
  const elements: StoryElementDraft[] = [];

  const take = (entry: unknown, kind: StoryElementKind, where: string) => {
    if (!isObject(entry)) {
      warnings.push(`${where} was not an object`);
      return;
    }
    const name = words(entry.name);
    const description = words(entry.description);
    if (name === undefined || description === undefined) {
      warnings.push(
        `${where} had no ${name === undefined ? "name" : "description"} and was left out`,
      );
      return;
    }
    const chapters = Array.isArray(entry.chapters)
      ? entry.chapters
          .filter((number): number is number => Number.isFinite(number))
          .map((number) => Math.round(number) - 1)
          .filter((index) => index >= 0)
      : [];
    elements.push({
      kind,
      name: cut(name, TITLE_MAX, `${where}'s name`, warnings),
      description: cut(
        description,
        DESCRIPTION_MAX,
        `${where}'s description`,
        warnings,
      ),
      ...(chapters.length > 0 ? { chapterIndexes: chapters } : {}),
    });
  };

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      take(entry, "character", `element ${index + 1}`),
    );
  } else if (isObject(value)) {
    const groups = new Map<
      StoryElementKind,
      { name: string; entries: unknown[] }
    >();
    for (const kind of KINDS) {
      const group = namedGroup(value, kind);
      if (group !== undefined) groups.set(kind, group);
    }
    if (groups.size === 0)
      return fail("the answer named no characters, scenes or props");
    for (const [kind, group] of groups) {
      group.entries.forEach((entry, index) =>
        take(entry, kind, `the ${GROUPS[kind]}' number ${index + 1}`),
      );
    }
    const known = new Set([
      ...Object.values(GROUPS),
      ...Object.values(ALSO_NAMED).flat(),
    ]);
    const unread = Object.keys(value).filter(
      (key) => !known.has(key) && Array.isArray(value[key]),
    );
    if (unread.length > 0) {
      warnings.push(
        `the answer listed ${unread.join(", ")} besides the three groups, and nothing was read from ${unread.length === 1 ? "it" : "them"}`,
      );
    }
  } else {
    return fail("the answer was not a list of elements");
  }

  if (elements.length === 0)
    return fail("no element of the answer had both a name and a description");
  return { ok: true, value: readAsOne(elements, warnings), warnings };
}

/**
 * The answer's elements with the ones it named twice read as one.
 *
 * An answer that names the same thing twice has named one thing twice, and
 * filing it twice would put two characters who are the same person into the
 * cast. Only a name of the same kind is the same thing — a place and a character
 * may share a name — and the words with more in them stand while the chapters
 * add up. What was folded is said out loud, since the second telling of a name
 * may have held something the first did not.
 */
function readAsOne(
  elements: StoryElementDraft[],
  warnings: string[],
): StoryElementDraft[] {
  const at = new Map<string, number>();
  const read: StoryElementDraft[] = [];
  for (const draft of elements) {
    const key = elementKey(draft.kind, draft.name);
    const seen = at.get(key);
    const held = seen === undefined ? undefined : read[seen];
    if (seen === undefined || held === undefined) {
      at.set(key, read.length);
      read.push(draft);
      continue;
    }
    read[seen] = mergeElementDrafts(held, draft);
    warnings.push(
      `the ${GROUPS[draft.kind]}' "${draft.name}" was named twice, and the two were read as one`,
    );
  }
  return read;
}

// -----------------------------------------------------------------------------
// The board
// -----------------------------------------------------------------------------

/** What the board of one episode is read against. */
export interface BoardContext {
  /** The elements on file, which is what a cast name is matched to. */
  elements: StoryElement[];
  /** How long the episode runs, which is what missing shot lengths share. */
  targetDurationMs: number;
}

/** The acts, shots and spoken lines a boarded episode holds. */
export function parseStoryboard(
  value: unknown,
  ctx: BoardContext,
): ParseResult<ActDraft[]> {
  const raw = listFrom(value, "acts");
  if (raw === undefined) return fail("the answer was not a board of acts");
  if (raw.length === 0) return fail("the chapter was boarded with no acts");

  const warnings: string[] = [];
  if (raw.length > MAX_ACTS_PER_CHAPTER) {
    warnings.push(
      `the board had ${raw.length} acts and only the first ${MAX_ACTS_PER_CHAPTER} were kept`,
    );
  }

  const acts: ActDraft[] = [];
  raw.slice(0, MAX_ACTS_PER_CHAPTER).forEach((entry, index) => {
    const at = index + 1;
    const act = readAct(entry, at, ctx, warnings);
    if (act !== undefined) acts.push(act);
  });

  if (acts.length === 0) return fail("no act of the board could be read");
  return { ok: true, value: acts, warnings };
}

function readAct(
  value: unknown,
  at: number,
  ctx: BoardContext,
  warnings: string[],
): ActDraft | undefined {
  if (!isObject(value)) {
    warnings.push(`act ${at} was not an object`);
    return undefined;
  }
  const keyframes = Array.isArray(value.keyframes) ? value.keyframes : [];
  if (keyframes.length === 0) {
    warnings.push(`act ${at} was boarded with no shots and was left out`);
    return undefined;
  }
  if (keyframes.length > MAX_KEYFRAMES_PER_ACT) {
    warnings.push(
      `act ${at} had ${keyframes.length} shots and only the first ${MAX_KEYFRAMES_PER_ACT} were kept`,
    );
  }

  const title = words(value.title);
  const summary = words(value.summary);
  if (title === undefined) warnings.push(`act ${at} was left without a title`);
  if (summary === undefined)
    warnings.push(`act ${at} was left without a summary`);

  const kept = keyframes.slice(0, MAX_KEYFRAMES_PER_ACT);
  const guesses: StoryGuess[] = [];
  // What a shot does not say about its length is shared out of the episode,
  // which is the only thing that knows how long the whole is.
  const plannedMs =
    kept.length === 0
      ? ctx.targetDurationMs
      : ctx.targetDurationMs / kept.length;
  const shots: KeyframeDraft[] = kept.flatMap((entry, index) => {
    const shot = readShot(
      entry,
      plannedMs,
      at,
      index + 1,
      ctx,
      warnings,
      guesses,
    );
    return shot === undefined ? [] : [shot];
  });
  const scene = matchedNames(
    value.scene === undefined ? [] : [value.scene],
    ctx.elements,
    "scene",
    at,
    warnings,
    "place",
  )[0];

  return {
    title:
      title === undefined
        ? ""
        : cut(title, TITLE_MAX, `act ${at}'s title`, warnings),
    summary:
      summary === undefined
        ? ""
        : cut(summary, SUMMARY_MAX, `act ${at}'s summary`, warnings),
    characters: matchedNames(
      value.characters,
      ctx.elements,
      "character",
      at,
      warnings,
      "character",
    ),
    ...(scene !== undefined ? { scene } : {}),
    props: matchedNames(
      value.props,
      ctx.elements,
      "prop",
      at,
      warnings,
      "thing",
    ),
    sound: readSound(value.sound),
    // The shots are read before the act is written out, since reading them is
    // what fills in the marks: an act written first would carry the empty list.
    ...(guesses.length === 0 ? {} : { guessed: guesses }),
    keyframes: shots,
  };
}

function readSound(value: unknown): StoryActSound {
  if (!isObject(value)) return { music: "", sfx: "", ambience: "" };
  return {
    music: words(value.music) ?? "",
    sfx: words(value.sfx) ?? "",
    ambience: words(value.ambience) ?? "",
  };
}

/**
 * The names in a cast list that the story can draw.
 *
 * A name is matched to the element it names — first as it is written, then
 * without its airs, then as part of one — and a name that matches nothing is
 * dropped and said out loud. Guessing which character a stranger meant would
 * put the wrong face in the shot and never say so.
 */
function matchedNames(
  value: unknown,
  elements: StoryElement[],
  kind: StoryElementKind,
  at: number,
  warnings: string[],
  what: string,
): string[] {
  if (!Array.isArray(value)) return [];
  const pool = elements.filter((element) => element.kind === kind);
  const ids: string[] = [];
  for (const entry of value) {
    const name = words(entry);
    if (name === undefined) continue;
    const element = matchElement(pool, name);
    if (element === undefined) {
      warnings.push(
        `act ${at} names ${name}, who is not one of the story's ${what}s`,
      );
      continue;
    }
    if (!ids.includes(element.id)) ids.push(element.id);
  }
  return ids;
}

/**
 * The element a written name names, by name, by airs, or by what was written
 * around it.
 *
 * The last reading is the one that has to be careful: a story with a 周 in it
 * does not have a 老周 in it, and reading one as the other puts the wrong face
 * in a shot without ever saying so. So a name is only read as a longer one when
 * it stands at the front of what was written — `林` for `林（男主）` — or when
 * the written name stands at the front of a longer one, which is a name the
 * answer shortened: `车厢` for `末班车车厢`.
 */
function matchElement(
  pool: StoryElement[],
  name: string,
): StoryElement | undefined {
  const wanted = name.trim();
  const lowered = wanted.toLowerCase();
  const byName = (test: (held: string) => boolean) =>
    pool.find((element) => test(element.name.trim()));

  return (
    pool.find((element) => element.name === wanted) ??
    byName((held) => held.toLowerCase() === lowered) ??
    byName((held) => wanted.startsWith(held)) ??
    pool.find(
      (element) => wanted.length >= 2 && element.name.trim().startsWith(wanted),
    )
  );
}

function readShot(
  value: unknown,
  plannedMs: number,
  actAt: number,
  at: number,
  ctx: BoardContext,
  warnings: string[],
  guesses: StoryGuess[],
): KeyframeDraft | undefined {
  if (!isObject(value)) {
    warnings.push(`shot ${at} of act ${actAt} was not an object`);
    return undefined;
  }
  const content = words(value.content);
  if (content === undefined) {
    warnings.push(
      `shot ${at} of act ${actAt} had nothing to show and was left out`,
    );
    return undefined;
  }

  const shotSize = matchShotSize(String(value.shotSize ?? ""));
  const cameraMove = matchCameraMove(String(value.cameraMove ?? ""));
  const angle = matchCameraAngle(String(value.angle ?? ""));
  if (shotSize === undefined && value.shotSize !== undefined)
    warnings.push(
      `shot ${at} of act ${actAt} was framed as "${String(value.shotSize)}", which was read as a medium shot`,
    );
  if (cameraMove === undefined && value.cameraMove !== undefined)
    warnings.push(
      `shot ${at} of act ${actAt} moved as "${String(value.cameraMove)}", which was read as a still camera`,
    );
  if (angle === undefined && value.angle !== undefined)
    warnings.push(
      `shot ${at} of act ${actAt} was seen from "${String(value.angle)}", which was read as eye level`,
    );
  // Which of the three the parser chose for: the cell is shown with a mark, so
  // a reader can tell a framing nobody offered from one the telling asked for.
  for (const [field, read] of [
    ["shotSize", shotSize],
    ["cameraMove", cameraMove],
    ["angle", angle],
  ] as const) {
    if (read !== undefined) continue;
    const said = value[field];
    if (said === undefined) continue;
    guesses.push({ keyframe: at, field, from: String(said) });
  }

  const given = readDuration(value.durationMs);
  const durationMs =
    given === undefined || given <= 0
      ? Math.round(plannedMs / 100) * 100
      : given;

  return {
    shotSize: shotSize ?? "medium",
    cameraMove: cameraMove ?? "static",
    angle: angle ?? "eyeLevel",
    content: cut(content, CONTENT_MAX, `shot ${at} of act ${actAt}`, warnings),
    dialogue: readDialogue(value.dialogue, ctx.elements, actAt, at, warnings),
    durationMs: shotLength(durationMs),
  };
}

function readDialogue(
  value: unknown,
  elements: StoryElement[],
  actAt: number,
  at: number,
  warnings: string[],
): KeyframeDraft["dialogue"] {
  if (!Array.isArray(value)) return [];
  const characters = elements.filter((element) => element.kind === "character");
  const lines: KeyframeDraft["dialogue"] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const said = words(entry.text);
    if (said === undefined) {
      warnings.push(
        `a line of shot ${at} of act ${actAt} had no words and was left out`,
      );
      continue;
    }
    const speaker = words(entry.speaker);
    const character =
      speaker === undefined ? undefined : matchElement(characters, speaker);
    lines.push({
      ...(character !== undefined ? { characterId: character.id } : {}),
      speaker: character?.name ?? speaker ?? "",
      text: said,
      ...(words(entry.tone) !== undefined ? { tone: words(entry.tone) } : {}),
    });
  }
  return lines;
}
