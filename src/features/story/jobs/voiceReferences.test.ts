import { beforeEach, describe, expect, it } from "vitest";

import type { ModelsView, ProtocolGroups } from "../../../api/models";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { useModelStore } from "../../settings/modelStore";
import { useStoryModels } from "../stores/storyModels";
import {
  audioCapableVideoModel,
  refreshVoiceReferences,
  stripVoiceReferences,
  voiceReferenceState,
  voiceReferencesFor,
  withVoiceReferences,
} from "./voiceReferences";

const ids = storyIds();

function story() {
  const held = buildStoryMokaFile().stories?.[0];
  if (held === undefined) throw new Error("the fixture holds a story");
  return held;
}

function viewWithVideo(
  models: Array<{ id: string; audioReference: boolean; protocol?: string }>,
): { view: ModelsView; protocols: ProtocolGroups } {
  return {
    view: {
      version: 1,
      revision: 1,
      models: models.map(({ id, protocol }) => ({
        id,
        category: "video" as const,
        protocol: protocol ?? "minimaxVideo",
        url: "https://provider.test/v2/video_generation",
        model: id,
        displayName: id,
        maxVideoSeconds: 15,
        enabled: true,
        apiKey: { set: false, masked: null },
      })),
      defaults: {
        text: null,
        image: null,
        speech: null,
        music: null,
        video: models[0]?.id ?? null,
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
        minimaxVideo: {
          script: "minimax-video.lua",
          displayName: "MiniMax",
          urlExample: "https://provider.test/v2/video_generation",
          features: {
            audioReference: true,
            audioReferenceSeconds: 11,
            audioReferenceSpeakers: 3,
          },
        },
        openaiVideos: {
          script: "openai-videos.lua",
          displayName: "OpenAI Videos",
          urlExample: "https://provider.test/v1/videos",
          features: {},
        },
      },
    },
  };
}

beforeEach(() => {
  useModelStore.setState({ view: null, protocols: null });
  useStoryModels.setState({ choices: {} });
});

describe("the voice mapping paragraph", () => {
  const voices = [
    { speaker: "S2", name: "周", assetId: "asset-bo" },
    { speaker: "S1", name: "林", assetId: "asset-hero" },
  ];

  it("sits inside the description the service reads", () => {
    const prompt = withVoiceReferences(
      "integrated_multimodal_description: Rain.\n\noverall_soundscape: N/A",
      voices,
    );
    expect(prompt).toContain(
      "<Audio 1> carries the voice of the speaker labelled (S2)",
    );
    expect(prompt).toContain(
      "<Audio 2> carries the voice of the speaker labelled (S1)",
    );
    expect(prompt.indexOf("Voice references:")).toBeGreaterThan(
      prompt.indexOf("integrated_multimodal_description:"),
    );
    expect(prompt.indexOf("Voice references:")).toBeLessThan(
      prompt.indexOf("overall_soundscape:"),
    );
  });

  it("is idempotent, and strips back to the words it was added to", () => {
    const base = "Shoot this shot as a clip.";
    const once = withVoiceReferences(base, voices);
    const twice = withVoiceReferences(once, voices);
    expect(twice).toBe(once);
    expect(stripVoiceReferences(once)).toBe(base);
  });

  it("is not added twice when a rewrite kept it", () => {
    const once = withVoiceReferences("Shoot this shot.", voices);
    expect(refreshVoiceReferences(once, voices)).toBe(once);
    const without = refreshVoiceReferences("Shoot this shot.", voices);
    expect(without).toBe(once);
  });

  it("sits before the soundscape when the contract names no description", () => {
    const prompt = withVoiceReferences(
      "overall_soundscape: rain.\n\nnon_diegetic_music: N/A",
      voices,
    );
    expect(prompt.indexOf("Voice references:")).toBeLessThan(
      prompt.indexOf("overall_soundscape:"),
    );
  });
});

