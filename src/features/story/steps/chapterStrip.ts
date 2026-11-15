/** One place in a folded strip: an episode's number, or a gap in the list. */
export type ChapterStripSlot = number | "gap";

/**
 * The episodes a folded strip keeps at hand: at most three chips around the one
 * the board stands on, with a gap standing for the ones further away.
 *
 * A strip with nothing hidden keeps every chip; a reader on the first or last
 * episode gets its two neighbours in one direction, and everyone else gets the
 * episodes either side, so stepping to an adjacent episode never needs the
 * strip opened.
 */
export function chapterStripWindow(
  total: number,
  current: number,
): ChapterStripSlot[] {
  if (total <= 3) return Array.from({ length: total }, (_, at) => at);
  if (current <= 0) return [0, 1, 2, "gap"];
  if (current >= total - 1) return ["gap", total - 3, total - 2, total - 1];
  const slots: ChapterStripSlot[] = [];
  if (current > 1) slots.push("gap");
  slots.push(current - 1, current, current + 1);
  if (current < total - 2) slots.push("gap");
  return slots;
}
