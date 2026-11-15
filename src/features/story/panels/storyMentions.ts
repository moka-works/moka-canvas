/**
 * The names a shot's words may mention, and the @ that offers them.
 *
 * A shot's words name the pictures that travel with it by writing a name in
 * backticks; the field draws each as a chip. This is where the names come
 * from — the shot's own reference list — and where what is being typed after
 * an @ is read.
 */

import { referenceName, type StoryDocument } from "../../../shared/domain";
import type {
  StoryElement,
  StoryKeyframeReference,
} from "../../../shared/domain/types";

/** One thing the @ may mention, and the name it is written as. */
export interface StoryMentionOption {
  /** The row's own name, which tells two references apart. */
  key: string;
  /** What the offer shows. */
  label: string;
  /** What is written into the words: the name the reference is kept by. */
  name: string;
}

/**
 * Every name a shot's words may mention: the names its references are kept by,
 * and the elements the act keeps at its top.
 *
 * The shot's own list comes first, in the order it was kept, so a name already
 * recognized is offered as the reference it stands on. The act's elements
 * follow, named as the story names them, so a name the shot has not kept yet
 * can be written at once — the words take it into the list as they are saved.
 * A name both lists use is offered once.
 */
export function storyMentionOptions(
  story: StoryDocument,
  references: StoryKeyframeReference[],
  cast: StoryElement[] = [],
): StoryMentionOption[] {
  const options: StoryMentionOption[] = [];
  const named = new Set<string>();
  references.forEach((reference, at) => {
    const name = referenceName(story, reference);
    if (name === "" || named.has(name)) return;
    named.add(name);
    options.push({
      key: `reference:${reference.elementId ?? reference.assetId ?? at}`,
      label: name,
      name,
    });
  });
  for (const element of cast) {
    const name = element.name.trim();
    if (name === "" || named.has(name)) continue;
    named.add(name);
    options.push({ key: `element:${element.id}`, label: name, name });
  }
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
