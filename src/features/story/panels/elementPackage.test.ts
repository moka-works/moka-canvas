import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  createElement,
  createElementVariant,
  createProject,
  createStory,
} from "../../../shared/domain/factories";
import { MAX_ELEMENTS_PER_STORY } from "../../../shared/domain/constants";
import type { MokaFile } from "../../../shared/domain/types";
import {
  ELEMENT_PACKAGE_MANIFEST,
  ElementPackageError,
  buildElementPackage,
  materializeImportedElements,
  planElementImport,
  readElementPackage,
  zipElementPackage,
} from "./elementPackage";

const AT = "2026-01-01T00:00:00.000Z";

function resource(id: string, name: string, mime: string, path: string) {
  return { id, name, mime, path, createdAt: AT, updatedAt: AT };
}

/** A project whose shelf holds the pictures and one recording a cast names. */
function project(): MokaFile {
  const moka = createProject("From");
  moka.resources.images = [
    resource(
      "asset-main",
      "keeper.png",
      "image/png",
      "assets/images/keeper.png",
    ),
    resource(
      "asset-turn",
      "keeper-sheet.png",
      "image/png",
      "assets/images/keeper-sheet.png",
    ),
    resource(
      "asset-young",
      "young.png",
      "image/png",
      "assets/images/young.png",
    ),
    resource(
      "asset-ref",
      "reference.png",
      "image/png",
      "assets/images/reference.png",
    ),
  ];
  moka.resources.voice = [
    resource(
      "asset-voice",
      "keeper.m4a",
      "audio/mp4",
      "assets/voice/keeper.m4a",
    ),
  ];
  return moka;
}

/** A telling whose cast carries a character with a form and a voice, and a place. */
function cast() {
  const keeper = createElement("character", "Keeper", "A keeper", [
    "chapter-1",
  ]);
  keeper.main = { takes: [{ assetIds: ["asset-main"], createdAt: AT }] };
  keeper.turnaround = { takes: [{ assetIds: ["asset-turn"], createdAt: AT }] };
  keeper.voice = {
    model: "speech-1",
    voice: "keeper",
    rate: 1.1,
    referenceAssetId: "asset-voice",
  };
  keeper.reference = { kind: "asset", assetId: "asset-ref" };
  const young = createElementVariant(keeper, "Young");
  keeper.variants = [
    {
      ...young,
      id: "form-young",
      description: "The keeper as a child",
      main: { takes: [{ assetIds: ["asset-young"], createdAt: AT }] },
      turnaround: undefined,
    },
  ];
  const platform = createElement("scene", "Platform", "A platform");
  platform.reference = {
    kind: "element",
    elementId: keeper.id,
    variantId: "form-young",
  };
  const story = createStory("From");
  story.chapters = [
    {
      id: "chapter-1",
      title: "One",
      synopsis: "",
      targetDurationMs: 0,
      acts: [],
    },
  ];
  story.elements = [keeper, platform];
  return story;
}

