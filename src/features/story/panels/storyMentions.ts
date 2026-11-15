/**
 * The names a shot's words may mention, and the @ that offers them.
 *
 * A shot's words name the pictures that travel with it by writing a name in
 * backticks; the field draws each as a chip. This is where the names come
 * from — the shot's own reference list: the cast names its words already use,
 * every form of them, and the extra pictures kept beside it — and where what is
 * being typed after an @ is read.
 */

import {
  elementForms,
  extraReferenceName,
  formName,
  storyMentions,
  type StoryDocument,
} from "../../../shared/domain";
import type {
  StoryElement,
  StoryExtraReference,
} from "../../../shared/domain/types";

/** One thing the @ may mention, and the name it is written as. */
export interface StoryMentionOption {
  /** The row's own name, which tells two forms of one element apart. */
  key: string;
  /** What the offer shows: the form's name, or the extra's own. */
  label: string;
  /** What is written into the words: the name the cast reads the picture by. */
  name: string;
  /** The cast form this choice draws the shot in, where it is one. */
  elementId?: string;
  variantId?: string;
}

/**
 * Every name a shot's words may mention: the cast its words already name,
 * forms first, then the pictures kept beside them.
 *
 * Nothing outside the shot's own reference list is offered: a picture the shot
 * does not carry has no place in the words, and is added to the list first.
 */
export function storyMentionOptions(
  story: StoryDocument,
  content: string,
  extras: StoryExtraReference[],
): StoryMentionOption[] {
  const options: StoryMentionOption[] = [];
  const named = new Set<string>();
  const mentioned = new Set(
    storyMentions(content).map((mention) => mention.name),
  );
  const byName = new Map<string, StoryElement>();
  for (const element of story.elements) {
    if (!byName.has(element.name)) byName.set(element.name, element);
  }
  for (const name of mentioned) {
    const element = byName.get(name);
    if (element === undefined) continue;
    for (const form of elementForms(element)) {
      const key = `cast:${element.id}:${form?.id ?? ""}`;
      if (named.has(key)) continue;
      named.add(key);
      named.add(`name:${name}`);
      options.push({
        key,
        label: formName(element, form),
        name,
        elementId: element.id,
        ...(form === undefined ? {} : { variantId: form.id }),
      });
    }
  }
  extras.forEach((extra, at) => {
    const name = extraReferenceName(story, extra);
    if (name === undefined || named.has(`name:${name}`)) return;
    named.add(`name:${name}`);
    options.push({
      key: `extra:${extra.elementId ?? extra.assetId ?? at}`,
      label: name,
      name,
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
