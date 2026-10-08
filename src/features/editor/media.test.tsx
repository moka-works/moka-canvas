// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import App from "../../App";
import {
  buildGenerationMokaFile,
  buildGoldenMokaFile,
  buildStoryMokaFile,
  goldenNodeIds,
  storyIds,
  timelineIds,
} from "../../shared/domain/fixtures";
import type {
  GenerationSpec,
  MediaNodeData,
  MokaFile,
  NodeData,
  SelfCheckReport,
} from "../../shared/domain";
import { createCanvas, createNode } from "../../shared/domain";
import {
  mediaInfoForNode,
  buildIssueIndex,
  buildResourceIndex,
  generationSummary,
  waveformPeaks,
} from "./canvas/mediaCards";
import { registerController } from "./canvas/canvasControl";
import type { LeaferEditorController } from "./canvas/controller";
import { undo } from "./commands/execute";
import {
  addAssetNode,
  addNodeAt,
  confirmDeleteAsset,
  editTextContent,
  pickSourceCandidates,
  requestDeleteAsset,
  resolveInputPick,
} from "./interactions/actions";
import { AssetDeleteDialog } from "./components/AssetDeleteDialog";
import { useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";

function hydrate(moka?: MokaFile, selfCheck?: SelfCheckReport) {
  const document = moka ?? buildGoldenMokaFile();
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka: document,
    selfCheck: selfCheck ?? { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  return document;
}

function activeCanvasOf(moka: MokaFile) {
  return moka.canvas[0];
}

const CONFIG = {
  productName: "Moka Canvas",
  maxUploadBytes: 104857600,
  allowedMediaTypes: ["image/png"],
  limits: {
    maxNodesPerCanvas: 500,
    maxEdgesPerCanvas: 800,
    maxCanvasesPerProject: 12,
    maxPackageBytes: 536870912,
    maxPackageEntries: 20000,
  },
  capabilities: { mode: "web", executors: ["noop"], assetCategories: [] },
};

const RECENTS = [
  {
    id: "recent-1",
    name: "Golden Fixture",
    path: "/tmp/golden",
    lastOpened: "2026-01-01T00:00:00.000Z",
  },
];

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ revision: 9, updatedAt: "2026-01-02" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    inputPick: null,
    assetDeletePrompt: null,
    previewAssetId: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  registerController(null);
  vi.unstubAllGlobals();
});