describe("element packages", () => {
  it("carries every picture and recording, and no chapter at all", () => {
    const story = cast();
    const { manifest, missing } = buildElementPackage(
      story.elements,
      project(),
    );

    expect(missing).toEqual([]);
    expect(manifest.elements).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain("chapterIds");
    expect(JSON.stringify(manifest)).not.toContain("chapter-1");
    expect(manifest.assets.map((asset) => asset.id).sort()).toEqual(
      [
        "asset-main",
        "asset-ref",
        "asset-turn",
        "asset-voice",
        "asset-young",
      ].sort(),
    );
    expect(
      manifest.assets.find((asset) => asset.id === "asset-voice")?.category,
    ).toBe("voice");
    expect(new Set(manifest.assets.map((asset) => asset.file)).size).toBe(
      manifest.assets.length,
    );
  });

  it("names a referenced file that is not on the shelf", () => {
    const story = cast();
    const moka = project();
    moka.resources.images = moka.resources.images.filter(
      (entry) => entry.id !== "asset-main",
    );

    expect(buildElementPackage(story.elements, moka).missing).toEqual([
      "asset-main",
    ]);
  });

  it("round-trips through a zip and lands with every reference on this side", () => {
    const story = cast();
    const built = buildElementPackage(story.elements, project());
    const files = new Map(
      built.manifest.assets.map((asset, at) => [
        asset.id,
        strToU8(`file-${at}`),
      ]),
    );
    const zipped = zipElementPackage(built.manifest, files);
    const read = readElementPackage(zipped);

    expect(read.files[ELEMENT_PACKAGE_MANIFEST]).toBeDefined();
    for (const asset of read.manifest.assets) {
      expect(read.files[asset.file]).toBeDefined();
    }

    const plan = planElementImport(createStory("To"), read.manifest);
    const assets = new Map(
      read.manifest.assets.map((asset) => [asset.id, `new-${asset.id}`]),
    );
    const imported = materializeImportedElements(plan, assets);

    expect(imported).toHaveLength(2);
    const keeper = imported.find((element) => element.name === "Keeper");
    const platform = imported.find((element) => element.name === "Platform");
    expect(keeper?.chapterIds).toEqual([]);
    expect(keeper?.id).not.toBe(story.elements[0]?.id);
    expect(keeper?.main.takes[0]?.assetIds).toEqual(["new-asset-main"]);
    expect(keeper?.turnaround?.takes[0]?.assetIds).toEqual(["new-asset-turn"]);
    expect(keeper?.voice).toEqual({
      model: "speech-1",
      voice: "keeper",
      rate: 1.1,
      referenceAssetId: "new-asset-voice",
    });
    expect(keeper?.reference).toEqual({
      kind: "asset",
      assetId: "new-asset-ref",
    });
    expect(keeper?.variants?.[0]?.id).not.toBe("form-young");
    expect(keeper?.variants?.[0]?.main.takes[0]?.assetIds).toEqual([
      "new-asset-young",
    ]);
    expect(platform?.reference).toEqual({
      kind: "element",
      elementId: keeper?.id,
      variantId: keeper?.variants?.[0]?.id,
    });
  });

  it("leaves a name the telling already holds alone, and its files unasked", () => {
    const story = cast();
    const built = buildElementPackage(story.elements, project());
    const target = createStory("To");
    const held = createElement("character", "Keeper", "The reader's keeper");
    held.variants = [
      {
        ...createElementVariant(held, "Young"),
        id: "keeper-young",
      },
    ];
    target.elements = [held];

    const plan = planElementImport(target, built.manifest);

    expect(plan.skipped.map((element) => element.name)).toEqual(["Keeper"]);
    expect(plan.planned.map(({ source }) => source.name)).toEqual(["Platform"]);
    expect(plan.assets).toEqual([]);
    const imported = materializeImportedElements(plan, new Map());
    expect(imported[0]?.reference).toEqual({
      kind: "element",
      elementId: held.id,
      variantId: "keeper-young",
    });
  });

  it("refuses a package from a newer format and one with no elements", () => {
    const newer = zipSync({
      [ELEMENT_PACKAGE_MANIFEST]: strToU8(
        JSON.stringify({
          format: "moka.story.elements",
          version: 2,
          elements: [],
          assets: [],
        }),
      ),
    });
    expect(() => readElementPackage(newer)).toThrowError(
      expect.objectContaining({ code: "VERSION" }),
    );

    const empty = zipSync({
      [ELEMENT_PACKAGE_MANIFEST]: strToU8(
        JSON.stringify({
          format: "moka.story.elements",
          version: 1,
          elements: [],
          assets: [],
        }),
      ),
    });
    expect(() => readElementPackage(empty)).toThrowError(
      expect.objectContaining({ code: "EMPTY" }),
    );
    expect(() => readElementPackage(strToU8("not a zip"))).toThrowError(
      expect.objectContaining({ code: "INVALID" }),
    );
  });

  it("refuses a cast that would go past the element limit", () => {
    const story = cast();
    const built = buildElementPackage(story.elements, project());
    const target = createStory("Full");
    target.elements = Array.from({ length: MAX_ELEMENTS_PER_STORY }, (_, at) =>
      createElement("prop", `Prop ${at}`),
    );

    expect(() => planElementImport(target, built.manifest)).toThrowError(
      expect.objectContaining({ code: "LIMIT" }),
    );
  });

  it("keeps a file it cannot read out of the package", () => {
    const story = cast();
    const built = buildElementPackage(story.elements, project());

    expect(() => zipElementPackage(built.manifest, new Map())).toThrowError(
      ElementPackageError,
    );
  });
});
