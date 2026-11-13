/**
 * Rewriting a clip's prompt into the contract its video model reads.
 *
 * A protocol declares the contract and the client applies it: the guide's
 * words, the material the clip is made of, and the prompt as it stands are
 * given to the room's own text model, and what comes back is put in front of
 * the reader before anything is sent. Nothing here sends a video ask, and
 * nothing writes into the document — the dialog owns both.
 */
import { generateApi } from "../../../api/generate";
import { i18n } from "../../../shared/i18n";
import {
  storyPromptRewriteAsk,
  storyPromptRewriteSystem,
} from "../../../shared/prompts";
import type { StoryPromptContext } from "../../../shared/prompts/story/promptContext";
import { effectiveDefaultId, useModelStore } from "../../settings/modelStore";
import { storyAskModel, storyTextModel } from "../stores/storyModels";
import {
  cleanRewrittenPrompt,
  promptContractIssues,
  readPromptContractChecks,
  type PromptContractChecks,
  type PromptContractIssue,
} from "./promptContract";

/** A video protocol's prompt contract, as the client applies it. */
export interface PromptRewriteGuide {
  guide: string;
  checks: PromptContractChecks;
  version: number;
}

/**
 * The contract the model this kind of clip is filmed by declares, or none.
 *
 * The model is the one the batch will actually be asked of — the room's own
 * choice where it has one, the deployment's default otherwise — so the
 * contract offered is the contract the words will be held to.
 */
export function videoPromptRewrite(
  kind: "actVideo" | "keyframeVideo",
): PromptRewriteGuide | null {
  const { view, protocols } = useModelStore.getState();
  if (view === null || protocols === null) return null;
  const id = storyAskModel(kind) ?? effectiveDefaultId(view, "video");
  const model = view.models.find((held) => held.id === id);
  if (model === undefined) return null;
  const declared = protocols.video?.[model.protocol]?.promptRewrite;
  if (declared === undefined) return null;
  return {
    guide: declared.guide,
    checks: readPromptContractChecks(declared.checks),
    version: declared.version,
  };
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
  signal?: AbortSignal;
}): Promise<RewrittenPrompt> {
  const model = storyTextModel();
  const answer = await generateApi.text(
    {
      capability: "text",
      ...(model === null ? {} : { model }),
      system: storyPromptRewriteSystem(input.guide.guide),
      prompt: storyPromptRewriteAsk({
        prompt: input.prompt,
        ...(input.context === undefined ? {} : { context: input.context }),
      }),
      params: { temperature: 0.2 },
    },
    input.signal,
  );
  const said = answer.text?.trim() ?? "";
  if (said === "") {
    throw new Error(i18n.t("story:storyboard.videoPromptRewriteEmpty"));
  }
  const prompt = cleanRewrittenPrompt(said);
  return {
    prompt,
    issues: promptContractIssues(prompt, input.context, input.guide.checks),
  };
}
