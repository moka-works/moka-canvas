// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { undo } from "../commands/execute";
import type { GenerationSpec, MokaFile } from "../../../shared/domain";
import {
  buildShelfMokaFile,
  buildTimelineMokaFile,
  goldenNodeIds,
  timelineIds,
} from "../../../shared/domain/fixtures";
import { AssetPickerModal } from "./AssetPickerModal";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { useClipStore } from "../../clip/stores/clipStore";

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function openProject(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-picker-test",
    selfCheck: { ok: true, issues: [] },
  });
  return moka;
}

function nodesOnMain() {
  return useProjectStore.getState().moka?.canvas[0].nodes ?? [];
}

function generationOf(nodeId: string): GenerationSpec | undefined {
  const node = nodesOnMain().find((entry) => entry.id === nodeId);
  return (node?.data as { generation?: GenerationSpec }).generation;
}

function withSecondImage(moka: MokaFile): string {
  moka.resources.images.push({
    id: "lantern-asset",
    name: "lantern.png",
    path: "assets/images/lantern-00000000.png",
    mime: "image/png",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return "lantern-asset";
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() => Promise.resolve(json({})));
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    announcement: "",
    selection: { nodeIds: [], edgeIds: [] },
    assetPicker: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the asset picker", () => {
  it("inserts every chosen file as a node in one step", async () => {
    const ids = goldenNodeIds();
    const moka = openProject(buildShelfMokaFile());
    const secondId = withSecondImage(moka);
    useEditorStore
      .getState()
      .openAssetPicker({ mode: "nodes", at: { x: 500, y: 300 } });
    render(<AssetPickerModal />);

    fireEvent.click(screen.getByTestId(`asset-pick-${ids.assetImage}`));
    fireEvent.click(screen.getByTestId(`asset-pick-${secondId}`));
    expect(screen.getByTestId("asset-pick-count").textContent).toBe(
      "Will be inserted as 2 nodes",
    );
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => {
      expect(useEditorStore.getState().assetPicker).toBeNull();
    });
    // The fixture already holds a node for lake.png, so what was made is read
    // off the selection the insertion left rather than off the asset it holds.
    const madeIds = useEditorStore.getState().selection.nodeIds;
    const added = nodesOnMain().filter((node) => madeIds.includes(node.id));
    expect(added.length).toBe(2);
    // Laid out where the ask was made, and the second clear of the first:
    // nothing in a batch lands on top of what arrived with it.
    expect(
      added.map((node) => ({
        x: node.bounds.x,
        y: node.bounds.y,
        title: node.title,
      })),
    ).toEqual([
      { x: 360, y: 260, title: "lake.png" },
      { x: 360, y: 500, title: "lantern.png" },
    ]);
    expect(useEditorStore.getState().announcement).toBe("Added 2 nodes");
    // One action, so one undo takes the whole insertion back.
    expect(undo()).toBe(true);
    expect(nodesOnMain().length).toBe(4);
  });

  it("adds chosen files to what a node is given", async () => {
    const ids = goldenNodeIds();
    const moka = openProject(buildShelfMokaFile());
    const textAssetId = moka.resources.texts[0].id;
    const target = moka.canvas[0].nodes.find((node) => node.id === ids.text);
    if (!target) throw new Error("fixture lost its text node");
    const spec: GenerationSpec = {
      capability: "text",
      mode: "generate",
      model: "",
      prompt: "Adapt this.",
      inputMode: "manual",
      params: {},
      referenceNodeIds: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    (target.data as { generation?: GenerationSpec }).generation = spec;
    useEditorStore
      .getState()
      .openAssetPicker({ mode: "reference", nodeId: ids.text });
    render(<AssetPickerModal />);

    fireEvent.click(screen.getByTestId(`asset-pick-${ids.assetImage}`));
    fireEvent.click(screen.getByTestId(`asset-pick-${textAssetId}`));
    expect(screen.getByTestId("asset-pick-count").textContent).toBe(
      "Will be added as 2 references",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(useEditorStore.getState().assetPicker).toBeNull();
    });
    const listed = generationOf(ids.text)?.referenceNodeIds ?? [];
    expect(listed.length).toBe(2);
    const made = nodesOnMain().filter((node) => listed.includes(node.id));
    expect(made.map((node) => node.title)).toEqual([
      "lake.png",
      "opening-lines.md",
    ]);
    expect(made.map((node) => node.bounds.x)).toEqual([-680, -640]);
    // The spec itself is untouched: only the list it keeps grew.
    expect(generationOf(ids.text)?.prompt).toBe("Adapt this.");
  });

  it("reads a text file's opening on its row and the whole of it on a hover", async () => {
    const moka = openProject(buildShelfMokaFile());
    moka.resources.texts.push({
      id: "brief-asset",
      name: "brief.md",
      path: "assets/texts/brief-00000000.md",
      mime: "text/markdown",
      bytes: 60,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const body = "LINE ONE\nline two of the brief, which goes on.";
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/assets/brief-asset")) {
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return Promise.resolve(json({}));
    });
    useEditorStore.getState().openAssetPicker({ mode: "nodes", at: null });
    render(<AssetPickerModal />);

    const excerpt = screen.getByTestId("asset-pick-excerpt-brief-asset");
    // The row leads with the file's own opening, read out of the file.
    await waitFor(() => expect(excerpt.textContent).toContain("LINE ONE"));

    fireEvent.mouseEnter(excerpt);
    const card = screen.getByTestId("asset-pick-words");
    expect(card.textContent).toBe(body);
    expect(card.getAttribute("role")).toBe("tooltip");

    fireEvent.mouseLeave(excerpt);
    expect(screen.queryByTestId("asset-pick-words")).toBeNull();
  });

  it("reads a sound's row by the words it came from, whole on a hover", () => {
    const moka = openProject(buildShelfMokaFile());
    moka.resources.music.push({
      id: "tune-asset",
      name: "tune.mp3",
      path: "assets/music/tune-00000000.mp3",
      mime: "audio/mpeg",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      keyword: "A slow tune for the opening credits.",
    });
    useEditorStore.getState().openAssetPicker({ mode: "nodes", at: null });
    render(<AssetPickerModal />);

    const excerpt = screen.getByTestId("asset-pick-excerpt-tune-asset");
    expect(excerpt.textContent).toContain("A slow tune");

    fireEvent.mouseEnter(excerpt);
    expect(screen.getByTestId("asset-pick-words").textContent).toBe(
      "A slow tune for the opening credits.",
    );
  });

  it("narrows the shelf by words, shelf, and what a file is filed under", () => {
    openProject(buildShelfMokaFile());
    useEditorStore.getState().openAssetPicker({ mode: "nodes", at: null });
    render(<AssetPickerModal />);

    fireEvent.change(screen.getByTestId("asset-pick-category"), {
      target: { value: "text" },
    });
    expect(screen.queryByText("lake.png")).toBeNull();
    expect(screen.getByText("opening-lines.md")).toBeTruthy();
    fireEvent.change(screen.getByTestId("asset-pick-category"), {
      target: { value: "" },
    });

    fireEvent.change(screen.getByTestId("asset-pick-asked"), {
      target: { value: "lantern" },
    });
    expect(screen.getByText("lake.png")).toBeTruthy();
    expect(screen.queryByText("opening-lines.md")).toBeNull();

    fireEvent.click(screen.getByTestId("asset-pick-tag-dusk"));
    expect(screen.getByText("lake.png")).toBeTruthy();
    fireEvent.click(screen.getByTestId("asset-pick-tag-opening"));
    expect(screen.getByTestId("asset-pick-none")).toBeTruthy();

    fireEvent.click(screen.getByTestId("asset-pick-tag-dusk"));
    fireEvent.change(screen.getByTestId("asset-pick-asked"), {
      target: { value: "" },
    });
    expect(screen.getByText("opening-lines.md")).toBeTruthy();
    expect(screen.queryByText("lake.png")).toBeNull();
  });

  it("lands a pick on the open cut, one clip after another", async () => {
    const ids = timelineIds();
    openProject(buildTimelineMokaFile());
    useClipStore.setState({
      activeTimelineId: ids.timeline,
      playheadMs: 5_000,
    });
    useEditorStore.getState().openAssetPicker({ mode: "place" });
    render(<AssetPickerModal />);

    expect(screen.getByRole("dialog", { name: "Add to the cut" })).toBeTruthy();
    fireEvent.click(screen.getByTestId(`asset-pick-${ids.videoAsset}`));
    fireEvent.click(screen.getByTestId(`asset-pick-${ids.followerAsset}`));
    expect(screen.getByTestId("asset-pick-count").textContent).toBe(
      "Will be added as 2 clips, one after another from the playhead",
    );
    fireEvent.click(screen.getByRole("button", { name: "Place" }));

    await waitFor(() => {
      expect(useEditorStore.getState().assetPicker).toBeNull();
    });
    const timeline = (useProjectStore.getState().moka?.timelines ?? [])[0];
    const landed = timeline.clips
      .filter(
        (clip) =>
          clip.assetId === ids.followerAsset ||
          (clip.assetId === ids.videoAsset && clip.id !== ids.videoClip),
      )
      .sort((left, right) => left.startMs - right.startMs);
    expect(landed.map((clip) => clip.startMs)).toEqual([5_000, 9_000]);
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "Added 2 files, one after another",
    );
  });
});
