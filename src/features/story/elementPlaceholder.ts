import type { StoryElementKind } from "../../shared/domain/types";

/**
 * The stand-in a kind is shown as until a drawing of it exists.
 *
 * One picture per kind, drawn as a dashed silhouette in the kind's own colour,
 * so a board that names someone nobody has drawn yet reads as a picture still
 * to come rather than as a missing one.
 */
const PLACEHOLDER_URLS: Record<StoryElementKind, string> = {
  character: "/story/element-character.svg",
  scene: "/story/element-scene.svg",
  prop: "/story/element-prop.svg",
};

/** The fixed picture standing in for an element that has no drawing yet. */
export function elementPlaceholderUrl(kind: StoryElementKind): string {
  return PLACEHOLDER_URLS[kind];
}
