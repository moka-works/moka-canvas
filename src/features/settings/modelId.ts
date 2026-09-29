import { MAX_MODEL_ID_LENGTH } from "../../shared/domain";

/**
 * Identifiers a node can store.
 *
 * A model configuration's id is the reference a node keeps, so it outlives the
 * form that made it and shows up in project files, logs, and the message that
 * says a model is gone. Nobody has to think about one: the display name
 * carries the meaning, the form never shows the id, and the random tail is
 * what keeps two models both called "Writer" apart.
 */

/** The random tail's length. 36^6 is far more room than a model list needs. */
const SUFFIX_LENGTH = 6;

/** What the tail is written in: lowercase letters and digits, like the rest. */
const SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** The stem a display name that is all symbols still produces. */
const FALLBACK_STEM = "model";

/**
 * How far a display name may reach into the identifier, leaving room for the
 * separator and the tail without going over the ceiling the server enforces.
 */
const STEM_LENGTH = MAX_MODEL_ID_LENGTH - SUFFIX_LENGTH - 1;

/**
 * The readable part of an identifier: lowercased, with every run of spaces and
 * symbols turned into a single hyphen and the hyphens at either end trimmed. A
 * name written with hyphens already (`gpt-4o-mini`) keeps them, since that is
 * how the identifiers in the wild are written, and a symbol between two words
 * leaves the one hyphen that separates them rather than a gap.
 */
export function identifierStem(displayName: string): string {
  const stem = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem.slice(0, STEM_LENGTH).replace(/-+$/, "");
}

/** A random tail, drawn from the platform's own source rather than Math.random. */
export function identifierSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => SUFFIX_ALPHABET[byte % 36]).join("");
}

/**
 * The identifier a display name suggests. Never empty: a name made only of
 * symbols still yields the fallback stem plus a tail.
 */
export function suggestedModelId(displayName: string): string {
  const stem = identifierStem(displayName);
  const head = stem === "" ? FALLBACK_STEM : stem;
  return `${head}-${identifierSuffix()}`;
}

/**
 * A suggested identifier that no stored model is using yet.
 *
 * A collision needs the same name and the same six characters, so one draw is
 * what happens in practice; the retries are here so that the rare case ends in
 * an identifier rather than in a form that refuses to save. Giving up returns
 * the last candidate, which the duplicate warning then reports — inventing a
 * second scheme for an event that has not happened would only hide it.
 */
export function uniqueModelId(
  displayName: string,
  taken: (id: string) => boolean,
  attempts = 8,
): string {
  let candidate = suggestedModelId(displayName);
  for (let attempt = 1; attempt < attempts && taken(candidate); attempt += 1) {
    candidate = suggestedModelId(displayName);
  }
  return candidate;
}
