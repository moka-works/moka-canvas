/**
 * What an edit of a picture asks for: the same place the picture lives in,
 * asked again with the picture itself as the subject of the change.
 *
 * An edit is not a redraw. A redraw is planned from the words alone, which is
 * what makes a reference a reference; an edit hands the kept picture back to
 * the model with an instruction and — where the model takes one — a mask that
 * says which part may change. What comes home lands in the same place as a new
 * take, so the old picture is not lost and the board reads the new one.
 */

import type {
  StoryJobInput,
  StoryJobItemDraft,
  StoryTarget,
} from "../../../api/story";
import { currentTake, elementAspect } from "../../../shared/domain";
import type {
  StoryAct,
  StoryDocument,
  StoryElement,
  StoryElementVariant,
  StoryKeyframe,
} from "../../../shared/domain/types";
import type { ElementView } from "../panels/elementPictures";
import { imageSizeForAspect, jobKey } from "./plan";

/** The place an edited picture belongs to. */
export type EditPlace =
  | {
      kind: "element";
      element: StoryElement;
      /** The form being edited; absent means the default form. */
      variant?: StoryElementVariant;
      view: ElementView;
    }
  | {
      kind: "keyframe";
      chapterId: string;
      act: StoryAct;
      keyframe: StoryKeyframe;
    };

/** How the picture being edited is asked about. */
export interface EditAsk {
  /** What should change, in the reader's own words. */
  instruction: string;
  /** The filed mask, white where the picture may change. */
  maskAssetId?: string;
}

/** The target a place writes back to. */
export function editTarget(place: EditPlace): StoryTarget {
  if (place.kind === "element") {
    return {
      kind: "elementArt",
      elementId: place.element.id,
      view: place.view,
      ...(place.variant === undefined ? {} : { variantId: place.variant.id }),
    };
  }
  return {
    kind: "keyframeArt",
    chapterId: place.chapterId,
    actId: place.act.id,
    keyframeId: place.keyframe.id,
  };
}

/** The picture an edit starts from, which is the one the place keeps. */
export function editSource(place: EditPlace): string | undefined {
  const slot =
    place.kind === "element"
      ? place.view === "main"
        ? (place.variant?.main ?? place.element.main)
        : (place.variant?.turnaround ?? place.element.turnaround)
      : place.keyframe.art;
  return currentTake(slot ?? { takes: [] })?.assetIds[0];
}

/** What a thing is called in a picture prompt, in the prompt's own words. */
const ELEMENT_NOUN: Record<StoryElement["kind"], string> = {
  character: "character",
  scene: "place",
  prop: "thing",
};

/** The words an edit asks in, written as a model reads a change. */
function editPrompt(
  story: StoryDocument,
  place: EditPlace,
  mask: boolean,
): string {
  const look = `The film's look: ${story.brief.style}. No text, no lettering, no watermark, no frame around the picture.`;
  const lines =
    place.kind === "element"
      ? [
          `Edit the reference picture of the ${ELEMENT_NOUN[place.element.kind]} "${place.variant === undefined ? place.element.name : `${place.element.name} (${place.variant.name})`}" from the attached picture. Keep everything else unchanged — the same face, hair, clothes, body and look; change only what the instruction says.`,
          look,
        ]
      : [
          `Edit this shot's frame from the attached picture. Keep the composition, the framing and the people, the place and the things exactly as they are; change only what the instruction says.`,
          `This shot: ${place.keyframe.content}. ${look}`,
        ];
  if (mask) {
    lines.push(
      "The second picture is a black-and-white mask: white marks the region to change and black the region to keep.",
    );
  }
  return lines.join("\n");
}

/**
 * One edit, as the piece its batch carries.
 *
 * The instruction stands on the first line, because that is the line a take is
 * filed under: a version whose note is the reader's own words is one they can
 * tell from the drawing it was made from. Nothing is planned when the place
 * holds no picture — there is nothing to hand back to be changed.
 */
export function planPictureEdit(
  story: StoryDocument,
  place: EditPlace,
  ask: EditAsk,
): StoryJobItemDraft | undefined {
  const source = editSource(place);
  if (source === undefined) return undefined;
  const target = editTarget(place);
  const mask = ask.maskAssetId !== undefined;
  const inputs: StoryJobInput[] = [{ role: "reference", assetId: source }];
  if (ask.maskAssetId !== undefined) {
    inputs.push({ role: "mask", assetId: ask.maskAssetId });
  }
  const size =
    place.kind === "element"
      ? imageSizeForAspect(
          place.view === "turnaround"
            ? "1:1"
            : elementAspect(story, place.element),
        )
      : imageSizeForAspect(story.brief.aspect);
  return {
    id: jobKey(target),
    target,
    capability: "image",
    prompt: `${ask.instruction.trim()}\n${editPrompt(story, place, mask)}`,
    inputs,
    params: { size },
  };
}
