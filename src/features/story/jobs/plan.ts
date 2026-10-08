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
  MAX_ITEMS_PER_STORY_JOB,
  MAX_VIDEO_SECONDS,
  STORY_READ_CHARS_DEFAULT,
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
  chunkWaves,
  currentTake,
  elementOf,
  keyframeAt,
  storyMentions,
  stripStoryMentions,
  takeFile,
  targetKey,
  voiceFor,
} from "../../../shared/domain/story";
import type { SourceChunk } from "../../../shared/domain/storySource";
import type { StoryElement } from "../../../shared/domain";
import type {
  StoryAct,
  StoryAspect,
  StoryDialogueLine,
  StoryDocument,
  StoryFilmRole,
  StoryKeyframe,
  StoryVoiceProfile,
} from "../../../shared/domain/types";
import {
  storyActMusicPrompt,
  storyActVideoPrompt,
  storyElementMainPrompt,
  storyElementTurnaroundPrompt,
  storyElementsPrompt,
  storyKeyframePrompt,
  storyKeyframeVideoPrompt,
  storyOutlinePrompt,
  storySplitPrompt,
  storyStoryboardPrompt,
  storySystemPrompt,
  type StoryFacts,
  type StoryLook,
} from "../../../shared/prompts";
import { i18n } from "../../../shared/i18n";
import {
  effectiveDefaultId,
  modelOptionsFor,
  useModelStore,
} from "../../settings/modelStore";
import { storyAskModel } from "../stores/storyModels";

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
    case "elementArt":
      return targetKey({
        kind: "element",
        elementId: target.elementId,
        view: target.view,
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
 * How many seconds a clip is asked for: what the story plans for it, rounded to
 * seconds, never less than one and never past the length one clip may be.
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
  return Math.min(ceiling, Math.max(1, Math.round(ms / 1000)));
}

/**
 * The longest one clip may be, in seconds, for the video model this machine
 * will ask: the one the room is set to, or the deployment's default, and that
 * model's own declared window where it has one.
 *
 * Read where a batch is planned rather than held, the way every other ask is:
 * a model swapped between two asks is the model the second one is planned for.
 */
export function videoCeiling(): number {
  const chosen = storyAskModel("actVideo");
  const view = useModelStore.getState().view;
  const id =
    chosen ??
    (view === null ? null : (effectiveDefaultId(view, "video") ?? null));
  const model = view?.models.find((held) => held.id === id);
  const seconds = model?.maxVideoSeconds;
  return typeof seconds === "number" && seconds > 0
    ? Math.min(seconds, MAX_VIDEO_SECONDS)
    : MAX_VIDEO_SECONDS;
}

/** How one piece of an act's clip travels with its pictures. */
export type ActClipKind = "frame" | "pair" | "reference";

/** One piece of an act's clip: the shots it is made of, and its length. */
export interface ActClipPiece {
  keyframes: StoryKeyframe[];
  /** How long the piece is asked for, in whole seconds. */
  seconds: number;
  /** Whether it opens on one frame, pairs two, or is drawn from references. */
  kind: ActClipKind;
}

/** The frames of an act that were drawn, in board order. */
export function drawnFrames(act: StoryAct): StoryKeyframe[] {
  return act.keyframes.filter(
    (keyframe) => currentTake(keyframe.art) !== undefined,
  );
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

/** Whether the frame at `at` opens a piece of its own under its role. */
function opensItsOwnPiece(drawn: StoryKeyframe[], at: number): boolean {
  const role = filmRoleOf(drawn[at]);
  return (
    role === "firstFrame" ||
    (role === "firstLastFrame" && at + 1 < drawn.length)
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
 */
export function actClipPieces(act: StoryAct, ceiling: number): ActClipPiece[] {
  const drawn = drawnFrames(act);
  const pieces: ActClipPiece[] = [];
  let index = 0;
  while (index < drawn.length) {
    const frame = drawn[index];
    const role = filmRoleOf(frame);
    // Whether this pair's tail is the act's closing frame: then nothing opens
    // on it, and its length rides with the pair that holds it rather than
    // being counted twice.
    const holdsAct = index + 1 === drawn.length - 1;
    if (index + 1 < drawn.length && role === "firstLastFrame") {
      const tail = drawn[index + 1];
      pieces.push({
        keyframes: [frame, tail],
        seconds: clampSeconds(
          frame.durationMs + (holdsAct ? tail.durationMs : 0),
          ceiling,
        ),
        kind: "pair",
      });
      // A tail that is not closing the act goes on to open its own piece,
      // under whatever role it was given.
      index += holdsAct ? 2 : 1;
      continue;
    }
    if (role === "firstFrame") {
      pieces.push({
        keyframes: [frame],
        seconds: clampSeconds(frame.durationMs, ceiling),
        kind: "frame",
      });
      index += 1;
      continue;
    }
    // The run of references this frame belongs to — the last frame of an act
    // whose pair never came degrades into one — cut where it outruns the
    // ceiling, at the same shot boundaries an act was always cut at.
    const run: StoryKeyframe[] = [];
    let runMs = 0;
    while (index < drawn.length && !opensItsOwnPiece(drawn, index)) {
      const held = drawn[index];
      if (runMs > 0 && runMs + held.durationMs > ceiling * 1000) break;
      run.push(held);
      runMs += held.durationMs;
      index += 1;
    }
    pieces.push({
      keyframes: run,
      seconds: clampSeconds(runMs, ceiling),
      kind: "reference",
    });
  }
  return pieces;
}

/**
 * How much of a telling one ask may carry, as the story settings say.
 *
 * Read where a batch is planned, the way the clip ceiling is: a telling cut to
 * yesterday's boundary is a telling already being read.
 */
export function storySplitChars(): number {
  const chars = useModelStore.getState().view?.preferences.story.splitChars;
  return typeof chars === "number" && chars > 0
    ? chars
    : STORY_SPLIT_CHARS_DEFAULT;
}

export function storyReadChars(): number {
  const chars = useModelStore.getState().view?.preferences.story.readChars;
  return typeof chars === "number" && chars > 0
    ? chars
    : STORY_READ_CHARS_DEFAULT;
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
 * The outline: either the premise written into chapters, or a manuscript's
 * parts written into them one at a time.
 *
 * A part is not a chapter yet when it is sent — what comes back is — so the
 * pieces are numbered and applied in order, which is the order the manuscript
 * was read in.
 */
export function planOutline(
  story: StoryDocument,
  options: {
    mode: "expand" | "split";
    chapters: number;
    chunks?: SourceChunk[];
  },
): StoryJobItemDraft[] {
  if (options.mode === "split") {
    const chunks = options.chunks ?? [];
    return chunks.map((chunk, index) => ({
      id: `outline:${index + 1}`,
      target: { kind: "outline" },
      capability: "text",
      system: storySystemPrompt(),
      prompt: storySplitPrompt({
        // The heading the manuscript itself wrote for this part travels with
        // it: a chapter is asked for by the name it was written under.
        text:
          chunk.title === undefined
            ? chunk.text
            : `${chunk.title}\n${chunk.text}`,
        index: index + 1,
        total: chunks.length,
        genre: story.brief.genre,
        style: story.brief.style,
      }),
    }));
  }
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

/**
 * The characters, places and things the chapters are made of.
 *
 * One ask for the whole telling wherever it fits, and otherwise a part of the
 * chapters at a time — a long telling's synopses are more than one prompt may
 * carry. A part is numbered the way a manuscript's parts are, and what it
 * names is read into the cast beside what earlier parts found rather than in
 * place of it.
 *
 * The chapters are listed under the telling's own numbers even where a part
 * holds a few of them, because those numbers are how the answer says where each
 * thing was noticed and how the reading files them: a part-local count would be
 * read against the whole table and land on the wrong chapters.
 */
export function planElements(
  story: StoryDocument,
  options: { chapterIds?: string[]; part?: number; total?: number } = {},
): StoryJobItemDraft[] {
  const asked = story.chapters
    .map((chapter, at) => ({ number: at + 1, chapter }))
    .filter(
      ({ chapter }) =>
        options.chapterIds === undefined ||
        options.chapterIds.includes(chapter.id),
    );
  return [
    {
      id: options.part === undefined ? "elements" : `elements:${options.part}`,
      target: { kind: "elements" },
      capability: "text",
      system: storySystemPrompt(),
      prompt: storyElementsPrompt({
        chapters: asked.map(({ number, chapter }) => ({
          number,
          title: chapter.title,
          synopsis: chapter.synopsis,
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

/** The board of one or more episodes, one ask each. */
export function planStoryboard(
  story: StoryDocument,
  chapterIds: string[],
): StoryJobItemDraft[] {
  const facts = factsOf(story);
  return chapterIds.flatMap((chapterId) => {
    const number = story.chapters.findIndex((held) => held.id === chapterId);
    const chapter = story.chapters[number];
    if (chapter === undefined) return [];
    const target: StoryTarget = { kind: "storyboard", chapterId };
    return [
      {
        id: jobKey(target),
        target,
        capability: "text",
        system: storySystemPrompt(),
        prompt: storyStoryboardPrompt({
          ...facts,
          number: number + 1,
          chapter: { title: chapter.title, synopsis: chapter.synopsis },
          targetDurationMs: chapter.targetDurationMs,
          elements: story.elements.map((element) => ({
            kind: element.kind,
            name: element.name,
            description: element.description,
          })),
          shotSizes: STORY_SHOT_SIZES,
          cameraMoves: STORY_CAMERA_MOVES,
          angles: STORY_CAMERA_ANGLES,
        }),
      },
    ];
  });
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
  targets: Array<{ elementId: string; view: "main" | "turnaround" }>,
): StoryJobItemDraft[] {
  const look = lookOf(story);
  const size = imageSizeForAspect(story.brief.aspect);
  return targets.flatMap(({ elementId, view }) => {
    const element = elementOf(story, elementId);
    if (element === undefined) return [];
    const main = currentTake(element.main);
    if (view === "turnaround" && main === undefined) return [];
    const target: StoryTarget = { kind: "elementArt", elementId, view };
    return [
      {
        id: jobKey(target),
        target,
        capability: "image",
        prompt:
          view === "turnaround"
            ? storyElementTurnaroundPrompt({
                ...look,
                name: element.name,
                description: element.description,
              })
            : storyElementMainPrompt({
                ...look,
                kind: element.kind,
                name: element.name,
                description: element.description,
              }),
        // A main picture is drawn from its description alone: handing the
        // previous one over would ask for the drawing that is being replaced.
        // A turn-around is the other way round — four views of the character
        // who was already drawn, from the picture that drew them.
        inputs:
          view === "turnaround" && main !== undefined
            ? [{ role: "reference", assetId: main.assetIds[0] }]
            : [],
        params: { size },
      },
    ];
  });
}

/** One of a frame's mentioned pictures: the element it names, and the drawing
 * that travels with the ask. */
export interface StoryReference {
  element: StoryElement;
  assetId: string;
}

/**
 * The cast a frame travels with, as the frame's own words name it.
 *
 * The pictures are chosen by the mentions in a shot's content: each mentioned
 * name the story knows and has drawn is a reference, in the order it is first
 * named, and one nobody has drawn — or nobody has at all — is left to the
 * words. The order is the contract between the numbered references in the
 * prompt and the pictures that travel with it, so it is decided once, here.
 *
 * The story's own limit decides how many of them fit: an image service refuses
 * a request over its bound whole rather than drawing with the first of the
 * pictures, so the first of the mentioned ones travel and the rest are left to
 * the words.
 */
export function keyframeCast(
  story: StoryDocument,
  content: string,
): {
  /** The pictures that travel, in the order the content names them. */
  carried: StoryReference[];
  /** The mentioned pictures the story's limit leaves behind. */
  beyond: StoryReference[];
  /** The mentioned names no drawing could be sent for. */
  undrawn: string[];
} {
  const byName = new Map<string, StoryElement>();
  for (const element of story.elements) {
    if (!byName.has(element.name)) byName.set(element.name, element);
  }
  const seen = new Set<string>();
  const drawn: StoryReference[] = [];
  const undrawn: string[] = [];
  for (const mention of storyMentions(content)) {
    if (seen.has(mention.name)) continue;
    seen.add(mention.name);
    const element = byName.get(mention.name);
    const take = element === undefined ? undefined : currentTake(element.main);
    if (element === undefined || take === undefined) {
      undrawn.push(mention.name);
      continue;
    }
    drawn.push({ element, assetId: take.assetIds[0] });
  }
  const limit = story.maxReferenceImages;
  return {
    carried: drawn.slice(0, limit),
    beyond: drawn.slice(limit),
    undrawn,
  };
}

/** One frame of a board, drawn with the cast that stands in it. */
export function planKeyframeArt(
  story: StoryDocument,
  targets: Array<{ chapterId: string; actId: string; keyframeId: string }>,
): StoryJobItemDraft[] {
  const look = lookOf(story);
  const size = imageSizeForAspect(story.brief.aspect);
  return targets.flatMap(({ chapterId, actId, keyframeId }) => {
    const chapter = story.chapters.find((held) => held.id === chapterId);
    const act = actAt(story, chapterId, actId);
    const keyframe =
      act === undefined
        ? undefined
        : act.keyframes.find((held) => held.id === keyframeId);
    if (chapter === undefined || act === undefined || keyframe === undefined)
      return [];
    const cast = keyframeCast(story, keyframe.content).carried;
    const target: StoryTarget = {
      kind: "keyframeArt",
      chapterId,
      actId,
      keyframeId,
    };
    return [
      {
        id: jobKey(target),
        target,
        capability: "image",
        prompt: storyKeyframePrompt({
          ...look,
          chapter: { title: chapter.title },
          act: { summary: act.summary },
          keyframe: {
            content: keyframe.content,
            shotSize: keyframe.shotSize,
            cameraMove: keyframe.cameraMove,
            angle: keyframe.angle,
          },
          cast: cast.map(({ element }) => ({
            name: element.name,
            description: element.description,
          })),
        }),
        inputs: cast.map(({ assetId }) => ({
          role: "reference" as const,
          assetId,
        })),
        params: { size },
      },
    ];
  });
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
  const ceiling = videoCeiling();
  return actIds.flatMap((actId) => {
    const act = actAt(story, chapterId, actId);
    if (act === undefined || act.keyframes.length === 0) return [];
    const pieces = actClipPieces(act, ceiling);
    if (pieces.length === 0) return [];
    const target: StoryTarget = { kind: "actVideo", chapterId, actId };
    const base = jobKey(target);
    const several = pieces.length > 1;
    return pieces.map((piece, at) => {
      const held = piece.keyframes.flatMap((keyframe) => {
        const take = currentTake(keyframe.art);
        return take === undefined
          ? []
          : [
              {
                content: stripStoryMentions(keyframe.content),
                assetId: take.assetIds[0],
              },
            ];
      });
      const first = held[0];
      const last = held[held.length - 1];
      const between = held.slice(1, -1);
      const references = piece.kind === "reference";
      const inputs: StoryJobInput[] = references
        ? held.map((frame) => ({
            role: "reference" as const,
            assetId: frame.assetId,
          }))
        : [
            { role: "firstFrame", assetId: first.assetId },
            ...(piece.kind === "pair"
              ? [{ role: "lastFrame" as const, assetId: last.assetId }]
              : []),
          ];
      return {
        id: several ? `${base}:${at + 1}` : base,
        target,
        capability: "video" as const,
        prompt: storyActVideoPrompt({
          ...look,
          title: act.title,
          summary: act.summary,
          first: first.content,
          last: last.content,
          middle: (references ? held : between)
            .map((frame) => frame.content)
            .join("; "),
          mode: references ? "references" : "frames",
          seconds: piece.seconds,
          ...(several ? { part: at + 1, total: pieces.length } : {}),
        }),
        inputs,
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
  const ceiling = videoCeiling();
  const act = actAt(story, chapterId, actId);
  if (act === undefined) return [];
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
    return [
      {
        id: jobKey(target),
        target,
        capability: "video",
        prompt: storyKeyframeVideoPrompt({
          ...look,
          title: keyframe.title,
          content: stripStoryMentions(keyframe.content),
          seconds,
        }),
        inputs,
        params: videoParams(story.brief.aspect, seconds),
      },
    ];
  });
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
 * Every line of an act read aloud, in the voice its speaker is given.
 *
 * One ask a line, because a telling's characters do not share a voice: each
 * line resolves through the voice chain and is asked of the model that came
 * out of it, so a batch carries one model and the lines of different models
 * travel as different waves, one after another. A line with no words in it is
 * not read, and telling the same model twice in a wave is telling it once.
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
      const tone = (line.tone ?? "").trim();
      const held = waves.get(voice.model) ?? [];
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
      waves.set(voice.model, held);
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
  const asked = speechModelOnMachine(storyAskModel("voice"));
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
          mode: "expand",
          chapters: Math.max(1, story.chapters.length),
        });
      case "elements":
        return planElements(story);
      case "storyboard":
        return planStoryboard(story, [target.chapterId]);
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
