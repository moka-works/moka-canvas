/**
 * The story room's own arithmetic: how far each step has got, what a new
 * answer keeps of the old one, and which place a job is asking about.
 *
 * Nothing here reads a file, a store, or a translated word. The room's
 * interface, the job client, and the server's own bookkeeping all reason
 * about a story through these functions, so a rule written once holds
 * everywhere it is read.
 */

import { MAX_TAKES_PER_SLOT } from "./constants";
import {
  createAct,
  createChapter,
  createElement,
  createKeyframe,
  emptyStorySlot,
} from "./factories";
import { newId } from "./ids";
import type {
  AssetId,
  StoryAct,
  StoryActSound,
  StoryAspect,
  StoryCameraAngle,
  StoryCameraMove,
  StoryChapter,
  StoryDialogueLine,
  StoryDocument,
  StoryElement,
  StoryElementKind,
  StoryElementVariant,
  StoryKeyframe,
  StoryPictureReference,
  StorySlot,
  StorySlotTarget,
  StoryShotSize,
  StoryTake,
  StoryVoiceProfile,
  StoryVoiceTake,
} from "./types";

// -----------------------------------------------------------------------------
// Where each step has got to
// -----------------------------------------------------------------------------

export const STORY_STEPS = [
  "idea",
  "outline",
  "elements",
  "storyboard",
  "edit",
] as const;
export type StoryStep = (typeof STORY_STEPS)[number];

export type StoryStepState =
  "empty" | "working" | "ready" | "confirmed" | "failed";

/**
 * One step's place in the telling.
 *
 * `done` and `total` count what the step settles — chapters confirmed,
 * elements drawn, acts finished — so the room can say "3/12" without knowing
 * what a chapter is. A step with nothing to count carries one number or none,
 * never a sentence: the words around the numbers belong to the interface, and
 * it has the reader's language.
 */
export interface StoryStepProgress {
  step: StoryStep;
  state: StoryStepState;
  done: number;
  total: number;
}

/**
 * How far a step has got, from three answers about it: is there anything at
 * all, is all of it made, has the reader pressed its own confirm.
 *
 * A step with some of its work done and some still to do is `working`, which
 * is also what a step whose work is out with a model says: the document can
 * tell what was settled, and what is being tried is the room's business.
 */
function stepState(
  empty: boolean,
  ready: boolean,
  confirmed: boolean,
): StoryStepState {
  if (confirmed) return "confirmed";
  if (empty) return "empty";
  return ready ? "ready" : "working";
}

/** How many shots an episode is boarded with. */
export function keyframeCount(chapter: StoryChapter): number {
  return chapter.acts.reduce((sum, act) => sum + act.keyframes.length, 0);
}

/** How long an act is meant to run: its shots, or the length a bridge was given. */
export function actPlannedMs(act: StoryAct): number {
  if (act.transition !== undefined) return act.transition.durationMs;
  return act.keyframes.reduce((sum, keyframe) => sum + keyframe.durationMs, 0);
}

/** Whether every shot in an act has a frame drawn for it. */
export function actHasAllArt(act: StoryAct): boolean {
  return (
    act.keyframes.length > 0 &&
    act.keyframes.every((keyframe) => keyframe.art.takes.length > 0)
  );
}

/** Whether an act has a board at all: shots for a clip to be made of. */
export function actHasShots(act: StoryAct): boolean {
  if (act.transition !== undefined) return true;
  return act.keyframes.length > 0;
}

/** One end of a transition: the picture and the shot's words. */
export interface StoryTransitionEnd {
  assetId: AssetId;
  content: string;
}

/**
 * The pictures a transition is filmed between: the last drawn frame of the act
 * before it and the first drawn frame of the act after it.
 *
 * A clip is made from these pictures, and the frame a clip ends on is the last
 * picture its act was drawn with, so these are the ends the two neighbouring
 * videos meet at. A neighbour that is itself a bridge, or has no drawn frame
 * yet, leaves its end of the move unspoken.
 */
export function transitionFrames(
  chapter: StoryChapter,
  at: number,
): { from?: StoryTransitionEnd; to?: StoryTransitionEnd } {
  const before = chapter.acts[at - 1];
  const after = chapter.acts[at + 1];
  const endOf = (act: StoryAct | undefined, tail: boolean) => {
    if (act === undefined || act.transition !== undefined) return undefined;
    const drawn = act.keyframes.filter(
      (keyframe) => currentTake(keyframe.art) !== undefined,
    );
    const frame = tail ? drawn[drawn.length - 1] : drawn[0];
    if (frame === undefined) return undefined;
    const assetId = currentTake(frame.art)?.assetIds[0];
    if (assetId === undefined) return undefined;
    return { assetId, content: frame.content };
  };
  return { from: endOf(before, true), to: endOf(after, false) };
}

/** One neighbouring clip's end, where a bridge's picture is cut out of it. */
export interface StoryNeighbourVideo {
  assetId: AssetId;
  /** The words of the shot the clip ends or begins on. */
  content: string;
}

/**
 * The clips a bridge stands between: the last clip of the act before it and the
 * first clip of the act after it.
 *
 * An act filmed a shot at a time holds one clip per frame, so its end is the
 * last of those clips on one side and the first on the other; an act filmed
 * whole holds one, or several pieces in play order. A neighbour that is itself
 * a bridge has no clip of its own to take a picture from.
 */
export function neighbourVideos(
  story: StoryDocument,
  chapter: StoryChapter,
  at: number,
): { from?: StoryNeighbourVideo; to?: StoryNeighbourVideo } {
  const endOf = (
    act: StoryAct | undefined,
    edge: "start" | "end",
  ): StoryNeighbourVideo | undefined => {
    if (act === undefined || act.transition !== undefined) return undefined;
    const perShot = actGranularity(act, story.shotGranularity) === "keyframe";
    if (perShot) {
      const frames =
        edge === "end" ? [...act.keyframes].reverse() : act.keyframes;
      for (const frame of frames) {
        const take = currentTake(frame.video);
        const assetId =
          edge === "end" ? take?.assetIds.at(-1) : take?.assetIds[0];
        if (assetId !== undefined) return { assetId, content: frame.content };
      }
      return undefined;
    }
    const take = currentTake(act.video);
    const assetId = edge === "end" ? take?.assetIds.at(-1) : take?.assetIds[0];
    if (assetId === undefined) return undefined;
    const frames =
      edge === "end" ? [...act.keyframes].reverse() : act.keyframes;
    const content =
      frames.find((frame) => frame.content.trim() !== "")?.content ??
      act.summary;
    return { assetId, content };
  };
  return {
    from: endOf(chapter.acts[at - 1], "end"),
    to: endOf(chapter.acts[at + 1], "start"),
  };
}

/**
 * The granularity an act is filmed at: its own where it has chosen one, and
 * otherwise the telling's habit, which is also what an act written before it
 * could choose meant.
 */
