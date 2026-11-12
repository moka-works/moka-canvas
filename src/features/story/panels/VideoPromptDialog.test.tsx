// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { MokaFile } from "../../../shared/domain/types";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { VideoPromptDialog } from "./VideoPromptDialog";

const ids = storyIds();
const ASK = `keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`;

function open(moka: MokaFile = buildStoryMokaFile()) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-video-prompt-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  const onClose = vi.fn();
  render(
    <VideoPromptDialog
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
  useModelStore.setState({ view: null });
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
