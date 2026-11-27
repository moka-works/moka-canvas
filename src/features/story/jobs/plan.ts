/**
 * What a step of the story room is asked for, as a batch of pieces.
 *
 * The room's buttons know what they are about — this chapter, these drawings,
 * this act — and nothing about how a model is asked: which picture of a
 * character travels with which line of the prompt, how long a clip is allowed
 * to be, what a shot with no drawing of its own leaves out. That knowing lives
 * here, in one place per step, so a prompt written into a button is not a thing
 * that can happen.
 *
 * Everything is planned from the document as it stands now rather than from
 * what a job record says was asked before: a retry is a new ask with today's
 * words and today's references, which is the only way a batch re-sent after a
 * description was edited comes back matching the description.
 */

import type {
  StoryJobInput,
  StoryJobItemDraft,
  StoryTarget,
} from "../../../api/story";
import {
  MAX_IMAGES_PER_ASK,
  MAX_ITEMS_PER_STORY_JOB,
  MAX_VIDEO_SECONDS,
  STORY_SPLIT_CHARS_DEFAULT,
} from "../../../shared/domain/constants";
import {
  STORY_CAMERA_ANGLES,
  STORY_CAMERA_MOVES,
  STORY_SHOT_SIZES,
} from "../../../shared/domain/types";
import {
  actAt,
  actPlannedMs,
  chapterActPlan,
  chapterOutlineAhead,
  chapterRevision,
  chunkWaves,
  currentTake,
  elementForm,
  elementOf,
  referenceName,
  formAspect,
  formDescription,
  formName,
  imagePromptOverride,
  keyframeAt,
  neighbourVideos,
  pictureReferenceAsset,
  referenceTake,
  storyMentions,
  stripStoryMentions,
  takeFile,
  targetKey,
  videoPromptOverride,
  voiceFor,
  type StoryElementFormDraft,
  type StoryMissingClip,
  type StoryReadingPiece,
} from "../../../shared/domain/story";
import { chapterText } from "../readText";
import type {
  StoryElement,
  StoryElementKind,
  StoryElementVariant,
} from "../../../shared/domain";
import type {
  StoryAct,
  StoryAspect,
  StoryChapter,
  StoryDialogueLine,
  StoryDocument,
  StoryKeyframeReference,
  StoryFilmRole,
  StoryKeyframe,
  StoryVoiceProfile,
} from "../../../shared/domain/types";
import {
  storyActMusicPrompt,
  storyActVideoPrompt,
  storyChapterPrompt,
  storyElementMainPrompt,
  storyElementTurnaroundPrompt,
  storyElementsPrompt,
  storyKeyframePrompt,
  storyKeyframeVideoPrompt,
  storyMergeElementsPrompt,
  storyOutlinePrompt,
  storyActPlanPrompt,
  storyContinuityPrompt,
  storyRevisionPrompt,
  storyStoryboardPrompt,
  storyStoryboardRepairPrompt,
  storySystemPrompt,
  storyTransitionVideoPrompt,
  type StoryFacts,
  type StoryLook,
  type StoryRevisionAct,
  type StoryRevisionFrame,
  type StoryStoryboardPromptInput,
} from "../../../shared/prompts";
import {
  castFor,
  characterRefs,
  linesFor,
  shotStarts,
  shotsFor,
  soundFor,
} from "../../../shared/prompts/story/promptContext";
import { fnv1a } from "../../../shared/domain/digest";
import { i18n } from "../../../shared/i18n";
import {
  effectiveDefaultId,
  modelOptionsFor,
  useModelStore,
} from "../../settings/modelStore";
import {
  storyAskModel,
  storyAskModelHead,
  storyAskModels,
} from "../stores/storyModels";
import {
  actVideoVoiceReference,
  audioCapableVideoModel,
  carriesVoiceReferences,
  voiceReferenceFits,
  voiceReferencesFor,
  voiceSpeakerIds,
  withVoiceReferences,
  type VoiceReference,
} from "./voiceReferences";

/**
 * The name a piece is known by, which is also how its answer is recognised
 * when it is applied.
 *
 * A slot's own name wherever the piece is for a slot, so an answer that comes
 * home twice lands in the same place twice; the steps that produce words rather
 * than pictures are named after what they write, and a manuscript's parts are
 * numbered because each part is a chapter's ask.
 */
export function jobKey(target: StoryTarget): string {
  switch (target.kind) {
    case "outline":
      return "outline";
    case "elements":
      return "elements";
    case "storyboard":
      return `storyboard:${target.chapterId}`;
    case "actPlan":
      return target.actId === undefined
        ? `actPlan:${target.chapterId}`
        : `actPlan:${target.chapterId}:${target.actId}`;
    case "continuity":
      return `continuity:${target.chapterId}`;
    case "outlineRevision":
      return `outlineRevision:${target.chapterId}`;
    case "elementArt":
      return targetKey({
        kind: "element",
        elementId: target.elementId,
        view: target.view,
        ...(target.variantId === undefined
          ? {}
          : { variantId: target.variantId }),
      });
    case "keyframeArt":
      return targetKey({
        kind: "keyframe",
        chapterId: target.chapterId,
        actId: target.actId,
        keyframeId: target.keyframeId,
      });
    case "actVideo":
      return targetKey({
        kind: "actVideo",
        chapterId: target.chapterId,
        actId: target.actId,
      });
    case "keyframeVideo":
      return targetKey({
        kind: "keyframeVideo",
        chapterId: target.chapterId,
        actId: target.actId,
        keyframeId: target.keyframeId,
      });
    case "voice":
      return targetKey({
        kind: "actVoice",
        chapterId: target.chapterId,
        actId: target.actId,
      });
    case "lineVoice":
      return targetKey({
        kind: "lineVoice",
        chapterId: target.chapterId,
        actId: target.actId,
        keyframeId: target.keyframeId,
        lineId: target.lineId,
      });
    case "music":
      return targetKey({
        kind: "actMusic",
        chapterId: target.chapterId,
        actId: target.actId,
      });
  }
}

/** How many drawings one place's ask is set to make, within what a place may. */
export function copiesFor(count: number | undefined): number {
  if (!Number.isFinite(count ?? 1)) return 1;
  return Math.min(MAX_IMAGES_PER_ASK, Math.max(1, Math.trunc(count ?? 1)));
}

/**
 * One drawing place's asks: one piece, or the set a reader asked to choose
 * between. Every piece of a set carries the count, which is what tells the
 * room the answers are one choice rather than an ordinary redraw.
 */
function withCopies(
  item: StoryJobItemDraft,
  count: number | undefined,
): StoryJobItemDraft[] {
  const copies = copiesFor(count);
  if (copies === 1) return [item];
  return Array.from({ length: copies }, (_, at) => ({
    ...item,
    id: `${item.id}:${at + 1}`,
    copies,
    ...(item.name === undefined ? {} : { name: `${item.name} ${at + 1}` }),
  }));
}

/**
 * Splits asks into batches without cutting one place's set of drawings in two:
 * a set is one choice, and the room only knows to offer it when every piece of
 * it comes home in the same batch.
 */
function chunkKeepingSets(
  items: StoryJobItemDraft[],
  size: number,
): StoryJobItemDraft[][] {
  const waves: StoryJobItemDraft[][] = [];
  let current: StoryJobItemDraft[] = [];
  let at = 0;
  while (at < items.length) {
    const key = jobKey(items[at]!.target);
    let end = at;
    while (end < items.length && jobKey(items[end]!.target) === key) end += 1;
    const run = items.slice(at, end);
    if (current.length > 0 && current.length + run.length > size) {
      waves.push(current);
      current = [];
    }
    current.push(...run);
    if (current.length >= size) {
      waves.push(current);
      current = [];
    }
    at = end;
  }
  if (current.length > 0) waves.push(current);
  return waves;
}

/** The drawing size closest to the frame a story is cut to. */
export function imageSizeForAspect(aspect: StoryAspect): string {
  switch (aspect) {
    case "9:16":
      return "1024x1536";
    case "1:1":
      return "1024x1024";
    default:
      return "1536x1024";
  }
}

/**
 * How many seconds a clip is asked for: what the story plans for it, in whole
 * seconds, never less than one and never past the length one clip may be.
 *
 * A whole second is taken down rather than up: a worker's ceiling is often a
 * fraction more than its frame grid can render (H3 declares fifteen seconds
 * and films 345 frames at 24 fps, 14.375 s), so a plan of 14.8 s rounded up
 * would ask for the ceiling and be refused. Asking a fraction shorter is a
 * clip that loses part of a second; asking longer is a clip that never starts.
 *
 * The ceiling is the video model's own where the deployment knows it, and the
 * app's otherwise — and not the video settings' length: that number is the
 * default a canvas node asks with when nobody says, while a telling says shot
 * by shot what each clip is for — a shot planned to run longer than the default
 * is a shot the reader asked to see run that long.
 */
export function clampSeconds(
  ms: number,
  ceiling: number = MAX_VIDEO_SECONDS,
): number {
  return Math.min(ceiling, Math.max(1, Math.floor(ms / 1000)));
}

/**
 * The longest one clip may be, in seconds, for the video model this machine
 * will ask: the one named, or the one the room is set to, and that model's own
 * declared window where it has one.
 *
 * Read where a batch is planned rather than held, the way every other ask is:
 * a model swapped between two asks is the model the second one is planned for.
 * An act that names its own model is planned against that model's window.
 */
export function videoCeiling(model?: string | null): number {
  const chosen = model === undefined ? storyAskModelHead("actVideo") : model;
  const view = useModelStore.getState().view;
  const id =
    chosen ??
    (view === null ? null : (effectiveDefaultId(view, "video") ?? null));
  const heldModel = view?.models.find((held) => held.id === id);
  const seconds = heldModel?.maxVideoSeconds;
  return typeof seconds === "number" && seconds > 0
    ? Math.min(seconds, MAX_VIDEO_SECONDS)
    : MAX_VIDEO_SECONDS;
}

/**
 * The video model an act is filmed by: the one the reader named for it, and
 * otherwise the one the step's list leads with.
 *
 * This is the model an act's prompt is shaped for, not the only model its
 * pieces are asked of: every piece takes the next model of the list in its
 * turn, and the pieces that land on one model travel as one batch.
 */
export function actVideoModel(act: StoryAct): string | null {
  const own = (act.videoModel ?? "").trim();
  return own === "" ? storyAskModelHead("actVideo") : own;
}

/**
 * The longest a piece of this act's clip may run when it is planned.
 *
 * An act with a model of its own is planned to that model's window. One that
 * takes its models from the step's list is planned to the shortest window in
 * the list, since every piece may land on whichever model comes next and no
 * piece may ask for more than the one it lands on will take.
 */
