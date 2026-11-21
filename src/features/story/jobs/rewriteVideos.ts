/**
 * Rewriting a batch's clip prompts before it is asked for.
 *
 * A video is drawn from its words in a way a picture is not: the same words
 * tend to come back as the same film, and a take is made to be compared with
 * the ones beside it. So a press asking for several takes rewrites each take
 * from the words the board wrote, rather than once for the whole set — every
 * take hears a fresh reading of the same scene.
 *
 * A place whose model declares no contract is left as it stands, and a place
 * whose rewrite failed is kept out of that take: no clip is filmed on words
 * the reader did not choose. An act filmed in pieces is one place: one of its
 * pieces failing drops the whole act, since a clip made from the pieces that
 * answered would be a shorter act than the board wrote.
 */
import { errorText } from "../../../api/client";
import type { StoryDocument } from "../../../shared/domain/types";
import { actAt, keyframeAt } from "../../../shared/domain/story";
import { actVideoModel, jobKey, type VideoAskWave } from "./plan";
import { videoPromptRewrite, rewriteVideoPrompt } from "./promptRewrite";
import type { RewriteFailure } from "./rewriteImages";
import type { StoryPromptContext } from "../../../shared/prompts/story/promptContext";

/** The clips after their places were rewritten, and what happened to each. */
export interface PreparedVideoWaves {
  waves: VideoAskWave[];
  /** The places whose words were rewritten. */
  rewritten: number;
  /** The places whose model declares no contract, filmed with their own words. */
  untouched: number;
  failed: RewriteFailure[];
}

/** One place's asks, held together across the pieces they travel in. */
interface Place {
  label: string;
  guide: ReturnType<typeof videoPromptRewrite>;
  items: Array<{
    item: VideoAskWave["items"][number];
    context?: StoryPromptContext;
  }>;
  rewritten?: string[];
}

function labelOf(
  story: StoryDocument,
  target: VideoAskWave["items"][number]["target"],
): string {
  const chapter = story.chapters.find((held) => held.id === target.chapterId);
  const act = actAt(story, target.chapterId, target.actId);
  const shot =
    target.kind === "keyframeVideo" ? keyframeAt(story, target) : undefined;
  return [chapter?.title, act?.title, shot?.title]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
}

/**
 * The same waves, with every place's words read afresh for this take.
 *
 * Called once per take rather than once per press: the input waves still hold
 * the board's own words, so each call rewrites the original prompt and no
 * take inherits the words of the one before it.
 */
export async function rewriteVideoWaves(
  story: StoryDocument,
  waves: VideoAskWave[],
  options: {
    signal?: AbortSignal;
    /** The text model to ask, or none for the room's next turn. */
    model?: string | null;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<PreparedVideoWaves> {
  const places = new Map<string, Place>();
  for (const wave of waves) {
    for (const item of wave.items) {
      const target = item.target;
      if (target.kind !== "actVideo" && target.kind !== "keyframeVideo") {
        continue;
      }
      const key = jobKey(target);
      let place = places.get(key);
      if (place === undefined) {
        const act = actAt(story, target.chapterId, target.actId);
        place = {
          label: labelOf(story, target),
          guide: videoPromptRewrite(
            target.kind,
            act === undefined ? null : actVideoModel(act),
          ),
          items: [],
        };
        places.set(key, place);
      }
      place.items.push({
        item,
        ...(item.promptContext === undefined
          ? {}
          : { context: item.promptContext }),
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
    const guide = place.guide;
    if (guide === null) continue;
    if (options.signal?.aborted) {
      throw new DOMException("The rewrite was stopped", "AbortError");
    }
    const prompts: string[] = [];
    try {
      for (const { item, context } of place.items) {
        const rewritten = await rewriteVideoPrompt({
          prompt: item.prompt,
          ...(context === undefined ? {} : { context }),
          guide,
          ...(options.model === undefined ? {} : { model: options.model }),
          signal: options.signal,
        });
        prompts.push(rewritten.prompt);
      }
      place.rewritten = prompts;
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
    const items = wave.items.flatMap((item): VideoAskWave["items"] => {
      const key = jobKey(item.target);
      if (failed.has(key)) return [];
      const place = places.get(key);
      if (place?.rewritten === undefined) return [item];
      const at = place.items.findIndex((held) => held.item.id === item.id);
      return [{ ...item, prompt: place.rewritten[at] ?? item.prompt }];
    });
    return items.length === 0 ? [] : [{ ...wave, items }];
  });
  return { waves: kept, rewritten, untouched, failed: failures };
}

/** The reason a place gave, in the words a toast keeps under its line. */
export function videoFailureDetail(failures: RewriteFailure[]): string {
  return failures
    .map((failure) =>
      failure.detail === undefined
        ? `${failure.label}: ${failure.message}`
        : `${failure.label}: ${failure.message}\n${failure.detail}`,
    )
    .join("\n");
}
