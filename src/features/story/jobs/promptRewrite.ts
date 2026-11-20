/**
 * Rewriting a clip's or a picture's prompt into the contract its model reads.
 *
 * A protocol declares the contract and the client applies it: the guide's
 * words, the material the ask is made of, and the prompt as it stands are
 * given to the room's own text model, and what comes back is put in front of
 * the reader before anything is sent. Nothing here sends media ask, and
 * nothing writes into the document — the dialog owns both.
 */
import { i18n } from "../../../shared/i18n";
import {
  imagePromptRewriteAsk,
  imagePromptRewriteSystem,
  videoPromptRewriteAsk,
  videoPromptRewriteSystem,
} from "../../../shared/prompts";
import type { ImagePromptContext } from "../../../shared/prompts/image/promptContext";
import {
  promptContractIssues,
  type PromptContractIssue,
} from "../../../shared/prompts/promptContract";
import {
  promptRewriteGuide,
  rewritePromptText,
  type PromptRewriteGuide,
} from "../../../shared/prompts/rewrite";
import type { StoryPromptContext } from "../../../shared/prompts/story/promptContext";
import { effectiveDefaultId, useModelStore } from "../../settings/modelStore";
import { storyAskModelHead, storyTextModel } from "../stores/storyModels";

export type { PromptRewriteGuide };

/**
 * The contract the model this work is asked of declares, or none.
 *
 * The model is the one named for the place — an act may name the model that
 * films it, a frame or a form may name the one that draws it — and otherwise
 * the one the batch will actually be asked of: the room's own choice where it
 * has one, the deployment's default otherwise, so the contract offered is the
 * contract the words will be held to.
 */
function guideFor(
  capability: "image" | "video",
  model: string | null | undefined,
): PromptRewriteGuide | null {
  const { view, protocols } = useModelStore.getState();
  if (view === null || protocols === null) return null;
  const id = model ?? effectiveDefaultId(view, capability);
  const held = view.models.find((each) => each.id === id);
  if (held === undefined) return null;
  return promptRewriteGuide(protocols, capability, held.protocol);
}

/** The contract the model this kind of clip is filmed by declares, or none. */
export function videoPromptRewrite(
  kind: "actVideo" | "keyframeVideo",
  model?: string | null,
): PromptRewriteGuide | null {
  return guideFor("video", model ?? storyAskModelHead(kind));
}

/** The contract the model this kind of picture is drawn by declares, or none. */
export function imagePromptRewrite(
  kind: "keyframeArt" | "elementArt",
  model?: string | null,
): PromptRewriteGuide | null {
  return guideFor("image", model ?? storyAskModelHead(kind));
}

/** A rewritten prompt and what is wrong with it, once the model answered. */
export interface RewrittenPrompt {
  prompt: string;
  issues: PromptContractIssue[];
}

/**
 * One clip's prompt, rewritten for its model.
 *
 * The text model answers in the reader's own words about what the clip holds;
 * the prompt it writes is cleaned of a model's usual wrappings and then
 * checked against the contract. A refusal is thrown as it came — the dialog
 * shows the reason whole rather than turning it into a generic failure.
 */
export async function rewriteVideoPrompt(input: {
  prompt: string;
  context?: StoryPromptContext;
  guide: PromptRewriteGuide;
  /** The text model to ask, or none for the model the room is set to. */
  model?: string | null;
  signal?: AbortSignal;
}): Promise<RewrittenPrompt> {
  const model = input.model ?? storyTextModel();
  const said = await rewritePromptText({
    system: videoPromptRewriteSystem(input.guide.guide),
    prompt: videoPromptRewriteAsk({
      prompt: input.prompt,
      ...(input.context === undefined ? {} : { context: input.context }),
    }),
    model,
    signal: input.signal,
  });
  if (said === "") {
    throw new Error(i18n.t("story:storyboard.videoPromptRewriteEmpty"));
  }
  return {
    prompt: said,
    issues: promptContractIssues(said, input.guide.checks, input.context),
  };
}

/**
 * One picture's prompt, rewritten for its model.
 *
 * The material carries the frame or form it is drawn from; the prompt's node
 * tokens, where a canvas node wrote any, are checked for survival here too.
 */
export async function rewriteImagePrompt(input: {
  prompt: string;
  context?: ImagePromptContext;
  guide: PromptRewriteGuide;
  /** The text model to ask, or none for the model the room is set to. */
  model?: string | null;
  signal?: AbortSignal;
}): Promise<RewrittenPrompt> {
  const model = input.model ?? storyTextModel();
  const said = await rewritePromptText({
    system: imagePromptRewriteSystem(input.guide.guide),
    prompt: imagePromptRewriteAsk({
      prompt: input.prompt,
      ...(input.context === undefined ? {} : { context: input.context }),
    }),
    model,
    signal: input.signal,
  });
  if (said === "") {
    throw new Error(i18n.t("story:storyboard.imagePromptRewriteEmpty"));
  }
  return {
    prompt: said,
    issues: promptContractIssues(said, input.guide.checks, {
      sourcePrompt: input.prompt,
    }),
  };
}
