/**
 * Reading a manuscript in windows, and the headings it writes its own
 * chapters with.
 *
 * A whole novel cannot be handed to a model in one ask, but a model today can
 * hold far more than one episode's worth of it. So the manuscript is read in
 * windows of the reader's own size, each cut back to a paragraph boundary so a
 * window never ends in the middle of one, and whatever the window did not
 * manage to divide is carried into the next one. The carry is what keeps a
 * chapter from being cut twice: the next window starts where the last unplaced
 * chapter starts, and takes on only as much new text as still fits.
 */

/** The headings a manuscript writes its own chapters with, in the two orders this app is read in. */
const HEADING =
  /^[ \t]*(第[ \t]*[一二三四五六七八九十百千零两0-9]+[ \t]*[章回节集卷]|Chapter\s+[0-9IVXLCivxlc]+|CHAPTER\s+[0-9IVXLCivxlc]+|[0-9]{1,3}\s*[、.．]\s*\S)/;

/**
 * How many chapters a manuscript writes of its own, or none when it writes too
 * few to be a structure rather than a line that happened to start with a
 * number.
 *
 * Read before the manuscript is cut, so the number the telling is divided into
 * can be the number it already has rather than the one the running time
 * suggests.
 */
export function sourceHeadings(text: string): number {
  const found = text.split("\n").filter((line) => HEADING.test(line)).length;
  return found >= 2 ? found : 0;
}

/** Whether this line is a chapter heading the manuscript wrote itself. */
export function isSourceHeading(line: string): boolean {
  return HEADING.test(line);
}

/**
 * Where a window opened at `from` ends, no further than `budget` characters on.
 *
 * The cut is pulled back to the last paragraph break when there is one worth
 * taking, so a window ends where a reader would pause rather than inside a
 * paragraph; failing that it is pulled back to a line break, and failing that
 * it stands where the budget says. The text between `from` and the answer is
 * always shorter than the budget unless the budget falls inside one paragraph.
 */
export function windowEndAt(
  text: string,
  from: number,
  budget: number,
): number {
  if (from >= text.length) return text.length;
  const wanted = Math.min(text.length, from + Math.max(1, Math.floor(budget)));
  if (wanted >= text.length) return text.length;
  // A window much shorter than the budget is not a window: looking for a break
  // over the whole of it would turn a small overrun into half an ask.
  const floor = from + Math.floor((wanted - from) / 2);
  const paragraph = text.lastIndexOf("\n\n", wanted);
  if (paragraph > floor) return paragraph + 2;
  const line = text.lastIndexOf("\n", wanted);
  if (line > floor) return line + 1;
  // A hard cut is the last resort, and it must not land between the halves of
  // a character written with two.
  const before = text.charCodeAt(wanted - 1);
  if (wanted > 0 && before >= 0xd800 && before <= 0xdbff) return wanted - 1;
  return wanted;
}

/**
 * A quotation as it is compared with the manuscript.
 *
 * Models add and drop air around a quotation — a leading ellipsis, quotes that
 * are not in the text, a space after a punctuation mark — and none of that is
 * a reason to lose a chapter. What is not forgiven is a rephrasing: the words
 * themselves have to be the manuscript's.
 */
function comparable(text: string): string {
  return text.replace(/\s+/g, "");
}

/** A quotation with the decorations a model wraps around one taken off. */
function bareQuote(quote: string): string {
  return quote
    .trim()
    .replace(/^['"“”‘’「『《【(（\s.…]+/, "")
    .replace(/['"“”‘’」』》】)）\s.…]+$/, "");
}

/** A window's words with their whitespace taken out, and where each one stood. */
export interface CompactWindow {
  text: string;
  /** The window offset of each character in `text`. */
  map: number[];
}

/** The whitespace-free reading of a window, made once for all its quotations. */
export function compactWindow(window: string): CompactWindow {
  const map: number[] = [];
  const text: string[] = [];
  for (let at = 0; at < window.length; at += 1) {
    const character = window[at];
    if (character === undefined || /\s/.test(character)) continue;
    map.push(at);
    text.push(character);
  }
  return { text: text.join(""), map };
}

/** The index in a compact window of the first character at or after `from`. */
function compactIndex(compact: CompactWindow, from: number): number {
  let low = 0;
  let high = compact.map.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((compact.map[mid] ?? 0) < from) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Where a quotation stands in the window, searching from `from` on.
 *
 * The exact words are looked for first; then the same words with their
 * whitespace ignored, which catches a model that reflowed a line rather than
 * rewrote it. An occurrence before `from` is not this chapter's: chapters are
 * named in order, and the same words earlier in the window belong to one
 * already placed.
 */
export function findQuote(
  window: string,
  quote: string,
  from: number,
  compact: CompactWindow = compactWindow(window),
): number | undefined {
  const bare = bareQuote(quote);
  if (bare === "" || Array.from(bare).length < 2) return undefined;
  const exact = window.indexOf(bare, from);
  if (exact >= 0) return exact;
  const target = comparable(bare);
  const at = compactIndex(compact, from);
  const found = compact.text.indexOf(target, at);
  return found < 0 ? undefined : compact.map[found];
}
