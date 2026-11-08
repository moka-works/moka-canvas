/**
 * An element the reader typed in themselves, and the one command that puts it
 * into the telling.
 *
 * The board's own reference row and step three's add button make the same
 * thing, so the shape an element is born with lives here: no pictures, the
 * chapters it was said to stand in, and the four views a character will want.
 */

import type {
  StoryDocument,
  StoryElement,
  StoryElementKind,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";

/** What a reader types before an element exists. */
export interface ElementDraft {
  kind: StoryElementKind;
  name: string;
  description: string;
  /** The chapters it stands in; none is any chapter. */
  chapterIds?: string[];
}

/** A name for an element nobody read out of the chapters. */
export function nextElementId(story: StoryDocument): string {
  for (let at = story.elements.length + 1; ; at += 1) {
    const id = `element-added-${at}`;
    if (!story.elements.some((held) => held.id === id)) return id;
  }
}

/** The element a draft makes, before it is written into the story. */
export function elementFromDraft(
  story: StoryDocument,
  draft: ElementDraft,
): StoryElement {
  return {
    id: nextElementId(story),
    kind: draft.kind,
    name: draft.name,
    description: draft.description,
    chapterIds: draft.chapterIds ?? [],
    main: { takes: [] },
    ...(draft.kind === "character" ? { turnaround: { takes: [] } } : {}),
  };
}

/** Adds one hand-typed element to the telling, as one step of the history. */
export function addElementToStory(
  story: StoryDocument,
  draft: ElementDraft,
): StoryElement | undefined {
  const element = elementFromDraft(story, draft);
  const done = execute(i18n.t("story:history.elements"), [
    {
      type: "setStoryElements",
      storyId: story.id,
      elements: [...story.elements, element],
    },
  ]);
  return done === null ? undefined : element;
}
