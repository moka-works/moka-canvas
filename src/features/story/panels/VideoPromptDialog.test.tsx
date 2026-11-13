// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { MokaFile } from "../../../shared/domain/types";
import { generateApi } from "../../../api/generate";
import type { GenerateResponse } from "../../../api/generate";
import type { ModelsView } from "../../../api/models";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { useStoryModels } from "../stores/storyModels";
import { VideoPromptDialog } from "./VideoPromptDialog";

const ids = storyIds();
const ASK = `keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`;

function open(
  moka: MokaFile = buildStoryMokaFile(),
  mode: "edit" | "film" = "edit",
) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-video-prompt-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  const onClose = vi.fn();
  render(
    <VideoPromptDialog
      mode={mode}
      onClose={onClose}
      place={{
        kind: "shot",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
        name: "Shot 1",
      }}
      story={useProjectStore.getState().moka!.stories![0]!}
    />,
  );
  return { onClose };
}

function withOverride(prompt: string, auto: string): MokaFile {
  const moka = buildStoryMokaFile();
  moka.stories![0]!.videoPromptOverrides = { [ASK]: { prompt, auto } };
  return moka;
}

beforeEach(() => {
  useModelStore.setState({ view: null, protocols: null });
  useStoryModels.setState({ choices: {} });
  useHistoryStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

describe("a clip's prompt written by hand", () => {
  it("shows the whole ask and keeps the reader's words", () => {
    const { onClose } = open();
    const field = screen.getByTestId(
      "story-video-prompt-text-0",
    ) as HTMLTextAreaElement;
    expect(field.value).toContain("Shoot this shot");
    expect(field.value).toContain("雨中的站台");

    fireEvent.change(field, { target: { value: "Hold on the lantern." } });
    fireEvent.click(screen.getByTestId("story-video-prompt-save"));

    expect(onClose).toHaveBeenCalledTimes(1);
    const story = useProjectStore.getState().moka!.stories![0]!;
    expect(story.videoPromptOverrides?.[ASK]?.prompt).toBe(
      "Hold on the lantern.",
    );
    expect(story.videoPromptOverrides?.[ASK]?.auto).toHaveLength(8);
  });

  it("refuses words that say nothing", () => {
    const { onClose } = open();
    fireEvent.change(screen.getByTestId("story-video-prompt-text-0"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByTestId("story-video-prompt-save"));

    expect(screen.getByRole("alert").textContent).toContain(
      "The prompt cannot be empty",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(
      useProjectStore.getState().moka!.stories![0]!.videoPromptOverrides,
    ).toBeUndefined();
  });

  it("hands a piece back to the board when the reader restores it", () => {
    open(withOverride("Hold on the lantern.", "0badcafe"));
    expect(
      (screen.getByTestId("story-video-prompt-text-0") as HTMLTextAreaElement)
        .value,
    ).toBe("Hold on the lantern.");

    fireEvent.click(screen.getByTestId("story-video-prompt-reset-0"));
    const field = screen.getByTestId(
      "story-video-prompt-text-0",
    ) as HTMLTextAreaElement;
    expect(field.value).toContain("Shoot this shot");

    fireEvent.click(screen.getByTestId("story-video-prompt-save"));
    expect(
      useProjectStore.getState().moka!.stories![0]!.videoPromptOverrides,
    ).toBeUndefined();
  });

  it("says when the board has moved on from the words that were written", () => {
    open(withOverride("Hold on the lantern.", "0badcafe"));
    expect(
      screen.getByTestId("story-video-prompt-moved-0").textContent,
    ).toContain("The board has changed");
  });
});

/** A video model whose protocol declares a prompt contract. */
function filmWithContract() {
  useStoryModels.setState({ choices: { video: "video-1" } });
  useModelStore.setState({
    view: {
      version: 1,
      revision: 1,
      models: [
        {
          id: "video-1",
          category: "video",
          protocol: "openai-h3",
          url: "http://127.0.0.1:8020/openai/v1/videos",
          model: "sora-2",
          displayName: "H3",
          enabled: true,
        },
      ],
      defaults: { video: "video-1" },
      preferences: {},
      secretStorage: "keyring",
    } as unknown as ModelsView,
    protocols: {
      video: {
        "openai-h3": {
          script: "video/openai-h3/openai-h3.lua",
          displayName: "OpenAI H3",
          urlExample: "http://127.0.0.1:8020/openai/v1/videos",
          promptRewrite: {
            guide: "CONTRACT GUIDE",
            checks: {
              bodyLanguage: "en",
              dialogueTag: "d",
              negativeBait: true,
            },
            version: 1,
          },
        },
      },
    },
  });
}

describe("a clip's prompt before it is filmed", () => {
  it("offers a rewrite only when the model declares a contract", () => {
    open(undefined, "film");
    expect(screen.getByTestId("story-video-prompt-send")).toBeTruthy();
    expect(screen.queryByTestId("story-video-prompt-rewrite")).toBeNull();
  });

  it("rewrites the words from the contract and the material, and names what is still wrong", async () => {
    filmWithContract();
    const text = vi.spyOn(generateApi, "text").mockResolvedValue({
      status: "succeeded",
      outputs: [],
      text: "integrated_multimodal_description: [Shot 1] She waits.",
    } as GenerateResponse);

    open(undefined, "film");
    fireEvent.click(screen.getByTestId("story-video-prompt-rewrite"));

    await waitFor(() =>
      expect(
        (screen.getByTestId("story-video-prompt-text-0") as HTMLTextAreaElement)
          .value,
      ).toContain("She waits."),
    );
    const request = text.mock.calls[0]![0];
    expect(request.system).toContain("CONTRACT GUIDE");
    expect(request.params).toEqual({ temperature: 0.2 });
    expect(request.prompt).toContain("车已经停运了。");
    expect(
      screen.getByTestId("story-video-prompt-issues").textContent,
    ).toContain("车已经停运了。");
    text.mockRestore();
  });

  it("shows the model's refusal rather than a generic failure", async () => {
    filmWithContract();
    const text = vi
      .spyOn(generateApi, "text")
      .mockRejectedValue(new Error("the text model is not configured"));

    open(undefined, "film");
    fireEvent.click(screen.getByTestId("story-video-prompt-rewrite"));

    await waitFor(() =>
      expect(
        screen.getByTestId("story-video-prompt-rewrite-error").textContent,
      ).toContain("the text model is not configured"),
    );
    text.mockRestore();
  });
});