describe("mediaCards", () => {
  it("maps self-check issues to broken card states", () => {
    const ids = goldenNodeIds();
    const moka = hydrate(undefined, {
      ok: false,
      issues: [
        {
          assetId: ids.assetImage,
          name: "lake.png",
          expectedPath: "assets/images/lake-00000000.png",
          reason: "missing",
          referencingNodes: [
            {
              canvasId: ids.canvasMain,
              nodeId: ids.image,
              title: "Reference image",
            },
          ],
        },
      ],
    });
    const node = moka.canvas[0].nodes.find((n) => n.id === ids.image)!;
    const media = mediaInfoForNode(
      node,
      buildResourceIndex(moka),
      buildIssueIndex(useProjectStore.getState().selfCheck),
    );
    expect(media?.state).toBe("missing");
    expect(media?.label).toBe("lake.png");
  });

  it("labels ready media with probe dimensions", () => {
    const ids = goldenNodeIds();
    const moka = hydrate();
    const node = moka.canvas[0].nodes.find((n) => n.id === ids.image)!;
    const media = mediaInfoForNode(node, buildResourceIndex(moka), new Map());
    expect(media?.state).toBe("ready");
    expect(media?.label).toBe("64×64");
    expect(media?.url).toContain(ids.assetImage);
  });

  it("derives deterministic waveform peaks from the hash", () => {
    const a = waveformPeaks("deadbeef");
    const b = waveformPeaks("deadbeef");
    expect(a).toEqual(b);
    expect(a.every((peak) => peak >= 0.25 && peak <= 1)).toBe(true);
  });

  it("gives a video its own file to play and a poster to be seen as", () => {
    const moka = buildGoldenMokaFile();
    moka.resources.videos.push({
      id: "asset-shot",
      name: "shot.mp4",
      path: "assets/videos/shot.mp4",
      mime: "video/mp4",
      bytes: 40960,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      probe: {
        mime: "video/mp4",
        bytes: 40960,
        sha256: "bb",
        width: 640,
        height: 360,
        durationMs: 4000,
      },
    });
    const shot = createNode("video", { x: 0, y: 0 });
    shot.data = { ...shot.data, assetId: "asset-shot" };
    const bare = mediaInfoForNode(shot, buildResourceIndex(moka), new Map());
    expect(bare?.state).toBe("ready");
    expect(bare?.label).toBe("640×360 · 0:04");
    expect(bare?.playable).toContain("/assets/asset-shot");
    // Nothing has made a poster, and the file itself is not a picture: the
    // card has no image to draw, only a file to play.
    expect(bare?.url).toBeUndefined();

    moka.resources.images.push({
      id: "asset-poster",
      name: "poster.png",
      path: "assets/images/poster.png",
      mime: "image/png",
      bytes: 2048,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      probe: { mime: "image/png", bytes: 2048, sha256: "cc" },
    });
    const postered = {
      ...shot,
      data: { ...shot.data, posterAssetId: "asset-poster" },
    };
    const drawn = mediaInfoForNode(
      postered,
      buildResourceIndex(moka),
      new Map(),
    );
    expect(drawn?.url).toContain("/assets/asset-poster");
    expect(drawn?.playable).toContain("/assets/asset-shot");
  });

  it("collapses a generation spec into one card line", () => {
    const nodes = buildGenerationMokaFile().canvas[0].nodes;
    const image = nodes.find((node) => node.kind === "image")!;
    expect(generationSummary(image)).toBe("painter · Paint @ref as a poster.");
    const text = nodes.find((node) => node.kind === "text")!;
    expect(generationSummary(text)).toBe(
      "Default model · Write a logline about a lantern over a lake.",
    );
  });

  it("keeps only the prompt's first line and falls back to the alias", () => {
    const nodes = buildGenerationMokaFile().canvas[0].nodes;
    const image = nodes.find((node) => node.kind === "image")!;
    const spec = (image.data as MediaNodeData).generation!;
    const withPrompt = (prompt: string) =>
      generationSummary({
        ...image,
        data: { ...image.data, generation: { ...spec, prompt } } as NodeData,
      });
    expect(withPrompt("First line\nsecond line")).toBe("painter · First line");
    expect(withPrompt("   ")).toBe("painter");
  });

  it("says nothing for nodes without a generation spec", () => {
    const nodes = buildGoldenMokaFile().canvas[0].nodes;
    expect(nodes.every((node) => generationSummary(node) === "")).toBe(true);
  });
});

describe("pickSourceCandidates / resolveInputPick", () => {
  it("keeps only nodes with a type-compatible output", () => {
    const ids = goldenNodeIds();
    const moka = hydrate();
    const canvas = activeCanvasOf(moka);
    const images = pickSourceCandidates(canvas, {
      nodeId: ids.operation,
      portId: "images",
    });
    expect([...images]).toEqual([ids.image]);
    const audio = pickSourceCandidates(canvas, {
      nodeId: ids.export,
      portId: "audio",
    });
    expect([...audio]).toEqual([ids.operation]);
  });

  it("connects the picked node's first valid output", () => {
    const ids = goldenNodeIds();
    const moka = hydrate();
    useEditorStore
      .getState()
      .startInputPick({ nodeId: ids.export, portId: "audio" });
    resolveInputPick(ids.operation);
    const canvas = activeCanvasOf(useProjectStore.getState().moka!);
    expect(
      canvas.edges.some(
        (edge) =>
          edge.source.nodeId === ids.operation &&
          edge.target.nodeId === ids.export &&
          edge.target.portId === "audio",
      ),
    ).toBe(true);
    expect(useEditorStore.getState().inputPick).toBeNull();
    void moka;
  });

  it("offers only sound cards for the voice input of a sound card", () => {
    const canvas = createCanvas("Canvas");
    const recording = createNode("audio", { x: 0, y: 0 });
    recording.data = { ...recording.data, assetId: "asset-recording" };
    const brief = createNode("text", { x: 0, y: 240 });
    brief.data = { ...brief.data, content: "Say it warmly." };
    const speaker = createNode("audio", { x: 320, y: 0 });
    canvas.nodes = [recording, brief, speaker];

    const candidates = pickSourceCandidates(canvas, {
      nodeId: speaker.id,
      portId: "audio",
    });
    expect([...candidates]).toEqual([recording.id]);
  });

  it("rejects a picked node with no compatible output", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore
      .getState()
      .startInputPick({ nodeId: ids.export, portId: "audio" });
    resolveInputPick(ids.image);
    const canvas = activeCanvasOf(useProjectStore.getState().moka!);
    expect(canvas.edges).toHaveLength(2);
    expect(
      useAppStore.getState().toasts.some((toast) => toast.kind === "error"),
    ).toBe(true);
  });
});

