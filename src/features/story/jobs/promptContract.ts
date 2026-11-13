/**
 * What a rewritten prompt is checked against before the reader sends it.
 *
 * The contract a protocol declares is words for a model, and a model may not
 * follow them. The parts that can be checked without understanding the model
 * are declared beside the guide — the language the body is written in, the tag
 * that marks spoken words, whether negative instructions bait it — and this is
 * where they are read. Nothing here decides what is sent: the reader does, in
 * front of the words, with what is wrong named beside them.
 */
import { MAX_PROMPT_LENGTH } from "../../../shared/domain/constants";
import type { StoryPromptContext } from "../../../shared/prompts/story/promptContext";

/** The checkable part of a protocol's prompt contract. */
export interface PromptContractChecks {
  /** The language everything outside the dialogue tag is written in. */
  bodyLanguage?: string;
  /** The element spoken lines are wrapped in, without its angle brackets. */
  dialogueTag?: string;
  /** Whether naming subtitles or on-screen text invites them instead. */
  negativeBait?: boolean;
}

/** What is wrong with a rewritten prompt, in terms a reader is told in. */
export type PromptContractIssue =
  | { code: "empty" }
  | { code: "tooLong"; max: number }
  | { code: "unbalancedTags"; tag: string }
  | { code: "dialogueMissing"; line: string }
  | { code: "unknownSpeaker"; ref: string }
  | { code: "bodyNotEnglish"; sample: string }
  | { code: "negativeInstruction"; phrase: string };

/** The checks a protocol declared, read into their own shape. */
export function readPromptContractChecks(
  raw: Record<string, unknown> | undefined,
): PromptContractChecks {
  if (raw === undefined) return {};
  const checks: PromptContractChecks = {};
  if (typeof raw.bodyLanguage === "string" && raw.bodyLanguage.trim() !== "") {
    checks.bodyLanguage = raw.bodyLanguage.trim();
  }
  if (typeof raw.dialogueTag === "string" && raw.dialogueTag.trim() !== "") {
    checks.dialogueTag = raw.dialogueTag.trim();
  }
  if (typeof raw.negativeBait === "boolean") {
    checks.negativeBait = raw.negativeBait;
  }
  return checks;
}

/**
 * The prompt a model wrote, with the wrappings a model likes to add taken off.
 *
 * A fenced block is unwrapped and a line announcing the answer is dropped;
 * nothing inside the words is touched. A model that answered with more than
 * wrappings — a preamble, an explanation after — is left for the reader to
 * see and fix, because guessing where its prompt ended would be worse than
 * showing it whole.
 */
export function cleanRewrittenPrompt(text: string): string {
  let held = text.trim();
  const lines = held.split("\n");
  while (lines.length > 1 && lines[0]!.trim() === "") lines.shift();
  if (
    lines.length > 1 &&
    /^(here('s| is)|the rewritten prompt|rewritten prompt|prompt)\b[^:：]*[:：]\s*$/i.test(
      lines[0]!.trim(),
    )
  ) {
    lines.shift();
  }
  held = lines.join("\n").trim();
  const fenced = held.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced !== null) held = fenced[1]!.trim();
  return held;
}

const NEGATIVE_INSTRUCTIONS = [
  "no subtitles",
  "without subtitles",
  "no captions",
  "without captions",
  "no text",
  "no lettering",
  "no watermark",
  "no writing",
  "nothing written",
  "无字幕",
  "不要字幕",
  "不加字幕",
  "不要文字",
  "画面无文字",
  "不要出现文字",
];

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * What a rewritten prompt gets wrong, in the order a reader would fix it.
 *
 * The contract is advisory here rather than enforced: every issue is shown
 * beside the words, and the reader may still send them. A missing line is the
 * one worth reading twice — it is what a model drops when it translates —
 * so each line the material holds is looked for, character for character,
 * inside a spoken-word block.
 */
export function promptContractIssues(
  prompt: string,
  context: StoryPromptContext | undefined,
  checks: PromptContractChecks,
): PromptContractIssue[] {
  const issues: PromptContractIssue[] = [];
  const held = prompt.trim();
  if (held === "") {
    issues.push({ code: "empty" });
    return issues;
  }
  if (held.length > MAX_PROMPT_LENGTH) {
    issues.push({ code: "tooLong", max: MAX_PROMPT_LENGTH });
  }

  const tag = checks.dialogueTag;
  let blocks: string[] = [];
  if (tag !== undefined) {
    const open = new RegExp(`<${tag}>`, "g");
    const close = new RegExp(`</${tag}>`, "g");
    const opened = held.match(open)?.length ?? 0;
    const closed = held.match(close)?.length ?? 0;
    if (opened !== closed) issues.push({ code: "unbalancedTags", tag });
    blocks = [
      ...held.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")),
    ].map((match) => match[1] ?? "");
  }

  for (const line of context?.dialogue ?? []) {
    const said = line.text.trim();
    if (said === "") continue;
    if (!blocks.some((block) => block.includes(said))) {
      issues.push({ code: "dialogueMissing", line: said });
    }
  }

  if (context !== undefined && context.cast.length > 0) {
    const allowed = new Set<string>();
    for (const member of context.cast) allowed.add(member.ref);
    for (const line of context.dialogue) {
      if (line.ref !== undefined) allowed.add(line.ref);
    }
    const used = held.match(/\(S\d+(?:\s*,\s*S\d+)*\)/g) ?? [];
    for (const group of used) {
      for (const ref of group.slice(1, -1).split(/\s*,\s*/)) {
        if (!allowed.has(ref)) issues.push({ code: "unknownSpeaker", ref });
      }
    }
  }

  if (checks.bodyLanguage === "en" && tag !== undefined) {
    const body = held.replace(
      new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"),
      "",
    );
    const found = body.match(HAN);
    if (found !== null) {
      const at = body.indexOf(found[0]);
      issues.push({
        code: "bodyNotEnglish",
        sample: body.slice(Math.max(0, at - 12), at + 12).trim(),
      });
    }
  }

  if (checks.negativeBait === true) {
    const lower = held.toLowerCase();
    const phrase = NEGATIVE_INSTRUCTIONS.find((candidate) =>
      lower.includes(candidate),
    );
    if (phrase !== undefined)
      issues.push({ code: "negativeInstruction", phrase });
  }

  return issues;
}
