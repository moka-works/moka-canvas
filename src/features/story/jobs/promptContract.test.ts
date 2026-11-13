import { describe, expect, it } from "vitest";

import type { StoryPromptContext } from "../../../shared/prompts/story/promptContext";
import {
  cleanRewrittenPrompt,
  promptContractIssues,
  readPromptContractChecks,
} from "./promptContract";

const CONTEXT: StoryPromptContext = {
  kind: "shot",
  aspect: "9:16",
  style: "live action",
  seconds: 5,
  ends: { first: true, last: false, references: false },
  shots: [{ text: "A rainy bus stop.", seconds: 5 }],
  cast: [{ name: "林", ref: "S1", kind: "character", description: "A woman." }],
  dialogue: [{ speaker: "林", ref: "S1", text: "车已经停运了。" }],
};

const CHECKS = { bodyLanguage: "en", dialogueTag: "d", negativeBait: true };

function asked(body: string): string {
  return `integrated_multimodal_description: ${body}

overall_soundscape: Rain on the pavement.

non_diegetic_music: N/A`;
}

describe("a rewritten prompt, before it is sent", () => {
  it("is unwrapped from the fences and the line a model likes to announce itself with", () => {
    expect(
      cleanRewrittenPrompt(
        "Here is the rewritten prompt:\n```text\nintegrated_multimodal_description: [Shot 1] A room.\n```",
      ),
    ).toBe("integrated_multimodal_description: [Shot 1] A room.");
  });

  it("keeps a line that stayed inside its spoken-word block", () => {
    const prompt = asked(
      "[Shot 1] A woman at a bus stop (S1) says: <d>[Chinese] 车已经停运了。</d> Her lips move, then close.",
    );
    expect(promptContractIssues(prompt, CONTEXT, CHECKS)).toEqual([]);
  });

  it("names a line the rewrite dropped", () => {
    const prompt = asked("[Shot 1] A woman waits at a bus stop.");
    expect(promptContractIssues(prompt, CONTEXT, CHECKS)).toEqual([
      { code: "dialogueMissing", line: "车已经停运了。" },
    ]);
  });

  it("names a speaker the material does not have", () => {
    const prompt = asked(
      "[Shot 1] A woman (S7) says: <d>[Chinese] 车已经停运了。</d>",
    );
    expect(promptContractIssues(prompt, CONTEXT, CHECKS)).toContainEqual({
      code: "unknownSpeaker",
      ref: "S7",
    });
  });

  it("finds Chinese outside the spoken-word blocks and not inside them", () => {
    const prompt = asked(
      "[Shot 1] 雨中的站台。(S1) says: <d>[Chinese] 车已经停运了。</d>",
    );
    const issues = promptContractIssues(prompt, CONTEXT, CHECKS);
    expect(issues.map((issue) => issue.code)).toContain("bodyNotEnglish");
  });

  it("finds an instruction about subtitles, which invites them", () => {
    const prompt = `${asked(
      "[Shot 1] A woman (S1) says: <d>[Chinese] 车已经停运了。</d>",
    )} No subtitles.`;
    expect(promptContractIssues(prompt, CONTEXT, CHECKS)).toContainEqual({
      code: "negativeInstruction",
      phrase: "no subtitles",
    });
  });

  it("says nothing when the protocol asked for nothing", () => {
    expect(promptContractIssues("anything at all", undefined, {})).toEqual([]);
    expect(readPromptContractChecks(undefined)).toEqual({});
    expect(
      readPromptContractChecks({ dialogueTag: "d", negativeBait: true }),
    ).toEqual({ dialogueTag: "d", negativeBait: true });
  });
});
