import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerateResponse } from "../../../api/generate";
import { generateApi } from "../../../api/generate";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { StoryDocument } from "../../../shared/domain/types";
import { useModelStore } from "../../settings/modelStore";
import { useStoryModels } from "../stores/storyModels";
import { planMissingVideoWaves } from "./plan";
import { rewriteVideoWaves } from "./rewriteVideos";

const ids = storyIds();

/** The fixture with its act's clip pending and long enough to be filmed in pieces. */
function pendingAct(): StoryDocument {
  const held = buildStoryMokaFile().stories![0]!;
  const act = held.chapters[0]!.acts[0]!;
  act.video = { takes: [] };
  act.keyframes[1]!.art = {
    takes: [
      { assetIds: ["asset-frame-second"], createdAt: "2026-01-01T00:00:00Z" },
    ],
  };
  for (const keyframe of act.keyframes) keyframe.durationMs = 9_000;
  return held;
}

function withVideoContract(): void {
  useModelStore.setState({
    view: {
      version: 1,
      revision: 1,
      models: [
        {
          id: "filmer",
          category: "video",
          protocol: "bailianVideo",
          url: "https://provider.test/video-synthesis",
          model: "filmer",
          displayName: "Filmer",
          maxVideoSeconds: 15,
          enabled: true,
          apiKey: { set: false, masked: null },
        },
      ],
      defaults: {
        text: null,
        image: null,
        speech: null,
        music: null,
        video: "filmer",
        asr: null,
      },
      preferences: {
        systemPrompt: "",
        reasoningEffort: "auto",
        image: { size: "1024x1024", quality: "auto", background: "", count: 1 },
        video: {
          seconds: 6,
          resolution: "",
          generateAudio: false,
          watermark: false,
          mode: "auto",
          ratio: "",
        },
        speech: {
          voice: "",
          format: "",
          speed: 1,
          instructions: "",
          sampleRate: 22_050,
          volume: 50,
          rate: 1,
          pitch: 1,
        },
        music: { format: "mp3", watermark: false },
        story: { splitChars: 12_000 },
      },
      secretStorage: "unset",
    },
    protocols: {
      video: {
        bailianVideo: {
          script: "video/bailianVideo/bailianVideo.lua",
          displayName: "Bailian Video",
          urlExample: "https://provider.test/video-synthesis",
          promptRewrite: {
            guide: "VIDEO CONTRACT",
            checks: {},
            version: 1,
          },
        },
      },
    },
  });
}

function answer(text: string): GenerateResponse {
  return {
    status: "succeeded",
    outputs: [],
    text,
  } as GenerateResponse;
}

beforeEach(() => {
  useModelStore.setState({ view: null, protocols: null });
  useStoryModels.setState({ choices: {} });
});

describe("rewriting a bulk press's clip words", () => {
  it("rewrites each piece of a long act on its own words", async () => {
    const story = pendingAct();
    withVideoContract();
    const text = vi
      .spyOn(generateApi, "text")
      .mockResolvedValue(answer("rewritten clip"));

    const waves = planMissingVideoWaves(story, [
      { chapterId: ids.chapterFirst, actId: ids.act },
    ]);
    expect(waves[0]?.items).toHaveLength(2);
    const prepared = await rewriteVideoWaves(story, waves);

    // One act, two pieces: each piece hears its own words rewritten rather
    // than the first answer standing for both.
    expect(text).toHaveBeenCalledTimes(2);
    const asked = text.mock.calls.map(([request]) => request.prompt);
    expect(asked[0]).toContain("part 1 of 2");
    expect(asked[1]).toContain("part 2 of 2");
    expect(prepared.waves[0]?.items.map((item) => item.prompt)).toEqual([
      "rewritten clip",
      "rewritten clip",
    ]);
    expect(prepared.failed).toEqual([]);
  });

  it("reads the board's own words again for every take", async () => {
    const story = pendingAct();
    withVideoContract();
    const text = vi
      .spyOn(generateApi, "text")
      .mockResolvedValueOnce(answer("first take words"))
      .mockResolvedValueOnce(answer("first take words"))
      .mockResolvedValueOnce(answer("second take words"))
      .mockResolvedValueOnce(answer("second take words"));

    const waves = planMissingVideoWaves(story, [
      { chapterId: ids.chapterFirst, actId: ids.act },
    ]);
    const first = await rewriteVideoWaves(story, waves);
    const second = await rewriteVideoWaves(story, waves);

    const asked = text.mock.calls.map(([request]) => request.prompt);
    // The second take's asks are the board's words again, not the first
    // take's rewrite: a video repeats itself when it hears the same words.
    expect(asked[2]).toContain("part 1 of 2");
    expect(asked[3]).toContain("part 2 of 2");
    expect(asked[2]).not.toContain("first take words");
    expect(first.waves[0]?.items[0]?.prompt).toBe("first take words");
    expect(second.waves[0]?.items[0]?.prompt).toBe("second take words");
  });

  it("drops the whole act when one of its pieces cannot be rewritten", async () => {
    const story = pendingAct();
    withVideoContract();
    vi.spyOn(generateApi, "text")
      .mockResolvedValueOnce(answer("rewritten clip"))
      .mockRejectedValueOnce(new Error("the model refused"));

    const waves = planMissingVideoWaves(story, [
      { chapterId: ids.chapterFirst, actId: ids.act },
    ]);
    const prepared = await rewriteVideoWaves(story, waves);

    // A clip made from one of the act's pieces is a shorter act than the
    // board wrote, so the act travels without either piece.
    expect(prepared.waves).toEqual([]);
    expect(prepared.failed).toHaveLength(1);
    expect(prepared.failed[0]?.label).toContain("第 1 幕 空站台");
  });

  it("leaves the words as they stand when the model declares no contract", async () => {
    const story = pendingAct();
    const text = vi.spyOn(generateApi, "text");

    const waves = planMissingVideoWaves(story, [
      { chapterId: ids.chapterFirst, actId: ids.act },
    ]);
    const prepared = await rewriteVideoWaves(story, waves);

    expect(text).not.toHaveBeenCalled();
    expect(prepared.untouched).toBe(1);
    expect(prepared.waves[0]?.items.map((item) => item.prompt)).toEqual(
      waves[0]?.items.map((item) => item.prompt),
    );
  });

  it("drops only the shot whose words were refused", async () => {
    const story = pendingAct();
    story.shotGranularity = "keyframe";
    withVideoContract();
    vi.spyOn(generateApi, "text")
      .mockRejectedValueOnce(new Error("the model refused"))
      .mockResolvedValueOnce(answer("rewritten shot"));

    const waves = planMissingVideoWaves(story, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
    ]);
    const prepared = await rewriteVideoWaves(story, waves);

    expect(prepared.failed).toHaveLength(1);
    expect(prepared.waves[0]?.items.map((item) => item.id)).toEqual([
      `keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`,
    ]);
    expect(prepared.waves[0]?.items[0]?.prompt).toBe("rewritten shot");
  });
});
