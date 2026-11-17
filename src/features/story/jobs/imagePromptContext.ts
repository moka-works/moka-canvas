/**
 * The material an image prompt is planned from, as its rewrite reads it.
 *
 * A frame's picture is drawn from a shot and the cast that stands in it; an
 * element's picture is drawn from that element's own description and the
 * picture it is made from, if any. Both are read here so the dialog can hand
 * the text model the facts the automatic prompt carried, without the prompt
 * itself having to explain them.
 */
import {
  actAt,
  elementForm,
  elementOf,
  formAspect,
  formDescription,
  formName,
  keyframeAt,
  stripStoryMentions,
} from "../../../shared/domain/story";
import type { ImagePromptContext } from "../../../shared/prompts/image/promptContext";
import { actDefaultReferences, keyframeCast, planElementArt } from "./plan";

/** One shot's picture, as the material it is drawn from. */
export function keyframeArtPromptContext(
  story: Parameters<typeof actAt>[0],
  chapterId: string,
  actId: string,
  keyframeId: string,
): ImagePromptContext | null {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  const act = actAt(story, chapterId, actId);
  const keyframe = keyframeAt(story, { chapterId, actId, keyframeId });
  if (chapter === undefined || act === undefined || keyframe === undefined)
    return null;
  const cast = keyframeCast(
    story,
    keyframe.content,
    keyframe.references,
    keyframe.variantChoices ?? {},
    actDefaultReferences(act),
  ).carried;
  return {
    kind: "frame",
    mode: cast.length > 0 ? "reference" : "generate",
    aspect: story.brief.aspect,
    style: story.brief.style,
    references: cast.map(({ name, description }) => ({ name, description })),
    frame: {
      chapter: chapter.title,
      act: act.summary,
      content: stripStoryMentions(keyframe.content),
      shotSize: keyframe.shotSize,
      cameraMove: keyframe.cameraMove,
      angle: keyframe.angle,
    },
  };
}

/** One element's picture, as the material it is drawn from. */
export function elementArtPromptContext(
  story: Parameters<typeof elementOf>[0],
  elementId: string,
  view: "main" | "turnaround",
  variantId?: string,
): ImagePromptContext | null {
  const element = elementOf(story, elementId);
  if (element === undefined) return null;
  const form = elementForm(element, variantId);
  if (variantId !== undefined && form === undefined) return null;
  const name = formName(element, form);
  const description = formDescription(element, form);
  const planned = planElementArt(story, [
    {
      elementId,
      view,
      ...(variantId === undefined ? {} : { variantId }),
    },
  ])[0];
  const carriesPicture = (planned?.inputs?.length ?? 0) > 0;
  return {
    kind: "element",
    mode: carriesPicture ? "reference" : "generate",
    aspect: view === "turnaround" ? "1:1" : formAspect(story, element, form),
    style: story.brief.style,
    references: carriesPicture ? [{ name, description }] : [],
    element: {
      kind: element.kind,
      name,
      description,
      view,
    },
  };
}
