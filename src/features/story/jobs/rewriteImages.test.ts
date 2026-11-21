import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApi } from "../../../api/generate";
import type { GenerateResponse } from "../../../api/generate";
import type { ModelsView, ProtocolGroups } from "../../../api/models";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { StoryDocument } from "../../../shared/domain/types";
import { useModelStore } from "../../settings/modelStore";
import { useStoryModels } from "../stores/storyModels";
import { planKeyframeArtWaves } from "./plan";
import { rewriteImageWaves } from "./rewriteImages";

const ids = storyIds();

function story(): StoryDocument {
  const held = buildStoryMokaFile().stories?.[0];
  if (held === undefined) throw new Error("the fixture holds a story");
  return held;
}

const painter = (id: string) => ({
  id,
  category: "image" as const,
  protocol: "openai-images",
  url: "https://provider.test/images",
  model: id,
  displayName: id,
  enabled: true,
  apiKey: { set: false, masked: null },
});

/** The settings with two picture models, the first the deployment's default. */
function withPainters(contract: "both" | "first" | "none"): void {
  const view = {
    version: 1,
    revision: 1,
    models: [painter("paint-1"), painter("paint-2")],
    defaults: {
      text: null,
      image: "paint-1",
      speech: null,
      music: null,
      video: null,
      asr: null,
    },
    preferences: {},
    secretStorage: "unset",
  } as unknown as ModelsView;
  const declared =
    contract === "none"
      ? undefined
      : {
          guide: "IMAGE CONTRACT",
          checks: {},
          version: 1,
        };
  const protocols: ProtocolGroups = {
    image: {
      "openai-images": {
        script: "image/openai-images/openai-images.lua",
        displayName: "OpenAI Images",
        urlExample: "https://provider.test/images",
        ...(declared === undefined ? {} : { promptRewrite: declared }),
      },
    },
  };
  useModelStore.setState({ view, protocols });
}

function oneFrame(count: number) {
  return planKeyframeArtWaves(story(), [
    {
      chapterId: ids.chapterFirst,
      actId: ids.act,
      keyframeId: ids.frameFirst,
      count,
    },
  ]);
}

function said(text: string): GenerateResponse {
  return { status: "succeeded", outputs: [], text };
}

beforeEach(() => {
  useModelStore.setState({ view: null, protocols: null });
  useStoryModels.setState({ choices: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rewriting a batch's picture prompts", () => {
  it("rewrites a place once, however many pictures its set holds", async () => {
    withPainters("both");
    useStoryModels.setState({ choices: { image: ["paint-1", "paint-2"] } });
    const text = vi
      .spyOn(generateApi, "text")
      .mockResolvedValue(said("A rewritten frame."));

    const waves = oneFrame(3);
    // The three requests of one frame take turns over the two models, which is
    // the plan's work rather than the rewrite's.
    expect(waves.map((wave) => wave.model)).toEqual(["paint-1", "paint-2"]);
    const prepared = await rewriteImageWaves(story(), "keyframeArt", waves);

    expect(text).toHaveBeenCalledTimes(1);
    expect(prepared.rewritten).toBe(1);
    expect(prepared.failed).toEqual([]);
    expect(
      prepared.waves.flatMap((wave) => wave.items.map((item) => item.prompt)),
    ).toEqual([
      "A rewritten frame.",
      "A rewritten frame.",
      "A rewritten frame.",
    ]);
  });

  it("leaves the words of a model that declares no contract as they stand", async () => {
    withPainters("none");
    const text = vi.spyOn(generateApi, "text");
    const waves = oneFrame(2);

    const prepared = await rewriteImageWaves(story(), "keyframeArt", waves);

    expect(text).not.toHaveBeenCalled();
    expect(prepared.rewritten).toBe(0);
    expect(prepared.untouched).toBe(1);
    expect(prepared.waves.flatMap((wave) => wave.items)).toEqual(
      waves.flatMap((wave) => wave.items),
    );
  });

  it("keeps a place out of the batch when its words could not be rewritten", async () => {
    withPainters("both");
    vi.spyOn(generateApi, "text").mockRejectedValue(
      new Error("the provider said no"),
    );

    const prepared = await rewriteImageWaves(
      story(),
      "keyframeArt",
      oneFrame(2),
    );

    expect(prepared.waves).toEqual([]);
    expect(prepared.rewritten).toBe(0);
    expect(prepared.failed).toHaveLength(1);
    expect(prepared.failed[0]?.message).toBe("the provider said no");
    expect(prepared.failed[0]?.label).toContain("#1");
  });

  it("stops when the reader takes the rewrite back", async () => {
    withPainters("both");
    const controller = new AbortController();
    vi.spyOn(generateApi, "text").mockImplementation(
      (_request, signal) =>
        new Promise((_settle, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    const asking = rewriteImageWaves(story(), "keyframeArt", oneFrame(1), {
      signal: controller.signal,
    });
    controller.abort();

    await expect(asking).rejects.toThrow();
  });
});
