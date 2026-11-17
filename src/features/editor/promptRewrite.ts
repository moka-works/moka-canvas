/**
 * Rewriting a canvas image prompt into the contract its model reads.
 *
 * The protocol is read off the model that will draw the node, including the
 * deployment's default when the node names none. The material is the node's
 * own references and the place it sits on the canvas; the words it rewrites
 * are the draft in the panel, and nothing here writes or sends a media ask.
 */
import type { ModelsView, ProtocolGroups } from "../../api/models";
import { i18n } from "../../shared/i18n";
import {
  imagePromptRewriteAsk,
  imagePromptRewriteSystem,
} from "../../shared/prompts";
import type { ImagePromptContext } from "../../shared/prompts/image/promptContext";
import {
  promptContractIssues,
  type PromptContractIssue,
} from "../../shared/prompts/promptContract";
import {
  promptRewriteGuide,
  rewritePromptText,
  type PromptRewriteGuide,
} from "../../shared/prompts/rewrite";
import { effectiveDefaultId } from "../settings/modelStore";

/** The contract the model that will draw this node declares, or none. */
export function canvasImagePromptRewrite(
  view: ModelsView | null,
  protocols: ProtocolGroups | null,
  model: string | null,
): PromptRewriteGuide | null {
  if (view === null || protocols === null) return null;
  const id =
    model === null || model === "" ? effectiveDefaultId(view, "image") : model;
  const held = view.models.find((each) => each.id === id);
  if (held === undefined) return null;
  return promptRewriteGuide(protocols, "image", held.protocol);
}

/** A rewritten canvas prompt and what is wrong with it. */
export interface RewrittenCanvasPrompt {
  prompt: string;
  issues: PromptContractIssue[];
}

/**
 * One canvas node's prompt, rewritten for its model.
 *
 * A refusal is thrown as it came — the panel shows the reason whole rather
 * than turning it into a generic failure. Node tokens are addresses, so every
 * one the draft carried is checked for survival.
 */
export async function rewriteCanvasImagePrompt(input: {
  prompt: string;
  context: ImagePromptContext;
  guide: PromptRewriteGuide;
  /** The text model to ask, or none for the deployment's default. */
  model?: string | null;
  signal?: AbortSignal;
}): Promise<RewrittenCanvasPrompt> {
  const said = await rewritePromptText({
    system: imagePromptRewriteSystem(input.guide.guide),
    prompt: imagePromptRewriteAsk({
      prompt: input.prompt,
      context: input.context,
    }),
    model: input.model,
    signal: input.signal,
  });
  if (said === "") {
    throw new Error(i18n.t("editor:promptPanel.rewriteEmpty"));
  }
  return {
    prompt: said,
    issues: promptContractIssues(said, input.guide.checks, {
      sourcePrompt: input.prompt,
    }),
  };
}
