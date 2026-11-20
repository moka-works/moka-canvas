// @vitest-environment jsdom
import {
  act,
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
import { useImagePromptSessions } from "./imagePromptSessions";

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
  useStoryModels.setState({ choices: { image: ["image-1"] } });
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
  useImagePromptSessions.getState().reset();
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

  it("keeps hand-written words for an element's picture too", () => {
    useProjectStore.getState().hydrate({
      moka: buildStoryMokaFile(),
      root: "/tmp/moka-image-prompt-element-test",
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
    const onClose = vi.fn();
    render(
      <ImagePromptDialog
        onClose={onClose}
        place={{
          kind: "element",
          elementId: ids.hero,
          view: "main",
          name: "Keeper · main picture",
        }}
        story={useProjectStore.getState().moka!.stories![0]!}
      />,
    );
    const field = screen.getByTestId(
      "story-image-prompt-text",
    ) as HTMLTextAreaElement;
    expect(field.value.length).toBeGreaterThan(0);
    fireEvent.change(field, {
      target: { value: "A portrait of the keeper." },
    });
    fireEvent.click(screen.getByTestId("story-image-prompt-save"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      useProjectStore.getState().moka!.stories![0]!.imagePromptOverrides?.[
        `element:main:${ids.hero}`
      ]?.prompt,
    ).toBe("A portrait of the keeper.");
  });
});

describe("a picture's prompt before it is drawn", () => {
  it("offers a rewrite only when the model declares a contract", () => {
    open();
    expect(screen.getByTestId("story-image-prompt-draw")).toBeTruthy();
    expect(screen.queryByTestId("story-image-prompt-rewrite")).toBeNull();
    expect(screen.queryByTestId("story-image-prompt-model")).toBeNull();
  });

  it("keeps the rewrite and its model in one column, apart from the buttons", () => {
    imageWithContract();
    open();
    const tools = document.querySelector(".story-prompt-rewrite");
    expect(tools).not.toBeNull();
    expect(
      tools!.contains(screen.getByTestId("story-image-prompt-rewrite")),
    ).toBe(true);
    expect(
      tools!.contains(screen.getByTestId("story-image-prompt-model")),
    ).toBe(true);
    const actions = document.querySelector(".dialog-actions");
    expect(
      actions!.contains(screen.getByTestId("story-image-prompt-draw")),
    ).toBe(true);
    expect(actions!.contains(tools!)).toBe(false);
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

  it("keeps a rewrite going after the dialog is closed, and reads it again on return", async () => {
    imageWithContract();
    let answer: (value: GenerateResponse) => void = () => {};
    const pending = new Promise<GenerateResponse>((resolve) => {
      answer = resolve;
    });
    const text = vi.spyOn(generateApi, "text").mockReturnValue(pending);

    const { onClose } = open();
    fireEvent.click(screen.getByTestId("story-image-prompt-rewrite"));
    await waitFor(() => expect(text).toHaveBeenCalledTimes(1));
    const signal = text.mock.calls[0]![1] as AbortSignal;

    // The reader clicks outside the dialog: the dialog goes, the ask does not.
    fireEvent.click(document.querySelector(".dialog-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    expect(signal.aborted).toBe(false);

    // Opened again on the same shot with the ask still out, the dialog says so
    // rather than offering to ask a second time.
    open();
    const again = screen.getByTestId("story-image-prompt-rewrite");
    expect(again.textContent).toBe("Rewriting…");
    expect(again).toHaveProperty("disabled", true);

    // The answer lands with nothing on screen, and the dialog opened after it
    // reads the words the ask wrote.
    await act(async () => {
      answer({
        status: "succeeded",
        outputs: [],
        text: "A still frame of the lantern. No subtitles.",
      } as GenerateResponse);
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("story-image-prompt-text") as HTMLTextAreaElement)
          .value,
      ).toContain("A still frame of the lantern."),
    );
    expect(screen.getByTestId("story-image-prompt-rewrite").textContent).toBe(
      "Rewrite prompt",
    );
    text.mockRestore();
  });

  it("offers no cancel while nothing is on its way, and closes from the corner", () => {
    imageWithContract();
    const { onClose } = open();
    expect(screen.queryByTestId("story-image-prompt-cancel")).toBeNull();

    fireEvent.click(screen.getByTestId("story-image-prompt-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes a rewrite back on cancel, keeping the words and the session", async () => {
    imageWithContract();
    let answer: (value: GenerateResponse) => void = () => {};
    const pending = new Promise<GenerateResponse>((resolve) => {
      answer = resolve;
    });
    const text = vi.spyOn(generateApi, "text").mockReturnValue(pending);

    const { onClose } = open();
    const before = (
      screen.getByTestId("story-image-prompt-text") as HTMLTextAreaElement
    ).value;
    fireEvent.click(screen.getByTestId("story-image-prompt-rewrite"));
    await waitFor(() => expect(text).toHaveBeenCalledTimes(1));
    const signal = text.mock.calls[0]![1] as AbortSignal;

    // Cancel is offered only while the rewrite is on its way, and it is the
    // ask it takes back — not the dialog it closes over.
    fireEvent.click(screen.getByTestId("story-image-prompt-cancel"));
    expect(signal.aborted).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("story-image-prompt-cancel")).toBeNull();
    expect(
      (screen.getByTestId("story-image-prompt-text") as HTMLTextAreaElement)
        .value,
    ).toBe(before);
    const again = screen.getByTestId("story-image-prompt-rewrite");
    expect(again.textContent).toBe("Rewrite prompt");
    expect(again).toHaveProperty("disabled", false);

    // The answer the cancelled ask would have written belongs to nobody: the
    // field keeps the words the reader had.
    await act(async () => {
      answer({
        status: "succeeded",
        outputs: [],
        text: "A still frame of the lantern. No subtitles.",
      } as GenerateResponse);
    });
    expect(
      (screen.getByTestId("story-image-prompt-text") as HTMLTextAreaElement)
        .value,
    ).toBe(before);
    text.mockRestore();
  });
});