describe("which recordings ride", () => {
  it("takes the speakers in first-speech order, with their stable ids", () => {
    const held = story();
    const hero = held.elements.find((element) => element.id === ids.hero)!;
    const partner = held.elements.find(
      (element) => element.id === ids.partner,
    )!;
    hero.voice = {
      model: "",
      voice: "",
      referenceAssetId: "asset-hero-voice",
    };
    partner.voice = {
      model: "",
      voice: "",
      referenceAssetId: "asset-partner-voice",
    };
    const keyframe = held.chapters[0]!.acts[0]!.keyframes[0]!;
    const lines = [
      ...keyframe.dialogue,
      {
        id: "line-2",
        characterId: ids.partner,
        speaker: "周",
        text: "我也是。",
      },
    ];
    expect(voiceReferencesFor(held, lines)).toEqual([
      { speaker: "S1", name: "林", assetId: "asset-hero-voice" },
      { speaker: "S2", name: "周", assetId: "asset-partner-voice" },
    ]);
    // A converter that reads one recording takes the first speaker only.
    expect(voiceReferencesFor(held, lines, 1)).toEqual([
      { speaker: "S1", name: "林", assetId: "asset-hero-voice" },
    ]);
  });
});

describe("the model an audio ask is sent to", () => {
  it("stays with a chosen model that reads recordings", () => {
    useModelStore.setState(
      viewWithVideo([{ id: "filmer", audioReference: true }]),
    );
    const act = story().chapters[0]!.acts[0]!;
    expect(audioCapableVideoModel(act, "filmer", 4)).toBe("filmer");
  });

  it("replaces a chosen model that reads none with one that does", () => {
    const settings = viewWithVideo([
      { id: "plain", audioReference: false, protocol: "openaiVideos" },
      { id: "filmer", audioReference: true },
    ]);
    useModelStore.setState(settings);
    useStoryModels.setState({ choices: { video: ["plain", "filmer"] } });
    const act = story().chapters[0]!.acts[0]!;
    expect(audioCapableVideoModel(act, "plain", 4)).toBe("filmer");
  });

  it("says why a recording is not travelling", () => {
    useModelStore.setState(
      viewWithVideo([{ id: "filmer", audioReference: true }]),
    );
    const held = story();
    const act = held.chapters[0]!.acts[0]!;
    const keyframe = act.keyframes[0]!;
    expect(voiceReferenceState(held, keyframe.dialogue, 4, act).state).toBe(
      "noRecording",
    );

    held.elements.find((element) => element.id === ids.hero)!.voice = {
      model: "",
      voice: "",
      referenceAssetId: "asset-hero-voice",
    };
    expect(voiceReferenceState(held, keyframe.dialogue, 12, act).state).toBe(
      "tooLong",
    );
    expect(voiceReferenceState(held, keyframe.dialogue, 4, act).state).toBe(
      "on",
    );

    useModelStore.setState(
      viewWithVideo([
        { id: "plain", audioReference: false, protocol: "openaiVideos" },
      ]),
    );
    expect(voiceReferenceState(held, keyframe.dialogue, 4, act).state).toBe(
      "noModel",
    );
  });

  it("uses the window each converter declares, and no window where it names none", () => {
    const settings = viewWithVideo([{ id: "filmer", audioReference: true }]);
    useModelStore.setState(settings);
    const held = story();
    held.elements.find((element) => element.id === ids.hero)!.voice = {
      model: "",
      voice: "",
      referenceAssetId: "asset-hero-voice",
    };
    const act = held.chapters[0]!.acts[0]!;
    const keyframe = act.keyframes[0]!;
    // MiniMax whispers 11 seconds; a longer clip is left without the recording.
    expect(voiceReferenceState(held, keyframe.dialogue, 12, act)).toEqual({
      state: "tooLong",
      voices: [{ speaker: "S1", name: "林", assetId: "asset-hero-voice" }],
      seconds: 11,
    });

    // A protocol that names no window is read at the model's own clip length.
    settings.protocols.video!["minimaxVideo"]!.features = {
      audioReference: true,
    };
    useModelStore.setState(settings);
    expect(voiceReferenceState(held, keyframe.dialogue, 20, act).state).toBe(
      "on",
    );
    expect(audioCapableVideoModel(act, "filmer", 20)).toBe("filmer");
  });
});