export function actGranularity(
  act: StoryAct,
  fallback: StoryDocument["shotGranularity"],
): StoryDocument["shotGranularity"] {
  return act.shotGranularity ?? fallback;
}

/** Whether an act's clip has been made, at whichever granularity is in force. */
export function actHasVideo(
  act: StoryAct,
  granularity: StoryDocument["shotGranularity"],
): boolean {
  // A bridge has one clip whatever the telling's habit: its video is the whole
  // of what it makes.
  if (act.transition !== undefined) return act.video.takes.length > 0;
  if (granularity === "keyframe") return chapterClipMade(act);
  return act.video.takes.length > 0;
}

/**
 * Whether an act is finished: a board, a picture for every shot, and a clip.
 *
 * This is what step four settles, and nothing about it is agreed to one shot
 * at a time — an act is done when there is nothing left of it to make.
 */
export function actComplete(
  act: StoryAct,
  granularity: StoryDocument["shotGranularity"],
): boolean {
  // A bridge is settled once its clip is: it has no pictures of its own to
  // draw, so the pictures its neighbours hold are not its gap.
  if (act.transition !== undefined) return act.video.takes.length > 0;
  return actHasShots(act) && actHasAllArt(act) && actHasVideo(act, granularity);
}

/** Whether every shot of an act has been filmed, which is how a clip is made. */
function chapterClipMade(act: StoryAct): boolean {
  return (
    act.keyframes.length > 0 &&
    act.keyframes.every((keyframe) => keyframe.video.takes.length > 0)
  );
}

/** Whether a chapter has words behind it. */
export function chapterHasWords(chapter: StoryChapter): boolean {
  return chapter.synopsis.trim() !== "";
}

/** Whether an episode has the words step two settles: a title and its text. */
export function chapterWritten(chapter: StoryChapter): boolean {
  return chapter.title.trim() !== "" && chapterHasWords(chapter);
}

/** Whether an element has the words every picture of it is made from. */
export function elementDescribed(element: StoryElement): boolean {
  return element.name.trim() !== "" && element.description.trim() !== "";
}

/**
 * The frame an element's main picture is drawn in.
 *
 * A character is always upright, a place is as wide as the telling is told,
 * and a thing is square unless its card names another shape — a shelf of props
 * is not made of one kind of thing.
 */
export function elementAspect(
  story: StoryDocument,
  element: StoryElement,
): StoryAspect {
  switch (element.kind) {
    case "character":
      return "9:16";
    case "scene":
      return story.brief.aspect;
    case "prop":
      return element.ratio ?? "1:1";
  }
}

/** The frame one form of an element is drawn in. */
export function formAspect(
  story: StoryDocument,
  element: StoryElement,
  form: StoryElementVariant | undefined,
): StoryAspect {
  if (element.kind !== "prop") return elementAspect(story, element);
  return form?.ratio ?? element.ratio ?? "1:1";
}

/** Whether a character has both drawings a character is drawn with. */
export function elementDrawn(element: StoryElement): boolean {
  return elementForms(element).every((form) => formDrawn(element, form));
}

/** The form an element's card is showing: its own, or one of its variants. */
export function elementForm(
  element: StoryElement,
  variantId?: string,
): StoryElementVariant | undefined {
  if (variantId === undefined) return undefined;
  return (element.variants ?? []).find((variant) => variant.id === variantId);
}

/** Every form an element takes, its default form first. */
export function elementForms(
  element: StoryElement,
): Array<StoryElementVariant | undefined> {
  return [undefined, ...(element.variants ?? [])];
}

/** How many forms a cast holds, which is what the page counts. */
export function elementCount(elements: StoryElement[]): number {
  return elements.reduce(
    (sum, element) => sum + 1 + (element.variants?.length ?? 0),
    0,
  );
}

/** The words one form is drawn from. */
export function formDescription(
  element: StoryElement,
  form: StoryElementVariant | undefined,
): string {
  return form === undefined ? element.description : form.description;
}

/** The name a form is shown under: the element's, and the form's beside it. */
export function formName(
  element: StoryElement,
  form: StoryElementVariant | undefined,
): string {
  return form === undefined ? element.name : `${element.name} · ${form.name}`;
}

/** Whether one form of an element has the drawings it is drawn with. */
export function formDrawn(
  element: StoryElement,
  form: StoryElementVariant | undefined,
): boolean {
  const main = form === undefined ? element.main : form.main;
  const turnaround = form === undefined ? element.turnaround : form.turnaround;
  if (main.takes.length === 0) return false;
  return element.kind !== "character" || (turnaround?.takes.length ?? 0) > 0;
}

/** The picture a reference names, as the file an ask can carry. */
export function pictureReferenceAsset(
  story: StoryDocument,
  reference: StoryPictureReference | undefined,
): string | undefined {
  if (reference === undefined) return undefined;
  if (reference.kind === "asset") return reference.assetId;
  const element = elementOf(story, reference.elementId);
  if (element === undefined) return undefined;
  const form = elementForm(element, reference.variantId);
  if (reference.variantId !== undefined && form === undefined) return undefined;
  return currentTake(form === undefined ? element.main : form.main)
    ?.assetIds[0];
}

/** Whether an element is finished: described, and every form of it drawn. */
export function elementComplete(element: StoryElement): boolean {
  return elementDescribed(element) && elementDrawn(element);
}

/**
 * The five steps' progress through one story, read from the document alone.
 *
 * A step that is waiting on a job is not something a document can say — what
 * is being tried is not what was settled — so the room lays its own failures
 * and spinners over these answers rather than asking for them here.
 *
 * A step the reader has settled stays settled: what is confirmed is the
 * reader's word about the step, and a chapter re-written afterwards does not
 * take a door away that somebody has already walked through. The count under
 * the step says what of it is finished just now, so a step being worked on
 * again reads as a step being worked on.
 */
export function storyProgress(
  story: StoryDocument,
): Record<StoryStep, StoryStepProgress> {
  const chapters = story.chapters;
  const acts = chapters.flatMap((chapter) => chapter.acts);
  const granularity = story.shotGranularity;
  const settled = (step: StoryStep) => story.confirmedSteps.includes(step);

  const ideaDone = ideaReady(story);

  const writtenChapters = chapters.filter(chapterWritten).length;
  const everyChapterWritten =
    chapters.length > 0 && writtenChapters === chapters.length;

  const elements = story.elements;
  // Every form counts: a character drawn in two ages is two drawings before
  // the step is done, and the page's own count says so.
  const elementTotal = elementCount(elements);
  const completeElements = elements.reduce(
    (sum, element) =>
      sum +
      elementForms(element).filter((form) =>
        form === undefined
          ? elementDescribed(element) && formDrawn(element, undefined)
          : formDrawn(element, form),
      ).length,
    0,
  );
  const everyElementComplete =
    elementTotal > 0 && completeElements === elementTotal;

  const completeActs = acts.filter((act) =>
    actComplete(act, actGranularity(act, granularity)),
  ).length;
  const everyActComplete = acts.length > 0 && completeActs === acts.length;

  return {
    idea: {
      step: "idea",
      state: stepState(!ideaDone, ideaDone, settled("idea")),
      done: ideaDone ? 1 : 0,
      total: 1,
    },
    outline: {
      step: "outline",
      state: stepState(
        chapters.length === 0,
        everyChapterWritten,
        settled("outline"),
      ),
      done: writtenChapters,
      total: chapters.length,
    },
    elements: {
      step: "elements",
      state: stepState(
        elements.length === 0,
        everyElementComplete,
        settled("elements"),
      ),
      done: completeElements,
      total: elementTotal,
    },
    storyboard: {
      step: "storyboard",
      state: stepState(
        acts.length === 0,
        everyActComplete,
        settled("storyboard"),
      ),
      done: completeActs,
      total: acts.length,
    },
    edit: {
      step: "edit",
      // The fifth step is the assembly itself: a timeline laid down is the
      // whole of what it makes, and there is nothing left to confirm.
      state: story.edit.timelineId === undefined ? "empty" : "ready",
      done: story.edit.timelineId === undefined ? 0 : 1,
      total: 1,
    },
  };
}

