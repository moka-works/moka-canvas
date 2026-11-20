import { describe, expect, it } from "vitest";

import { i18n } from "../../../shared/i18n";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { StoryJobItem } from "../../../api/story";
import { failurePieceLabel } from "./failureLabel";

const ids = storyIds();
const story = buildStoryMokaFile().stories![0]!;

/** One failed piece, as a record carries it. */
function item(target: StoryJobItem["target"], id = "piece"): StoryJobItem {
  return {
    id,
    target,
    capability: "image",
    prompt: "",
    inputs: [],
    params: {},
    status: "failed",
    error: "no",
  };
}

describe("the place a failed piece was making", () => {
  it("says the chapter, act and frame a board piece belongs to", () => {
    expect(
      failurePieceLabel(
        story,
        item({ kind: "storyboard", chapterId: ids.chapterFirst }),
        i18n.t,
      ),
    ).toBe("Chapter 1 · Board");
    expect(
      failurePieceLabel(
        story,
        item({
          kind: "keyframeArt",
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId: ids.frameFirst,
        }),
        i18n.t,
      ),
    ).toBe("Chapter 1 · Act 1 · Frame 1 · Picture");
  });

  it("names a character's drawing by the form and view it was made for", () => {
    expect(
      failurePieceLabel(
        story,
        item({ kind: "elementArt", elementId: ids.hero, view: "main" }),
        i18n.t,
      ),
    ).toBe("林 · Main picture");
  });

  it("says an outline piece by the chapter it was asked for", () => {
    expect(
      failurePieceLabel(
        story,
        item({ kind: "outline" }, "outline:rewrite:2"),
        i18n.t,
      ),
    ).toBe("Chapter 2 · Outline");
    expect(
      failurePieceLabel(story, item({ kind: "outline" }, "outline"), i18n.t),
    ).toBe("The whole outline");
  });

  it("says so rather than going blank when the place has left the story", () => {
    expect(
      failurePieceLabel(
        story,
        item({ kind: "storyboard", chapterId: "chapter-gone" }),
        i18n.t,
      ),
    ).toBe("Something no longer in the story");
    expect(
      failurePieceLabel(
        story,
        item({ kind: "elementArt", elementId: "element-gone", view: "main" }),
        i18n.t,
      ),
    ).toBe("Something no longer in the story");
  });
});
