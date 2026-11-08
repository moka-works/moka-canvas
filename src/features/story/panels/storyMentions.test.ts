import { describe, expect, it } from "vitest";

import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { StoryDocument } from "../../../shared/domain/types";
import {
  insertStoryMention,
  narrowStoryMentions,
  storyMentionBeingTyped,
  storyMentionOptions,
} from "./storyMentions";

const ids = storyIds();

function story(): StoryDocument {
  const held = buildStoryMokaFile().stories?.[0];
  if (held === undefined) throw new Error("the fixture holds a story");
  return held;
}

describe("the names an @ offers", () => {
  it("offers every form of the cast and the shot's extras", () => {
    const held = story();
    const hero = held.elements.find((element) => element.id === ids.hero)!;
    hero.variants = [
      {
        id: "variant-old",
        name: "老年",
        description: "二十年以后。",
        main: { takes: [] },
      },
    ];
    const options = storyMentionOptions(held, [
      { elementId: ids.scene, name: "车厢背面" },
      { assetId: "asset-extra", name: "傍晚的暖光" },
      { assetId: "asset-unnamed" },
    ]);
    expect(options.map((option) => option.label)).toContain("林 · 老年");
    expect(options.map((option) => option.label)).toContain("车厢背面");
    expect(options.map((option) => option.label)).toContain("傍晚的暖光");
    // A file nobody named has no name to write into the words.
    expect(options.map((option) => option.name)).not.toContain("");
    // The cast's own name wins over an extra of the same name.
    const repeated = storyMentionOptions(held, [
      { elementId: ids.scene, name: "林" },
    ]);
    expect(
      repeated.filter(
        (option) => option.name === "林" && option.group === "extra",
      ),
    ).toEqual([]);
  });

  it("narrows the offer by what has been typed", () => {
    const options = storyMentionOptions(story(), []);
    expect(
      narrowStoryMentions(options, "林").map((option) => option.name),
    ).toEqual(["林"]);
    expect(narrowStoryMentions(options, "zzz")).toEqual([]);
  });

  it("reads an @ only at the start of a word", () => {
    expect(storyMentionBeingTyped("paint @her", 10)).toEqual({
      start: 6,
      query: "her",
    });
    expect(storyMentionBeingTyped("someone@example", 15)).toBeNull();
    expect(storyMentionBeingTyped("@her there", 10)).toBeNull();
    expect(storyMentionBeingTyped("看@车厢", 4)).toEqual({
      start: 1,
      query: "车厢",
    });
    expect(storyMentionBeingTyped("a @", 3)).toEqual({ start: 2, query: "" });
  });

  it("writes the chosen name as the mention the words already use", () => {
    expect(insertStoryMention("看 @车厢 里。", 2, 5, "末班车车厢")).toEqual({
      value: "看 `末班车车厢`  里。",
      caret: 2 + "`末班车车厢` ".length,
    });
  });
});
