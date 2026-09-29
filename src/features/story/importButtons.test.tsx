// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { MokaFile } from "../../shared/domain";
import {
  buildEmptyStory,
  buildStoryMokaFile,
} from "../../shared/domain/fixtures";
import { useClipStore } from "../clip/stores/clipStore";
import { undo } from "../editor/commands/execute";
import { useAppStore } from "../editor/stores/appStore";
import { useHistoryStore, isBoundary } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { StoryPage } from "./StoryPage";
import { useStoryStore } from "./stores/storyStore";

/** The server under the test: no batches are out, and the project is as it is. */
function serving(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const json = (payload: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      if (url.includes("/story/jobs")) return json([]);
      return json({});
    }),
  );
}

/** The room open on a telling, standing on one of its steps. */
function openAtStep(moka: MokaFile, step: "storyboard" | "edit" | "outline") {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-import-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useStoryStore.getState().adopt(moka);
  render(<StoryPage />);
  act(() => useStoryStore.getState().goStep(step));
}

function canvases() {
  return useProjectStore.getState().moka?.canvas ?? [];
}

function timelines() {
  return useProjectStore.getState().moka?.timelines ?? [];
}

beforeEach(() => {
  serving();
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useStoryStore.getState().forget();
  useAppStore.setState({ phase: "story" });
  useClipStore.getState().setActiveTimeline(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("taking a telling into the canvas", () => {
  it("asks what the board is called, makes it from what was generated, and opens it", async () => {
    const moka = buildStoryMokaFile();
    openAtStep(moka, "storyboard");
    const before = canvases().length;

    fireEvent.click(screen.getByTestId("story-import-canvas"));
    const name = await screen.findByTestId("story-import-canvas-dialog-name");
    // The telling's own name is offered, and can be typed over.
    expect((name as HTMLInputElement).value).toBe("雨夜列车");
    fireEvent.change(name, { target: { value: "雨夜列车 · 分镜" } });
    fireEvent.click(screen.getByTestId("story-import-canvas-dialog-confirm"));

    await waitFor(() => expect(canvases()).toHaveLength(before + 1));
    const made = canvases()[canvases().length - 1];
    expect(made.name).toBe("雨夜列车 · 分镜");
    // The cards are the telling's own: words, pictures and a clip.
    expect(made.nodes.length).toBeGreaterThan(10);
    expect(made.edges.length).toBeGreaterThan(5);
    expect(made.nodes.some((node) => node.kind === "video")).toBe(true);
    // The reader is standing in the board that was just made for them.
    expect(useProjectStore.getState().activeCanvasId).toBe(made.id);
    expect(useAppStore.getState().phase).toBe("editing");

    // Making the board was one thing the reader asked for, so it is one step
    // of the history — and stepping into the new board is the seam that keeps
    // an undo made in the canvas from reaching back into the story room.
    expect(
      useHistoryStore
        .getState()
        .undoStack.filter((entry) => !isBoundary(entry)),
    ).toHaveLength(1);
    act(() => {
      undo();
    });
    expect(canvases()).toHaveLength(before + 1);
  });

  it("offers nothing where the steps have generated nothing", () => {
    openAtStep(buildEmptyStory(), "outline");
    expect(screen.getByTestId("story-import-canvas")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("makes a card a line for a telling read aloud line by line", async () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    moka.resources.voice = [
      {
        id: "said-one",
        name: "said-one.mp3",
        path: "assets/voice/said-one.mp3",
        mime: "audio/mpeg",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        probe: {
          mime: "audio/mpeg",
          bytes: 2_048,
          sha256: "1".repeat(64),
          durationMs: 900,
        },
      },
    ];
    const frame = story.chapters[0]!.acts[0]!.keyframes[0]!;
    frame.voices = [
      {
        lineId: frame.dialogue[0]!.id,
        text: frame.dialogue[0]!.text,
        voice: "reader-1",
        slot: {
          takes: [
            { assetIds: ["said-one"], createdAt: "2026-01-01T00:00:00.000Z" },
          ],
        },
      },
    ];
    openAtStep(moka, "storyboard");
    const before = canvases().length;
    fireEvent.click(screen.getByTestId("story-import-canvas"));
    await screen.findByTestId("story-import-canvas-dialog-name");
    fireEvent.click(screen.getByTestId("story-import-canvas-dialog-confirm"));

    await waitFor(() => expect(canvases()).toHaveLength(before + 1));
    const made = canvases()[canvases().length - 1]!;
    // The reading is a card of its own, filed as a voice and named for the line
    // it reads — and the whole act's reading is nowhere on the board, since
    // there is none.
    const readings = made.nodes.filter(
      (node) =>
        (node.data as { audioCategory?: string }).audioCategory === "voice",
    );
    expect(readings).toHaveLength(1);
    expect(readings[0]?.title).toContain("Line 1");
    expect((readings[0]?.data as { assetId?: string }).assetId).toBe(
      "said-one",
    );
  });
});

describe("taking a telling into the cutting room", () => {
  it("asks what the cut is called, lays the clips down, and opens the room on it", async () => {
    const moka = buildStoryMokaFile();
    openAtStep(moka, "edit");
    const before = timelines().length;

    fireEvent.click(screen.getByTestId("story-import-timeline"));
    const name = await screen.findByTestId("story-import-timeline-dialog-name");
    expect((name as HTMLInputElement).value).toBe("雨夜列车 · cut");
    fireEvent.change(name, { target: { value: "初剪" } });
    fireEvent.click(screen.getByTestId("story-import-timeline-dialog-confirm"));

    await waitFor(() => expect(timelines()).toHaveLength(before + 1));
    const made = timelines()[timelines().length - 1];
    expect(made.name).toBe("初剪");
    expect(made.clips.some((clip) => clip.kind === "video")).toBe(true);
    expect(useClipStore.getState().activeTimelineId).toBe(made.id);
    expect(useAppStore.getState().phase).toBe("clip");
  });
});
