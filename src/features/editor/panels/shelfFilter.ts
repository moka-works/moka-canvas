import type {
  AssetCategory,
  AssetId,
  AssetKind,
  ResourceEntry,
  ResourceRegistry,
} from "../../../shared/domain";
import {
  ASSET_KINDS,
  ASSET_ORIGIN_LABELS,
  PROJECT_ASSET_CATEGORIES,
} from "../../../shared/domain";

/**
 * The shelves each kind of asset is filed on.
 *
 * Four kinds and five shelves, because what a reader asks for and what a project
 * files are not the same cut of the same things: a sound is asked for as audio
 * and filed as either music or a voice, so the audio tab is two shelves and the
 * other three are one each. Every shelf is under exactly one kind, which is what
 * makes the four tabs a way of reading the whole shelf rather than a way of
 * losing part of it.
 */
export const KIND_SHELVES: Record<AssetKind, readonly AssetCategory[]> = {
  text: ["texts"],
  image: ["images"],
  audio: ["music", "voice"],
  video: ["videos"],
  model: ["models"],
};

/** The kinds, in the order the tabs read them. */
export const SHELF_KINDS: readonly AssetKind[] = ASSET_KINDS;

/** What a row shows when there is no picture of the file to show. */
export const SHELF_GLYPHS: Record<AssetCategory, string> = {
  images: "\u25a3",
  music: "\u266b",
  voice: "\u266a",
  texts: "\u00b6",
  videos: "\u25b6",
  models: "\u25c8",
};

/** Which kind a shelf is read under. */
export function kindOfShelf(shelf: AssetCategory): AssetKind {
  return (
    SHELF_KINDS.find((kind) => KIND_SHELVES[kind].includes(shelf)) ?? "image"
  );
}

/** How many rows the shelf shows before asking a reader to carry on. */
export const SHELF_PAGE = 60;

/**
 * Where the shelf says a file came from.
 *
 * One of these answers is not a field on the entry: a project that made a file
 * says so through `provenance`, so "made here" is read out of that rather than
 * written twice and given a chance to disagree with itself.
 */
export type ShelfWhere = "made" | "brought" | "filed";

export const SHELF_WHERE_LABELS: Record<ShelfWhere, string> = {
  made: "domain:assetOrigin.madeHere",
  ...ASSET_ORIGIN_LABELS,
};

export function shelfWhere(entry: ResourceEntry): ShelfWhere {
  if (entry.origin === "filed") return "filed";
  if (entry.provenance) return "made";
  if (entry.origin === "brought") return "brought";
  // Nothing recognisable was said about where it came from, and no node made
  // it: a project was handed the file.
  return "brought";
}

/**
 * A question a shelf stands behind on its own.
 *
 * A lens is a preset of the reader's own filter — the origin a face is about,
 * or the files a board is holding — applied under whatever the reader then
 * asks. It is deliberately not part of `ShelfFilter`: a lens does not show up
 * in the filter bar, does not light the Clear button, and is not the reader's
 * to take off.
 */
export interface ShelfLens {
  /** The origin the face reads, or null for a face that is open on origin. */
  where?: ShelfWhere | null;
  /** Anything else the face will not show. */
  narrow?: (entry: ResourceEntry) => boolean;
}

/**
 * The files one document holds, for a face that is about that document.
 *
 * A board's column and a cut's column read their own material through this:
 * what the shelf shows is what that document points at. It narrows and does
 * not answer the origin question — a reader looking at one board's files may
 * still ask for the ones brought in.
 */
export function heldLens(ids: ReadonlySet<AssetId>): ShelfLens {
  return { narrow: (entry) => ids.has(entry.id) };
}

/**
 * Everything the project holds that is placed nowhere: the unused view.
 *
 * Built from the same pointing-at the delete guard reads, so a file kept by a
 * story's old drawing counts as used as much as one a card shows.
 */
export function unheldLens(placed: ReadonlySet<AssetId>): ShelfLens {
  return { narrow: (entry) => !placed.has(entry.id) };
}

