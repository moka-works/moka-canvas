// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssetVideoPlayer } from "./AssetVideoPlayer";

/**
 * jsdom draws no media: the element's clock and its playing flag are made
 * here, and the two commands a browser would carry out report themselves back
 * the way the real element does.
 */
function stageTheFile() {
  const video = screen.getByTestId("asset-preview-video") as HTMLVideoElement;
  let currentTime = 0;
  let paused = true;
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
    },
  });
  Object.defineProperty(video, "paused", {
    configurable: true,
    get: () => paused,
  });
  Object.defineProperty(video, "duration", {
    configurable: true,
    value: 3,
  });
  vi.spyOn(video, "play").mockImplementation(() => {
    paused = false;
    fireEvent.play(video);
    return Promise.resolve();
  });
  vi.spyOn(video, "pause").mockImplementation(() => {
    paused = true;
    fireEvent.pause(video);
  });
  return {
    video,
    clock: () => screen.getByTestId("asset-player-clock").textContent,
  };
}

beforeEach(() => {
  render(<AssetVideoPlayer poster="/frame.png" src="/film.mp4" />);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a film in the column's player", () => {
  it("opens on its own first frame, held where it is", () => {
    const { video } = stageTheFile();

    expect(video.getAttribute("poster")).toBe("/frame.png");
    expect(video.hasAttribute("controls")).toBe(false);
    expect(video.paused).toBe(true);
    expect(
      screen.getByRole("button", { name: "Play" }).getAttribute("aria-label"),
    ).toBe("Play");
    // Nothing is known about the file's length until its header has been read.
    expect(
      (screen.getByTestId("asset-player-seek") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("drags through the film's stills and starts from where it was left", () => {
    const { video, clock } = stageTheFile();
    fireEvent.loadedMetadata(video);
    const seek = screen.getByTestId("asset-player-seek") as HTMLInputElement;
    expect(seek.disabled).toBe(false);
    expect(seek.max).toBe("3000");

    fireEvent.change(seek, { target: { value: "2400" } });

    expect(video.currentTime).toBe(2.4);
    expect(clock()).toBe("0:02 / 0:03");

    // The play control starts the file where the timeline stands rather than
    // from the beginning of it.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(2.4);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("follows the file's own clock as it runs", () => {
    const { video, clock } = stageTheFile();
    fireEvent.loadedMetadata(video);

    fireEvent.play(video);
    video.currentTime = 1.2;
    fireEvent.timeUpdate(video);

    expect(clock()).toBe("0:01 / 0:03");
    fireEvent.pause(video);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("says why a film will not play", () => {
    const { video } = stageTheFile();
    Object.defineProperty(video, "error", {
      configurable: true,
      value: { code: 4, message: "no supported source was found" },
    });

    fireEvent.error(video);

    expect(screen.getByRole("alert").textContent).toContain(
      "no supported source was found",
    );
  });
});