export function actVideoCeiling(act: StoryAct): number {
  if ((act.videoModel ?? "").trim() !== "") {
    return videoCeiling(act.videoModel);
  }
  const pool = storyAskModels("actVideo");
  if (pool.length === 0) return videoCeiling();
  return Math.min(...pool.map((model) => videoCeiling(model)));
}

/**
 * How one piece of an act's clip travels with its pictures.
 *
 * `words` is a piece with no pictures at all: pictureless shots that cannot
 * stand inside a piece pinned to a frame, filmed from their words alone.
 */
export type ActClipKind = "frame" | "pair" | "reference" | "words";

/** One piece of an act's clip: the shots it is made of, and its length. */
export interface ActClipPiece {
  keyframes: StoryKeyframe[];
  /** How long the piece is asked for, in whole seconds. */
  seconds: number;
  /** Whether it opens on one frame, pairs two, is drawn from references, or is words alone. */
  kind: ActClipKind;
}

/** The frames of an act that were drawn, in board order. */
export function drawnFrames(act: StoryAct): StoryKeyframe[] {
  return act.keyframes.filter(
    (keyframe) => currentTake(keyframe.art) !== undefined,
  );
}

/**
 * The shots of an act a clip may carry, in board order: every frame that was
 * drawn, and every shot the reader said needs no picture. A pictureless shot
 * is still a moment of the act — it has words and a hold — so it travels in
 * the clip's timeline; only its picture is missing, and the frames around it
 * are what the model draws it from. A shot still waiting for a drawing is not
 * filmable yet and is left out.
 */
export function clipShots(act: StoryAct): StoryKeyframe[] {
  return act.keyframes.filter(
    (keyframe) =>
      currentTake(keyframe.art) !== undefined || keyframe.artNotNeeded === true,
  );
}

/** Whether a shot travels with a picture of its own. */
function hasPicture(keyframe: StoryKeyframe): boolean {
  return currentTake(keyframe.art) !== undefined;
}

/** The first shot from `from` on that travels with a picture. */
function nextPictured(
  shots: StoryKeyframe[],
  from: number,
): number | undefined {
  for (let at = from; at < shots.length; at += 1) {
    if (hasPicture(shots[at])) return at;
  }
  return undefined;
}

/**
 * How a frame is used when the act is shot.
 *
 * Nothing said is the plainest use there is: a frame nobody has given a role is
 * one of the references a video is drawn from, which is also what a board
 * written before roles existed meant.
 */
export function filmRoleOf(keyframe: StoryKeyframe): StoryFilmRole {
  return keyframe.filmRole ?? "reference";
}

/**
 * The frames whose role is not the reader's to choose any more: the last frame
 * of an act whose next-to-last drawn frame is a first-and-last frame, since
 * that pair already closes the act with it. Every frame before those two stays
 * choosable, because a frame may as well open the piece after it as close the
 * one before.
 */
export function settledRoleFrames(act: StoryAct): Set<string> {
  const drawn = drawnFrames(act);
  const settled = new Set<string>();
  const last = drawn.length - 1;
  if (last >= 1 && filmRoleOf(drawn[last - 1]) === "firstLastFrame") {
    settled.add(drawn[last].id);
  }
  return settled;
}

/** Whether the shot at `at` opens a piece of its own under its role. */
function opensItsOwnPiece(shots: StoryKeyframe[], at: number): boolean {
  if (!hasPicture(shots[at])) return false;
  const role = filmRoleOf(shots[at]);
  return (
    role === "firstFrame" ||
    (role === "firstLastFrame" && nextPictured(shots, at + 1) !== undefined)
  );
}

/**
 * An act's clip as it is asked for: the pieces its roles and its length make
 * of it, each opening where the one before closed.
 *
 * A frame marked as a first-and-last frame pairs with the frame after it as
 * the ends of one video, a frame marked as a first frame opens a video of its
 * own, and every other frame joins the run of references around it — which is
 * cut at shot boundaries whenever it outruns what one clip may be, since a
 * piece of a film has to open and close on frames that exist. A pair longer
 * than the ceiling cannot be cut at all, so it is asked for the longest a clip
 * may be, and what is lost is said out loud beside the act.
 *
 * A shot said to need no picture is a moment of the piece around it: its words
 * and hold travel with the pictures on either side, and the model draws what it
 * shows from them. Words at the head of a reference run join the run, which is
 * not pinned to a picture; words before a piece that opens on a picture, or
 * after a pair that closes the act, are a clip of their own, since the frames
 * given cannot show anything before their opening picture or after their last.
 */
export function actClipPieces(act: StoryAct, ceiling: number): ActClipPiece[] {
  const shots = clipShots(act);
  const pieces: ActClipPiece[] = [];
  /** The run of pictureless shots at `at`, as a piece of its own. */
  const wordsPiece = (at: number): number => {
    let end = at;
    let ms = 0;
    while (end < shots.length && !hasPicture(shots[end])) {
      ms += shots[end].durationMs;
      end += 1;
    }
    pieces.push({
      keyframes: shots.slice(at, end),
      seconds: clampSeconds(ms, ceiling),
      kind: "words",
    });
    return end;
  };
  let at = 0;
  while (at < shots.length) {
    if (!hasPicture(shots[at])) {
      const next = nextPictured(shots, at);
      if (next === undefined || opensItsOwnPiece(shots, next)) {
        at = wordsPiece(at);
        continue;
      }
      // A reference run follows, which is not pinned to a picture: the words
      // open the run.
    }
    const shot = shots[at];
    const role = filmRoleOf(shot);
    const tail =
      role === "firstLastFrame" ? nextPictured(shots, at + 1) : undefined;
    if (tail !== undefined) {
      // Whether this pair's tail is the act's closing picture: then nothing
      // opens on it, and its length rides with the pair rather than being
      // counted twice. The words between the two pictures are inside the pair.
      const closing = nextPictured(shots, tail + 1) === undefined;
      const inner = shots.slice(at, tail + 1);
      const ms = inner.reduce((sum, held) => sum + held.durationMs, 0);
      pieces.push({
        keyframes: inner,
        seconds: clampSeconds(
          ms - (closing ? 0 : shots[tail].durationMs),
          ceiling,
        ),
        kind: "pair",
      });
      // A tail that is not closing the act goes on to open its own piece,
      // under whatever role it was given.
      at = closing ? tail + 1 : tail;
      continue;
    }
    if (role === "firstFrame") {
      let end = at + 1;
      while (end < shots.length && !hasPicture(shots[end])) end += 1;
      const inner = shots.slice(at, end);
      pieces.push({
        keyframes: inner,
        seconds: clampSeconds(
          inner.reduce((sum, held) => sum + held.durationMs, 0),
          ceiling,
        ),
        kind: "frame",
      });
      at = end;
      continue;
    }
    // The run of references this shot belongs to — the last frame of an act
    // whose pair never came degrades into one — with the pictureless shots
    // between them as moments it passes through, every hold counting toward
    // the ceiling. It is cut at a shot boundary where it outruns the clip.
    const run: StoryKeyframe[] = [];
    let runMs = 0;
    while (at < shots.length) {
      const held = shots[at];
      if (run.length > 0 && hasPicture(held) && opensItsOwnPiece(shots, at)) {
        break;
      }
      if (runMs > 0 && runMs + held.durationMs > ceiling * 1000) break;
      run.push(held);
      runMs += held.durationMs;
      at += 1;
    }
    pieces.push({
      keyframes: run,
      seconds: clampSeconds(runMs, ceiling),
      // Words that filled the clip before a picture could join it are a piece
      // of words, not a run of references with nothing to refer to.
      kind: run.some(hasPicture) ? "reference" : "words",
    });
  }
  return pieces;
}

/**
 * How much of a telling one ask may carry, as the story settings say.
 *
 * The same ceiling cuts a manuscript and packs a reading: both are asks of a
 * model about words, and what one ask can hold is a property of the model
 * behind the room. Read where a batch is planned, the way the clip ceiling is:
 * a telling cut to yesterday's boundary is a telling already being read.
 */
export function storySplitChars(): number {
  const chars = useModelStore.getState().view?.preferences.story.splitChars;
  return typeof chars === "number" && chars > 0
    ? chars
    : STORY_SPLIT_CHARS_DEFAULT;
}

/**
 * A clip's parameters: how long it runs, in what shape, and the machine's own
 * answers about sound and a watermark.
 *
 * The story decides the first two — a clip is as long as the story planned and
 * as wide as the story is told — and the preferences decide the rest, since
 * whether a provider writes sound into its clip is not a thing a telling has
 * an opinion about. A mode handed in is what the pictures of this clip mean,
 * stated by the caller rather than guessed from the machine's own taste.
 */
function videoParams(
  ratio: StoryAspect,
  seconds: number,
  mode?: "auto" | "reference",
): Record<string, unknown> {
  const video = useModelStore.getState().view?.preferences.video;
  return {
    seconds,
    ratio,
    ...(mode === undefined ? {} : { mode }),
    ...(video?.resolution ? { resolution: video.resolution } : {}),
    generateAudio: video?.generateAudio ?? false,
    watermark: video?.watermark ?? false,
  };
}

function factsOf(story: StoryDocument): StoryFacts {
  return {
    aspect: story.brief.aspect,
    genre: story.brief.genre,
    style: story.brief.style,
    totalDurationMs: story.brief.totalDurationMs,
  };
}

function lookOf(story: StoryDocument): StoryLook {
  return { aspect: story.brief.aspect, style: story.brief.style };
}

// -----------------------------------------------------------------------------
// Step two and three: the words
// -----------------------------------------------------------------------------

/**
 * The outline: the premise written into chapters.
 *
 * A manuscript is not written from here. Its chapters are cut out of its own
 * text by the split planner, which asks the model only where the cuts fall and
 * keeps every word as it was.
 */
export function planOutline(
  story: StoryDocument,
  options: { chapters: number },
): StoryJobItemDraft[] {
  return [
    {
      id: "outline",
      target: { kind: "outline" },
      capability: "text",
      system: storySystemPrompt(),
      prompt: storyOutlinePrompt({
        ...factsOf(story),
        idea: story.brief.idea,
        chapters: options.chapters,
      }),
    },
  ];
}

/** What a chapter's words are, as the ask that writes around it reads them. */
function chapterWordsOf(chapter: StoryChapter): string {
  const held = chapterText(chapter);
  // A window whose manuscript has not been read this session falls back to the
  // synopsis rather than planning an ask from nothing.
  return held === "" ? chapter.synopsis : held;
}

