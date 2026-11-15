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
  it("offers the names the shot's references are kept by", () => {
    const held = story();
    const options = storyMentionOptions(held, [
      { elementId: ids.hero, name: "林" },
      { elementId: ids.scene, variantId: "variant-night", name: "车厢背面" },
      { assetId: "asset-extra", name: "傍晚的暖光" },
      { assetId: "asset-unnamed", name: "" },
    ]);
    expect(options.map((option) => option.label)).toEqual([
      "林",
      "车厢背面",
      "傍晚的暖光",
    ]);
    // A reference the reader never named is offered under its form's name;
    // a file with no name has no name to write into the words.
    const unnamed = storyMentionOptions(held, [
      { elementId: ids.hero, name: "" },
    ]);
    expect(unnamed.map((option) => option.name)).toEqual(["林"]);
    // Two references of one name are one name as far as the words go.
    const repeated = storyMentionOptions(held, [
      { elementId: ids.hero, name: "林" },
      { assetId: "asset-extra", name: "林" },
    ]);
    expect(repeated.map((option) => option.name)).toEqual(["林"]);
  });

  it("narrows the offer by what has been typed", () => {
    const options = storyMentionOptions(story(), [
      { elementId: ids.hero, name: "林" },
      { assetId: "asset-extra", name: "傍晚的暖光" },
    ]);
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
