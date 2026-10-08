import type { AssetHolder, AssetId, MokaFile } from "../../shared/domain";
import { assetHolders } from "../../shared/domain";
import { i18n } from "../../shared/i18n";
import {
  blocksDelete,
  placeName,
  referenceWho,
} from "../editor/interactions/actions";

/**
 * Where a file is used, told as the room a reader would go to.
 *
 * A use is a holder said in the reader's words: what points at the file — a
 * card, a clip, a story place, a manuscript, a voice naming it — and which
 * room that thing lives in. Nothing here decides what points at what; that is
 * `assetHolders`'s one answer, and this only translates it for a list that has
 * to lead somewhere.
 */
export type UseRoom = "canvas" | "clip" | "story";

export interface AssetUse {
  room: UseRoom;
  holder: AssetHolder;
  /** Who holds it, as a reader knows it: board · card, cut · clip, story · place. */
  title: string;
  /** Whether this holder refuses a delete (mirrors `blocksDelete`). */
  blocking: boolean;
  /** A story place keeping the file as an old take rather than the one in use. */
  oldDrawing?: boolean;
}

const ROOM_OF: Record<AssetHolder["kind"], UseRoom> = {
  node: "canvas",
  clip: "clip",
  drawing: "story",
  drawingInUse: "story",
  storyFile: "story",
  voiceReference: "story",
};

/** Which room a holder lives in, for the heading that gathers it. */
export function roomOf(holder: AssetHolder): UseRoom {
  return ROOM_OF[holder.kind];
}

/**
 * One holder's title, read off the document at the moment it is said.
 *
 * The names are the document's to change and the holder only carries what
 * finds the thing again — a board by its id, a place by its target — so the
 * title is resolved here rather than frozen into the holder. A piece the
 * document no longer holds falls back to the id it was found by, which is at
 * least something to search for.
 */
function titleOf(moka: MokaFile, holder: AssetHolder): string {
  switch (holder.kind) {
    case "node": {
      const canvas = moka.canvas.find((held) => held.id === holder.canvasId);
      const node = canvas?.nodes.find((held) => held.id === holder.nodeId);
      return i18n.t("assets:uses.boardCard", {
        board: canvas?.name ?? holder.canvasId,
        card: node?.title ?? holder.nodeId,
      });
    }
    case "clip":
      return i18n.t("assets:uses.cutClip", {
        timeline: holder.timelineName,
        clip: holder.clipLabel,
      });
    case "drawing":
    case "drawingInUse": {
      const story = (moka.stories ?? []).find(
        (held) => held.id === holder.storyId,
      );
      return i18n.t("assets:uses.storyPlace", {
        story: holder.storyName,
        place:
          story === undefined
            ? i18n.t("editor:holders.aPlace")
            : placeName(story, holder.target),
      });
    }
    case "storyFile":
      return i18n.t("assets:uses.manuscriptTitle", {
        story: holder.storyName,
      });
    case "voiceReference":
      return i18n.t("assets:uses.storyVoice", {
        story: holder.storyName,
        who: referenceWho(moka, holder),
      });
  }
}

/** Everywhere one file is used, boards then cuts then stories. */
export function assetUses(moka: MokaFile, assetId: AssetId): AssetUse[] {
  return assetHolders(moka, assetId).map((holder) => ({
    room: roomOf(holder),
    holder,
    title: titleOf(moka, holder),
    blocking: blocksDelete(holder),
    ...(holder.kind === "drawing" ? { oldDrawing: true } : {}),
  }));
}

/** The uses gathered under their rooms, empty rooms left out. */
export function groupUses(
  uses: AssetUse[],
): { room: UseRoom; uses: AssetUse[] }[] {
  const rooms: UseRoom[] = ["canvas", "clip", "story"];
  return rooms
    .map((room) => ({ room, uses: uses.filter((use) => use.room === room) }))
    .filter((group) => group.uses.length > 0);
}
