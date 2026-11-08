/**
 * The names a shot's words may mention, and the @ that offers them.
 *
 * A shot's words name the pictures that travel with it by writing a name in
 * backticks; the field draws each as a chip. This is where the names come
 * from — the cast, every form of it, and the pictures the shot carries beside
 * it — and where what is being typed after an @ is read.
 */

import {
  elementForms,
  elementOf,
  formName,
  type StoryDocument,
} from "../../../shared/domain";
import type { StoryExtraReference } from "../../../shared/domain/types";

/** One thing the @ may mention, and the name it is written as. */
export interface StoryMentionOption {
  /** The row's own name, which tells two forms of one element apart. */
  key: string;
  /** What the offer shows: the form's name, or the extra's own. */
  label: string;
  /** What is written into the words: the name the cast reads the picture by. */
  name: string;
  group: "cast" | "extra";
  /** The cast form this choice draws the shot in, where it is one. */
  elementId?: string;
  variantId?: string;
}

/** Every name a shot's words may mention: its cast, forms first, then extras. */
export function storyMentionOptions(
  story: StoryDocument,
  extras: StoryExtraReference[],
): StoryMentionOption[] {
  const options: StoryMentionOption[] = [];
  const named = new Set<string>();
  for (const element of story.elements) {
    for (const form of elementForms(element)) {
      const name = element.name;
      if (named.has(`cast:${element.id}:${form?.id ?? ""}`)) continue;
      named.add(`cast:${element.id}:${form?.id ?? ""}`);
      named.add(`name:${name}`);
      options.push({
        key: `cast:${element.id}:${form?.id ?? ""}`,
        label: formName(element, form),
        name,
        group: "cast",
        elementId: element.id,
        ...(form === undefined ? {} : { variantId: form.id }),
      });
    }
  }
  extras.forEach((extra, at) => {
    if (extra.elementId === undefined) {
      // An extra with no name is a file nobody has named: a mention of it
      // would be prose the room cannot tell from any other word.
      if (extra.name === undefined || extra.name.trim() === "") return;
      const name = extra.name;
      if (named.has(`name:${name}`)) return;
      named.add(`name:${name}`);
      options.push({
        key: `extra:asset:${extra.assetId ?? at}`,
        label: name,
        name,
        group: "extra",
      });
      return;
    }
    const element = elementOf(story, extra.elementId);
    const form =
      element === undefined
        ? undefined
        : elementForms(element).find(
            (held) => (held?.id ?? "") === (extra.variantId ?? ""),
          );
    const name =
      extra.name ??
      (element === undefined ? undefined : formName(element, form));
    if (name === undefined || named.has(`name:${name}`)) return;
    named.add(`name:${name}`);
    options.push({
      key: `extra:element:${extra.elementId}:${extra.variantId ?? ""}:${at}`,
      label: name,
      name,
      group: "extra",
    });
  });
  return options;
}

/** The names an offer shows for what has been typed after the @. */
export function narrowStoryMentions(
  options: StoryMentionOption[],
  query: string,
): StoryMentionOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return options;
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.name.toLowerCase().includes(needle),
  );
}

/**
 * The @ the caret is in the middle of typing, or null when it is in prose.
 *
 * An @ only offers names when it starts a word: one glued to a Latin word is
 * part of an address. Whitespace after it ends the offer, and so does a
 * closing backtick, because that mention is finished. A Chinese character
 * before it is a word's end without needing a space, so the offer opens.
 */
export function storyMentionBeingTyped(
  prompt: string,
  caret: number,
): { start: number; query: string } | null {
  if (caret <= 0) return null;
  const start = prompt.lastIndexOf("@", caret - 1);
  if (start < 0) return null;
  if (start > 0 && /[A-Za-z0-9_.]/.test(prompt[start - 1])) return null;
  const typed = prompt.slice(start + 1, caret);
  if (/[\s`]/.test(typed)) return null;
  return { start, query: typed };
}

/** The words after one name is taken up, and where the caret then stands. */
export function insertStoryMention(
  value: string,
  start: number,
  caret: number,
  name: string,
): { value: string; caret: number } {
  const token = `\`${name}\` `;
  return {
    value: `${value.slice(0, start)}${token}${value.slice(caret)}`,
    caret: start + token.length,
  };
}