// -----------------------------------------------------------------------------
// What a step is still waiting for
// -----------------------------------------------------------------------------

/**
 * One thing a step has not got yet, as the room reads the document.
 *
 * The kinds are the shapes of the gaps rather than sentences about them: what
 * a reader is told is the interface's business, and it has the reader's
 * language. The pieces a gap names — chapters by their number, elements and
 * acts by their name — are the telling's own words and are handed over as they
 * are written.
 */
export type StoryStepGap =
  | { kind: "ideaMissing" }
  | { kind: "noChapters" }
  | { kind: "chaptersUnwritten"; numbers: number[] }
  | { kind: "noElements" }
  | { kind: "elementsUndescribed"; names: string[] }
  | { kind: "elementsUndrawn"; names: string[] }
  | { kind: "noActs" }
  | { kind: "actsWithoutShots"; count: number }
  | { kind: "framesMissing"; count: number }
  | { kind: "clipsMissing"; count: number }
  | { kind: "shotsMissing"; count: number }
  | { kind: "noTimeline" };

/**
 * What a step would still need before it could be settled.
 *
 * An empty list is the whole of the check a step's confirm makes: the room
 * presses the same reading twice — once to decide, once to say why not — so
 * what a reader is told and what the press acts on cannot drift apart.
 */
export function stepGaps(
  story: StoryDocument,
  step: StoryStep,
): StoryStepGap[] {
  const granularity = story.shotGranularity;
  const acts = story.chapters.flatMap((chapter) => chapter.acts);
  switch (step) {
    case "idea":
      return ideaReady(story) ? [] : [{ kind: "ideaMissing" }];
    case "outline": {
      if (story.chapters.length === 0) return [{ kind: "noChapters" }];
      const numbers = story.chapters.flatMap((chapter, at) =>
        chapterWritten(chapter) ? [] : [at + 1],
      );
      return numbers.length === 0
        ? []
        : [{ kind: "chaptersUnwritten", numbers }];
    }
    case "elements": {
      if (story.elements.length === 0) return [{ kind: "noElements" }];
      const gaps: StoryStepGap[] = [];
      const undescribed = story.elements.filter(
        (element) => !elementDescribed(element),
      );
      if (undescribed.length > 0) {
        gaps.push({
          kind: "elementsUndescribed",
          names: undescribed.map((element) => element.name),
        });
      }
      const undrawn = story.elements.flatMap((element) =>
        elementForms(element)
          .filter((form) =>
            form === undefined ? elementDescribed(element) : true,
          )
          .filter((form) => !formDrawn(element, form))
          .map((form) => formName(element, form)),
      );
      if (undrawn.length > 0) {
        gaps.push({
          kind: "elementsUndrawn",
          names: undrawn,
        });
      }
      return gaps;
    }
    case "storyboard": {
      if (acts.length === 0) return [{ kind: "noActs" }];
      const gaps: StoryStepGap[] = [];
      // A bridge has no shots by design, so it is not an act waiting for them.
      const bare = acts.filter(
        (act) => act.transition === undefined && !actHasShots(act),
      );
      if (bare.length > 0) {
        gaps.push({ kind: "actsWithoutShots", count: bare.length });
      }
      const frames = acts.reduce(
        (sum, act) =>
          sum +
          act.keyframes.filter((keyframe) => keyframe.art.takes.length === 0)
            .length,
        0,
      );
      if (frames > 0) gaps.push({ kind: "framesMissing", count: frames });
      const clips = acts.filter((act) =>
        act.transition !== undefined
          ? !actHasVideo(act, granularity)
          : actGranularity(act, granularity) === "act" &&
            !actHasVideo(act, "act"),
      ).length;
      if (clips > 0) gaps.push({ kind: "clipsMissing", count: clips });
      // A telling filmed a shot at a time is short of shots rather than of
      // acts, and a mixed one is short of both: the two are counted apart so
      // the reason says which way each act is waiting.
      const shots = acts
        .filter((act) => actGranularity(act, granularity) === "keyframe")
        .reduce(
          (sum, act) =>
            sum +
            act.keyframes.filter(
              (keyframe) => keyframe.video.takes.length === 0,
            ).length,
          0,
        );
      if (shots > 0) gaps.push({ kind: "shotsMissing", count: shots });
      return gaps;
    }
    case "edit": {
      if (story.edit.timelineId === undefined) return [{ kind: "noTimeline" }];
      return [];
    }
  }
}

/** Whether a step has everything it needs to be settled. */
export function stepComplete(story: StoryDocument, step: StoryStep): boolean {
  return stepGaps(story, step).length === 0;
}

// -----------------------------------------------------------------------------
// What the parsers hand over
// -----------------------------------------------------------------------------

/** An outline's chapter, before it meets the story it will become. */
export interface StoryChapterDraft {
  title: string;
  synopsis: string;
  targetDurationMs?: number;
}

/** An identified element, before it meets the elements already known. */
export interface StoryElementDraft {
  kind: StoryElementKind;
  name: string;
  description: string;
  /** Where the outline put this, counted in chapters; resolved by the caller. */
  chapterIndexes?: number[];
}

/** The fields of a shot the parser had to read a value it did not recognise into. */
export const STORY_GUESSED_FIELDS = [
  "shotSize",
  "cameraMove",
  "angle",
] as const;
export type StoryGuessedField = (typeof STORY_GUESSED_FIELDS)[number];

/**
 * One value the parser did not recognise and read as a default instead.
 *
 * Kept beside the board rather than inside it: what the document holds is the
 * board, and what a reader needs to see is which of its cells a model did not
 * really answer — a shot framed as something nobody offered is a shot whose
 * framing is the parser's word, not the telling's.
 */
export interface StoryGuess {
  /** Which shot of the act, counted from one. */
  keyframe: number;
  field: StoryGuessedField;
  /** What the answer said, which is what was not recognised. */
  from: string;
}