/**
 * One chapter of a premise written again, in the place it already stands.
 *
 * The chapters around it travel as the short reading the telling already holds,
 * so a chapter written again is in the same stretch of the story as its
 * neighbours rather than a fresh telling with one chapter replaced.
 */
export function planChapterRewrite(
  story: StoryDocument,
  index: number,
): StoryJobItemDraft | undefined {
  const chapter = story.chapters[index];
  if (chapter === undefined) return undefined;
  const around = (at: number) => {
    const held = story.chapters[at];
    return held === undefined
      ? undefined
      : {
          number: at + 1,
          title: held.title,
          text: chapterWordsOf(held).slice(0, 1200),
        };
  };
  return {
    id: `outline:rewrite:${index + 1}`,
    target: { kind: "outline" },
    capability: "text",
    system: storySystemPrompt(),
    prompt: storyChapterPrompt({
      idea: story.brief.idea,
      chapters: story.chapters.length,
      number: index + 1,
      ...(index > 0 ? { previous: around(index - 1) } : {}),
      ...(index + 1 < story.chapters.length ? { next: around(index + 1) } : {}),
      current: {
        title: chapter.title,
        text: chapterWordsOf(chapter).slice(0, 1200),
      },
    }),
  };
}

/**
 * The characters, places and things the chapters are made of.
 *
 * One ask for the whole telling wherever it fits, and otherwise a part of the
 * words at a time — a long telling's chapters are more than one prompt may
 * carry. A part is numbered the way a manuscript's parts are, and what it names
 * is read into the cast beside what earlier parts found rather than in place of
 * it.
 *
 * A part arrives already cut to the reading budget, because a chapter longer
 * than one ask is carried across parts. The pieces keep the telling's own
 * chapter numbers even where a part holds a slice or a few chapters, because
 * those numbers are how the answer says where each thing was noticed and how
 * the reading files them: a part-local count would be read against the whole
 * table and land on the wrong chapters.
 */
export function planElements(
  story: StoryDocument,
  options: { pieces?: StoryReadingPiece[]; part?: number; total?: number } = {},
): StoryJobItemDraft[] {
  const pieces =
    options.pieces ??
    story.chapters.map((chapter, at) => ({
      chapterId: chapter.id,
      number: at + 1,
      title: chapter.title,
      text: chapterWordsOf(chapter),
    }));
  return [
    {
      id: options.part === undefined ? "elements" : `elements:${options.part}`,
      target: { kind: "elements" },
      capability: "text",
      system: storySystemPrompt(),
      prompt: storyElementsPrompt({
        chapters: pieces.map(({ number, title, text }) => ({
          number,
          title,
          text,
        })),
        genre: story.brief.genre,
        style: story.brief.style,
        ...(options.part === undefined
          ? {}
          : { part: options.part, total: options.total }),
      }),
    },
  ];
}

// -----------------------------------------------------------------------------
// Step three: what the parts said about the same name
// -----------------------------------------------------------------------------

/** One part's reading of an element's default and additional forms. */
export interface ElementReading {
  description: string;
  forms?: StoryElementFormDraft[];
}

/** One name the telling's parts described more than once. */
export interface ElementRepeat {
  kind: StoryElementKind;
  name: string;
  readings: ElementReading[];
}

/** The name every merge piece's id begins with. */
export const ELEMENT_MERGE_ID = "elements:merge";

function mergePromptLength(
  story: StoryDocument,
  groups: ElementRepeat[],
  part: number,
  total: number,
): number {
  return storyMergeElementsPrompt({
    groups,
    genre: story.brief.genre,
    style: story.brief.style,
    part,
    total,
  }).length;
}

/**
 * How the names are handed over, the room's reading budget at a time.
 *
 * A batch carries whole names and complete appearances: dropping words to fit
 * a budget could erase exactly the difference that makes two forms necessary.
 * One name too large for a batch therefore travels in an oversized ask alone.
 */
export function chunkElementMerges(
  story: StoryDocument,
  repeats: ElementRepeat[],
  budget: number,
): ElementRepeat[][] {
  const limit = Math.max(1, Math.floor(budget));
  const total = repeats.length;
  const waves: ElementRepeat[][] = [];
  let wave: ElementRepeat[] = [];
  for (const group of repeats) {
    const part = waves.length + 1;
    if (
      wave.length > 0 &&
      mergePromptLength(story, [...wave, group], part, total) > limit
    ) {
      waves.push(wave);
      wave = [group];
      continue;
    }
    wave.push(group);
  }
  if (wave.length > 0) waves.push(wave);
  return waves;
}

/** One merge ask: the names a batch carries, as a text piece. */
export function planElementMerge(
  story: StoryDocument,
  groups: ElementRepeat[],
  part: number,
  total: number,
): StoryJobItemDraft[] {
  if (groups.length === 0) return [];
  return [
    {
      id: `${ELEMENT_MERGE_ID}:${part}`,
      target: { kind: "elements" },
      capability: "text",
      system: storySystemPrompt(),
      prompt: storyMergeElementsPrompt({
        groups,
        genre: story.brief.genre,
        style: story.brief.style,
        ...(total > 1 ? { part, total } : {}),
      }),
    },
  ];
}

/**
 * The merge asks a recognition's repeats make, in reading order.
 *
 * The room's own split budget decides how many names travel together, so a
 * merge is never a request larger than a reading the room would send anyway.
 * An empty list is a telling the parts did not repeat a name in, which is no
 * ask at all.
 */
export function planElementMergeWaves(
  story: StoryDocument,
  repeats: ElementRepeat[],
): Array<{ items: StoryJobItemDraft[] }> {
  if (repeats.length === 0) return [];
  const waves = chunkElementMerges(story, repeats, storySplitChars());
  return waves.map((groups, index) => ({
    items: planElementMerge(story, groups, index + 1, waves.length),
  }));
}

/** What one chapter's board is asked, before the ask is shaped into an item. */
function storyboardAsk(
  story: StoryDocument,
  chapterId: string,
): { target: StoryTarget; input: StoryStoryboardPromptInput } | undefined {
  const number = story.chapters.findIndex((held) => held.id === chapterId);
  const chapter = story.chapters[number];
  if (chapter === undefined) return undefined;
  const plans = chapterActPlan(chapter);
  return {
    target: { kind: "storyboard", chapterId },
    input: {
      ...factsOf(story),
      number: number + 1,
      chapter: {
        title: chapter.title,
        text: chapterWordsOf(chapter),
      },
      targetDurationMs: chapter.targetDurationMs,
      maxVideoSeconds: videoCeiling(),
      elements: story.elements.map((element) => ({
        kind: element.kind,
        name: element.name,
        description: element.description,
      })),
      shotSizes: STORY_SHOT_SIZES,
      cameraMoves: STORY_CAMERA_MOVES,
      angles: STORY_CAMERA_ANGLES,
      ...(plans === undefined ? {} : { planned: plans }),
    },
  };
}

/** The board of one or more episodes, one ask each. */
export function planStoryboard(
  story: StoryDocument,
  chapterIds: string[],
): StoryJobItemDraft[] {
  return chapterIds.flatMap((chapterId) => {
    const asked = storyboardAsk(story, chapterId);
    if (asked === undefined) return [];
    return [
      {
        id: jobKey(asked.target),
        target: asked.target,
        capability: "text",
        system: storySystemPrompt(),
        prompt: storyStoryboardPrompt(asked.input),
      },
    ];
  });
}

/**
 * The same board asked again, with the reasons the first answer could not be
 * kept. The place it is asked for does not change: the answer is still the
 * board of that chapter.
 */
export function planStoryboardRepair(
  story: StoryDocument,
  chapterId: string,
  previous: string,
  problems: string[],
): StoryJobItemDraft | undefined {
  const asked = storyboardAsk(story, chapterId);
  if (asked === undefined) return undefined;
  return {
    id: jobKey(asked.target),
    target: asked.target,
    capability: "text",
    system: storySystemPrompt(),
    prompt: storyStoryboardRepairPrompt({
      ...asked.input,
      previous,
      problems,
    }),
  };
}

/**
 * One chapter's acts planned before their shots are written, or one act of it
 * planned again after a split, a merge or a reader's own hand.
 */
export function planActPlan(
  story: StoryDocument,
  chapterId: string,
  actId?: string,
): StoryJobItemDraft | undefined {
  const number = story.chapters.findIndex((held) => held.id === chapterId);
  const chapter = story.chapters[number];
  if (chapter === undefined) return undefined;
  const regular = chapter.acts.filter((act) => act.transition === undefined);
  const single =
    actId === undefined ? undefined : regular.find((act) => act.id === actId);
  if (actId !== undefined && single === undefined) return undefined;
  const standing =
    single !== undefined
      ? [
          "Write the plan for this one act only:",
          `- ${single.id} — “${single.title}” — ${single.summary}`,
        ].join("\n")
      : regular.length === 0
        ? "The chapter has no acts yet: write them."
        : [
            "The chapter is already planned as the acts below. Keep each actId and the order; rewrite what the chapter needs.",
            ...regular.map(
              (act) =>
                `- ${act.id} — “${act.title}” — ${act.summary}${act.plan === undefined ? "" : ` — ${act.plan}`}`,
            ),
          ].join("\n");
  const target: StoryTarget = {
    kind: "actPlan",
    chapterId,
    ...(actId === undefined ? {} : { actId }),
  };
  return {
    id: jobKey(target),
    target,
    capability: "text",
    system: storySystemPrompt(),
    prompt: storyActPlanPrompt({
      ...factsOf(story),
      number: number + 1,
      chapter: {
        title: chapter.title,
        text: chapterWordsOf(chapter),
      },
      targetDurationMs: chapter.targetDurationMs,
      standing,
      elements: story.elements.map((element) => ({
        kind: element.kind,
        name: element.name,
        description: element.description,
      })),
    }),
  };
}

/**
 * The board's staging as it stands, in a form a check can be stamped with.
 *
 * A patch is written against the shots the check read: if a reader moves a
 * shot while the check is out, the answer is no longer about this board and is
 * not written. The cast and the place are part of it because a check reads the
 * board with them in mind.
 */
export function continuityFingerprint(chapter: StoryChapter): string {
  const rows: string[] = [];
  for (const act of chapter.acts) {
    if (act.transition !== undefined) continue;
    rows.push(
      `act:${act.id}:${act.title}:${act.sceneId ?? ""}:${act.characterIds.join(",")}:${act.propIds.join(",")}`,
    );
    for (const keyframe of act.keyframes) {
      rows.push(
        `shot:${keyframe.id}:${keyframe.shotSize}:${keyframe.cameraMove}:${keyframe.angle}:${keyframe.durationMs}:${keyframe.content}:${keyframe.motion}`,
      );
      for (const line of keyframe.dialogue) {
        rows.push(`line:${line.id}:${line.speaker}:${line.text}`);
      }
    }
  }
  return fnv1a(rows.join("\n"));
}