describe("editTextContent", () => {
  it("commits an undoable updateNode patch", () => {
    const ids = goldenNodeIds();
    hydrate();
    editTextContent(ids.text, "A replacement brief");
    let canvas = activeCanvasOf(useProjectStore.getState().moka!);
    expect(
      (canvas.nodes.find((n) => n.id === ids.text)!.data as { content: string })
        .content,
    ).toBe("A replacement brief");
    undo();
    canvas = activeCanvasOf(useProjectStore.getState().moka!);
    expect(
      (canvas.nodes.find((n) => n.id === ids.text)!.data as { content: string })
        .content,
    ).toContain("lantern");
  });

  it("skips unchanged content and non-text nodes", () => {
    const ids = goldenNodeIds();
    hydrate();
    editTextContent(ids.text, "A lantern floats over a quiet lake at dusk.");
    editTextContent(ids.image, "not a text node");
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });
});

describe("asset deletion", () => {
  const WHEN = "2026-01-01T00:00:00.000Z";

  /** The story fixture with `heroMain` kept only as an old picture. */
  function redrawnStory(): MokaFile {
    const moka = buildStoryMokaFile();
    const hero = moka.stories![0].elements.find(
      (element) => element.id === storyIds().hero,
    )!;
    hero.main.takes.push({ assetIds: ["asset-hero-redrawn"], createdAt: WHEN });
    return moka;
  }

  function holding(id: string) {
    return {
      id,
      name: `${id}.png`,
      path: `assets/images/${id}-00000000.png`,
      mime: "image/png",
      bytes: 10,
      createdAt: WHEN,
      updatedAt: WHEN,
    };
  }

  function deleted(assetId: string) {
    return fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url).includes(`/assets/${assetId}`) &&
        (init as RequestInit)?.method === "DELETE",
    );
  }

  it("prompts when nodes still reference the asset", async () => {
    const ids = goldenNodeIds();
    hydrate();
    await requestDeleteAsset(ids.assetImage);
    expect(useEditorStore.getState().assetDeletePrompt).toEqual({
      assetId: ids.assetImage,
      nodeIds: [ids.image],
      drawings: [],
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/assets/"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("asks before a story's old drawing goes, and takes the drawing with the file", async () => {
    const moka = redrawnStory();
    moka.resources.images.push(holding(storyIds().heroMain));
    hydrate(moka);
    await requestDeleteAsset(storyIds().heroMain);
    // The ask is about the place, in the place's own words: nothing on a
    // canvas holds this file, and a card count would have said nothing.
    expect(useEditorStore.getState().assetDeletePrompt).toEqual({
      assetId: storyIds().heroMain,
      nodeIds: [],
      drawings: [
        {
          kind: "drawing",
          storyId: storyIds().story,
          storyName: "雨夜列车",
          target: { kind: "element", elementId: storyIds().hero, view: "main" },
        },
      ],
    });
    render(<AssetDeleteDialog />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("林 · Main picture");
    expect(dialog.textContent).toContain("雨夜列车");
    expect(deleted(storyIds().heroMain)).toBe(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Throw the drawing away and delete",
      }),
    );
    await act(() => Promise.resolve());
    const after = useProjectStore.getState().moka!;
    const hero = after.stories![0].elements.find(
      (element) => element.id === storyIds().hero,
    )!;
    expect(hero.main.takes.map((take) => take.assetIds[0])).toEqual([
      "asset-hero-redrawn",
    ]);
    expect(
      after.resources.images.some((e) => e.id === storyIds().heroMain),
    ).toBe(false);
    expect(deleted(storyIds().heroMain)).toBe(true);
  });

  it("empties a card and an old drawing in one act", async () => {
    const moka = redrawnStory();
    const ids = goldenNodeIds();
    const node = activeCanvasOf(moka).nodes.find(
      (held) => held.id === ids.image,
    )!;
    (node.data as MediaNodeData).assetId = storyIds().heroMain;
    moka.resources.images.push(holding(storyIds().heroMain));
    hydrate(moka);
    await requestDeleteAsset(storyIds().heroMain);
    expect(useEditorStore.getState().assetDeletePrompt).toEqual({
      assetId: storyIds().heroMain,
      nodeIds: [ids.image],
      drawings: [
        {
          kind: "drawing",
          storyId: storyIds().story,
          storyName: "雨夜列车",
          target: { kind: "element", elementId: storyIds().hero, view: "main" },
        },
      ],
    });
    await confirmDeleteAsset();
    const after = useProjectStore.getState().moka!;
    expect(
      activeCanvasOf(after).nodes.some((held) => held.id === ids.image),
    ).toBe(false);
    expect(
      after
        .stories![0].elements.find((element) => element.id === storyIds().hero)!
        .main.takes.map((take) => take.assetIds[0]),
    ).toEqual(["asset-hero-redrawn"]);
    expect(deleted(storyIds().heroMain)).toBe(true);
  });

  it("refuses the drawing a place is using, naming the place", async () => {
    hydrate(buildStoryMokaFile());
    await requestDeleteAsset(storyIds().heroMain);
    expect(useEditorStore.getState().assetDeletePrompt).toBeNull();
    const toasts = useAppStore.getState().toasts;
    expect(toasts.at(-1)?.message).toBe(
      "The asset cannot be deleted: it is the drawing 林 · Main picture in “雨夜列车” is using",
    );
    expect(deleted(storyIds().heroMain)).toBe(false);
  });

  it("refuses a file a clip reads, naming the clip and its timeline", async () => {
    hydrate(buildStoryMokaFile());
    await requestDeleteAsset(timelineIds().videoAsset);
    expect(useEditorStore.getState().assetDeletePrompt).toBeNull();
    const toasts = useAppStore.getState().toasts;
    expect(toasts.at(-1)?.message).toBe(
      "The asset cannot be deleted: clip “opening.mp4” on the timeline “Timeline 1” is using it",
    );
    expect(deleted(timelineIds().videoAsset)).toBe(false);
  });

  it("confirm removes referencing nodes and deletes the file", async () => {
    const ids = goldenNodeIds();
    hydrate();
    await requestDeleteAsset(ids.assetImage);
    await confirmDeleteAsset();
    const state = useProjectStore.getState();
    const canvas = activeCanvasOf(state.moka!);
    expect(canvas.nodes.some((n) => n.id === ids.image)).toBe(false);
    expect(state.moka!.resources.images).toHaveLength(0);
    expect(useEditorStore.getState().assetDeletePrompt).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes(`/assets/${ids.assetImage}`) &&
          (init as RequestInit)?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("deletes unreferenced assets without prompting", async () => {
    const moka = buildGoldenMokaFile();
    moka.resources.images.push({
      id: "orphan-asset",
      name: "orphan.png",
      path: "assets/images/orphan-1.png",
      mime: "image/png",
      bytes: 10,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    hydrate(moka);
    await requestDeleteAsset("orphan-asset");
    expect(useEditorStore.getState().assetDeletePrompt).toBeNull();
    expect(useProjectStore.getState().moka!.resources.images).toHaveLength(1);
  });
});

describe("addAssetNode", () => {
  it("creates a selected image node titled after the asset", async () => {
    const ids = goldenNodeIds();
    hydrate();
    await addAssetNode(ids.assetImage, { x: 100, y: 50 });
    const canvas = activeCanvasOf(useProjectStore.getState().moka!);
    const node = canvas.nodes.find((n) => n.title === "lake.png");
    expect(node?.kind).toBe("image");
    expect((node?.data as { assetId?: string }).assetId).toBe(ids.assetImage);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([node!.id]);
  });

  it("lands where the drag was let go when nothing is sitting there", async () => {
    const ids = goldenNodeIds();
    hydrate();
    // The pointer is at the middle-ish of the card, which is where a card
    // dropped on an empty stretch of the board is expected to appear.
    await addAssetNode(ids.assetImage, { x: 900, y: 500 });
    const node = activeCanvasOf(useProjectStore.getState().moka!).nodes.find(
      (n) => n.title === "lake.png",
    )!;
    expect(node.bounds).toMatchObject({ x: 900 - 140, y: 500 - 40 });
  });

  it("steps right and down clear of a card already under the drop", async () => {
    const ids = goldenNodeIds();
    const before = activeCanvasOf(hydrate()).nodes.map((n) => n.bounds);
    // Straight onto the fixture's first two cards.
    await addAssetNode(ids.assetImage, { x: 100, y: 50 });
    const node = activeCanvasOf(useProjectStore.getState().moka!).nodes.find(
      (n) => n.title === "lake.png",
    )!;
    // Not under the drop, which is covered, and not left of or above it: the
    // search only ever moves a card out of the way to the right and below.
    expect(node.bounds.x).toBeGreaterThanOrEqual(100 - 140);
    expect(node.bounds.y).toBeGreaterThanOrEqual(50 - 40);
    for (const rect of before) {
      const clear =
        node.bounds.x >= rect.x + rect.width ||
        rect.x >= node.bounds.x + node.bounds.width ||
        node.bounds.y >= rect.y + rect.height ||
        rect.y >= node.bounds.y + node.bounds.height;
      expect(clear).toBe(true);
    }
  });

  it("maps voice category assets to voice audio nodes", async () => {
    const moka = buildGoldenMokaFile();
    moka.resources.voice.push({
      id: "voice-1",
      name: "line.wav",
      path: "assets/voice/line-1.wav",
      mime: "audio/x-wav",
      bytes: 100,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    hydrate(moka);
    await addAssetNode("voice-1", { x: 0, y: 0 });
    const canvas = activeCanvasOf(useProjectStore.getState().moka!);
    const node = canvas.nodes.find((n) => n.title === "line.wav");
    expect(node?.kind).toBe("audio");
    expect((node?.data as { audioCategory?: string }).audioCategory).toBe(
      "voice",
    );
  });
});

describe("editor shell integration", () => {
  function route(selfCheck: SelfCheckReport) {
    return (url: string, init?: RequestInit): Response => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url === "/api/v1/config") return json(CONFIG);
      if (url === "/api/health") return json({ status: "ok" });
      if (url === "/api/v1/recent-projects") return json(RECENTS);
      if (url === "/api/v1/projects/open") {
        return json({
          root: "/tmp/golden",
          moka: buildGoldenMokaFile(),
          selfCheck,
        });
      }
      if (url === "/api/v1/projects/current/commands") {
        return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
      }
      if (url.includes("/reveal") && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/assets/") && init?.method === "DELETE") {
        return json({ revision: 5, updatedAt: "2026-01-01T00:00:03.000Z" });
      }
      if (
        url === "/api/v1/projects/current/assets" &&
        init?.method === "POST"
      ) {
        return json({
          entry: {
            id: "dropped-asset",
            name: "drop.png",
            path: "assets/images/drop-1.png",
            mime: "image/png",
            bytes: 12,
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
          revision: 6,
          updatedAt: "2026-01-01T00:00:04.000Z",
        });
      }
      if (
        url === "/api/v1/projects/current/assets/from-node" &&
        init?.method === "POST"
      ) {
        return json(
          {
            entry: {
              id: "filed-brief",
              name: "Brief.md",
              path: "assets/texts/brief-00000000.md",
              mime: "text/markdown",
              bytes: 42,
              createdAt: "2026-01-02T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
              favorite: true,
              origin: "filed",
            },
            revision: 7,
            updatedAt: "2026-01-01T00:00:05.000Z",
            created: true,
          },
          201,
        );
      }
      return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
    };
  }

  /**
   * The shelf lives behind the assets face of the left column, since what a
   * project holds and what it is made of are two ways of reading one column.
   */
  function showAssets() {
    fireEvent.click(screen.getByTestId("left-tab-assets"));
  }

  async function openGolden(
    selfCheck: SelfCheckReport = { ok: true, issues: [] },
  ) {
    fetchMock.mockImplementation((input, init) =>
      Promise.resolve(route(selfCheck)(String(input), init as RequestInit)),
    );
    render(<App />);
    const recent = await screen.findByText("Golden Fixture");
    fireEvent.click(recent);
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
  }

  it("shows asset metadata and actions for a selected image node", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.image], edgeIds: [] });
    });
    const inspector = screen.getByRole("complementary", {
      name: "Inspector",
    });
    // The inspector still reads as empty until the selection's commit lands,
    // which can trail a loaded machine's next line.
    await vi.waitFor(() => {
      expect(inspector.textContent).toContain("lake.png");
    });
    expect(inspector.textContent).toContain("image/png");
    expect(inspector.textContent).toContain("64×64");
    expect(inspector.textContent).toContain("assets/images/lake-00000000.png");
    expect(inspector.textContent).toContain("2.0 KB");
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
  });

  it("files a text node's words to the shelf from the inspector", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.text], edgeIds: [] });
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Save as material" }),
    );
    await act(() => Promise.resolve());
    const call = fetchMock.mock.calls.find(
      ([url]) => url === "/api/v1/projects/current/assets/from-node",
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      canvasId: ids.canvasMain,
      nodeId: ids.text,
    });
    expect(useEditorStore.getState().announcement).toContain(
      "Brief.md saved to the shelf",
    );
    expect(
      useProjectStore
        .getState()
        .moka!.resources.texts.some((entry) => entry.id === "filed-brief"),
    ).toBe(true);
  });

  it("renders input chips and disconnects a single edge", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.operation], edgeIds: [] });
    });
    const chip = await screen.findByText("Brief");
    expect(chip.closest(".inspector-chip")?.textContent).toContain("Text");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.edges).toHaveLength(1);
    expect(canvas.edges[0].id).toBe(ids.edgeOpExport);
  });

  it("opens the delete confirmation from the inspector", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.image], edgeIds: [] });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("lake.png");
    expect(dialog.textContent).toContain("1 node");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove nodes and delete" }),
    );
    await act(() => Promise.resolve());
    const state = useProjectStore.getState();
    expect(state.moka!.canvas[0].nodes.some((n) => n.id === ids.image)).toBe(
      false,
    );
    expect(state.moka!.resources.images).toHaveLength(0);
  });

  it("prompts before editing when the self-check reports issues", async () => {
    const ids = goldenNodeIds();
    await openGolden({
      ok: false,
      issues: [
        {
          assetId: ids.assetImage,
          name: "lake.png",
          expectedPath: "assets/images/lake-00000000.png",
          reason: "missing",
          referencingNodes: [
            {
              canvasId: ids.canvasMain,
              nodeId: ids.image,
              title: "Reference image",
            },
          ],
        },
      ],
    });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Missing or changed assets");
    expect(dialog.textContent).toContain("lake.png");
    expect(dialog.textContent).toContain("Reference image");
    expect(useAppStore.getState().phase).toBe("opening");
    fireEvent.click(
      screen.getByRole("button", { name: "Open with missing assets" }),
    );
    expect(useAppStore.getState().phase).toBe("editing");
    // The broken asset is flagged on the shelf.
    showAssets();
    const row = screen.getByText("lake.png").closest(".resource-row");
    expect(row?.textContent).toContain("broken");
  });

  it("returns to the launcher when the missing-assets prompt is cancelled", async () => {
    const ids = goldenNodeIds();
    await openGolden({
      ok: false,
      issues: [
        {
          assetId: ids.assetImage,
          name: "lake.png",
          expectedPath: "assets/images/lake-00000000.png",
          reason: "changed",
          referencingNodes: [],
        },
      ],
    });
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Back to launcher" }));
    expect(useAppStore.getState().phase).toBe("launcher");
    expect(useProjectStore.getState().moka).toBeNull();
  });

  it("creates a source node when a panel asset is dropped on the canvas", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    const host = await screen.findByTestId("canvas-host");
    fireEvent.drop(host, {
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-moka-asset" ? ids.assetImage : "",
        files: [],
      },
    });
    await act(() => Promise.resolve());
    const canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.nodes).toHaveLength(5);
    expect(canvas.nodes.some((n) => n.title === "lake.png")).toBe(true);
  });

  /** Points the camera stand-in at a world point, for a drop. */
  function aimAtPoint(world: { x: number; y: number }) {
    registerController({
      clientToWorld: () => world,
      viewCenterWorld: () => world,
      worldToClient: () => ({ x: 0, y: 0 }),
    } as unknown as LeaferEditorController);
    return world;
  }

  /** Drops a panel asset on the canvas at a point the camera reports. */
  async function dropAsset(assetId: string, world: { x: number; y: number }) {
    aimAtPoint(world);
    const host = await screen.findByTestId("canvas-host");
    fireEvent.drop(host, {
      clientX: 10,
      clientY: 10,
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-moka-asset" ? assetId : "",
        files: [],
      },
    });
    await act(() => Promise.resolve());
    return useProjectStore
      .getState()
      .moka!.canvas[0].nodes.find((n) => n.title === "lake.png")!;
  }

  it("creates a dragged asset where the drag was let go", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    // An empty stretch of the board: the card arrives under the pointer.
    const node = await dropAsset(ids.assetImage, { x: 900, y: 500 });
    expect(node.bounds).toMatchObject({ x: 900 - 140, y: 500 - 40 });
  });

  it("moves a dropped asset clear of the card under the pointer", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    await screen.findByTestId("canvas-host");
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const under = canvas.nodes.find((entry) => entry.id === ids.text)!;
    const node = await dropAsset(ids.assetImage, {
      x: under.bounds.x + under.bounds.width / 2,
      y: under.bounds.y + under.bounds.height / 2,
    });
    // Out of the way to the right and below, and off the card it landed on.
    expect(node.bounds.x).toBeGreaterThanOrEqual(under.bounds.x);
    expect(node.bounds.y).toBeGreaterThanOrEqual(under.bounds.y);
    const clear =
      node.bounds.x >= under.bounds.x + under.bounds.width ||
      node.bounds.y >= under.bounds.y + under.bounds.height;
    expect(clear).toBe(true);
  });

  it("imports dropped files and creates nodes", async () => {
    await openGolden();
    const host = await screen.findByTestId("canvas-host");
    fireEvent.drop(host, {
      dataTransfer: {
        getData: () => "",
        files: [new File(["x"], "drop.png", { type: "image/png" })],
      },
    });
    await act(() => Promise.resolve());
    await vi.waitFor(() => {
      const state = useProjectStore.getState();
      expect(
        state.moka!.resources.images.some((e) => e.id === "dropped-asset"),
      ).toBe(true);
    });
    const state = useProjectStore.getState();
    expect(
      state.moka!.canvas[0].nodes.some((n) => n.title === "drop.png"),
    ).toBe(true);
  });

  /** Points the camera stand-in at the middle of a node, for a drop. */
  function aimAt(nodeId: string) {
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const node = canvas.nodes.find((entry) => entry.id === nodeId)!;
    const aimed = {
      x: node.bounds.x + node.bounds.width / 2,
      y: node.bounds.y + node.bounds.height / 2,
    };
    registerController({
      clientToWorld: () => aimed,
      viewCenterWorld: () => aimed,
      worldToClient: () => ({ x: 0, y: 0 }),
    } as unknown as LeaferEditorController);
    return aimed;
  }

  it("puts a file dropped on a node in place of what that node held", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    aimAt(ids.image);

    fireEvent.drop(screen.getByTestId("canvas-host"), {
      dataTransfer: {
        getData: () => "",
        files: [new File(["x"], "drop.png", { type: "image/png" })],
      },
    });
    await vi.waitFor(() => {
      const node = useProjectStore
        .getState()
        .moka!.canvas[0].nodes.find((entry) => entry.id === ids.image);
      expect((node?.data as { assetId?: string }).assetId).toBe(
        "dropped-asset",
      );
    });

    // The file went onto the node rather than onto the canvas: nothing new.
    expect(useProjectStore.getState().moka!.canvas[0].nodes).toHaveLength(4);
    expect(useEditorStore.getState().announcement).toBe(
      "Replaced Reference image with drop.png",
    );
  });

  it("lays a file the node cannot hold on the canvas instead", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    aimAt(ids.text);

    fireEvent.drop(screen.getByTestId("canvas-host"), {
      dataTransfer: {
        getData: () => "",
        files: [new File(["x"], "drop.png", { type: "image/png" })],
      },
    });
    await vi.waitFor(() => {
      expect(
        useProjectStore
          .getState()
          .moka!.canvas[0].nodes.some((n) => n.title === "drop.png"),
      ).toBe(true);
    });

    const canvas = useProjectStore.getState().moka!.canvas[0];
    const brief = canvas.nodes.find((entry) => entry.id === ids.text)!;
    // A picture is not words: the brief keeps its own text and no asset.
    expect((brief.data as { content?: string }).content).toBe(
      "A lantern floats over a quiet lake at dusk.",
    );
    expect((brief.data as { assetId?: string }).assetId).toBeUndefined();
    expect(canvas.nodes).toHaveLength(5);
  });

  it("files and lists a file dropped on what the node is given", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.image], edgeIds: [] });
      // The selection brings the panel up on its own; opened here as well so
      // the test does not lean on the timing of that effect.
      useEditorStore.getState().openPromptPanel(ids.image);
    });
    const bar = await screen.findByTestId("reference-bar");

    fireEvent.drop(bar, {
      dataTransfer: {
        getData: () => "",
        files: [new File(["x"], "drop.png", { type: "image/png" })],
        types: ["Files"],
      },
    });
    await vi.waitFor(() => {
      expect(
        useProjectStore
          .getState()
          .moka!.canvas[0].nodes.some((n) => n.title === "drop.png"),
      ).toBe(true);
    });

    const canvas = useProjectStore.getState().moka!.canvas[0];
    const made = canvas.nodes.find((node) => node.title === "drop.png")!;
    // One node, listed by hand: nothing is wired into this node, so what it is
    // given is a list, and the canvas under the panel did not take the same
    // drop a second time.
    expect(canvas.nodes).toHaveLength(5);
    const spec = (
      canvas.nodes.find((node) => node.id === ids.image)!.data as {
        generation?: GenerationSpec;
      }
    ).generation;
    expect(spec?.inputMode).toBe("manual");
    expect(spec?.referenceNodeIds).toEqual([made.id]);
    expect(canvas.edges.some((edge) => edge.target.nodeId === ids.image)).toBe(
      false,
    );
  });

  it("takes files off a paste, filed and laid out like a drop", async () => {
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");

    const consumed = fireEvent.paste(window, {
      clipboardData: {
        getData: () => "",
        files: [new File(["x"], "drop.png", { type: "image/png" })],
      },
    });
    await vi.waitFor(() => {
      expect(
        useProjectStore
          .getState()
          .moka!.canvas[0].nodes.some((n) => n.title === "drop.png"),
      ).toBe(true);
    });

    // The editor answered for the paste rather than leaving it to the page.
    expect(consumed).toBe(false);
    const state = useProjectStore.getState();
    expect(
      state.moka!.resources.images.some((e) => e.id === "dropped-asset"),
    ).toBe(true);
    expect(state.moka!.canvas[0].nodes).toHaveLength(5);
  });

  it("lists assets on the shelf with use counts", async () => {
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    showAssets();
    const row = screen.getByText("lake.png").closest(".resource-row");
    expect(row?.textContent).toContain("2.0 KB");
    expect(row?.textContent).toContain("1 use");
  });

  it("fills a waiting node from what the project already holds", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    await screen.findByTestId("canvas-tab-Canvas 1");
    act(() => {
      addNodeAt({ x: 0, y: 0 }, "image", null);
    });
    const waiting = useEditorStore.getState().selection.nodeIds[0];
    const inspector = screen.getByRole("complementary", {
      name: "Inspector",
    });
    expect(inspector.textContent).toContain("No asset linked");

    // The other way to fill a node that is waiting: nothing is asked for, so
    // nothing is spent on a provider to get the picture into it.
    fireEvent.change(
      screen.getByLabelText<HTMLSelectElement>(/Link an asset to/),
      { target: { value: ids.assetImage } },
    );

    const dataOf = (nodeId: string) => {
      const canvas = useProjectStore.getState().moka!.canvas[0];
      const node = canvas.nodes.find((entry) => entry.id === nodeId);
      return node?.data as { assetId?: string } | undefined;
    };
    expect(dataOf(waiting)?.assetId).toBe(ids.assetImage);
    expect(inspector.textContent).toContain("lake.png");
    expect(useEditorStore.getState().announcement).toBe("Linked lake.png");

    // One step of history, so the node goes back to waiting as it was.
    undo();
    expect(dataOf(waiting)?.assetId).toBeUndefined();
  });
});