/** A shot as the board was written, before it meets the board on file. */
export interface KeyframeDraft {
  shotSize: StoryShotSize;
  cameraMove: StoryCameraMove;
  angle: StoryCameraAngle;
  content: string;
  dialogue: Array<{
    speaker: string;
    text: string;
    tone?: string;
    characterId?: string;
  }>;
  durationMs: number;
}

/**
 * An act as the board was written.
 *
 * The cast arrives already resolved to element ids: a name the parser could
 * not match against the elements on file is not in these lists, because a
 * reference nobody can draw is not a reference.
 */
export interface ActDraft {
  title: string;
  summary: string;
  characters: string[];
  scene?: string;
  props: string[];
  sound: StoryActSound;
  keyframes: KeyframeDraft[];
  /** The shots whose framing, movement or angle the parser chose. */
  guessed?: StoryGuess[];
}

// -----------------------------------------------------------------------------
// Merging an answer into what is already there
// -----------------------------------------------------------------------------

/**
 * An outline's chapters against the story's own.
 *
 * A chapter is matched to the one in its place — an outline is read in order,
 * and a chapter is the same chapter when it stands where it stood. A matched
 * chapter keeps everything that was made for it and takes only the new words:
 * a board survives a re-write of the outline it was made from.
 *
 * The table that comes back is the answer's own length, so a telling that was
 * re-split into fewer chapters drops the ones that were left out.
 */
export function mergeChapters(
  existing: StoryChapter[],
  proposed: StoryChapterDraft[],
): StoryChapter[] {
  return mergeChaptersAt(
    existing,
    proposed.map((draft, at) => ({ at, draft })),
    true,
  );
}

/** One chapter's new words, at the place in the table they were asked for. */
export interface ChapterWrite {
  at: number;
  draft: StoryChapterDraft;
}

/**
 * The story's chapters with answers written into the places they belong.
 *
 * A manuscript asked for one part at a time is answered one chapter at a time,
 * and each answer knows which part it is: writing them into the table in the
 * order they happen to come home would put a chapter where the answer before
 * it ended rather than where it was asked for. A place past the end of the
 * table is a chapter the telling has not reached yet — a part that came home
 * before the parts before it did — and is added there rather than left as a
 * hole, since a telling with a gap in it is not a telling.
 *
 * `whole` says the answer is the table rather than a place in it — one ask for
 * every chapter — and then the chapters it left out are dropped.
 */
export function mergeChaptersAt(
  existing: StoryChapter[],
  writes: ChapterWrite[],
  whole = false,
): StoryChapter[] {
  const table = [...existing];
  const sorted = [...writes].sort((one, other) => one.at - other.at);
  for (const { at, draft } of sorted) {
    const place = Math.min(at, table.length);
    const held = table[place];
    if (held === undefined) {
      table[place] = createChapter(draft.title, draft.synopsis);
      continue;
    }
    table[place] = {
      ...held,
      title: draft.title,
      synopsis: draft.synopsis,
      targetDurationMs: draft.targetDurationMs ?? held.targetDurationMs,
    };
  }
  if (!whole) return table;
  const length = writes.reduce(
    (deepest, write) => Math.max(deepest, write.at + 1),
    0,
  );
  return table.slice(0, length);
}

/** The quotes and brackets a name may be wrapped in, which are not its name. */
const AROUND_A_NAME = "「」『』“‘”’\"'《》【】[]（）()";

/** A name as it is compared: the airs around it are not part of it. */
function bareName(name: string): string {
  const plain = name.trim().toLowerCase().replace(/\s+/g, "");
  let first = 0;
  let last = plain.length;
  while (first < last && AROUND_A_NAME.includes(plain[first] ?? "")) first += 1;
  while (last > first && AROUND_A_NAME.includes(plain[last - 1] ?? ""))
    last -= 1;
  return plain.slice(first, last);
}

/** The name two elements are the same by: kind, and the name without its airs. */
export function elementKey(kind: StoryElementKind, name: string): string {
  return `${kind}:${bareName(name)}`;
}

