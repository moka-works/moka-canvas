import { assetUrl } from "../../api";
import type { AssetId, StoryChapter, StoryDocument } from "../../shared/domain";

/**
 * The words of a text asset, read whole.
 *
 * A manuscript lives on the shelf as a file and never in the document: what a
 * story holds is where the words are, not the words themselves, so that a novel
 * uploaded once does not swell every save. Reading it back is this one call,
 * made when the story is about to be written from it.
 *
 * The words are kept for the session once read: a split manuscript is cut in
 * batches and the steps after it are planned from the same text, and fetching
 * a few hundred kilobytes again for every batch would be a second copy made
 * over and over. The cache is cleared when the project is put down.
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

/**
 * The words behind a chapter: the manuscript window it was cut from, or the
 * synopsis it was written with.
 *
 * A window whose manuscript has not been read this session reads as nothing.
 * The room reads the manuscript when it opens, and every step that plans an ask
 * from it waits for that read, so this is the shape of a state that should not
 * be reached rather than a second kind of chapter.
 */
export function chapterText(chapter: StoryChapter): string {
  const source = chapter.source;
  if (source === undefined) return chapter.synopsis;
  const text = held.get(source.assetId);
  return text === undefined ? "" : text.slice(source.start, source.end);
}

/** What a chapter carries into an ask, counted in characters. */
export function chapterLength(chapter: StoryChapter): number {
  if (chapter.source !== undefined) {
    return Math.max(0, chapter.source.end - chapter.source.start);
  }
  return Array.from(chapter.synopsis).length;
}

/**
 * Reads the manuscript a story's chapters were cut from, when they were.
 *
 * A story written from a premise has no manuscript to read, and a manuscript
 * whose chapters nobody has cut yet is read by the step that cuts it.
 */
export async function ensureStoryText(story: StoryDocument): Promise<void> {
  const assetId = story.brief.sourceAssetId;
  if (assetId === undefined) return;
  if (!story.chapters.some((chapter) => chapter.source !== undefined)) return;
  await readTextAsset(assetId);
}
