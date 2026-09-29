// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MokaFile } from "../../../shared/domain";
import {
  buildTimelineMokaFile,
  timelineIds,
} from "../../../shared/domain/fixtures";
import { useAppStore } from "../../editor/stores/appStore";
import { useEditorStore } from "../../editor/stores/editorStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import { MediaColumn } from "./MediaColumn";

const fetchMock = vi.fn<typeof fetch>();

/** The cutting room's column with the fixture's cut open, playhead parked. */
function openCut(): MokaFile {
  const moka = buildTimelineMokaFile();
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-media-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useClipStore.setState({
    activeTimelineId: timelineIds().timeline,
    mediaSelection: null,
    playheadMs: 8_000,
    face: "cut",
  });
  render(<MediaColumn />);
  return moka;
}

/** The names the cut's own list leads with, the tray's rows left out. */
function rowsShown(): string[] {
  return [
    ...document.querySelectorAll(
      ".side-resource-group:not(.side-resource-tray) .resource-main strong",
    ),
  ].map((name) => name.textContent ?? "");
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({ assetPicker: null });
  useClipStore.setState({
    activeTimelineId: null,
    mediaSelection: null,
    selection: { clipIds: [], transitionId: null },
    playheadMs: 0,
    playing: false,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the cut's own column", () => {
  it("reads the material this cut holds, not the whole project", () => {
    openCut();

    // The cut reads pictures first, and holds none.
    expect(rowsShown()).toEqual([]);
    fireEvent.click(screen.getByTestId("asset-kind-video"));
    expect(rowsShown()).toEqual(["opening.mp4"]);

    // A file the project holds but no clip reads is not this cut's material.
    expect(rowsShown()).not.toContain("closing.mp4");
    fireEvent.click(screen.getByTestId("asset-kind-image"));
    expect(rowsShown()).not.toContain("lake.png");
  });

  it("keeps a file waiting for a place in the tray, and lands it from there", () => {
    const moka = openCut();
    moka.resources.images.push({
      id: "image-dawn",
      name: "dawn.png",
      path: "assets/images/dawn-00000000.png",
      mime: "image/png",
      bytes: 2_048,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    cleanup();
    useProjectStore.getState().hydrate({
      moka,
      root: "/tmp/moka-media-test",
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
    render(<MediaColumn />);

    // Brought in and placed nowhere, so it waits above the cut's own list...
    const tray = screen.getByTestId("shelf-tray");
    expect(tray.textContent).toContain("dawn.png");
    expect(rowsShown()).toEqual([]);

    // ...and the tray's own ＋ lays it on the cut at the playhead.
    fireEvent.click(tray.querySelector('[data-testid="clip-media-add"]')!);
    const timeline = (useProjectStore.getState().moka?.timelines ?? [])[0];
    const landed = timeline.clips.find((clip) => clip.assetId === "image-dawn");
    expect(landed?.startMs).toBe(8_000);
  });

  it("offers the whole project through the picker rather than a second list", () => {
    openCut();

    fireEvent.click(screen.getByTestId("clip-from-project"));

    expect(useEditorStore.getState().assetPicker).toEqual({ mode: "place" });
  });
});