/** The chapters a place was noticed in, in telling order and without repeats. */
function chapterIdsOf(ids: string[], chapters: StoryChapter[]): string[] {
  const order = new Map(chapters.map((chapter, at) => [chapter.id, at]));
  return [...new Set(ids)].sort(
    (one, other) =>
      (order.get(one) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(other) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * One copy of an element written over another from the same answer.
 *
 * A reading that names the same thing twice named it once, and how it is said
 * the second time is not a second thing: the description with more in it
 * stands, since a description is what the thing is drawn from, and the chapters
 * are added up.
 */
export function mergeElementDrafts(
  one: StoryElementDraft,
  other: StoryElementDraft,
): StoryElementDraft {
  const fuller =
    other.description.length > one.description.length ? other : one;
  const chapterIndexes = [
    ...new Set([
      ...(one.chapterIndexes ?? []),
      ...(other.chapterIndexes ?? []),
    ]),
  ].sort((left, right) => left - right);
  return {
    ...fuller,
    ...(chapterIndexes.length > 0 ? { chapterIndexes } : {}),
  };
}

/**
 * An identification's elements against the story's own.
 *
 * Matching is by kind and name rather than by place, because reading a story
 * does not reorder its cast the way an outline's chapters are ordered: a
 * character is the same character under another description, and the pictures
 * already drawn of them belong to the reader, not to the model.
 *
 * `chapters` resolves the draft's chapter numbers into the story's chapter
 * ids; a number naming no chapter is dropped rather than guessed at.
 *
 * A reading that only saw some of the chapters is a `partial` one: what it did
 * not name stays where it was, since a character who stood in the part read
 * first is not gone for being absent from the part read second — and the
 * chapters it did notice are added to the ones already on file rather than
 * standing in their place, since a part that read chapters 21 onwards cannot
 * unsay what the part before it found in chapters 1 to 20. A reading of the
 * whole telling is the cast the story now has, and everything else goes.
 *
 * The cast is built by name, so no name stands in it twice however many times
 * an answer — or the parts of a long telling — says it. A later part's words
 * about a name an earlier part already described are held rather than written:
 * one part's description would overwrite the other's, while the parts read the
 * same telling and their words belong together. The key is listed in
 * `holdDescriptionKeys` when that is so; the chapters it noticed are still added
 * to the ones on file, since those are the reader's own map of where a thing
 * appears.
 */
export function mergeElements(
  existing: StoryElement[],
  identified: StoryElementDraft[],
  chapters: StoryChapter[] = [],
  options: { partial?: boolean; holdDescriptionKeys?: Set<string> } = {},
): StoryElement[] {
  const partial = options.partial === true;
  const holding = options.holdDescriptionKeys ?? new Set<string>();
  const known = new Map(
    existing.map((element) => [
      elementKey(element.kind, element.name),
      element,
    ]),
  );
  const cast = new Map<string, StoryElement>();
  for (const draft of identified) {
    const key = elementKey(draft.kind, draft.name);
    const noticed = (draft.chapterIndexes ?? [])
      .map((index) => chapters[index]?.id)
      .filter((id): id is string => id !== undefined);
    const held = cast.get(key) ?? known.get(key);
    if (held === undefined) {
      cast.set(
        key,
        createElement(draft.kind, draft.name, draft.description, noticed),
      );
      continue;
    }
    const chapterIds = partial
      ? chapterIdsOf([...held.chapterIds, ...noticed], chapters)
      : noticed.length > 0
        ? noticed
        : held.chapterIds;
    if (partial && holding.has(key)) {
      cast.set(key, { ...held, chapterIds });
      continue;
    }
    cast.set(key, {
      ...held,
      name: draft.name,
      description: draft.description,
      chapterIds,
    });
  }
  // The cast keeps the order the reader arranged it in: what was already there
  // stays where it was, and what this reading found for the first time is added
  // after it in the order the answer named them. A reading again is not the
  // room's word on how the cast should be listed.
  const firstAt = new Map<string, number>();
  existing.forEach((element, at) => {
    const key = elementKey(element.kind, element.name);
    if (!firstAt.has(key)) firstAt.set(key, at);
  });
  const kept = existing.flatMap((element, at) => {
    const key = elementKey(element.kind, element.name);
    if (firstAt.get(key) !== at) return [];
    const merged = cast.get(key);
    return merged === undefined ? [] : [merged];
  });
  const added: StoryElement[] = [];
  const taken = new Set<string>();
  for (const draft of identified) {
    const key = elementKey(draft.kind, draft.name);
    if (known.has(key) || taken.has(key)) continue;
    taken.add(key);
    const element = cast.get(key);
    if (element !== undefined) added.push(element);
  }
  if (!partial) return [...kept, ...added];
  const named = new Set(
    identified.map((draft) => elementKey(draft.kind, draft.name)),
  );
  return [
    ...kept,
    ...added,
    ...existing.filter((held) => !named.has(elementKey(held.kind, held.name))),
  ];
}

/**
 * A board's acts against the acts already on file.
 *
 * An act is matched to the one in its place, and a shot to the shot in its
 * place within it: re-boarding an episode that already has frames keeps them,
 * so asking the model for the words again does not throw away the pictures
 * the reader has already looked at. What a new board brings is what a board
 * is — the words, the cast, the sound.
 */
export function mergeActs(
  existing: StoryAct[],
  proposed: ActDraft[],
): StoryAct[] {
  // A bridge is not a board the model wrote and has nothing to keep when the
  // board is written again; the acts around it are matched without it.
  const regular = existing.filter((act) => act.transition === undefined);
  return proposed.map((draft, index) => {
    const held = regular[index];
    const keyframes = mergeKeyframes(held?.keyframes ?? [], draft.keyframes);
    if (!held) {
      return {
        ...createAct(draft.title, draft.summary),
        characterIds: draft.characters,
        ...(draft.scene !== undefined ? { sceneId: draft.scene } : {}),
        propIds: draft.props,
        sound: draft.sound,
        keyframes,
      };
    }
    return {
      ...held,
      title: draft.title,
      summary: draft.summary,
      characterIds: draft.characters,
      sceneId: draft.scene,
      propIds: draft.props,
      sound: draft.sound,
      keyframes,
    };
  });
}

/** A board's shots against the shots already on file, paired by place. */
function mergeKeyframes(
  existing: StoryKeyframe[],
  proposed: KeyframeDraft[],
): StoryKeyframe[] {
  return proposed.map((draft, index) => {
    const held = existing[index];
    // A line is paired with the one that stood in its place, the same way a
    // shot is: the words may be rewritten without the take that read them
    // being forgotten, and a line added in the middle is the only one that
    // arrives unnamed. The recorded words are what says the take is out of
    // date afterwards, not the name.
    const dialogue: StoryDialogueLine[] = draft.dialogue.map((line, at) => ({
      id: held?.dialogue[at]?.id ?? newId(),
      ...(line.characterId !== undefined
        ? { characterId: line.characterId }
        : {}),
      speaker: line.speaker,
      text: line.text,
      ...(line.tone !== undefined ? { tone: line.tone } : {}),
    }));
    if (!held) {
      return {
        ...createKeyframe(index, draft.shotSize, draft.cameraMove, draft.angle),
        content: draft.content,
        dialogue,
        durationMs: draft.durationMs,
      };
    }
    return {
      ...held,
      shotSize: draft.shotSize,
      cameraMove: draft.cameraMove,
      angle: draft.angle,
      content: draft.content,
      dialogue,
      durationMs: draft.durationMs,
    };
  });
}

// -----------------------------------------------------------------------------
// Slots
// -----------------------------------------------------------------------------

/** The take a place is using, which is the newest one kept. */
export function currentTake(slot: StorySlot): StoryTake | undefined {
  return slot.takes[slot.takes.length - 1];
}

/**
 * The one file a take is, for the places that hold a single file: a drawing, a
 * line read aloud, a shot's own clip. An act filmed in pieces keeps several,
 * and this is the piece it opens on.
 */
export function takeFile(take: StoryTake | undefined): AssetId | undefined {
  return take?.assetIds[0];
}

/**
 * A place with this take added.
 *
 * A take already kept is not kept twice, however many times a job's answer is
 * applied: the same drawing filed at the same place is the same drawing, and
 * the room reads a job's answer more than once. The oldest take is let go
 * when the place is full, since what a reader is choosing between is recent
 * work.
 */
export function withTake(
  slot: StorySlot,
  take: StoryTake,
  max: number = MAX_TAKES_PER_SLOT,
): StorySlot {
  if (slot.takes.some((kept) => sameFiles(kept, take))) return slot;
  const takes = [...slot.takes, take];
  return {
    ...slot,
    takes: takes.length > max ? takes.slice(takes.length - max) : takes,
  };
}

/** Whether two takes are the same files in the same order. */
function sameFiles(one: StoryTake, other: StoryTake): boolean {
  return (
    one.assetIds.length === other.assetIds.length &&
    one.assetIds.every((assetId, at) => assetId === other.assetIds[at])
  );
}

/**
 * The slot a place holds once a take is the one being kept.
 *
 * Keeping is the newest take of the list, which is how every other part of the
 * room reads a place — so choosing one moves it to the end and leaves the rest
 * in the order they were drawn in.
 */
export function slotWithCurrent(slot: StorySlot, assetId: string): StorySlot {
  const chosen = slot.takes.find((held) => held.assetIds.includes(assetId));
  if (chosen === undefined) return slot;
  return {
    ...slot,
    takes: [...slot.takes.filter((held) => held !== chosen), chosen],
  };
}

/**
 * A place with one of its drawings thrown away.
 *
 * What a reader throws away here is work they no longer need, so the take a
 * place is keeping is not one of them: letting that one go would leave the
 * place holding a picture nobody chose, and it is a different act — made by
 * choosing another take first. A name the place never held, or the one it is
 * using, leaves the slot exactly as it was.
 */
export function slotWithoutTake(slot: StorySlot, assetId: string): StorySlot {
  const current = currentTake(slot);
  if (current?.assetIds.includes(assetId)) return slot;
  const takes = slot.takes.filter((take) => !take.assetIds.includes(assetId));
  if (takes.length === slot.takes.length) return slot;
  return { ...slot, takes };
}

/** The element an id names, if the story still holds it. */
export function elementOf(
  story: StoryDocument,
  id: string,
): StoryElement | undefined {
  return story.elements.find((element) => element.id === id);
}

/** Whether the reader has said anything at all about a voice. */
export function voiceNamed(voice: StoryVoiceProfile | undefined): boolean {
  return (
    voice !== undefined &&
    (voice.model !== "" ||
      voice.voice !== "" ||
      voice.referenceAssetId !== undefined ||
      voice.rate !== undefined ||
      voice.pitch !== undefined ||
      (voice.instructions ?? "") !== "")
  );
}

/**
 * The voice a character's lines are read in, resolved layer by layer.
 *
 * The character's own voice comes first, field by field rather than whole;
 * then the telling's narrator; then, through `ask`, what this machine reads
 * its lines in when the story says nothing. What is still empty is the
 * provider's own default tone, and an empty model means whoever the
 * deployment's speech default names — the chain the room shows on the cards
 * is this one, so a card and the ask it stands for cannot disagree.
 */
export function voiceFor(
  story: StoryDocument,
  characterId: string | undefined,
  ask: { model?: string } = {},
): StoryVoiceProfile {
  const own =
    characterId === undefined
      ? undefined
      : elementOf(story, characterId)?.voice;
  const layers = [own, story.narrator];
  const pick = <K extends keyof StoryVoiceProfile>(
    field: K,
  ): StoryVoiceProfile[K] | undefined => {
    for (const layer of layers) {
      const held = layer?.[field];
      if (held !== undefined && held !== "") return held;
    }
    return undefined;
  };
  const voice: StoryVoiceProfile = {
    model: pick("model") ?? ask.model ?? "",
    voice: pick("voice") ?? "",
  };
  const rate = pick("rate");
  const pitch = pick("pitch");
  const instructions = pick("instructions");
  const reference = pick("referenceAssetId");
  if (rate !== undefined) voice.rate = rate;
  if (pitch !== undefined) voice.pitch = pitch;
  if (instructions !== undefined) voice.instructions = instructions;
  if (reference !== undefined) voice.referenceAssetId = reference;
  return voice;
}

/** How many lines of the whole telling a character is given to say. */
export function lineCountFor(story: StoryDocument, elementId: string): number {
  let count = 0;
  for (const chapter of story.chapters)
    for (const act of chapter.acts)
      for (const keyframe of act.keyframes)
        for (const line of keyframe.dialogue)
          if (line.characterId === elementId) count += 1;
  return count;
}

/** The take a shot keeps of one line read aloud, by the line's own name. */
export function voiceTakeOf(
  keyframe: StoryKeyframe,
  lineId: string,
): StoryVoiceTake | undefined {
  return keyframe.voices?.find((take) => take.lineId === lineId);
}

/**
 * Whether the board holds a reading of this line, of the words it has now.
 *
 * A line read before it was rewritten is not read as it stands: what the take
 * holds is the older words, and saying so is what lets a reader notice rather
 * than wonder why the voice does not match the line.
 */
export function voiceHoldsLine(
  keyframe: StoryKeyframe,
  line: StoryDialogueLine,
): boolean {
  const take = voiceTakeOf(keyframe, line.id);
  return take !== undefined && take.text === line.text.trim();
}

/** The take a line-voice target names, if the story still holds the shot. */
export function storyVoiceTake(
  story: StoryDocument,
  target: Extract<StorySlotTarget, { kind: "lineVoice" }>,
): StoryVoiceTake | undefined {
  const keyframe = keyframeAt(story, target);
  if (keyframe === undefined) return undefined;
  return voiceTakeOf(keyframe, target.lineId);
}

/** The first line of the telling a character is given, words and all. */
export function firstLineOf(
  story: StoryDocument,
  elementId: string,
): StoryDialogueLine | undefined {
  for (const chapter of story.chapters)
    for (const act of chapter.acts)
      for (const keyframe of act.keyframes)
        for (const line of keyframe.dialogue)
          if (line.characterId === elementId && line.text.trim() !== "")
            return line;
  return undefined;
}

/**
 * The act's cast, as the story holds it: the elements that are still there,
 * and the ids of the references that are not.
 *
 * A drawing is asked for with what is there, and the room says out loud what
 * it could not find rather than quietly prompting with a character who was
 * taken out of the story.
 */
export function actCast(
  story: StoryDocument,
  act: StoryAct,
): {
  characters: StoryElement[];
  scenes: StoryElement[];
  props: StoryElement[];
  missing: string[];
} {
  const byId = new Map(story.elements.map((element) => [element.id, element]));
  const missing: string[] = [];
  const pick = (ids: string[]): StoryElement[] =>
    ids.flatMap((id) => {
      const element = byId.get(id);
      if (element) return [element];
      missing.push(id);
      return [];
    });
  const characters = pick(act.characterIds);
  const scenes = pick(act.sceneId === undefined ? [] : [act.sceneId]);
  const props = pick(act.propIds);
  return { characters, scenes, props, missing };
}

/**
 * The name a place is known by while work is out on it.
 *
 * It is written from the target alone, so the room's "is this being drawn
 * just now" and a job's "which place is this item for" are the same answer
 * without either of them having to read the document.
 */
/**
 * The element names a shot's words mention, in the order they are written.
 *
 * A mention is a name between backticks, the way a Markdown line names a piece
 * of code: the telling's prose keeps its own words and the bracketed name is
 * how the frame's ask is told which picture to hold to, and in what order. A
 * backtick with no partner before the text ends — a content cut short, a
 * reader mid-typing — is left as the character it is rather than swallowing
 * the rest of the shot.
 */
export function storyMentions(
  content: string,
): Array<{ start: number; end: number; name: string }> {
  const found: Array<{ start: number; end: number; name: string }> = [];
  let cursor = 0;
  while (cursor < content.length) {
    const open = content.indexOf("`", cursor);
    if (open < 0) break;
    const close = content.indexOf("`", open + 1);
    if (close < 0) break;
    const name = content.slice(open + 1, close).trim();
    if (name !== "") found.push({ start: open, end: close + 1, name });
    cursor = close + 1;
  }
  return found;
}

/**
 * The same words without the backticks that make a mention one.
 *
 * What is sent to a model is the sentence as the telling means it — `林` is
 * the character 林 — while the backticks are the app's own mark for which
 * picture travels with the ask, and no model is owed them.
 */
export function stripStoryMentions(content: string): string {
  let out = "";
  let cursor = 0;
  for (const span of storyMentions(content)) {
    out += content.slice(cursor, span.start) + span.name;
    cursor = span.end;
  }
  return out + content.slice(cursor);
}

export function targetKey(target: StorySlotTarget): string {
  switch (target.kind) {
    case "element": {
      const form = target.variantId === undefined ? "" : `:${target.variantId}`;
      return `element:${target.view}:${target.elementId}${form}`;
    }
    case "keyframe":
      return `keyframe:${target.chapterId}:${target.actId}:${target.keyframeId}`;
    case "actVideo":
      return `actVideo:${target.chapterId}:${target.actId}`;
    case "actVoice":
      return `actVoice:${target.chapterId}:${target.actId}`;
    case "lineVoice":
      return `lineVoice:${target.chapterId}:${target.actId}:${target.keyframeId}:${target.lineId}`;
    case "actMusic":
      return `actMusic:${target.chapterId}:${target.actId}`;
    case "keyframeVideo":
      return `keyframeVideo:${target.chapterId}:${target.actId}:${target.keyframeId}`;
  }
}

/** The act a target names, if the story still holds it. */
export function actAt(
  story: StoryDocument,
  chapterId: string,
  actId: string,
): StoryAct | undefined {
  return story.chapters
    .find((chapter) => chapter.id === chapterId)
    ?.acts.find((act) => act.id === actId);
}

/** The shot a target names, if the story still holds it. */
export function keyframeAt(
  story: StoryDocument,
  target: { chapterId: string; actId: string; keyframeId: string },
): StoryKeyframe | undefined {
  return actAt(story, target.chapterId, target.actId)?.keyframes.find(
    (keyframe) => keyframe.id === target.keyframeId,
  );
}

/**
 * The slot a place holds, so a take can be added to it or one taken out.
 *
 * The two sound slots are absent on a telling that was never voiced, and an
 * absent place answers as an empty one: the first take ever made for an act is
 * written into a slot that was not there, which is what a reader pressing the
 * button for the first time is asking for.
 */
export function slotAt(
  story: StoryDocument,
  target: StorySlotTarget,
): StorySlot | undefined {
  switch (target.kind) {
    case "element": {
      const element = elementOf(story, target.elementId);
      if (element === undefined) return undefined;
      if (target.variantId !== undefined) {
        const form = elementForm(element, target.variantId);
        if (form === undefined) return undefined;
        return target.view === "main" ? form.main : form.turnaround;
      }
      return target.view === "main" ? element.main : element.turnaround;
    }
    case "keyframe":
      return keyframeAt(story, target)?.art;
    case "actVideo":
      return actAt(story, target.chapterId, target.actId)?.video;
    case "actVoice": {
      const act = actAt(story, target.chapterId, target.actId);
      if (act === undefined) return undefined;
      return act.voice ?? emptyStorySlot();
    }
    case "lineVoice": {
      // The line's take is read off the shot, not off the line: a line edited
      // or taken out of the board leaves its take where it was, so that what
      // was said is not lost by what was said afterwards.
      const keyframe = keyframeAt(story, target);
      if (keyframe === undefined) return undefined;
      return voiceTakeOf(keyframe, target.lineId)?.slot ?? emptyStorySlot();
    }
    case "actMusic": {
      const act = actAt(story, target.chapterId, target.actId);
      if (act === undefined) return undefined;
      return act.music ?? emptyStorySlot();
    }
    case "keyframeVideo":
      return keyframeAt(story, target)?.video;
  }
}

// -----------------------------------------------------------------------------
// What a reader is shown
// -----------------------------------------------------------------------------

/**
 * The step a story is standing on: the first one that is not settled, which is
 * the one whose work is wanted next.
 *
 * A story every step of which is settled reads as standing on its last step,
 * since that is where the finished film is.
 */
export function storyCurrentStep(
  progress: Record<StoryStep, StoryStepProgress>,
): StoryStepProgress {
  for (const step of STORY_STEPS) {
    const held = progress[step];
    if (held.state !== "confirmed") return held;
  }
  return progress[STORY_STEPS[STORY_STEPS.length - 1]];
}

/**
 * What the step before it has to have settled, read off that step's state.
 *
 * A step opens on the step before it being settled — that is what pressing a
 * step's confirm is for, and the only thing that opens a door. A step that is
 * merely complete is not a door yet: the reader has to have said so.
 */
const STEP_OPENS_AFTER: Record<
  StoryStep,
  (before: StoryStepProgress) => boolean
> = {
  /** The first step is always reachable: a premise can always be re-written. */
  idea: () => true,
  outline: (idea) => idea.state === "confirmed",
  elements: (outline) => outline.state === "confirmed",
  storyboard: (elements) => elements.state === "confirmed",
  edit: (storyboard) => storyboard.state === "confirmed",
};

/** Whether a step can be walked to yet. */
export function stepReachable(
  progress: Record<StoryStep, StoryStepProgress>,
  step: StoryStep,
): boolean {
  const index = STORY_STEPS.indexOf(step);
  if (index <= 0) return true;
  return STEP_OPENS_AFTER[step](progress[STORY_STEPS[index - 1]]);
}

/**
 * The frame a finished film is cut to, in pixels.
 *
 * The frame a story is told in is a proportion, and a proportion is not a size:
 * what a story asks its pictures for is a shape, while what the cutting room
 * exports is a size. This is the one place the two meet, so a story told in one
 * frame is not exported in another.
 */
export function timelineSizeForAspect(aspect: StoryAspect): {
  width: number;
  height: number;
} {
  switch (aspect) {
    case "9:16":
      return { width: 1080, height: 1920 };
    case "1:1":
      return { width: 1080, height: 1080 };
    case "4:3":
      return { width: 1440, height: 1080 };
    case "21:9":
      return { width: 2560, height: 1080 };
    default:
      return { width: 1920, height: 1080 };
  }
}

/** The shortest a premise may be and still be one. */
export const STORY_IDEA_MIN = 10;

/**
 * Whether step one has what the steps after it need.
 *
 * A premise of one line is not a premise — the outline it would be written
 * into has nothing to go on — and a manuscript is a premise of its own, since
 * the second step reads the text rather than the summary. The look and the
 * genre may be left empty; they are asked about again at every step that uses
 * them, and a story without them is drawn plainly rather than not drawn.
 */
export function ideaReady(story: StoryDocument): boolean {
  const written = story.brief.idea.trim().length >= STORY_IDEA_MIN;
  return written || story.brief.sourceAssetId !== undefined;
}

/** A running time a reader can read: `mm:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * What deleting a story would stop referring to, counted for the question that
 * is asked before it.
 *
 * Nothing is deleted by it: the drawings and the clips stay in the shelf, and
 * the timeline it assembled stays in the cutting room. What the count says is
 * how much of the telling stops pointing at them.
 */
export function storyDeleteCost(story: StoryDocument): {
  chapters: number;
  acts: number;
  pictures: number;
  videos: number;
  voices: number;
} {
  let acts = 0;
  let pictures = story.elements.reduce(
    (sum, element) =>
      sum + element.main.takes.length + (element.turnaround?.takes.length ?? 0),
    0,
  );
  let videos = 0;
  let voices = 0;
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      acts += 1;
      videos += act.video.takes.length;
      voices += act.voice?.takes.length ?? 0;
      for (const keyframe of act.keyframes) {
        pictures += keyframe.art.takes.length;
        videos += keyframe.video.takes.length;
        for (const take of keyframe.voices ?? []) {
          voices += take.slot.takes.length;
        }
      }
    }
  }
  return { chapters: story.chapters.length, acts, pictures, videos, voices };
}

/**
 * What splitting a story again would overwrite, counted for the question that
 * is asked before it.
 *
 * A chapter keeps everything made for it as long as it stands where it stood,
 * so what a re-split costs is the words it replaces — every chapter that has
 * text of its own — and the boards of the chapters the new telling has no room
 * for. Counting the acts that would go is why the count is asked for before
 * the split rather than after it.
 */
export function chapterRegenerationCost(
  story: StoryDocument,
  chapterCount: number = story.chapters.length,
): { chapters: number; acts: number } {
  const kept = Math.max(0, Math.min(chapterCount, story.chapters.length));
  return {
    chapters: story.chapters.filter(chapterHasWords).length,
    acts: story.chapters
      .slice(kept)
      .reduce((sum, chapter) => sum + chapter.acts.length, 0),
  };
}

/**
 * What boarding an episode again writes over.
 *
 * A board is written onto the acts in their places, so an act standing where
 * it stood keeps its frames and its clip — the words of the board are what a
 * new answer replaces. What the question is about is therefore the work that
 * would be left standing on nothing: acts the new board has no room for, and
 * the pictures and clips made for the shots inside them.
 */
export function actsRegenerationCost(chapter: StoryChapter): {
  acts: number;
  drawn: number;
  filmed: number;
} {
  return {
    acts: chapter.acts.length,
    drawn: chapter.acts.reduce(
      (sum, act) =>
        sum +
        act.keyframes.filter((keyframe) => keyframe.art.takes.length > 0)
          .length,
      0,
    ),
    filmed: chapter.acts.reduce(
      (sum, act) =>
        sum +
        (act.video.takes.length > 0 ? 1 : 0) +
        act.keyframes.filter((keyframe) => keyframe.video.takes.length > 0)
          .length,
      0,
    ),
  };
}

/**
 * A list cut into the waves a story's jobs are taken in.
 *
 * A batch may hold no more pieces than the story job client's limit allows, and
 * a telling may ask for more than that at once — five hundred episodes of a
 * manuscript, eight episodes of boards at a time. The pieces are the same
 * pieces either way; what the waves decide is how many asks the telling is
 * made of, and a list that fits in one wave comes back as one.
 */
export function chunkWaves<T>(items: T[], per: number): T[][] {
  const width = Math.max(1, Math.floor(per));
  const waves: T[][] = [];
  for (let at = 0; at < items.length; at += width) {
    waves.push(items.slice(at, at + width));
  }
  return waves;
}

/** One chapter's words as a reading ask carries them, possibly a slice of it. */
export interface StoryReadingPiece {
  chapterId: string;
  /** The chapter's number in the telling, counted from one. */
  number: number;
  title: string;
  text: string;
}

/**
 * The last paragraph boundary at or before `limit`.
 *
 * A reading batch ends on a whole paragraph rather than inside one, and it
 * never runs past the configured ceiling: the boundary is taken backwards, so
 * the batch may be shorter than the ceiling but not longer. A text with no
 * paragraph break before the ceiling is cut at its last line break, and a text
 * with neither is cut at the ceiling.
 */
function paragraphCutAt(text: string, limit: number): number {
  const wanted = Math.min(text.length, Math.max(1, Math.floor(limit)));
  if (wanted >= text.length) return text.length;
  if (wanted >= 2) {
    const paragraph = text.lastIndexOf("\n\n", wanted - 2);
    if (paragraph >= 0) return paragraph + 2;
  }
  const line = text.lastIndexOf("\n", wanted - 1);
  if (line >= 0) return line + 1;
  // A hard cut must not land between the halves of a character written with
  // two.
  const before = text.charCodeAt(wanted - 1);
  if (wanted > 1 && before >= 0xd800 && before <= 0xdbff) return wanted - 1;
  return wanted;
}

/**
 * The chapters of a telling packed into the asks that read them.
 *
 * A reading ask carries words, so the packer weighs the words rather than the
 * chapter count: neighbouring chapters share an ask until it is full, and a
 * chapter longer than one ask is cut back to a paragraph boundary and carried
 * into the next one. Every piece keeps its chapter's number and title, so what
 * the answer says it noticed still lands on the chapter it was noticed in —
 * including a chapter whose text arrived in two pieces.
 *
 * A piece costs its text and its title, since the title is written into the
 * ask as well; a chapter with no words still travels so the reading can say it
 * holds nothing. A batch that is less than half full is closed rather than
 * carried forward, since a small tail costs an ask of its own.
 */
export function chapterReadingWaves(
  chapters: StoryChapter[],
  budget: number,
  textOf: (chapter: StoryChapter) => string,
): StoryReadingPiece[][] {
  const limit = Math.max(1, Math.floor(budget));
  const floor = Math.max(1, Math.floor(limit / 2));
  const waves: StoryReadingPiece[][] = [];
  let wave: StoryReadingPiece[] = [];
  let used = 0;
  const flush = () => {
    if (wave.length === 0) return;
    waves.push(wave);
    wave = [];
    used = 0;
  };
  chapters.forEach((chapter, index) => {
    const title = chapter.title;
    const titleCost = Array.from(title).length;
    const piece = (text: string): StoryReadingPiece => ({
      chapterId: chapter.id,
      number: index + 1,
      title,
      text,
    });
    let rest = textOf(chapter).trim();
    if (rest === "") {
      wave.push(piece(""));
      used += titleCost;
      if (used >= limit) flush();
      return;
    }
    while (rest !== "") {
      const remaining = limit - used;
      if (remaining < floor) {
        flush();
        continue;
      }
      const room = remaining - titleCost;
      if (room <= 0) {
        if (wave.length > 0) {
          flush();
          continue;
        }
        // A title wider than the ask it is carried in fills one on its own
        // rather than leaving the packer with nowhere to put the words.
        wave.push(piece(rest));
        used += rest.length + titleCost;
        rest = "";
        flush();
        break;
      }
      if (rest.length <= room) {
        wave.push(piece(rest));
        used += rest.length + titleCost;
        rest = "";
        if (used >= limit) flush();
        break;
      }
      const take = Math.min(rest.length, paragraphCutAt(rest, room));
      wave.push(piece(rest.slice(0, take)));
      used += take + titleCost;
      rest = rest.slice(take);
      flush();
    }
  });
  flush();
  return waves;
}
