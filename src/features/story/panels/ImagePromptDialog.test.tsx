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
import { generateApi } from "../../../api/generate";
import type { GenerateResponse } from "../../../api/generate";
import type { ModelsView } from "../../../api/models";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { MokaFile } from "../../../shared/domain/types";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { useStoryModels } from "../stores/storyModels";
import { ImagePromptDialog } from "./ImagePromptDialog";

const ids = storyIds();
const ASK = `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`;

function open(moka: MokaFile = buildStoryMokaFile()) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-image-prompt-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  const onClose = vi.fn();
  render(
    <ImagePromptDialog
      onClose={onClose}
      place={{
        kind: "keyframe",
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
  moka.stories![0]!.imagePromptOverrides = { [ASK]: { prompt, auto } };
  return moka;
}

function imageWithContract() {
  useStoryModels.setState({ choices: { image: "image-1" } });
  useModelStore.setState({
    view: {
      version: 1,
      revision: 1,
      models: [
        {
          id: "image-1",
          category: "image",
          protocol: "openai-images",
          url: "http://127.0.0.1:8020/v1/images/generations",
          model: "gpt-image",
          displayName: "Images",
          enabled: true,
        },
      ],
      defaults: { image: "image-1" },
      preferences: {},
      secretStorage: "keyring",
    } as unknown as ModelsView,
    protocols: {
      image: {
        "openai-images": {
          script: "image/openai-images/openai-images.lua",
          displayName: "OpenAI Images",
          urlExample: "http://127.0.0.1:8020/v1/images/generations",
          promptRewrite: {
            guide: "IMAGE CONTRACT GUIDE",
            checks: { negativeBait: true },
            version: 1,
          },
        },
      },
    },
  });
}

beforeEach(() => {
  useModelStore.setState({ view: null, protocols: null });
  useStoryModels.setState({ choices: {} });
  useHistoryStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

describe("a picture's prompt written by hand", () => {
  it("shows the whole ask and keeps the reader's words", () => {
    const { onClose } = open();
    const field = screen.getByTestId(
      "story-image-prompt-text",
    ) as HTMLTextAreaElement;
    expect(field.value).toContain("雨中的站台");

    fireEvent.change(field, {
      target: { value: "A still frame of the lantern." },
    });
    fireEvent.click(screen.getByTestId("story-image-prompt-save"));

    expect(onClose).toHaveBeenCalledTimes(1);
    const story = useProjectStore.getState().moka!.stories![0]!;
    expect(story.imagePromptOverrides?.[ASK]?.prompt).toBe(
      "A still frame of the lantern.",
    );
    expect(story.imagePromptOverrides?.[ASK]?.auto).toHaveLength(8);
  });

  it("refuses words that say nothing", () => {
    const { onClose } = open();
    fireEvent.change(screen.getByTestId("story-image-prompt-text"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByTestId("story-image-prompt-save"));

    expect(screen.getByRole("alert").textContent).toContain(
      "The prompt cannot be empty",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(
      useProjectStore.getState().moka!.stories![0]!.imagePromptOverrides,
    ).toBeUndefined();
  });

  it("hands the picture back to the board when the reader restores it", () => {
    open(withOverride("A still frame of the lantern.", "0badcafe"));
    expect(
      (screen.getByTestId("story-image-prompt-text") as HTMLTextAreaElement)
        .value,
    ).toBe("A still frame of the lantern.");

    fireEvent.click(screen.getByTestId("story-image-prompt-reset"));
    const field = screen.getByTestId(
      "story-image-prompt-text",
    ) as HTMLTextAreaElement;
    expect(field.value).toContain("雨中的站台");

    fireEvent.click(screen.getByTestId("story-image-prompt-save"));
    expect(
      useProjectStore.getState().moka!.stories![0]!.imagePromptOverrides,
    ).toBeUndefined();
  });

  it("says when the board has moved on from the words that were written", () => {
    open(withOverride("A still frame of the lantern.", "0badcafe"));
    expect(
      screen.getByTestId("story-image-prompt-moved").textContent,
    ).toContain("The board has changed");
  });
});

describe("a picture's prompt before it is drawn", () => {
  it("offers a rewrite only when the model declares a contract", () => {
    open();
    expect(screen.getByTestId("story-image-prompt-draw")).toBeTruthy();
    expect(screen.queryByTestId("story-image-prompt-rewrite")).toBeNull();
  });

  it("rewrites from the contract and the material, and names what is still wrong", async () => {
    imageWithContract();
    const text = vi.spyOn(generateApi, "text").mockResolvedValue({
      status: "succeeded",
      outputs: [],
      text: "A still frame of the lantern. No subtitles.",
    } as GenerateResponse);

    open();
    fireEvent.click(screen.getByTestId("story-image-prompt-rewrite"));

    await waitFor(() =>
      expect(
        (screen.getByTestId("story-image-prompt-text") as HTMLTextAreaElement)
          .value,
      ).toContain("A still frame of the lantern."),
    );
    const request = text.mock.calls[0]![0];
    expect(request.system).toContain("IMAGE CONTRACT GUIDE");
    expect(request.params).toEqual({ temperature: 0.2 });
    expect(request.prompt).toContain("雨中的站台");
    expect(
      screen.getByTestId("story-image-prompt-issues").textContent,
    ).toContain("no subtitles");
    text.mockRestore();
  });

  it("shows the model's refusal rather than a generic failure", async () => {
    imageWithContract();
    const text = vi
      .spyOn(generateApi, "text")
      .mockRejectedValue(new Error("the text model is not configured"));

    open();
    fireEvent.click(screen.getByTestId("story-image-prompt-rewrite"));

    await waitFor(() =>
      expect(
        screen.getByTestId("story-image-prompt-rewrite-error").textContent,
      ).toContain("the text model is not configured"),
    );
    text.mockRestore();
  });
});