/**
 * The shelf's rows newest first, within each group.
 *
 * A cutting room reader reaches for what just arrived before what was filed
 * long ago, and an import lands at the top of its group where the reader can
 * see it without paging. The order is the shelf's own property rather than the
 * filter's: it holds whether or not anything is being asked of the shelf.
 */
export function newestFirst(
  entries: readonly ResourceEntry[],
): ResourceEntry[] {
  return [...entries].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export interface ShelfFilter {
  /** Words to find, matched against the name and everything said about it. */
  asked: string;
  /** Every one of these must be carried by an asset for it to stay. */
  tags: string[];
  keepersOnly: boolean;
  where: ShelfWhere | null;
  category: AssetCategory | null;
  /**
   * The kind of thing asked for, which is the cut a reader thinks in: a
   * sound is one kind filed on two shelves, so narrowing to the kind leaves
   * both of them standing.
   */
  kind: AssetKind | null;
}

export const OPEN_SHELF_FILTER: ShelfFilter = {
  asked: "",
  tags: [],
  keepersOnly: false,
  where: null,
  category: null,
  kind: null,
};

export function shelfFilterIsOpen(filter: ShelfFilter): boolean {
  return (
    filter.asked.trim() === "" &&
    filter.tags.length === 0 &&
    !filter.keepersOnly &&
    filter.where === null &&
    filter.category === null &&
    filter.kind === null
  );
}

function carriesTag(entry: ResourceEntry, tag: string): boolean {
  const asked = tag.toLowerCase();
  return (entry.tags ?? []).some((carried) => carried.toLowerCase() === asked);
}

function saidAbout(entry: ResourceEntry): string {
  return [
    entry.name,
    ...(entry.tags ?? []),
    entry.note ?? "",
    entry.keyword ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/** The shelf, narrowed to what a reader asked for, in filing order. */
export function filterShelf(
  resources: ResourceRegistry,
  filter: ShelfFilter,
): ResourceEntry[] {
  const asked = filter.asked.trim().toLowerCase();
  const kept: ResourceEntry[] = [];
  for (const category of PROJECT_ASSET_CATEGORIES) {
    if (filter.category && filter.category !== category) continue;
    if (filter.kind && !KIND_SHELVES[filter.kind]?.includes(category)) {
      continue;
    }
    for (const entry of resources[category] ?? []) {
      if (filter.keepersOnly && entry.favorite !== true) continue;
      if (filter.where && shelfWhere(entry) !== filter.where) continue;
      if (filter.tags.some((tag) => !carriesTag(entry, tag))) continue;
      if (asked && !saidAbout(entry).includes(asked)) continue;
      kept.push(entry);
    }
  }
  return kept;
}

export interface ShelfTag {
  tag: string;
  count: number;
}

/**
 * Every word on the shelf, most-carried first.
 *
 * Counted over the whole shelf rather than over what a filter left standing, so
 * adding a second word narrows the list instead of emptying it.
 */
export function shelfTags(resources: ResourceRegistry): ShelfTag[] {
  const counts = new Map<string, ShelfTag>();
  for (const category of PROJECT_ASSET_CATEGORIES) {
    for (const entry of resources[category] ?? []) {
      for (const tag of entry.tags ?? []) {
        const seen = counts.get(tag.toLowerCase());
        if (seen) seen.count += 1;
        else counts.set(tag.toLowerCase(), { tag, count: 1 });
      }
    }
  }
  return [...counts.values()].sort(
    (left, right) =>
      right.count - left.count || left.tag.localeCompare(right.tag),
  );
}

/** Kept in filing order, so a page of the shelf reads the same twice. */
export function groupShelf(
  entries: ResourceEntry[],
): { category: AssetCategory; entries: ResourceEntry[] }[] {
  return PROJECT_ASSET_CATEGORIES.map((category) => ({
    category,
    entries: entries.filter((entry) => entry.path.split("/")[1] === category),
  })).filter((group) => group.entries.length > 0);
}
