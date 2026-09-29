/**
 * A short, stable reading of what something is.
 *
 * FNV-1a over the text, 32 bits, written as eight hexadecimal digits. It is not
 * a seal against anyone editing a document by hand — a document is the reader's
 * — but it is enough to notice that what a film was made of is not what the
 * telling holds now, which is the one question the film card has to answer.
 *
 * The text is hashed a code unit at a time rather than a byte at a time, so the
 * same words give the same digest on every machine the room runs on, and the
 * same words in a different language give a different one.
 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    // The 32-bit multiply by the FNV prime, kept inside a double throughout.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