/** The board as a staging check reads it: ids to patch by, and what stands. */
function continuityBoard(story: StoryDocument, chapter: StoryChapter): string {
  return chapter.acts
    .filter((act) => act.transition === undefined)
    .map((act, at) => {
      const cast = act.characterIds
        .map((id) => elementOf(story, id)?.name)
        .filter((name): name is string => name !== undefined);
      const place = elementOf(story, act.sceneId ?? "")?.name;
      const shots = act.keyframes.map((keyframe, shotAt) =>
        [
          `  Shot ${shotAt + 1} — id: ${keyframe.id} — ${keyframe.shotSize}/${keyframe.cameraMove}/${keyframe.angle}, ${keyframe.durationMs} ms`,
          `    content: ${keyframe.content}`,
          ...(keyframe.motion === "" ? [] : [`    motion: ${keyframe.motion}`]),
          ...keyframe.dialogue.map(
            (line) => `    line (${line.speaker}): ${line.text}`,
          ),
        ].join("\n"),
      );
      return [
        `Act ${at + 1} — id: ${act.id} — “${act.title}”`,
        `  place: ${place ?? "—"}; cast: ${cast.join(", ") || "—"}`,
        ...shots,
      ].join("\n");
    })
    .join("\n\n");
}

/** One chapter's staging checked, as an ask that patches the board it holds. */
export function planContinuity(
  story: StoryDocument,
  chapterId: string,
): StoryJobItemDraft | undefined {
  const number = story.chapters.findIndex((held) => held.id === chapterId);
  const chapter = story.chapters[number];
  if (
    chapter === undefined ||
    chapter.acts.every(
      (act) => act.transition !== undefined || act.keyframes.length === 0,
    )
  ) {
    return undefined;
  }
  const target: StoryTarget = { kind: "continuity", chapterId };
  const stamp = `${chapterRevision(chapter)}:${continuityFingerprint(chapter)}`;
  return {
    id: `${jobKey(target)}:${stamp}`,
    target,
    capability: "text",
    system: storySystemPrompt(),
    prompt: storyContinuityPrompt({
      ...factsOf(story),
      number: number + 1,
      chapter: {
        title: chapter.title,
        text: chapterWordsOf(chapter),
      },
      board: continuityBoard(story, chapter),
      shotSizes: STORY_SHOT_SIZES,
      cameraMoves: STORY_CAMERA_MOVES,
      angles: STORY_CAMERA_ANGLES,
    }),
  };
}

/**
 * The revision of one chapter's board from an outline that has moved on.
 *
 * Both outlines travel, and the board as it stands named by the ids the answer
 * must use. The item is stamped with the revision it was planned at, so an
 * answer planned from v2 is never written onto a chapter that has moved on to
 * v3: the room asks again rather than patching words that have moved.
 */
export function planOutlineRevision(
  story: StoryDocument,
  chapterId: string,
): StoryJobItemDraft | undefined {
  const number = story.chapters.findIndex((held) => held.id === chapterId);
  const chapter = story.chapters[number];
  if (chapter === undefined || !chapterOutlineAhead(chapter)) return undefined;
  const before = chapter.boardOutline;
  if (before === undefined) return undefined;
  const revision = chapterRevision(chapter);
  const target: StoryTarget = { kind: "outlineRevision", chapterId };
  return {
    id: `${jobKey(target)}:${revision}`,
    target,
    capability: "text",
    system: storySystemPrompt(),
    prompt: storyRevisionPrompt({
      ...factsOf(story),
      number: number + 1,
      before: { title: before.title, text: before.synopsis },
      after: { title: chapter.title, text: chapter.synopsis },
      targetDurationMs: chapter.targetDurationMs,
      elements: story.elements.map((element) => ({
        kind: element.kind,
        name: element.name,
        description: element.description,
      })),
      acts: revisionActs(story, chapter),
      shotSizes: STORY_SHOT_SIZES,
      cameraMoves: STORY_CAMERA_MOVES,
      angles: STORY_CAMERA_ANGLES,
    }),
  };
}

/** The acts and shots a revision may touch, as the ask reads them. */
function revisionActs(
  story: StoryDocument,
  chapter: StoryChapter,
): StoryRevisionAct[] {
  return chapter.acts
    .filter((act) => act.transition === undefined)
    .map((act) => ({
      id: act.id,
      title: act.title,
      summary: act.summary,
      frames: act.keyframes.map((keyframe) =>
        revisionFrame(story, chapter.id, act.id, keyframe),
      ),
    }));
}

/** One shot of the board, with what has already been made from it. */
function revisionFrame(
  story: StoryDocument,
  chapterId: string,
  actId: string,
  keyframe: StoryKeyframe,
): StoryRevisionFrame {
  const made: string[] = [];
  if (currentTake(keyframe.art) !== undefined) made.push("frame drawn");
  if (currentTake(keyframe.video) !== undefined) made.push("shot filmed");
  if (
    (keyframe.voices ?? []).some(
      (voice) => currentTake(voice.slot) !== undefined,
    )
  ) {
    made.push("line read aloud");
  }
  const shotId = jobKey({
    kind: "keyframeVideo",
    chapterId,
    actId,
    keyframeId: keyframe.id,
  });
  if (videoPromptOverride(story, shotId) !== undefined) {
    made.push("hand-written video prompt");
  }
  return {
    id: keyframe.id,
    title: keyframe.title,
    shotSize: keyframe.shotSize,
    cameraMove: keyframe.cameraMove,
    angle: keyframe.angle,
    durationMs: keyframe.durationMs,
    content: keyframe.content,
    ...(keyframe.motion === undefined || keyframe.motion.trim() === ""
      ? {}
      : { motion: keyframe.motion }),
    dialogue: keyframe.dialogue.map((line) => ({
      id: line.id,
      speaker: line.speaker,
      text: line.text,
      ...(line.tone === undefined ? {} : { tone: line.tone }),
    })),
    made: made.length === 0 ? "nothing yet" : made.join(", "),
  };
}

// -----------------------------------------------------------------------------
// Step three and four: the drawings
// -----------------------------------------------------------------------------

/**
 * A character, a place or a thing, drawn on its own.
 *
 * A character's turn-around is drawn from the picture already on file, so it is
 * not planned at all while that picture is missing: four views of a face nobody
 * has drawn is four different people.
 */
export function planElementArt(
  story: StoryDocument,
  targets: Array<{
    elementId: string;
    view: "main" | "turnaround";
    variantId?: string;
    /** How many drawings the ask is for; absent is one. */
    count?: number;
  }>,
): StoryJobItemDraft[] {
  const look = lookOf(story);
  return targets.flatMap(({ elementId, view, variantId, count }) => {
    const element = elementOf(story, elementId);
    if (element === undefined) return [];
    const form = elementForm(element, variantId);
    if (variantId !== undefined && form === undefined) return [];
    const main = currentTake(form === undefined ? element.main : form.main);
    if (view === "turnaround" && main === undefined) return [];
    const target: StoryTarget = {
      kind: "elementArt",
      elementId,
      view,
      ...(variantId === undefined ? {} : { variantId }),
    };
    // A turn-around uses a landscape sheet: close-up on the left, three
    // full-body views on the right; every other picture keeps its kind's frame.
    const size = imageSizeForAspect(
      view === "turnaround" ? "16:9" : formAspect(story, element, form),
    );
    // A drawing may be made from another element's picture or one on the
    // shelf; a form made from its element starts out pointing at the default
    // form, which is what keeps the two the same person.
    const reference = pictureReferenceAsset(
      story,
      form?.reference ?? element.reference,
    );
    const id = jobKey(target);
    return withCopies(
      {
        id,
        target,
        capability: "image",
        prompt:
          imagePromptOverride(story, id)?.prompt ??
          (view === "turnaround"
            ? storyElementTurnaroundPrompt({
                ...look,
                name: formName(element, form),
                description: formDescription(element, form),
              })
            : storyElementMainPrompt({
                ...look,
                kind: element.kind,
                name: formName(element, form),
                description: formDescription(element, form),
                hasReference: reference !== undefined,
              })),
        // A main picture is drawn from its description, and from the
        // reference its card names where one is named. A turn-around is drawn
        // from the picture of that same form, which is the drawing it shows
        // four views of.
        inputs:
          view === "turnaround"
            ? main === undefined
              ? []
              : [{ role: "reference", assetId: main.assetIds[0] }]
            : reference === undefined
              ? []
              : [{ role: "reference", assetId: reference }],
        // The four views are filed under the character's own name and a fixed
        // suffix in the reader's language, not a generic label with a batch's
        // random tag.
        ...(view === "turnaround"
          ? {
              name: `${formName(element, form)} ${i18n.t("story:import.turnaround")}`,
            }
          : {}),
        params: { size },
      },
      count,
    );
  });
}

/** One element's pictures, as the asks their own models make of them. */
export interface ElementArtWave {
  /** The picture model this wave is asked of; null is the deployment's. */
  model: string | null;
  items: StoryJobItemDraft[];
}

/** The model an element or one of its forms names of its own, if any. */
function ownElementArtModel(
  element: StoryElement,
  variantId?: string,
): string | null {
  const form = elementForm(element, variantId);
  const own = (form?.imageModel ?? element.imageModel ?? "").trim();
  return own === "" ? null : own;
}

/**
 * The picture model an element's form is drawn by: the one the form or the
 * reader named for it, and otherwise the one the step's list leads with.
 */
export function elementArtModel(
  element: StoryElement,
  variantId?: string,
): string | null {
  return (
    ownElementArtModel(element, variantId) ?? storyAskModelHead("elementArt")
  );
}

/**
 * An element's drawings, gathered by the model each takes its turn with.
 *
 * A card that names a model of its own is drawn by it; every other drawing
 * takes the next model of the step's list, one turn per drawing, and the
 * drawings that land on one model travel as one ask. Each ask is cut to what a
 * batch may carry, as a whole cast's drawings are.
 */
