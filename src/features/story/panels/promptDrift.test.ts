import { describe, expect, it } from "vitest";

import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { ResourceEntry } from "../../../shared/domain/types";
import { planActVideos, planKeyframeArt } from "../jobs/plan";
import {
  actVideoPromptDrifted,
  driftedFrameTargets,
  promptSnapshots,
} from "./promptDrift";

const ids = storyIds();
const T0 = "2026-01-01T00:00:00.000Z";

function filedWith(entry: ResourceEntry | undefined, prompt: string): void {
  if (entry === undefined) throw new Error("the fixture holds the asset");
  entry.provenance = {
    createdAt: T0,
    parameterSnapshot: { prompt },
  };
}

describe("whether a picture was drawn from older words", () => {
  it("passes while the prompt is the one the picture was filed with", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const chapter = story.chapters[0]!;
    const act = chapter.acts[0]!;
    const frame = act.keyframes[0]!;
    const planned = planKeyframeArt(story, [
      { chapterId: chapter.id, actId: act.id, keyframeId: frame.id },
    ])[0]!.prompt;
    filedWith(
      moka.resources.images.find((entry) => entry.id === ids.frameArt),
      planned,
    );

    expect(
      driftedFrameTargets(story, chapter, promptSnapshots(moka.resources)),
    ).toEqual([]);
  });

  it("names the shot once its words change under the picture", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const chapter = story.chapters[0]!;
    const act = chapter.acts[0]!;
    const frame = act.keyframes[0]!;
    const planned = planKeyframeArt(story, [
      { chapterId: chapter.id, actId: act.id, keyframeId: frame.id },
    ])[0]!.prompt;
    filedWith(
      moka.resources.images.find((entry) => entry.id === ids.frameArt),
      planned,
    );
    frame.content = "`林`立在熄灭的灯下。";

    expect(
      driftedFrameTargets(story, chapter, promptSnapshots(moka.resources)),
    ).toEqual([
      {
        chapterId: chapter.id,
        actId: act.id,
        keyframeId: frame.id,
      },
    ]);
  });

  it("says nothing about a picture filed before the words were kept", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const chapter = story.chapters[0]!;
    chapter.acts[0]!.keyframes[0]!.content = "改过的文字。";

    expect(
      driftedFrameTargets(story, chapter, promptSnapshots(moka.resources)),
    ).toEqual([]);
  });
});

describe("whether a clip was filmed from older words", () => {
  it("passes while the act's words are the ones it was filmed with", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const chapter = story.chapters[0]!;
    const act = chapter.acts[0]!;
    const planned = planActVideos(story, chapter.id, [act.id]).map(
      (item) => item.prompt,
    );
    expect(planned).toHaveLength(1);
    filedWith(
      moka.resources.videos.find((entry) => entry.id === ids.actVideo),
      planned[0]!,
    );

    expect(
      actVideoPromptDrifted(
        story,
        chapter.id,
        act,
        promptSnapshots(moka.resources),
      ),
    ).toBe(false);
  });

  it("flags the act once its summary changes under the clip", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const chapter = story.chapters[0]!;
    const act = chapter.acts[0]!;
    const planned = planActVideos(story, chapter.id, [act.id]).map(
      (item) => item.prompt,
    );
    filedWith(
      moka.resources.videos.find((entry) => entry.id === ids.actVideo),
      planned[0]!,
    );
    act.summary = "站台上的灯忽然全灭了。";

    expect(
      actVideoPromptDrifted(
        story,
        chapter.id,
        act,
        promptSnapshots(moka.resources),
      ),
    ).toBe(true);
  });

  it("says nothing about a clip taken from the shelf rather than filmed", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const chapter = story.chapters[0]!;
    const act = chapter.acts[0]!;
    act.video.takes[0]!.jobId = undefined;
    act.summary = "站台上的灯忽然全灭了。";

    expect(
      actVideoPromptDrifted(
        story,
        chapter.id,
        act,
        promptSnapshots(moka.resources),
      ),
    ).toBe(false);
  });
});
