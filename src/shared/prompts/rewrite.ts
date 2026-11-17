/**
 * The one ask a rewritten prompt is made with, whichever medium it is for.
 *
 * A protocol declares the contract and the feature supplies the material; this
 * is where the text model is asked and where the answer is unwrapped. Nothing
 * here sends the image or video ask, and nothing writes into a document.
 */
import type { ProtocolGroups } from "../../api/models";
import { generateApi } from "../../api/generate";
import type { Capability } from "../domain";
import {
  cleanRewrittenPrompt,
  readPromptContractChecks,
  type PromptContractChecks,
} from "./promptContract";

/** A protocol's prompt contract, as the client applies it. */
export interface PromptRewriteGuide {
  guide: string;
  checks: PromptContractChecks;
  version: number;
}

/**
 * The contract the protocol of one model declares, or none.
 *
 * The caller resolves which model will send the ask — including the
 * deployment's default when nobody named one — and hands over the protocol
 * that model speaks.
 */
export function promptRewriteGuide(
  protocols: ProtocolGroups | null,
  capability: Capability,
  protocol: string | undefined,
): PromptRewriteGuide | null {
  if (protocols === null || protocol === undefined) return null;
  const declared = protocols[capability]?.[protocol]?.promptRewrite;
  if (declared === undefined) return null;
  return {
    guide: declared.guide,
    checks: readPromptContractChecks(declared.checks),
    version: declared.version,
  };
}

/**
 * One text-model answer, cleaned of its wrappings.
 *
 * An empty answer is returned as an empty line rather than thrown here: each
 * surface says that in its own words, beside the field the reader is looking
 * at. A refusal is thrown as it came, so the surface can show the reason whole.
 */
export async function rewritePromptText(input: {
  system: string;
  prompt: string;
  model?: string | null;
  signal?: AbortSignal;
}): Promise<string> {
  const answer = await generateApi.text(
    {
      capability: "text",
      ...(input.model === undefined || input.model === null
        ? {}
        : { model: input.model }),
      system: input.system,
      prompt: input.prompt,
      params: { temperature: 0.2 },
    },
    input.signal,
  );
  return cleanRewrittenPrompt(answer.text?.trim() ?? "");
}
