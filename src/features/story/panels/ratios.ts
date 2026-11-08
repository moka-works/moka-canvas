import { formAspect } from "../../../shared/domain/story";
import type {
  StoryDocument,
  StoryElement,
  StoryElementVariant,
} from "../../../shared/domain/types";

/** Every frame of a story has the shape the story is told in. */
const RATIOS: Record<string, string> = {
  "16:9": "16 / 9",
  "9:16": "9 / 16",
  "1:1": "1 / 1",
  "4:3": "4 / 3",
  "21:9": "21 / 9",
};

/** The shape a place holds, as the CSS aspect ratio a picture is drawn in. */
export function frameRatio(story: StoryDocument): string {
  return RATIOS[story.brief.aspect] ?? "16 / 9";
}

/** The shape an element's main picture holds, by the frame it is drawn in. */
export function elementRatio(
  story: StoryDocument,
  element: StoryElement,
  form?: StoryElementVariant,
): string {
  return RATIOS[formAspect(story, element, form)] ?? "1 / 1";
}
