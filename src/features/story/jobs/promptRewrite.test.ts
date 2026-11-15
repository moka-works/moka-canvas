import { beforeEach, describe, expect, it } from "vitest";

import type { ModelsView } from "../../../api/models";
import { useModelStore } from "../../settings/modelStore";
import { useStoryModels } from "../stores/storyModels";
import { videoPromptRewrite } from "./promptRewrite";

function twoVideoModels(): ModelsView {
  return {
    version: 1,
    revision: 1,
    models: [
      {
        id: "step-model",
        category: "video",
        protocol: "openai-videos",
        url: "http://127.0.0.1:8020/v1/videos",
        model: "plain",
        displayName: "Plain",
        enabled: true,
      },
      {
        id: "act-model",
        category: "video",
        protocol: "openai-h3",
        url: "http://127.0.0.1:8020/openai/v1/videos",
        model: "sora-2",
        displayName: "H3",
        enabled: true,
      },
    ],
    defaults: { video: "step-model" },
    preferences: {},
    secretStorage: "keyring",
  } as unknown as ModelsView;
}

const protocols = {
  video: {
    "openai-h3": {
      script: "video/openai-h3/openai-h3.lua",
      displayName: "OpenAI H3",
      urlExample: "http://127.0.0.1:8020/openai/v1/videos",
      promptRewrite: {
        guide: "CONTRACT GUIDE",
        checks: { bodyLanguage: "en", dialogueTag: "d", negativeBait: true },
        version: 1,
      },
    },
  },
};

beforeEach(() => {
  useStoryModels.setState({ choices: {} });
  useModelStore.setState({ view: twoVideoModels(), protocols });
});

describe("the contract a clip's words are written for", () => {
  it("reads the model that will film the act, not only the step's", () => {
    useStoryModels.setState({ choices: { video: "step-model" } });
    expect(videoPromptRewrite("actVideo")).toBeNull();
    expect(videoPromptRewrite("actVideo", "act-model")?.guide).toBe(
      "CONTRACT GUIDE",
    );
  });

  it("falls back to the step's model when the act names none", () => {
    useStoryModels.setState({ choices: { video: "act-model" } });
    expect(videoPromptRewrite("actVideo", null)?.guide).toBe("CONTRACT GUIDE");
  });

  it("declares nothing while the registry has not been read", () => {
    useModelStore.setState({ view: twoVideoModels(), protocols: null });
    expect(videoPromptRewrite("actVideo", "act-model")).toBeNull();
  });
});
