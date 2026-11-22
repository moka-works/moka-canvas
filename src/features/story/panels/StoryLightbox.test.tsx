// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { useProjectStore } from "../../editor/stores/projectStore";
import { StoryLightbox } from "./StoryLightbox";

const mocks = vi.hoisted(() => ({
  askSavePath: vi.fn(),
  write: vi.fn(),
}));

vi.mock("../../../api/filesystem", () => ({
  filesystemApi: { write: mocks.write },
}));

vi.mock("../../editor/launcher/savePath", () => ({
  askSavePath: mocks.askSavePath,
  fileSafeName: (name: string) => name.replace(/[\\/:*?"<>|]+/g, "-"),
}));

const ids = storyIds();

beforeEach(() => {
  useProjectStore.setState({ moka: buildStoryMokaFile() });
  mocks.askSavePath.mockReset();
  mocks.write.mockReset();
  mocks.write.mockResolvedValue({ path: "/tmp/out", bytes: 1 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      blob: async () => new Blob(["picture"], { type: "image/png" }),
    })),
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => {},
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saving what is being looked at", () => {
  it("writes a picture where the reader asks for it", async () => {
    mocks.askSavePath.mockResolvedValue("/tmp/frame-art.png");
    render(
      <StoryLightbox
        assetIds={[ids.frameArt]}
        label="Frame"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("story-lightbox-save"));

    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        "/tmp/frame-art.png",
        expect.any(Blob),
      ),
    );
    expect(mocks.askSavePath).toHaveBeenCalledWith(
      expect.objectContaining({ defaultName: "frame-art.png" }),
    );
  });
});

describe("the window a clip is kept to", () => {
  it("opens paused and gives its one timeline a working play control", async () => {
    render(
      <StoryLightbox
        assetIds={[ids.actVideo]}
        label="Clip"
        onClose={() => {}}
        onTrim={() => {}}
        video
      />,
    );
    const video = screen.getByTestId(
      "story-lightbox-video",
    ) as HTMLVideoElement;
    let paused = true;
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });
    const play = vi.spyOn(video, "play").mockImplementation(() => {
      paused = false;
      fireEvent.play(video);
      return Promise.resolve();
    });
    vi.mocked(video.pause).mockImplementation(() => {
      paused = true;
      fireEvent.pause(video);
    });

    fireEvent.loadedMetadata(video);

    expect(video.autoplay).toBe(false);
    expect(video.controls).toBe(false);
    expect(paused).toBe(true);
    expect(play).not.toHaveBeenCalled();
    expect(screen.getByTestId("story-trim")).toBeTruthy();

    fireEvent.click(screen.getByTestId("story-lightbox-toggle"));
    expect(play).toHaveBeenCalledTimes(1);
    expect(paused).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId("story-lightbox-toggle").textContent).toBe(
        "Pause",
      ),
    );

    fireEvent.click(screen.getByTestId("story-lightbox-toggle"));
    expect(paused).toBe(true);
    expect(screen.getByTestId("story-lightbox-toggle").textContent).toBe(
      "Play",
    );
  });

  it("offers two ends over a measured take and hands the cut window on", () => {
    const onTrim = vi.fn();
    render(
      <StoryLightbox
        assetIds={[ids.actVideo]}
        label="Clip"
        onClose={() => {}}
        onTrim={onTrim}
        video
      />,
    );

    expect(screen.getByTestId("story-trim")).toBeTruthy();
    const track = screen.getByTestId("story-trim-track");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 1_000,
    } as DOMRect);

    const start = screen.getByTestId("story-trim-in");
    fireEvent.pointerDown(start, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 200, pointerId: 1 });
    fireEvent.pointerUp(start, { clientX: 200, pointerId: 1 });

    // A fifth of a five-second take: the start moves, the end stays the whole.
    expect(onTrim).toHaveBeenCalledWith(1_000, undefined);
  });
});
