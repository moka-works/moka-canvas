// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { planPictureEdit } from "./editPlan";

const ids = storyIds();

function scene() {
  const story = buildStoryMokaFile().stories![0]!;
  const chapter = story.chapters[0]!;
  const act = chapter.acts[0]!;
  const hero = story.elements.find((element) => element.id === ids.hero)!;
  return { story, chapter, act, hero };
}

describe("an edit of a picture", () => {
  it("hands the kept picture back with the words of the change", () => {
    const { story, hero } = scene();
    const item = planPictureEdit(
      story,
      { kind: "element", element: hero, view: "main" },
      { instruction: "把外套换成深灰色" },
    );
    expect(item?.target).toEqual({
      kind: "elementArt",
      elementId: ids.hero,
      view: "main",
    });
    expect(item?.inputs).toEqual([
      { role: "reference", assetId: ids.heroMain },
    ]);
    // The first line is what the new take is filed under.
    expect(item?.prompt.split("\n")[0]).toBe("把外套换成深灰色");
    // A character is drawn in its own frame, not the film's.
    expect(item?.params).toEqual({ size: "1024x1536" });
  });

  it("carries the mask as a mask, and says what it means", () => {
    const { story, hero } = scene();
    const item = planPictureEdit(
      story,
      { kind: "element", element: hero, view: "main" },
      { instruction: "换成深灰色外套", maskAssetId: "asset-mask" },
    );
    expect(item?.inputs).toEqual([
      { role: "reference", assetId: ids.heroMain },
      { role: "mask", assetId: "asset-mask" },
    ]);
    expect(item?.prompt).toContain("black-and-white mask");
  });

  it("edits a shot's frame from the frame it keeps", () => {
    const { story, chapter, act } = scene();
    const frame = act.keyframes[0]!;
    const item = planPictureEdit(
      story,
      { kind: "keyframe", chapterId: chapter.id, act, keyframe: frame },
      { instruction: "把雨改成雪" },
    );
    expect(item?.target).toEqual({
      kind: "keyframeArt",
      chapterId: chapter.id,
      actId: act.id,
      keyframeId: frame.id,
    });
    expect(item?.inputs).toEqual([
      { role: "reference", assetId: ids.frameArt },
    ]);
    expect(item?.params).toEqual({ size: "1536x1024" });
  });

  it("plans nothing for a place that holds no picture", () => {
    const { story, chapter, act } = scene();
    const frame = act.keyframes[1]!;
    expect(
      planPictureEdit(
        story,
        { kind: "keyframe", chapterId: chapter.id, act, keyframe: frame },
        { instruction: "把雨改成雪" },
      ),
    ).toBeUndefined();
  });
});
