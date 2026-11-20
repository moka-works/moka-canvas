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
import { useVideoPromptSessions } from "./videoPromptSessions";

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
  useVideoPromptSessions.getState().reset();
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

  it("takes the board's new words when it is opened again after the board moved", () => {
    const moka = buildStoryMokaFile();
    const frame = moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!;
    open(moka);
    cleanup();

    // The reader retimes the shot and rewrites it by hand while the dialog is
    // closed: the words nobody touched follow the board, not the session.
    frame.content = "雨中的站台，灯灭了。";
    frame.durationMs = 5_000;
    open(moka);
    const field = screen.getByTestId(
      "story-video-prompt-text-0",
    ) as HTMLTextAreaElement;
    expect(field.value).toContain("灯灭了。");
    expect(field.value).toContain("about 5 seconds");
  });

  it("keeps the reader's own words when the board moves under them", () => {
    const moka = buildStoryMokaFile();
    const frame = moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!;
    open(moka);
    const field = screen.getByTestId(
      "story-video-prompt-text-0",
    ) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Hold on the lantern." } });
    cleanup();

    frame.content = "雨中的站台，灯灭了。";
    open(moka);
    expect(
      (screen.getByTestId("story-video-prompt-text-0") as HTMLTextAreaElement)
        .value,
    ).toBe("Hold on the lantern.");
  });
});

/** A video model whose protocol declares a prompt contract. */
function filmWithContract() {
  useStoryModels.setState({ choices: { video: ["video-1"] } });
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
        {
          id: "text-1",
          category: "text",
          protocol: "openai",
          url: "http://127.0.0.1:8020/v1/chat/completions",
          model: "writer",
          displayName: "Writer",
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
    expect(screen.queryByTestId("story-video-prompt-model")).toBeNull();
  });

  it("asks the text model the reader names, or the room's own when none is named", async () => {
    filmWithContract();
    const text = vi.spyOn(generateApi, "text").mockResolvedValue({
      status: "succeeded",
      outputs: [],
      text: "integrated_multimodal_description: [Shot 1] She waits.",
    } as GenerateResponse);

    open(undefined, "film");
    const picker = screen.getByTestId(
      "story-video-prompt-model",
    ) as HTMLSelectElement;
    // The room's own model until the reader names another for this place.
    expect(picker.value).toBe("");

    fireEvent.change(picker, { target: { value: "text-1" } });
    fireEvent.click(screen.getByTestId("story-video-prompt-rewrite"));
    await waitFor(() => expect(text).toHaveBeenCalledTimes(1));
    expect(text.mock.calls[0]![0].model).toBe("text-1");
    text.mockRestore();
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
    expect(request.model).toBeUndefined();
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

  it("keeps a rewrite going after the dialog is closed, and reads it again on return", async () => {
    filmWithContract();
    let answer: (value: GenerateResponse) => void = () => {};
    const pending = new Promise<GenerateResponse>((resolve) => {
      answer = resolve;
    });
    const text = vi.spyOn(generateApi, "text").mockReturnValue(pending);

    open(undefined, "film");
    fireEvent.click(screen.getByTestId("story-video-prompt-rewrite"));
    await waitFor(() => expect(text).toHaveBeenCalledTimes(1));
    const signal = text.mock.calls[0]![1] as AbortSignal;

    // The reader clicks outside the dialog: the dialog goes, the ask does not.
    cleanup();
    expect(signal.aborted).toBe(false);

    // Opened again on the same shot with the ask still out, the dialog says so
    // rather than offering to ask a second time.
    open(undefined, "film");
    const again = screen.getByTestId("story-video-prompt-rewrite");
    expect(again.textContent).toBe("Rewriting…");
    expect(again).toHaveProperty("disabled", true);

    // The answer lands with nothing on screen, and the dialog opened after it
    // reads the words the ask wrote.
    await act(async () => {
      answer({
        status: "succeeded",
        outputs: [],
        text: "integrated_multimodal_description: [Shot 1] She waits.",
      } as GenerateResponse);
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("story-video-prompt-text-0") as HTMLTextAreaElement)
          .value,
      ).toContain("She waits."),
    );
    expect(screen.getByTestId("story-video-prompt-rewrite").textContent).toBe(
      "Rewrite prompt",
    );
    text.mockRestore();
  });

  it("offers no cancel while nothing is on its way, and closes from the corner", () => {
    filmWithContract();
    const { onClose } = open(undefined, "film");
    expect(screen.queryByTestId("story-video-prompt-cancel")).toBeNull();

    fireEvent.click(screen.getByTestId("story-video-prompt-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes a rewrite back on cancel, keeping the words and the session", async () => {
    filmWithContract();
    let answer: (value: GenerateResponse) => void = () => {};
    const pending = new Promise<GenerateResponse>((resolve) => {
      answer = resolve;
    });
    const text = vi.spyOn(generateApi, "text").mockReturnValue(pending);

    const { onClose } = open(undefined, "film");
    const before = (
      screen.getByTestId("story-video-prompt-text-0") as HTMLTextAreaElement
    ).value;
    fireEvent.click(screen.getByTestId("story-video-prompt-rewrite"));
    await waitFor(() => expect(text).toHaveBeenCalledTimes(1));
    const signal = text.mock.calls[0]![1] as AbortSignal;

    // Cancel is offered only while the rewrite is on its way, and it is the
    // ask it takes back — not the dialog it closes over.
    fireEvent.click(screen.getByTestId("story-video-prompt-cancel"));
    expect(signal.aborted).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("story-video-prompt-cancel")).toBeNull();
    expect(
      (screen.getByTestId("story-video-prompt-text-0") as HTMLTextAreaElement)
        .value,
    ).toBe(before);
    const again = screen.getByTestId("story-video-prompt-rewrite");
    expect(again.textContent).toBe("Rewrite prompt");
    expect(again).toHaveProperty("disabled", false);

    // The answer the cancelled ask would have written belongs to nobody: the
    // field keeps the words the reader had.
    await act(async () => {
      answer({
        status: "succeeded",
        outputs: [],
        text: "integrated_multimodal_description: [Shot 1] She waits.",
      } as GenerateResponse);
    });
    expect(
      (screen.getByTestId("story-video-prompt-text-0") as HTMLTextAreaElement)
        .value,
    ).toBe(before);
    text.mockRestore();
  });
});
