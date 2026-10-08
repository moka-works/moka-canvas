// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";
import { buildStoryMokaFile } from "../../../shared/domain/fixtures";
import { useProjectStore } from "../../editor/stores/projectStore";
import { VoiceReferencePicker } from "./VoiceReferencePicker";

/** The project as a reader's shelf looks with a recording and a score on it. */
function listening(): void {
  const moka = buildStoryMokaFile();
  moka.resources.voice.push({
    id: "voice-recording-a",
    name: "hero-voice.wav",
    path: "assets/voice/hero-voice-00000000.wav",
    mime: "audio/wav",
    bytes: 128_000,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    probe: {
      mime: "audio/wav",
      bytes: 128_000,
      sha256: "f".repeat(64),
      durationMs: 12_000,
      sampleRate: 24_000,
      channels: 1,
    },
  });
  moka.resources.music.push({
    id: "audio-score",
    name: "score.mp3",
    path: "assets/music/score-00000000.mp3",
    mime: "audio/mpeg",
    bytes: 64_000,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    probe: { mime: "audio/mpeg", bytes: 64_000, sha256: "e".repeat(64) },
  });
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-voice-reference-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
}

function draw(
  overrides: Partial<Parameters<typeof VoiceReferencePicker>[0]> = {},
) {
  const onWrite = vi.fn();
  render(
    <VoiceReferencePicker
      fallbackVoice={{ model: "", voice: "" }}
      onWrite={onWrite}
      testId="voice-reference"
      voice={{ model: "", voice: "" }}
      {...overrides}
    />,
  );
  return { onWrite };
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.getState().close();
  listening();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("what a voice copies from", () => {
  it("shows the recording the card names, with a way to take it off", () => {
    const { onWrite } = draw({
      voice: { model: "", voice: "", referenceAssetId: "voice-recording-a" },
    });
    expect(screen.getByTestId("voice-reference").textContent).toContain(
      "hero-voice.wav",
    );

    fireEvent.click(screen.getByTestId("voice-reference-clear"));
    expect(onWrite).toHaveBeenCalledWith({ model: "", voice: "" });
  });

  it("says which recording a card with none follows", () => {
    draw({
      fallbackVoice: {
        model: "",
        voice: "",
        referenceAssetId: "voice-recording-a",
      },
    });
    expect(screen.getByTestId("voice-reference-followed").textContent).toBe(
      "Following the narrator: hero-voice.wav",
    );
  });

  it("says nothing is chosen when the chain names none either", () => {
    draw();
    expect(screen.getByTestId("voice-reference-none").textContent).toBe(
      "None chosen",
    );
  });

  it("keeps a recording whose file has left on show rather than quietly forgetting it", () => {
    const { onWrite } = draw({
      voice: { model: "", voice: "", referenceAssetId: "asset-gone" },
    });
    expect(screen.getByTestId("voice-reference-missing").textContent).toContain(
      "no longer in the project",
    );

    // Taking it off is the repair, and it is the reader's to make: nothing
    // was written behind their back.
    fireEvent.click(screen.getByTestId("voice-reference-clear"));
    expect(onWrite).toHaveBeenCalledWith({ model: "", voice: "" });
  });
});

describe("picking the recording", () => {
  it("offers the sounds the project holds, recording takes and scores alike", () => {
    const { onWrite } = draw();
    fireEvent.click(screen.getByTestId("voice-reference-open"));
    const menu = screen.getByTestId("voice-reference-menu");
    expect(menu.textContent).toContain("hero-voice.wav");
    expect(menu.textContent).toContain("score.mp3");

    fireEvent.click(
      screen.getByTestId("voice-reference-choice-hero-voice.wav"),
    );
    expect(onWrite).toHaveBeenCalledWith({
      model: "",
      voice: "",
      referenceAssetId: "voice-recording-a",
    });
  });

  it("picks a score the same way: a voice can be copied from one", () => {
    const { onWrite } = draw();
    fireEvent.click(screen.getByTestId("voice-reference-open"));
    fireEvent.click(screen.getByTestId("voice-reference-choice-score.mp3"));
    expect(onWrite).toHaveBeenCalledWith({
      model: "",
      voice: "",
      referenceAssetId: "audio-score",
    });
  });
});