export function planElementArtWaves(
  story: StoryDocument,
  targets: Array<{
    elementId: string;
    view: "main" | "turnaround";
    variantId?: string;
    count?: number;
  }>,
): ElementArtWave[] {
  const groups = new Map<
    string,
    { model: string | null; items: StoryJobItemDraft[] }
  >();
  const seen = new Set<string>();
  for (const item of planElementArt(story, targets)) {
    if (item.target.kind !== "elementArt" || seen.has(item.id)) continue;
    seen.add(item.id);
    const element = elementOf(story, item.target.elementId);
    if (element === undefined) continue;
    const model =
      ownElementArtModel(element, item.target.variantId) ??
      storyAskModel("elementArt");
    const key = model ?? "";
    const group = groups.get(key) ?? { model, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(({ model, items }) =>
    chunkKeepingSets(items, MAX_ITEMS_PER_STORY_JOB).map((wave) => ({
      model,
      items: wave,
    })),
  );
}

/** One of a frame's carried pictures: what the ask calls it, and the file. */
export interface StoryReference {
  /** The element this picture is of, where it stands for one. */
  element?: StoryElement;
  /** The form of that element the picture is of, where one was chosen. */
  variant?: StoryElementVariant;
  /** How the ask names it: the reference's own name. */
  name: string;
  description: string;
  assetId: string;
}

/**
 * The act's cast as the references a shot falls back on.
 *
 * A shot whose words name no picture of their own is drawn with what the act
 * says stands in it — its characters, its place and its things, in the order
 * the act's own row keeps them. The reference names are left empty so each
 * picture is known by the form it draws, exactly as an unnamed element is.
 */
export function actDefaultReferences(act: StoryAct): StoryKeyframeReference[] {
  return [
    ...act.characterIds,
    ...(act.sceneId === undefined ? [] : [act.sceneId]),
    ...act.propIds,
  ].map((elementId) => ({ elementId, name: "" }));
}

/** Whether a shot is framed so close that its frame may stand without a place. */
export function isCloseShot(shotSize: string): boolean {
  return shotSize === "close" || shotSize === "extremeClose";
}

/**
 * The pictures a shot must carry besides what its words name: its act's place,
 * unless the shot is a close-up, and everyone who speaks in it.
 *
 * A frame without its place loses the film's world around the people in it,
 * and a speaker whose picture is not in the frame is a line given to the wrong
 * face. Both are facts of the board rather than of the shot's prose, so they
 * are kept whether or not the words happen to name them.
 */
export function requiredKeyframeElements(
  act: StoryAct,
  keyframe: Pick<StoryKeyframe, "shotSize" | "dialogue">,
): string[] {
  const ids: string[] = [];
  if (act.sceneId !== undefined && !isCloseShot(keyframe.shotSize)) {
    ids.push(act.sceneId);
  }
  for (const line of keyframe.dialogue) {
    if (line.characterId !== undefined) ids.push(line.characterId);
  }
  return [...new Set(ids)];
}

/** The required pictures that stand on the shot's own reference list. */
export function requiredCastReferences(
  act: StoryAct,
  keyframe: Pick<StoryKeyframe, "shotSize" | "dialogue">,
  allowed: StoryKeyframeReference[],
): StoryKeyframeReference[] {
  const held = new Set(
    allowed.flatMap((reference) =>
      reference.elementId === undefined ? [] : [reference.elementId],
    ),
  );
  return requiredKeyframeElements(act, keyframe)
    .filter((elementId) => held.has(elementId))
    .map((elementId) => ({ elementId, name: "" }));
}

/**
 * A board's shot with the place and speakers it must carry kept among its
 * references. It is how a board is written; from then on the list is the
 * shot's own, and a reader who takes one out is not overruled by planning.
 */
export function withRequiredReferences(
  act: StoryAct,
  keyframe: StoryKeyframe,
): StoryKeyframe {
  const required = requiredKeyframeElements(act, keyframe);
  if (required.length === 0) return keyframe;
  const base =
    keyframe.references ??
    (storyMentions(keyframe.content).length === 0
      ? actDefaultReferences(act)
      : []);
  const held = new Set(
    base.flatMap((reference) =>
      reference.elementId === undefined ? [] : [reference.elementId],
    ),
  );
  const missing = required.filter((elementId) => !held.has(elementId));
  if (missing.length === 0) return keyframe;
  return {
    ...keyframe,
    references: [
      ...base,
      ...missing.map((elementId) => ({ elementId, name: "" })),
    ],
  };
}

/**
 * The cast a frame travels with, as the frame's own words name it.
 *
 * The pictures are chosen by the mentions in a shot's content: each mentioned
 * name that is one of the shot's references is a reference here, in the order
 * it is first named, and a name the shot cannot draw is left to the words. A
 * picture the shot keeps but its words never name is not sent when the words
 * name other pictures: what is named decides, except for the pictures the act
 * and the spoken lines require, which travel behind the named ones. The order
 * is the contract between the numbered references in the prompt and the
 * pictures that travel with it, so it is decided once, here.
 *
 * A shot whose words name nothing is drawn from a list instead: the shot's own
 * references where it keeps any, and the act's cast where it has never kept a
 * list — the act's row is the default, and words that name pictures are how a
 * shot says otherwise. An emptied list is not the same thing: the reader has
 * taken every reference out of the shot, and nothing stands in for them.
 *
 * The story's own limit decides how many of them fit: an image service refuses
 * a request over its bound whole rather than drawing with the first of the
 * pictures, so the first of the named ones travel and the rest are left to the
 * words.
 */
export function keyframeCast(
  story: StoryDocument,
  content: string,
  references?: StoryKeyframeReference[],
  variantChoices: Record<string, string> = {},
  fallback: StoryKeyframeReference[] = [],
  required: StoryKeyframeReference[] = [],
): {
  /** The pictures that travel, in the order the content names them. */
  carried: StoryReference[];
  /** The mentioned pictures the story's limit leaves behind. */
  beyond: StoryReference[];
  /** The mentioned names no drawing could be sent for. */
  undrawn: string[];
} {
  const mentions = storyMentions(content);
  const seen = new Set<string>();
  const drawn: StoryReference[] = [];
  const undrawn: string[] = [];
  if (mentions.length === 0) {
    const whole = references === undefined ? fallback : references;
    for (const reference of whole) {
      const carried = carriedReference(story, reference, variantChoices);
      if (carried !== undefined) {
        drawn.push(carried);
        continue;
      }
      const name = referenceName(story, reference);
      if (name !== "" && !undrawn.includes(name)) undrawn.push(name);
    }
  } else {
    // The shot's own reference list, by the name its words use for each. Two
    // references of one name are one picture as far as the words are concerned.
    const heldByName = new Map<string, StoryKeyframeReference>();
    for (const reference of references ?? []) {
      const name = referenceName(story, reference);
      if (name === "" || heldByName.has(name)) continue;
      heldByName.set(name, reference);
    }
    for (const mention of mentions) {
      if (seen.has(mention.name)) continue;
      seen.add(mention.name);
      const held = heldByName.get(mention.name);
      if (held !== undefined) {
        const reference = carriedReference(story, held, variantChoices);
        if (reference === undefined) undrawn.push(mention.name);
        else drawn.push(reference);
        continue;
      }
      // A name the list does not hold but the story can still draw is carried
      // too, so a word typed ahead of the list is not silently dropped.
      const reference = carriedElement(story, mention.name, variantChoices);
      if (reference === undefined) undrawn.push(mention.name);
      else drawn.push(reference);
    }
  }
  // The pictures the act and the lines require travel whatever the words name:
  // a frame without its place, or with a speaker missing from it, is a frame
  // that cannot hold the shot together. They stand after the named pictures and
  // share the story's own limit with them.
  for (const reference of required) {
    const carried = carriedReference(story, reference, variantChoices);
    if (carried !== undefined) {
      drawn.push(carried);
      continue;
    }
    const name = referenceName(story, reference);
    if (name !== "" && !undrawn.includes(name)) undrawn.push(name);
  }
  const seenAssets = new Set<string>();
  const all = drawn.filter((reference) => {
    if (seenAssets.has(reference.assetId)) return false;
    seenAssets.add(reference.assetId);
    return true;
  });
  // The place is the base a frame is composed on, so it leads the pictures
  // that travel; people follow it, and things come last. A close-up kept
  // without its place is not overruled here: the picture list decides what
  // travels, and this only fixes the order the list is read in.
  const rank = (reference: StoryReference): number => {
    const kind = reference.element?.kind;
    if (kind === "scene") return 0;
    if (kind === "character") return 1;
    if (kind === "prop") return 2;
    return 3;
  };
  const ordered = all
    .map((reference, index) => ({ reference, index }))
    .sort((a, b) => rank(a.reference) - rank(b.reference) || a.index - b.index)
    .map(({ reference }) => reference);
  const limit = story.maxReferenceImages;
  return {
    carried: ordered.slice(0, limit),
    beyond: ordered.slice(limit),
    undrawn,
  };
}

/**
 * A frame's cast as every ask and every view of it reads: the pictures its
 * words name, the pictures its act and its lines require, and the story's limit
 * over both.
 */
export function keyframeCastFor(
  story: StoryDocument,
  act: StoryAct,
  keyframe: StoryKeyframe,
  content: string = keyframe.content,
): ReturnType<typeof keyframeCast> {
  const fallback = actDefaultReferences(act);
  const allowed =
    keyframe.references ??
    (storyMentions(content).length === 0 ? fallback : []);
  return keyframeCast(
    story,
    content,
    keyframe.references,
    keyframe.variantChoices ?? {},
    fallback,
    requiredCastReferences(act, keyframe, allowed),
  );
}

/** A cast member by the name the words use, as the shot draws them. */
function carriedElement(
  story: StoryDocument,
  name: string,
  variantChoices: Record<string, string>,
): StoryReference | undefined {
  const element = story.elements.find((held) => held.name === name);
  if (element === undefined) return undefined;
  const variant = elementForm(element, variantChoices[element.id]);
  const take = referenceTake(element, variant);
  if (take === undefined) return undefined;
  return {
    element,
    ...(variant === undefined ? {} : { variant }),
    name: element.name,
    description:
      variant === undefined ? element.description : variant.description,
    assetId: take.assetIds[0],
  };
}

/** A frame's pictures as the ask carries them: its cast, its place leading. */
export function keyframeArtCast(
  story: StoryDocument,
  act: StoryAct,
  keyframe: StoryKeyframe,
  content: string = keyframe.content,
): { cast: StoryReference[]; place: boolean } {
  const carried = keyframeCastFor(story, act, keyframe, content).carried;
  // The place the shot's own list names is the base; the act's place stands in
  // only when the shot left it out (a close-up keeps the room's light and
  // walls behind the face). A frame with no pictures at all stays
  // reference-free — a title card or an insert is drawn from its words alone.
  const listed = carried.find((held) => held.element?.kind === "scene");
  if (listed !== undefined)
    return { cast: carried, place: carried[0] === listed };
  const placeElement =
    carried.length === 0 || act.sceneId === undefined
      ? undefined
      : elementOf(story, act.sceneId);
  const place =
    placeElement === undefined
      ? undefined
      : carriedElement(story, placeElement.name, keyframe.variantChoices ?? {});
  if (place === undefined) return { cast: carried, place: false };
  const cast = [
    place,
    ...carried.filter((held) => held.assetId !== place.assetId),
  ].slice(0, story.maxReferenceImages);
  return { cast, place: cast[0] === place };
}

/** One picture of the shot's list, as its words name it. */
function carriedReference(
  story: StoryDocument,
  reference: StoryKeyframeReference,
  variantChoices: Record<string, string>,
): StoryReference | undefined {
  if (reference.elementId !== undefined) {
    const element = elementOf(story, reference.elementId);
    if (element === undefined) return undefined;
    // The form the reference names, or the shot's own choice for the element;
    // a form that has left the story is the default one, while a form nobody
    // could draw leaves the reference without a picture.
    const chosen = reference.variantId ?? variantChoices[element.id];
    const variant = elementForm(element, chosen);
    if (reference.variantId !== undefined && variant === undefined)
      return undefined;
    const take = referenceTake(element, variant);
    if (take === undefined) return undefined;
    return {
      element,
      ...(variant === undefined ? {} : { variant }),
      name: referenceName(story, reference) || element.name,
      description:
        variant === undefined ? element.description : variant.description,
      assetId: take.assetIds[0],
    };
  }
  if (reference.assetId === undefined) return undefined;
  return {
    name: referenceName(story, reference) || "Reference",
    description: "A picture this shot is drawn with.",
    assetId: reference.assetId,
  };
}

/** One frame of a board, drawn with the cast that stands in it. */
export function planKeyframeArt(
  story: StoryDocument,
  targets: Array<{
    chapterId: string;
    actId: string;
    keyframeId: string;
    /** How many drawings the ask is for; absent is one. */
    count?: number;
  }>,
): StoryJobItemDraft[] {
  const look = lookOf(story);
  const size = imageSizeForAspect(story.brief.aspect);
  return targets.flatMap(({ chapterId, actId, keyframeId, count }) => {
    const chapter = story.chapters.find((held) => held.id === chapterId);
    const act = actAt(story, chapterId, actId);
    const keyframe =
      act === undefined
        ? undefined
        : act.keyframes.find((held) => held.id === keyframeId);
    if (chapter === undefined || act === undefined || keyframe === undefined)
      return [];
    const { cast, place: hasPlace } = keyframeArtCast(story, act, keyframe);
    const target: StoryTarget = {
      kind: "keyframeArt",
      chapterId,
      actId,
      keyframeId,
    };
    const id = jobKey(target);
    return withCopies(
      {
        id,
        target,
        capability: "image",
        prompt:
          imagePromptOverride(story, id)?.prompt ??
          storyKeyframePrompt({
            ...look,
            chapter: { title: chapter.title },
            act: { summary: act.summary },
            keyframe: {
              content: keyframe.content,
              shotSize: keyframe.shotSize,
              angle: keyframe.angle,
            },
            cast: cast.map(({ name, description }) => ({
              name,
              description,
            })),
            place: hasPlace,
          }),
        inputs: cast.map(({ assetId }) => ({
          role: "reference" as const,
          assetId,
        })),
        params: { size },
      },
      count,
    );
  });
}

/** The model a frame names of its own, if any. */
function ownKeyframeArtModel(
  story: StoryDocument,
  target: { chapterId: string; actId: string; keyframeId: string },
): string | null {
  const own = (keyframeAt(story, target)?.imageModel ?? "").trim();
  return own === "" ? null : own;
}

/**
 * The picture model a frame is drawn by: the one the reader named for it, and
 * otherwise the one the step's list leads with.
 */
export function keyframeArtModel(
  story: StoryDocument,
  target: { chapterId: string; actId: string; keyframeId: string },
): string | null {
  return ownKeyframeArtModel(story, target) ?? storyAskModelHead("keyframeArt");
}

/**
 * A board's frames, gathered by the model each takes its turn with.
 *
 * A row that names a model of its own is drawn by it; every other frame takes
 * the next model of the step's list, one turn per frame, and the frames that
 * land on one model travel as one ask. Each ask is cut to what a batch may
 * carry, as a whole board is.
 */
export function planKeyframeArtWaves(
  story: StoryDocument,
  targets: Array<{
    chapterId: string;
    actId: string;
    keyframeId: string;
    count?: number;
  }>,
): Array<{ model: string | null; items: StoryJobItemDraft[] }> {
  const groups = new Map<
    string,
    { model: string | null; items: StoryJobItemDraft[] }
  >();
  const seen = new Set<string>();
  for (const item of planKeyframeArt(story, targets)) {
    if (item.target.kind !== "keyframeArt" || seen.has(item.id)) continue;
    seen.add(item.id);
    const model =
      ownKeyframeArtModel(story, item.target) ?? storyAskModel("keyframeArt");
    const key = model ?? "";
    const group = groups.get(key) ?? { model, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(({ model, items }) =>
    chunkKeepingSets(items, MAX_ITEMS_PER_STORY_JOB).map((wave) => ({
      model,
      items: wave,
    })),
  );
}

// -----------------------------------------------------------------------------
// Step four: the clips
// -----------------------------------------------------------------------------

/**
 * One act filmed whole, as the pieces its roles and its length make of it.
 *
 * The drawings its shots were given travel the way each piece uses them: the
 * ends a video moves between, or the references the shots are drawn from —
 * stated per piece so that no provider has to guess, and so a pair is not
 * refused for arriving beside the references of another piece. What comes
 * back plays as the act the board wrote. One piece is the act itself, and is
 * asked for under the name it has always had.
 */
export function planActVideos(
  story: StoryDocument,
  chapterId: string,
  actIds: string[],
): StoryJobItemDraft[] {
  const look = lookOf(story);
  return actIds.flatMap((actId): StoryJobItemDraft[] => {
    const chapter = story.chapters.find((held) => held.id === chapterId);
    const act = actAt(story, chapterId, actId);
    if (chapter === undefined || act === undefined) return [];
    // The models this act may be filmed by decide how long one of its pieces
    // may run: a piece may land on any of them, so the shortest window in
    // force is the ceiling.
    const ceiling = actVideoCeiling(act);
    const target: StoryTarget = { kind: "actVideo", chapterId, actId };
    const base = jobKey(target);
    // A bridge is filmed between its neighbours' own clips: the last frame of
    // the act before and the first frame of the act after, taken out of those
    // clips at the moment the request is sent. It has no pictures of its own,
    // and a neighbour that has not been filmed yet leaves the move unasked.
    if (act.transition !== undefined) {
      const at = chapter.acts.indexOf(act);
      const videos = neighbourVideos(story, chapter, at);
      if (videos.from === undefined || videos.to === undefined) return [];
      const seconds = clampSeconds(act.transition.durationMs, ceiling);
      return [
        {
          id: base,
          target,
          capability: "video" as const,
          prompt:
            videoPromptOverride(story, base)?.prompt ??
            storyTransitionVideoPrompt({
              ...look,
              from: stripStoryMentions(videos.from.content),
              to: stripStoryMentions(videos.to.content),
              move: act.transition.prompt,
              seconds,
            }),
          inputs: [
            {
              role: "firstFrame" as const,
              assetId: videos.from.assetId,
              frame: "last" as const,
            },
            {
              role: "lastFrame" as const,
              assetId: videos.to.assetId,
              frame: "first" as const,
            },
          ],
          promptContext: {
            kind: "transition" as const,
            ...look,
            seconds,
            ends: { first: true, last: true, references: false },
            shots: [],
            transition: {
              from: stripStoryMentions(videos.from.content),
              to: stripStoryMentions(videos.to.content),
              move: act.transition.prompt,
            },
            cast: castFor(story, act.characterIds, []),
            dialogue: [],
            ...(soundFor(act.sound) === undefined
              ? {}
              : { sound: soundFor(act.sound) }),
          },
          params: videoParams(story.brief.aspect, seconds, "auto"),
        },
      ];
    }
    if (act.keyframes.length === 0) return [];
    const pieces = actClipPieces(act, ceiling);
    if (pieces.length === 0) return [];
    const several = pieces.length > 1;
    // A clip that continues an earlier act opens on that act's own last frame,
    // taken out of its finished clip rather than from a picture drawn for this
    // one. A piece made from references or words has no single first frame to
    // give, and is left to begin on its own.
    const previous =
      act.continueFromPrevious === true
        ? neighbourVideos(story, chapter, chapter.acts.indexOf(act)).from
        : undefined;
    const voiceAbility = actVideoVoiceReference(act);
    return pieces.map((piece, at) => {
      const held = piece.keyframes.flatMap((keyframe) => {
        const take = currentTake(keyframe.art);
        return take === undefined
          ? []
          : [
              {
                title: keyframe.title,
                content: stripStoryMentions(keyframe.content),
                assetId: take.assetIds[0],
              },
            ];
      });
      const first = held[0];
      const last = held[held.length - 1];
      const references = piece.kind === "reference";
      const words = piece.kind === "words";
      const continues =
        at === 0 &&
        previous !== undefined &&
        (piece.kind === "frame" || piece.kind === "pair");
      const inputs: StoryJobInput[] = references
        ? held.map((frame) => ({
            role: "reference" as const,
            assetId: frame.assetId,
          }))
        : first === undefined
          ? []
          : [
              continues
                ? {
                    role: "firstFrame" as const,
                    assetId: previous.assetId,
                    frame: "last" as const,
                  }
                : { role: "firstFrame", assetId: first.assetId },
              ...(piece.kind === "pair" && last !== undefined
                ? [{ role: "lastFrame" as const, assetId: last.assetId }]
                : []),
            ];
      const id = several ? `${base}:${at + 1}` : base;
      const starts = shotStarts(piece.keyframes, piece.seconds);
      const lines = piece.keyframes.flatMap((keyframe) => keyframe.dialogue);
      const refs = characterRefs(story);
      const sound = soundFor(act.sound);
      // The speakers' own recordings ride when the model that films this
      // piece reads one and the piece is short enough for it to hear them.
      const voices: VoiceReference[] = voiceReferenceFits(
        voiceAbility,
        piece.seconds,
      )
        ? voiceReferencesFor(story, lines)
        : [];
      for (const voice of voices) {
        inputs.push({ role: "referenceAudio", assetId: voice.assetId });
      }
      let prompt =
        videoPromptOverride(story, id)?.prompt ??
        storyActVideoPrompt({
          ...look,
          title: act.title,
          summary: act.summary,
          shots: piece.keyframes.map((keyframe, shot) => ({
            at: starts[shot],
            content: stripStoryMentions(keyframe.content),
            ...(keyframe.motion === undefined || keyframe.motion.trim() === ""
              ? {}
              : { motion: stripStoryMentions(keyframe.motion) }),
            move: keyframe.cameraMove,
            dialogue: keyframe.dialogue,
          })),
          mode: references ? "references" : words ? "words" : "frames",
          seconds: piece.seconds,
          ...(several ? { part: at + 1, total: pieces.length } : {}),
          ...(continues ? { continues: true } : {}),
          ...(voices.length === 0
            ? {}
            : { speakerIds: voiceSpeakerIds(story) }),
        });
      if (voices.length > 0) prompt = withVoiceReferences(prompt, voices);
      return {
        id,
        target,
        capability: "video" as const,
        prompt,
        inputs,
        promptContext: {
          kind: "act" as const,
          ...look,
          seconds: piece.seconds,
          ends: {
            first: !references && first !== undefined,
            last: piece.kind === "pair",
            references,
            ...(references ? { referenceCount: held.length } : {}),
          },
          shots: shotsFor(piece.keyframes, piece.seconds),
          ...(references
            ? {
                referencePictures: held.map((frame, at) => ({
                  position: at + 1,
                  name: frame.title,
                  description: frame.content,
                })),
              }
            : {}),
          cast: castFor(story, act.characterIds, lines),
          dialogue: piece.keyframes.flatMap((keyframe, shot) =>
            linesFor(story, refs, keyframe.dialogue).map((line) => ({
              ...line,
              shot: shot + 1,
            })),
          ),
          ...(voices.length === 0
            ? {}
            : {
                voices: voices.map(({ speaker, name }) => ({
                  speaker,
                  name,
                })),
              }),
          ...(sound === undefined ? {} : { sound }),
          ...(several ? { part: at + 1, total: pieces.length } : {}),
          ...(continues ? { continues: true } : {}),
        },
        params: videoParams(
          story.brief.aspect,
          piece.seconds,
          references ? "reference" : "auto",
        ),
      };
    });
  });
}

/** One shot filmed, starting from its own drawing and ending on the next. */
export function planKeyframeVideos(
  story: StoryDocument,
  chapterId: string,
  actId: string,
  keyframeIds: string[],
): StoryJobItemDraft[] {
  const look = lookOf(story);
  const act = actAt(story, chapterId, actId);
  if (act === undefined) return [];
  const ceiling = actVideoCeiling(act);
  const voiceAbility = actVideoVoiceReference(act);
  return keyframeIds.flatMap((keyframeId) => {
    const keyframe = keyframeAt(story, { chapterId, actId, keyframeId });
    if (keyframe === undefined) return [];
    const frame = currentTake(keyframe.art);
    if (frame === undefined) return [];
    const position = act.keyframes.indexOf(keyframe);
    const after = act.keyframes[position + 1] ?? keyframe;
    const lastFrame = takeFile(currentTake(after.art));
    // A shot is one frame to the next and cannot be cut anywhere in between,
    // so a shot longer than the model films is made as long as it can be, and
    // the row says so.
    const seconds = clampSeconds(keyframe.durationMs, ceiling);
    const target: StoryTarget = {
      kind: "keyframeVideo",
      chapterId,
      actId,
      keyframeId,
    };
    const inputs: StoryJobInput[] = [
      { role: "firstFrame", assetId: frame.assetIds[0] },
    ];
    if (lastFrame !== undefined && lastFrame !== frame.assetIds[0]) {
      inputs.push({ role: "lastFrame", assetId: lastFrame });
    }
    const id = jobKey(target);
    const sound = soundFor(act.sound);
    const voices: VoiceReference[] = voiceReferenceFits(voiceAbility, seconds)
      ? voiceReferencesFor(story, keyframe.dialogue)
      : [];
    for (const voice of voices) {
      inputs.push({ role: "referenceAudio", assetId: voice.assetId });
    }
    let prompt =
      videoPromptOverride(story, id)?.prompt ??
      storyKeyframeVideoPrompt({
        ...look,
        title: keyframe.title,
        content: stripStoryMentions(keyframe.content),
        ...(keyframe.motion === undefined || keyframe.motion.trim() === ""
          ? {}
          : { motion: stripStoryMentions(keyframe.motion) }),
        move: keyframe.cameraMove,
        seconds,
        dialogue: keyframe.dialogue,
        ...(voices.length === 0 ? {} : { speakerIds: voiceSpeakerIds(story) }),
      });
    if (voices.length > 0) prompt = withVoiceReferences(prompt, voices);
    return [
      {
        id,
        target,
        capability: "video",
        prompt,
        inputs,
        promptContext: {
          kind: "shot" as const,
          ...look,
          seconds,
          ends: {
            first: true,
            last: inputs.some((input) => input.role === "lastFrame"),
            references: false,
          },
          shots: shotsFor([keyframe]),
          cast: castFor(story, act.characterIds, keyframe.dialogue),
          dialogue: linesFor(story, characterRefs(story), keyframe.dialogue),
          ...(voices.length === 0
            ? {}
            : {
                voices: voices.map(({ speaker, name }) => ({
                  speaker,
                  name,
                })),
              }),
          ...(sound === undefined ? {} : { sound }),
        },
        params: videoParams(story.brief.aspect, seconds),
      },
    ];
  });
}

/**
 * Acts filmed whole, gathered by the model each piece takes its turn with.
 *
 * An act that names a model of its own is filmed by it; every other piece
 * takes the next model of the step's list, one turn per piece, so an act cut
 * into several pieces is spread over the list. The pieces that land on one
 * model travel as one ask, as a batch carries one model.
 */
export function planActVideoWaves(
  story: StoryDocument,
  chapterId: string,
  actIds: string[],
): Array<{ model: string | null; items: StoryJobItemDraft[] }> {
  const groups = new Map<
    string,
    { model: string | null; items: StoryJobItemDraft[] }
  >();
  const seen = new Set<string>();
  for (const item of planActVideos(story, chapterId, actIds)) {
    if (item.target.kind !== "actVideo" || seen.has(item.id)) continue;
    seen.add(item.id);
    const act = actAt(story, item.target.chapterId, item.target.actId);
    if (act === undefined) continue;
    const own = (act.videoModel ?? "").trim();
    const chosen = own === "" ? storyAskModel("actVideo") : own;
    // A piece carrying the speakers' recordings goes to a model that reads
    // them, even where the step's list has another model next in line.
    const model = carriesVoiceReferences(item)
      ? audioCapableVideoModel(act, chosen, Number(item.params?.seconds ?? 0))
      : chosen;
    const key = model ?? "";
    const group = groups.get(key) ?? { model, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(({ model, items }) =>
    // An act's pieces are one clip: a batch that cut them in two would film a
    // shorter act than the board wrote, so the cuts keep every act whole.
    chunkKeepingSets(items, MAX_ITEMS_PER_STORY_JOB).map((wave) => ({
      model,
      items: wave,
    })),
  );
}

/** The same, for one act's shots filmed one at a time. */
export function planKeyframeVideoWaves(
  story: StoryDocument,
  chapterId: string,
  actId: string,
  keyframeIds: string[],
): Array<{ model: string | null; items: StoryJobItemDraft[] }> {
  const act = actAt(story, chapterId, actId);
  if (act === undefined) return [];
  const own = (act.videoModel ?? "").trim();
  const groups = new Map<string, StoryJobItemDraft[]>();
  for (const item of planKeyframeVideos(story, chapterId, actId, keyframeIds)) {
    const chosen = own === "" ? storyAskModel("actVideo") : own;
    const model = carriesVoiceReferences(item)
      ? audioCapableVideoModel(act, chosen, Number(item.params?.seconds ?? 0))
      : chosen;
    const key = model ?? "";
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups].flatMap(([model, items]) =>
    chunkWaves(items, MAX_ITEMS_PER_STORY_JOB).map((wave) => ({
      model: model === "" ? null : model,
      items: wave,
    })),
  );
}

/** One ask of a bulk film press: the kind of clip it makes, and its pieces. */
export interface VideoAskWave {
  kind: "actVideo" | "keyframeVideo";
  model: string | null;
  items: StoryJobItemDraft[];
}

/**
 * A bulk press's clips, gathered by the kind of ask and the model each takes
 * its turn with.
 *
 * A whole act and a shot filmed on its own are two kinds of ask, and a batch
 * carries one kind and one model; the pieces that land on one of each travel
 * together. The plan is made once for the press, and every take is asked from
 * it again — what differs between takes is the words, not the places.
 */
export function planMissingVideoWaves(
  story: StoryDocument,
  targets: StoryMissingClip[],
): VideoAskWave[] {
  const byChapter = new Map<
    string,
    { acts: string[]; shots: Map<string, string[]> }
  >();
  for (const target of targets) {
    const held = byChapter.get(target.chapterId) ?? {
      acts: [],
      shots: new Map<string, string[]>(),
    };
    if (target.keyframeId === undefined) {
      if (!held.acts.includes(target.actId)) held.acts.push(target.actId);
    } else {
      const shots = held.shots.get(target.actId) ?? [];
      if (!shots.includes(target.keyframeId)) shots.push(target.keyframeId);
      held.shots.set(target.actId, shots);
    }
    byChapter.set(target.chapterId, held);
  }
  const waves: VideoAskWave[] = [];
  for (const [chapterId, held] of byChapter) {
    for (const wave of planActVideoWaves(story, chapterId, held.acts)) {
      waves.push({ kind: "actVideo", ...wave });
    }
    for (const [actId, keyframeIds] of held.shots) {
      for (const wave of planKeyframeVideoWaves(
        story,
        chapterId,
        actId,
        keyframeIds,
      )) {
        waves.push({ kind: "keyframeVideo", ...wave });
      }
    }
  }
  return waves;
}

// -----------------------------------------------------------------------------
// The sound of an act
// -----------------------------------------------------------------------------

/** One wave of line asks: the pieces asked of one model, in board order. */
export interface LineVoiceWave {
  /** The model every piece in this wave is asked of; null is the deployment's. */
  model: string | null;
  items: StoryJobItemDraft[];
}

/** The recording a voice is copied from, as the input an ask carries. */
function referenceInputFor(voice: StoryVoiceProfile): StoryJobInput[] {
  return voice.referenceAssetId === undefined
    ? []
    : [{ role: "reference", assetId: voice.referenceAssetId }];
}

/**
 * Every line of an act read aloud, gathered by the model each takes its turn
 * with.
 *
 * One ask a line, because a telling's characters do not share a voice. A
 * character whose voice chain names a model is read by that model; every
 * other line takes the next model of the step's list, one turn per line, and
 * the lines that land on one model travel as one wave. A line with no words
 * in it is not read.
 */
export function planLineVoiceAsks(
  story: StoryDocument,
  chapterId: string,
  actId: string,
  only?: string[],
): LineVoiceWave[] {
  const act = actAt(story, chapterId, actId);
  if (act === undefined) return [];
  // Keyed by the model the line is read of; the empty string stands for the
  // deployment's own default, which is what the batch is started without.
  const waves = new Map<string, StoryJobItemDraft[]>();
  for (const keyframe of act.keyframes) {
    for (const line of keyframe.dialogue) {
      const text = line.text.trim();
      if (text === "") continue;
      if (only !== undefined && !only.includes(line.id)) continue;
      const target: StoryTarget = {
        kind: "lineVoice",
        chapterId,
        actId,
        keyframeId: keyframe.id,
        lineId: line.id,
      };
      const voice = resolveVoice(story, line.characterId);
      const model =
        voiceOwnModel(story, line.characterId) ?? storyAskModel("voice");
      const tone = (line.tone ?? "").trim();
      const key = model ?? "";
      const held = waves.get(key) ?? [];
      held.push({
        id: jobKey(target),
        target,
        capability: "speech",
        // The words are the line's own and nothing else: a voice that can
        // read is a voice that reads whatever it is given, directions and
        // all. The tone and the act ride in the params' direction instead,
        // which is the parameter a speech model reads as how to say things.
        prompt: text,
        inputs: referenceInputFor(voice),
        params: voiceParamsFor(story, voice, {
          act: act.summary,
          ...(tone === "" ? {} : { tone }),
        }),
      });
      waves.set(key, held);
    }
  }
  // One wave keeps a batch under the pieces a batch may carry: a telling may
  // hold more lines than that, and asking for them all at once is asking for
  // a batch the server would refuse whole.
  return [...waves].flatMap(([model, items]) =>
    chunkWaves(items, MAX_ITEMS_PER_STORY_JOB).map((wave) => ({
      model: model === "" ? null : model,
      items: wave,
    })),
  );
}

/**
 * The model a character's voice chain names of its own, if this machine still
 * has it. A voice with none takes its turn with the step's list per line.
 */
function voiceOwnModel(
  story: StoryDocument,
  characterId: string | undefined,
): string | null {
  const own = voiceFor(story, characterId, { model: "" }).model.trim();
  return own === "" ? null : speechModelOnMachine(own);
}

/** The same, flat: every line of the act, whoever it ends up being asked of. */
export function planLineVoices(
  story: StoryDocument,
  chapterId: string,
  actId: string,
  only?: string[],
): StoryJobItemDraft[] {
  return planLineVoiceAsks(story, chapterId, actId, only).flatMap(
    (wave) => wave.items,
  );
}

/**
 * An act's lines read aloud, as one piece in one voice.
 *
 * One ask for the whole act rather than one a line, because a voice that
 * changed halfway through an act is not a voice: the lines of every shot are
 * flattened in board order, and a line with no words in it is not read. The
 * ask carries the words themselves, one line to a line — a voice reads
 * whatever it is given, so the speaker's name and the tone in brackets stay
 * out of it too. Kept for the tellings voiced before each character had a
 * voice: a take already filed under the old ask is replayed and retried
 * through it, and nothing new is asked for that way.
 */
export function planActVoice(
  story: StoryDocument,
  chapterId: string,
  actId: string,
): StoryJobItemDraft[] {
  const act = actAt(story, chapterId, actId);
  if (act === undefined) return [];
  const words = act.keyframes
    .flatMap((keyframe) => keyframe.dialogue)
    .map((line) => line.text.trim())
    .filter((line) => line !== "");
  if (words.length === 0) return [];
  const target: StoryTarget = { kind: "voice", chapterId, actId };
  return [
    {
      id: jobKey(target),
      target,
      capability: "speech",
      prompt: words.join("\n"),
      inputs: [],
      params: voiceParams(story),
    },
  ];
}

/**
 * An act's music and sound, as one piece under the whole act.
 *
 * The three descriptions the board holds are asked for together, since music
 * that arrived as three files would be three things a reader has to mix; an
 * act with nothing said about its sound has nothing to ask for.
 */
export function planActMusic(
  story: StoryDocument,
  chapterId: string,
  actId: string,
): StoryJobItemDraft[] {
  const act = actAt(story, chapterId, actId);
  if (act === undefined) return [];
  const music = act.sound.music.trim();
  const sfx = act.sound.sfx.trim();
  const ambience = (act.sound.ambience ?? "").trim();
  if (music === "" && sfx === "" && ambience === "") return [];
  const seconds = clampSeconds(actPlannedMs(act));
  const target: StoryTarget = { kind: "music", chapterId, actId };
  return [
    {
      id: jobKey(target),
      target,
      capability: "music",
      prompt: storyActMusicPrompt({
        ...lookOf(story),
        genre: story.brief.genre,
        title: act.title,
        summary: act.summary,
        music,
        sfx,
        ambience,
        seconds,
      }),
      inputs: [],
      // The score plays under the lines rather than being sung over them, so a
      // service that can write words for a song is told not to. Shape and
      // watermark are not sent from here: the music preferences speak for the
      // machine, and the gateway fills them in.
      params: { instrumental: true },
    },
  ];
}

/** One line of dialogue as it reads in an ask, with the tone in brackets. */
export function spokenLine(line: StoryDialogueLine): string {
  const words = line.text.trim();
  if (words === "") return "";
  const speaker = line.speaker.trim();
  const said = speaker === "" ? words : `${speaker}：${words}`;
  const tone = (line.tone ?? "").trim();
  return tone === "" ? said : `${said}（${tone}）`;
}

/**
 * What a read-aloud ask is carried with, for one voice.
 *
 * The voice's own fields press over this machine's speech settings field by
 * field, so a character with a tone of its own keeps the machine's format and
 * pace; an empty tone is the provider's default and nothing is sent for it.
 * The acting direction rides in `instructions` because that is the parameter
 * a speech model reads as how to say something; a protocol that has never
 * heard of it drops it rather than failing, which is the gateway's standing
 * rule. Where the voice travels as a recording, no name is sent beside it:
 * the two are two ways of saying one voice. The try-out and every ask it
 * stands for are assembled here, so what a reader hears is what the telling
 * will say.
 */
export function voiceParamsFor(
  story: StoryDocument,
  voice: StoryVoiceProfile,
  extra: { act?: string; tone?: string } = {},
): Record<string, unknown> {
  const tone = (extra.tone ?? "").trim();
  const instructions = [
    i18n.t("story:voice.instructions", {
      genre: story.brief.genre,
      style: story.brief.style,
    }),
    (extra.act ?? "").trim(),
    tone === "" ? "" : `（${tone}）`,
    (voice.instructions ?? "").trim(),
  ]
    .filter((part) => part !== "")
    .join(" ");
  const params: Record<string, unknown> = {
    ...audioParams(),
    ...(voice.voice !== "" ? { voice: voice.voice } : {}),
    ...(voice.rate !== undefined ? { rate: voice.rate } : {}),
    ...(voice.pitch !== undefined ? { pitch: voice.pitch } : {}),
    instructions,
  };
  // A recorded voice and a named one are two ways of saying one voice: where
  // a recording travels, the name it would have been said by stands aside.
  if (voice.referenceAssetId !== undefined) delete params.voice;
  return params;
}

/** The same, for a reader who has named no voice: the machine speaks alone. */
function voiceParams(story: StoryDocument): Record<string, unknown> {
  return voiceParamsFor(story, { model: "", voice: "" });
}

/** The speech model a reference names, while this machine still has it. */
function speechModelOnMachine(reference: string | null): string | null {
  if (reference === null || reference === "") return null;
  return modelOptionsFor(useModelStore.getState().view, "speech").some(
    (option) => option.reference === reference,
  )
    ? reference
    : null;
}

/**
 * The voice a character's lines are read in, as this machine can read it.
 *
 * The document's own layers resolve first (the character, then the narrator);
 * a model the telling names but this machine no longer has is passed over
 * rather than sent to be refused, so a story keeps being read aloud after a
 * model was deleted or switched off — the same falling through the picker's
 * empty choice means. What no layer names is the deployment's own default.
 */
export function resolveVoice(
  story: StoryDocument,
  characterId: string | undefined,
): StoryVoiceProfile {
  const asked = speechModelOnMachine(storyAskModelHead("voice"));
  const voice = voiceFor(story, characterId, { model: asked ?? "" });
  if (voice.model !== "" && speechModelOnMachine(voice.model) === null) {
    return { ...voice, model: asked ?? "" };
  }
  return voice;
}

/** The format and pace this machine's speech settings ask for. */
function audioParams(): Record<string, unknown> {
  const speech = useModelStore.getState().view?.preferences.speech;
  return {
    ...(speech?.voice ? { voice: speech.voice } : {}),
    ...(speech?.format ? { format: speech.format } : {}),
    ...(speech?.speed ? { speed: speech.speed } : {}),
  };
}

// -----------------------------------------------------------------------------
// Asking again for what did not come back
// -----------------------------------------------------------------------------

/**
 * The pieces that would make these places again, planned from the story as it
 * stands now.
 *
 * This is what a retry is: not the old ask sent twice, but the ask today's
 * document would make. A description that was edited between the two, a
 * reference that has since been redrawn, a chapter that moved — all of them
 * belong to the new ask, and none of them were in the old one.
 */
export function itemsForTargets(
  story: StoryDocument,
  targets: StoryTarget[],
): StoryJobItemDraft[] {
  return targets.flatMap((target) => {
    switch (target.kind) {
      case "outline":
        return planOutline(story, {
          chapters: Math.max(1, story.chapters.length),
        });
      case "elements":
        return planElements(story);
      case "storyboard":
        return planStoryboard(story, [target.chapterId]);
      case "actPlan": {
        const planned = planActPlan(story, target.chapterId, target.actId);
        return planned === undefined ? [] : [planned];
      }
      case "continuity": {
        const planned = planContinuity(story, target.chapterId);
        return planned === undefined ? [] : [planned];
      }
      case "outlineRevision": {
        const planned = planOutlineRevision(story, target.chapterId);
        return planned === undefined ? [] : [planned];
      }
      case "elementArt":
        return planElementArt(story, [
          { elementId: target.elementId, view: target.view },
        ]);
      case "keyframeArt":
        return planKeyframeArt(story, [target]);
      case "actVideo":
        return planActVideos(story, target.chapterId, [target.actId]);
      case "keyframeVideo":
        return planKeyframeVideos(story, target.chapterId, target.actId, [
          target.keyframeId,
        ]);
      case "voice":
        return planActVoice(story, target.chapterId, target.actId);
      case "lineVoice":
        return planLineVoices(story, target.chapterId, target.actId, [
          target.lineId,
        ]);
      case "music":
        return planActMusic(story, target.chapterId, target.actId);
    }
  });
}
