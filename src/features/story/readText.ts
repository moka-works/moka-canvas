import { assetUrl } from "../../api";
import type { AssetId, StoryChapter } from "../../shared/domain";

/**
 * The words of a text asset, read whole.
 *
 * A manuscript is filed on the shelf while it is being cut, read here once,
 * and released when the chapters hold its words. Reading it back is this one
 * call; the text is kept for the session because a long manuscript is cut in
 * batches from the same copy. The cache is cleared when the project is put
 * down.
 */
const held = new Map<AssetId, string>();

/** The manuscript as this session last read it, when it has read it. */
export function cachedTextAsset(assetId: AssetId): string | undefined {
  return held.get(assetId);
}

/** Forgets every manuscript read this session, which a closed project does. */
export function forgetTextAssets(): void {
  held.clear();
}

export async function readTextAsset(assetId: AssetId): Promise<string> {
  const known = held.get(assetId);
  if (known !== undefined) return known;
  const response = await fetch(assetUrl(assetId));
  if (!response.ok) {
    throw new Error(
      `The manuscript could not be read back (${response.status})`,
    );
  }
  const text = (await response.text()).replace(/\r\n?/g, "\n");
  held.set(assetId, text);
  return text;
}

/** The words behind a chapter: the text it was cut with, or its synopsis. */
export function chapterText(chapter: StoryChapter): string {
  return chapter.synopsis;
}
