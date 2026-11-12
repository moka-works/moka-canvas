/**
 * An old take let go for good: out of the place that kept it, and off the
 * shelf with it.
 *
 * The place's own write happens first and is the caller's — the card hands over
 * what dropping a take means for the slot it belongs to. What is left is the
 * files, and a file is not the room's to drop on its own: the server refuses to
 * remove anything the document still points at, so the step that took the take
 * out has to have landed before the shelf is asked. That is why the two are one
 * flow and not two calls — half of it alone would either refuse the file or
 * leave it behind.
 *
 * A take may be more than one file — an act longer than one clip is filmed in
 * pieces and kept as the pieces — so every file of the take is handed over, and
 * the whole take leaves the shelf together.
 *
 * What comes back is the line the picks dialog says under its list: nothing
 * when the files went, and the reason one stayed when it did not. A file the
 * rest of the project also uses is not a failure — the reader asked for this
 * place's copy to go, and that part has happened.
 */

import { assetsApi } from "../../../api/assets";
import { isApiError } from "../../../api/client";
import type { StoryDocument } from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import {
  saveTrouble,
  settleBeforeFiling,
  useProjectStore,
} from "../../editor/stores/projectStore";

/** What the caller's write did to the place. */
export type TakeDrop =
  /** The take is out of the slot, and its file is the caller's next errand. */
  | "dropped"
  /** The place no longer holds that take: a stale ask, or one already gone. */
  | "gone"
  /** The document would not take the change, and the room has said why. */
  | "refused";

/** The story as the document holds it now, which is not what a render saw. */
export function liveStory(storyId: string): StoryDocument | undefined {
  return (useProjectStore.getState().moka?.stories ?? []).find(
    (story) => story.id === storyId,
  );
}

/**
 * Throws an old take away: the slot first, by the caller's own write, and the
 * file after it.
 *
 * The drop is read off the live document rather than off the render the reader
 * clicked in, because a slot is written whole: a place computed from a render
 * would put back whatever a job landed while the picks dialog stood open — or
 * drop it, depending on which way the render was stale.
 */
export async function removeOldTake(
  assetIds: string | string[],
  drop: () => TakeDrop,
): Promise<string | undefined> {
  const files = Array.isArray(assetIds) ? assetIds : [assetIds];
  // A read of the document that has started is on its way to replacing it, and
  // a take dropped from what that read is about to overwrite would be dropped
  // for nothing.
  await useProjectStore.getState().untilAdopted();
  const outcome = drop();
  if (outcome === "gone") return i18n.t("story:panels.removeGone");
  if (outcome === "refused") return saveTrouble().message;
  // The step that took the take out is the document's only once it has landed,
  // and the server reads the document to decide whether the file is still
  // wanted. A flush already on its way carried only what was pending when it
  // started, so the step may still be queued behind it: the document has
  // settled when a flush has carried everything, not when one has answered.
  if (!(await settleBeforeFiling()) && !(await settleBeforeFiling())) {
    return i18n.t("story:panels.removeUnsettled");
  }
  let notice: string | undefined;
  for (const assetId of files) {
    try {
      const result = await assetsApi.remove(assetId);
      useProjectStore.getState().removeAssetEntry(assetId, result);
    } catch (error) {
      // Still wanted elsewhere: the story has let it go, the shelf has not.
      if (isApiError(error, "ASSET_IN_USE")) {
        notice ??= i18n.t("story:panels.removeKept");
        continue;
      }
      // Undoing the step brings the take back with its file already gone, so
      // asking for it again finds nothing to remove — which is the outcome that
      // was wanted.
      if (isApiError(error, "NOT_FOUND")) continue;
      notice ??= i18n.t("story:panels.removeFailed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return notice;
}
