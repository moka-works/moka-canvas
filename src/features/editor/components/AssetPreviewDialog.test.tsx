// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  buildTimelineMokaFile,
  timelineIds,
} from "../../../shared/domain/fixtures";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { AssetPreviewDialog } from "./AssetPreviewDialog";

beforeEach(() => {
  useProjectStore.getState().hydrate({
    moka: buildTimelineMokaFile(),
    root: "/tmp/moka-preview-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ previewAssetId: null });
  useProjectStore.getState().close();
});

describe("a film opened full screen", () => {
  it("waits on its first frame until it is asked to play", () => {
    useEditorStore.getState().openPreview(timelineIds().videoAsset);
    render(<AssetPreviewDialog />);

    const video = screen.getByTestId("asset-preview-video");
    // Opening a film is not asking for it to run: the first frame is what a
    // reader is shown, and the play control is how the rest of it starts.
    expect(video.hasAttribute("autoplay")).toBe(false);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.getByTestId("asset-player-seek")).toBeTruthy();
  });
});
