/**
 * Rewriting a batch's picture prompts before it is asked for.
 *
 * A bulk press draws a place as a set of pictures from one prompt, and a
 * reader may ask that prompt to be put into the contract its picture model
 * reads first. The rewrite is one ask per place rather than one per picture:
 * every picture of a set is drawn from the same words, so the set is rewritten
 * once and all of its copies carry the one answer.
 *
 * A place whose model declares no contract is left as it stands, and a place
 * whose rewrite failed is kept out of the batch: the pictures are not drawn on
 * words the reader did not choose. Which model draws a request is not decided
 * here — the plan has already taken a turn of the step's list for every
 * request, and rewriting the words does not change whose turn it is.
 */
import { errorText } from "../../../api/client";
import type { StoryJobItemDraft, StoryTarget } from "../../../api/story";
import type { StoryDocument } from "../../../shared/domain/types";
import {
  elementForm,
  elementOf,
  keyframeAt,
} from "../../../shared/domain/story";
import { i18n } from "../../../shared/i18n";
import type { ImagePromptContext } from "../../../shared/prompts/image/promptContext";
import {
  elementArtPromptContext,
  keyframeArtPromptContext,
} from "./imagePromptContext";
import { elementArtModel, jobKey, keyframeArtModel } from "./plan";
import {
  imagePromptRewrite,
  rewriteImagePrompt,
  type PromptRewriteGuide,
} from "./promptRewrite";

/** The batches one place's drawings are asked in, each of one model. */
export interface ImageWave {
  model: string | null;
  items: StoryJobItemDraft[];
}

/** A place whose words could not be rewritten, with the reason it gave. */
export interface RewriteFailure {
  label: string;
  message: string;
  detail?: string;
}

/** The batches after their places were rewritten, and what happened to each. */
export interface PreparedImageWaves {
  waves: ImageWave[];
  /** The places whose words were rewritten. */
  rewritten: number;
  /** The places whose model declares no contract, drawn with their own words. */
  untouched: number;
  failed: RewriteFailure[];
}

/** One place's words, held across every copy and every batch they travel in. */
interface Place {
  prompt: string;
  label: string;
  guide: PromptRewriteGuide | null;
  context: ImagePromptContext | null;
  rewritten?: string;
}

/** What the rewrite needs to know about a place, or none for a target it cannot find. */
function placeOf(
  story: StoryDocument,
  kind: "elementArt" | "keyframeArt",
  target: StoryTarget,
):
  | {
      label: string;
      guide: PromptRewriteGuide | null;
      context: ImagePromptContext | null;
    }
  | undefined {
  if (kind === "keyframeArt") {
    if (target.kind !== "keyframeArt") return undefined;
    const chapter = story.chapters.find((held) => held.id === target.chapterId);
    const act = chapter?.acts.find((held) => held.id === target.actId);
    const keyframe = keyframeAt(story, target);
    if (chapter === undefined || act === undefined || keyframe === undefined) {
      return undefined;
    }
    return {
      label: `${chapter.title} · ${act.title} · ${keyframe.title}`,
      guide: imagePromptRewrite("keyframeArt", keyframeArtModel(story, target)),
      context: keyframeArtPromptContext(
        story,
        target.chapterId,
        target.actId,
        target.keyframeId,
      ),
    };
  }
  if (target.kind !== "elementArt") return undefined;
  const element = elementOf(story, target.elementId);
  if (element === undefined) return undefined;
  const form = elementForm(element, target.variantId);
  const view = i18n.t(
    target.view === "main"
      ? "story:elements.main"
      : "story:elements.turnaround",
  );
  return {
    label: [element.name, form?.name, view].filter(Boolean).join(" · "),
    guide: imagePromptRewrite(
      "elementArt",
      elementArtModel(element, target.variantId),
    ),
    context: elementArtPromptContext(
      story,
      target.elementId,
      target.view,
      target.variantId,
    ),
  };
}

/**
 * The same batches, with every place's words rewritten once.
 *
 * The copies of a place may travel in several batches — the step's list gives
 * every request its own turn — so the places are gathered across all of them
 * before anything is asked, and each answer is written onto every copy.
 */
export async function rewriteImageWaves(
  story: StoryDocument,
  kind: "elementArt" | "keyframeArt",
  waves: ImageWave[],
  options: {
    signal?: AbortSignal;
    /** The text model to ask, or none for the room's next turn. */
    model?: string | null;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<PreparedImageWaves> {
  const places = new Map<string, Place>();
  for (const wave of waves) {
    for (const item of wave.items) {
      const key = jobKey(item.target);
      if (places.has(key)) continue;
      const found = placeOf(story, kind, item.target);
      places.set(key, {
        prompt: item.prompt,
        label: found?.label ?? key,
        guide: found?.guide ?? null,
        context: found?.context ?? null,
      });
    }
  }

  const rewritable = [...places.values()].filter(
    (place) => place.guide !== null,
  );
  let done = 0;
  options.onProgress?.(0, rewritable.length);
  const failed = new Set<string>();
  const failures: RewriteFailure[] = [];
  for (const [key, place] of places) {
    if (place.guide === null) continue;
    if (options.signal?.aborted) {
      throw new DOMException("The rewrite was stopped", "AbortError");
    }
    try {
      const rewritten = await rewriteImagePrompt({
        prompt: place.prompt,
        ...(place.context === null ? {} : { context: place.context }),
        guide: place.guide,
        ...(options.model === undefined ? {} : { model: options.model }),
        signal: options.signal,
      });
      place.rewritten = rewritten.prompt;
    } catch (problem) {
      if (options.signal?.aborted) throw problem;
      const said = errorText(problem);
      failures.push({
        label: place.label,
        message: said.message,
        ...(said.detail === undefined ? {} : { detail: said.detail }),
      });
      failed.add(key);
    }
    done += 1;
    options.onProgress?.(done, rewritable.length);
  }

  let rewritten = 0;
  let untouched = 0;
  for (const place of places.values()) {
    if (place.rewritten !== undefined) rewritten += 1;
    else if (place.guide === null) untouched += 1;
  }
  const kept = waves.flatMap((wave) => {
    const items = wave.items.flatMap((item): StoryJobItemDraft[] => {
      const key = jobKey(item.target);
      if (failed.has(key)) return [];
      const place = places.get(key);
      if (place?.rewritten === undefined) return [item];
      return [{ ...item, prompt: place.rewritten }];
    });
    return items.length === 0 ? [] : [{ model: wave.model, items }];
  });
  return { waves: kept, rewritten, untouched, failed: failures };
}
