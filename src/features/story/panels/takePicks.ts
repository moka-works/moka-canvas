import {
  slotWithCurrent,
  slotWithoutTake,
  voiceTakeOf,
} from "../../../shared/domain";
import type { StoryDocument, StorySlot } from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { liveStory, removeOldTake, type TakeDrop } from "./removeOldTake";

/**
 * A place whose takes a reader chooses between: a clip or a piece of sound.
 *
 * Every one of them is redrawn rather than overwritten, so the takes a card
 * holds are a history — and which of them the place is using is one write of
 * that history, not of anything beside it.
 */
export type TakePlace =
  | { kind: "actVideo"; chapterId: string; actId: string }
  | {
      kind: "keyframeVideo";
      chapterId: string;
      actId: string;
      keyframeId: string;
    }
  | { kind: "actVoice"; chapterId: string; actId: string }
  | { kind: "actMusic"; chapterId: string; actId: string }
  | {
      kind: "lineVoice";
      chapterId: string;
      actId: string;
      keyframeId: string;
      lineId: string;
    };

/** The slot a place names, as the document holds it. */
export function slotAt(
  story: StoryDocument,
  place: TakePlace,
): StorySlot | undefined {
  const chapter = story.chapters.find((held) => held.id === place.chapterId);
  const act = chapter?.acts.find((held) => held.id === place.actId);
  if (act === undefined) return undefined;
  switch (place.kind) {
    case "actVideo":
      return act.video;
    case "actVoice":
      return act.voice;
    case "actMusic":
      return act.music;
    case "keyframeVideo":
      return act.keyframes.find((held) => held.id === place.keyframeId)?.video;
    case "lineVoice": {
      const keyframe = act.keyframes.find(
        (held) => held.id === place.keyframeId,
      );
      return keyframe === undefined
        ? undefined
        : voiceTakeOf(keyframe, place.lineId)?.slot;
    }
  }
}

function writeSlot(
  story: StoryDocument,
  place: TakePlace,
  slot: StorySlot,
): boolean {
  return (
    execute(i18n.t("story:history.storyboard"), [
      { type: "setStorySlot", storyId: story.id, target: place, slot },
    ]) !== null
  );
}

/**
 * Keeps the take a reader picked, written onto the document as it stands now.
 *
 * Read off the live document rather than off the render the dialog was opened
 * in, because a slot is written whole: a place computed from a render would put
 * back whatever a job landed while the dialog stood open.
 */
export function keepTake(
  storyId: string,
  place: TakePlace,
  assetId: string,
): void {
  const live = liveStory(storyId);
  const slot = live === undefined ? undefined : slotAt(live, place);
  if (live === undefined || slot === undefined) return;
  writeSlot(live, place, slotWithCurrent(slot, assetId));
}

/**
 * Throws one of a place's old takes away: the whole take leaves the slot, and
 * every file it is made of leaves the shelf with it.
 */
export function removeTake(
  storyId: string,
  place: TakePlace,
  assetId: string,
): Promise<string | undefined> {
  const live = liveStory(storyId);
  const take =
    live === undefined
      ? undefined
      : slotAt(live, place)?.takes.find((held) =>
          held.assetIds.includes(assetId),
        );
  const files = take?.assetIds ?? [assetId];
  return removeOldTake(files, () => dropTake(storyId, place, assetId));
}

function dropTake(
  storyId: string,
  place: TakePlace,
  assetId: string,
): TakeDrop {
  const live = liveStory(storyId);
  const slot = live === undefined ? undefined : slotAt(live, place);
  if (live === undefined || slot === undefined) return "gone";
  const without = slotWithoutTake(slot, assetId);
  if (without === slot) return "gone";
  return writeSlot(live, place, without) ? "dropped" : "refused";
}
