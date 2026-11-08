/**
 * The ways an element's place takes a picture: one already kept, one from the
 * shelf, or one from this computer.
 *
 * Step three's cards and step four's picture inspector are two doors to the
 * same places, so what binding a picture to a place means lives here rather
 * than on either door. Every write goes through the command pipeline, and the
 * upload files the picture on the shelf before the command can name it.
 */

import { errorText } from "../../../api/client";
import { assetsApi } from "../../../api/assets";
import { slotWithCurrent, withTake } from "../../../shared/domain";
import type {
  StoryDocument,
  StoryElement,
  StorySlot,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { saveTrouble, useProjectStore } from "../../editor/stores/projectStore";

export type ElementView = "main" | "turnaround";

function slotOf(
  element: StoryElement,
  view: ElementView,
  variantId?: string,
): StorySlot | undefined {
  if (variantId !== undefined) {
    const form = (element.variants ?? []).find(
      (variant) => variant.id === variantId,
    );
    if (form === undefined) return undefined;
    return view === "main" ? form.main : form.turnaround;
  }
  return view === "main" ? element.main : element.turnaround;
}

/** One of an element's places, written whole as one step of the history. */
export function writeElementSlot(
  story: StoryDocument,
  element: StoryElement,
  view: ElementView,
  slot: StorySlot,
  variantId?: string,
): boolean {
  return (
    execute(i18n.t("story:history.elements"), [
      {
        type: "setStorySlot",
        storyId: story.id,
        target: {
          kind: "element",
          elementId: element.id,
          view,
          ...(variantId === undefined ? {} : { variantId }),
        },
        slot,
      },
    ]) !== null
  );
}

/** Keeps a picture the place already holds, letting the older ones stay. */
export function chooseElementTake(
  story: StoryDocument,
  element: StoryElement,
  view: ElementView,
  assetId: string,
  variantId?: string,
): void {
  const slot = slotOf(element, view, variantId);
  if (slot === undefined) return;
  writeElementSlot(
    story,
    element,
    view,
    slotWithCurrent(slot, assetId),
    variantId,
  );
}

/**
 * A picture from the shelf, kept as the place's newest take.
 *
 * The file may be one the place has never held — a drawing from another
 * telling, or one brought in from this computer — so this keeps a take for it
 * rather than walking a list of takes it is already among.
 */
export function keepElementPicture(
  story: StoryDocument,
  element: StoryElement,
  view: ElementView,
  assetId: string,
  variantId?: string,
): void {
  const slot = slotOf(element, view, variantId);
  if (slot === undefined) return;
  writeElementSlot(
    story,
    element,
    view,
    withTake(slot, {
      assetIds: [assetId],
      createdAt: new Date().toISOString(),
    }),
    variantId,
  );
}

/**
 * A picture from this computer, filed on the shelf.
 *
 * The file is the project's before any place can name it, so what is waiting
 * to be saved goes first: a command pointing at a file the server has not been
 * told about yet is a command it refuses. Answers with the new file's name, or
 * with nothing when it could not be filed — the reason is said where it is
 * known rather than read off a missing file afterwards.
 */
export async function filePictureFromComputer(
  file: File,
): Promise<string | undefined> {
  try {
    await useProjectStore.getState().flush();
    const after = useProjectStore.getState();
    if (after.pending.length > 0 || after.saveStatus === "conflicted") {
      const blocked = saveTrouble();
      useAppStore
        .getState()
        .pushToast("error", blocked.message, undefined, blocked.detail);
      return undefined;
    }
    const filed = await assetsApi.upload(file, { categoryHint: "images" });
    useProjectStore.getState().integrateAssetEntry(filed.entry, {
      revision: filed.revision,
      updatedAt: filed.updatedAt,
    });
    return filed.entry.id;
  } catch (problem) {
    const trouble = errorText(problem);
    useAppStore
      .getState()
      .pushToast(
        "error",
        i18n.t("story:panels.fileFailed"),
        undefined,
        trouble.detail ?? trouble.message,
      );
    return undefined;
  }
}

/**
 * A picture from this computer, filed on the shelf and kept here.
 *
 * The file is the project's before the place can name it, so what is waiting
 * to be saved goes first: a command pointing at a file the server has not been
 * told about yet is a command it refuses.
 */
export async function uploadElementPicture(
  story: StoryDocument,
  element: StoryElement,
  view: ElementView,
  file: File,
  variantId?: string,
): Promise<boolean> {
  const assetId = await filePictureFromComputer(file);
  if (assetId === undefined) return false;
  keepElementPicture(story, element, view, assetId, variantId);
  return true;
}
