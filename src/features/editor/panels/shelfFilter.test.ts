import { describe, expect, it } from "vitest";
import type {
  AssetCategory,
  ResourceEntry,
  ResourceRegistry,
} from "../../../shared/domain";
import {
  OPEN_SHELF_FILTER,
  SHELF_PAGE,
  SHELF_WHERE_LABELS,
  filterShelf,
  groupShelf,
  heldLens,
  shelfFilterIsOpen,
  shelfTags,
  shelfWhere,
  unheldLens,
  type ShelfFilter,
} from "./shelfFilter";

const WHEN = "2026-01-01T00:00:00.000Z";

function onShelf(
  shelf: AssetCategory,
  index: number,
  said: Partial<ResourceEntry> = {},
): ResourceEntry {
  const name = said.name ?? `lake-${index}.png`;
  return {
    id: `asset-${shelf}-${index}`,
    name,
    path: `assets/${shelf}/${name}`,
    mime: shelf === "texts" ? "text/markdown" : "image/png",
    createdAt: WHEN,
    updatedAt: WHEN,
    ...said,
  };
}

function registryOf(...entries: ResourceEntry[]): ResourceRegistry {
  const shelves = {
    images: [],
    music: [],
    voice: [],
    texts: [],
    videos: [],
    models: [],
  } as ResourceRegistry;
  for (const entry of entries) {
    const shelf = entry.path.split("/")[1] as AssetCategory;
    shelves[shelf].push(entry);
  }
  return shelves;
}

function asked(criteria: Partial<ShelfFilter>): ShelfFilter {
  return { ...OPEN_SHELF_FILTER, ...criteria };
}

const keeper = onShelf("images", 1, {
  tags: ["lake", "dusk"],
  note: "Kept for the opening shot.",
  favorite: true,
  origin: "brought",
});
const made = onShelf("images", 2, {
  name: "lantern.png",
  tags: ["Lantern"],
  keyword: "A lantern floats over a quiet lake at dusk.",
  provenance: { createdAt: WHEN, runId: "run-1" },
});
const filedText = onShelf("texts", 3, {
  name: "opening-lines.md",
  origin: "filed",
  tags: ["opening"],
  provenance: { createdAt: WHEN, operationNodeId: "node-1" },
});
const shelf = registryOf(keeper, made, filedText);

describe("the shelf a reader filters", () => {
  it("shows everything while nothing is asked", () => {
    expect(shelfFilterIsOpen(OPEN_SHELF_FILTER)).toBe(true);
    expect(
      filterShelf(shelf, OPEN_SHELF_FILTER).map((entry) => entry.id),
    ).toEqual([keeper.id, made.id, filedText.id]);
  });

  it("finds a word in the name, a tag, a note, or a summary", () => {
    for (const [words, wanted] of [
      ["lantern", made.id],
      ["dusk", keeper.id],
      ["opening shot", keeper.id],
      ["floats over", made.id],
    ] as const) {
      expect(
        filterShelf(shelf, asked({ asked: words }))
          .map((entry) => entry.id)
          .includes(wanted),
      ).toBe(true);
    }
    expect(
      filterShelf(shelf, asked({ asked: "  opening shot  " })).map((e) => e.id),
    ).toEqual([keeper.id]);
  });

  it("asks for every chosen word rather than any of them", () => {
    expect(
      filterShelf(shelf, asked({ tags: ["lake"] })).map((e) => e.id),
    ).toEqual([keeper.id]);
    expect(filterShelf(shelf, asked({ tags: ["lake", "dusk"] })).length).toBe(
      1,
    );
    expect(
      filterShelf(shelf, asked({ tags: ["lake", "opening"] })).length,
    ).toBe(0);
  });

  it("takes a chosen word in any spelling it was written", () => {
    expect(
      filterShelf(shelf, asked({ tags: ["lantern"] })).map((e) => e.id),
    ).toEqual([made.id]);
  });

  it("keeps only what a reader marked to hand", () => {
    expect(
      filterShelf(shelf, asked({ keepersOnly: true })).map((e) => e.id),
    ).toEqual([keeper.id]);
    const setAside = onShelf("images", 4, { favorite: false });
    expect(
      filterShelf(registryOf(keeper, setAside), asked({ keepersOnly: true }))
        .length,
    ).toBe(1);
  });

  it("names where a file came from even when the entry says nothing", () => {
    expect(shelfWhere(keeper)).toBe("brought");
    expect(shelfWhere(made)).toBe("made");
    expect(shelfWhere(filedText)).toBe("filed");
    expect(shelfWhere(onShelf("images", 5))).toBe("brought");
    expect(
      shelfWhere(
        onShelf("images", 6, {
          origin: "inherited" as ResourceEntry["origin"],
          provenance: undefined,
        }),
      ),
    ).toBe("brought");
  });

  it("filters by the one answer that is not a field", () => {
    expect(
      filterShelf(shelf, asked({ where: "made" })).map((e) => e.id),
    ).toEqual([made.id]);
    expect(
      filterShelf(shelf, asked({ where: "brought" })).map((e) => e.id),
    ).toEqual([keeper.id]);
    expect(Object.values(SHELF_WHERE_LABELS).length).toBe(3);
  });

  it("narrows to one shelf", () => {
    expect(
      filterShelf(shelf, asked({ category: "texts" })).map((e) => e.id),
    ).toEqual([filedText.id]);
  });

  it("counts the words over the whole shelf, most carried first", () => {
    const crowded = onShelf("images", 7, { tags: ["lake"] });
    expect(shelfTags(registryOf(keeper, made, filedText, crowded))).toEqual([
      { tag: "lake", count: 2 },
      { tag: "dusk", count: 1 },
      { tag: "Lantern", count: 1 },
      { tag: "opening", count: 1 },
    ]);
  });

  it("groups a page back into the shelves it came from", () => {
    expect(groupShelf(filterShelf(shelf, OPEN_SHELF_FILTER))).toEqual([
      { category: "images", entries: [keeper, made] },
      { category: "texts", entries: [filedText] },
    ]);
  });

  it("carries on a shelf longer than one page", () => {
    expect(SHELF_PAGE).toBe(60);
    const many = Array.from({ length: SHELF_PAGE + 3 }, (_, index) =>
      onShelf("images", index),
    );
    const matched = filterShelf(registryOf(...many), OPEN_SHELF_FILTER);
    expect(matched.length).toBe(SHELF_PAGE + 3);
    expect(matched.slice(0, SHELF_PAGE).length).toBe(SHELF_PAGE);
    expect(matched.slice(0, 2 * SHELF_PAGE).length).toBe(SHELF_PAGE + 3);
  });
});

describe("the lenses a face reads through", () => {
  it("shows the files a document holds and nothing else", () => {
    const lens = heldLens(new Set([made.id]));
    expect(lens.where).toBeUndefined();
    expect(lens.narrow!(made)).toBe(true);
    expect(lens.narrow!(keeper)).toBe(false);
  });

  it("shows what a document does not hold, for the unused view", () => {
    const lens = unheldLens(new Set([made.id]));
    expect(lens.narrow!(keeper)).toBe(true);
    expect(lens.narrow!(made)).toBe(false);
  });

  it("leaves the origin question to the reader", () => {
    expect(heldLens(new Set()).where).toBeUndefined();
    expect(unheldLens(new Set()).where).toBeUndefined();
  });
});
