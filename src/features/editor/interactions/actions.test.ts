import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetsApi } from "../../../api";
import {
  batchNodeIds,
  buildBatchMokaFile,
  buildGenerationMokaFile,
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import {
  DEFAULT_NODE_WIDTH,
  GROUP_DETACH_THRESHOLD_PX,
  MOKA_FRAGMENT_MIME,
  findNode,
  type GenerationSpec,
  type MokaFile,
  type Rect,
  type ResultSlot,
} from "../../../shared/domain";
import { execute, redo, undo } from "../commands/execute";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { buildFragment } from "./clipboard";
import {
  addNodeAt,
  alignNodes,
  checkConnection,
  chooseResult,
  choosableResults,
  connectPorts,
  copySelection,
  distributeNodes,
  editTextContent,
  equalizeNodes,
  fileNodeAsAsset,
  groupSelection,
  importFiles,
  marqueeSelect,
  moveNodes,
  pasteAt,
  pasteClipboard,
  relatedHighlight,
  renameNode,
  resizeNodeTo,
  selectNodeWithMembers,
  setNodeGeneration,
  ungroupSelection,
} from "./actions";

function hydrate(moka?: MokaFile) {
  const document = moka ?? buildGoldenMokaFile();
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka: document,
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  return document;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    hoveredNodeId: null,
    hoveredPort: null,
    pointerWorld: null,
    announcement: "",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("marqueeSelect", () => {
  it("selects nodes whose bounds intersect the marquee", () => {
    const ids = goldenNodeIds();
    hydrate();
    // Covers the text node corner only: intersect, not contain.
    marqueeSelect({ x: -400, y: -200, width: 100, height: 100 }, false);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.text]);
  });

  it("keeps the baseline selection in additive mode", () => {
    const ids = goldenNodeIds();
    hydrate();
    selectNodeWithMembers(ids.export, false);
    marqueeSelect({ x: -400, y: -200, width: 100, height: 100 }, true);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([
      ids.export,
      ids.text,
    ]);
  });
});

describe("checkConnection", () => {
  it("maps domain validation to preview states", () => {
    const ids = goldenNodeIds();
    hydrate();
    expect(
      checkConnection(
        { nodeId: ids.image, portId: "out" },
        { nodeId: ids.operation, portId: "images" },
      ),
    ).toBe("ok");
    // export.video is cardinality one and already occupied.
    expect(
      checkConnection(
        { nodeId: ids.operation, portId: "out" },
        { nodeId: ids.export, portId: "video" },
      ),
    ).toBe("replace");
    // Self-loop is never allowed.
    expect(
      checkConnection(
        { nodeId: ids.operation, portId: "out" },
        { nodeId: ids.operation, portId: "text" },
      ),
    ).toBe("invalid");
  });

  it("follows the extended port table for prompt inputs", () => {
    const ids = goldenNodeIds();
    hydrate();
    expect(
      checkConnection(
        { nodeId: ids.text, portId: "out" },
        { nodeId: ids.image, portId: "prompt" },
      ),
    ).toBe("ok");

    addNodeAt({ x: 900, y: 400 }, "audio", null);
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const audio = canvas.nodes.find((node) => node.kind === "audio")!;
    expect(
      checkConnection(
        { nodeId: ids.image, portId: "out" },
        { nodeId: audio.id, portId: "prompt" },
      ),
    ).toBe("invalid");
  });
});

describe("connectPorts", () => {
  it("replaces an occupied cardinality-one input in one history entry", () => {
    const ids = goldenNodeIds();
    hydrate();
    const before = useHistoryStore.getState().undoStack.length;
    connectPorts(
      { nodeId: ids.operation, portId: "out" },
      { nodeId: ids.export, portId: "video" },
    );
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const incoming = canvas.edges.filter(
      (edge) =>
        edge.target.nodeId === ids.export && edge.target.portId === "video",
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0].id).not.toBe(ids.edgeOpExport);
    expect(useHistoryStore.getState().undoStack.length).toBe(before + 1);
  });

  it("rejects cyclic connections without a history entry", () => {
    const ids = goldenNodeIds();
    hydrate();
    const before = useHistoryStore.getState().undoStack.length;
    // export.out (artifact) into operation.text (text) is a type mismatch.
    connectPorts(
      { nodeId: ids.export, portId: "out" },
      { nodeId: ids.operation, portId: "text" },
    );
    expect(useHistoryStore.getState().undoStack.length).toBe(before);
    expect(useAppStore.getState().toasts.length).toBeGreaterThan(0);
  });
});

describe("moveNodes group membership", () => {
  it("detaches a member dragged out past the threshold", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    groupSelection();
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const group = canvas.nodes.find((node) => node.kind === "group")!;
    const member = findNode(canvas, ids.text)!;
    // Pull the text node's center beyond group bounds + threshold.
    moveNodes({
      [ids.text]: {
        x: group.bounds.x + group.bounds.width + GROUP_DETACH_THRESHOLD_PX,
        y: member.bounds.y,
      },
    });
    const after = useProjectStore.getState().moka!.canvas[0];
    // Down to one member, the group auto-dissolves and keeps both nodes.
    expect(after.groups).toHaveLength(0);
    expect(findNode(after, ids.text)).toBeDefined();
    expect(findNode(after, ids.image)).toBeDefined();
  });

  it("attaches a node whose center enters a group frame", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    groupSelection();
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const group = canvas.nodes.find((node) => node.kind === "group")!;
    const operation = findNode(canvas, ids.operation)!;
    // Place the operation node's center well inside the group frame.
    moveNodes({
      [ids.operation]: {
        x: group.bounds.x + group.bounds.width / 2 - operation.bounds.width / 2,
        y:
          group.bounds.y +
          group.bounds.height / 2 -
          operation.bounds.height / 2,
      },
    });
    const after = useProjectStore.getState().moka!.canvas[0];
    expect(
      after.groups.find((g) => g.groupId === group.id)?.childNodeIds,
    ).toContain(ids.operation);
  });

  it("keeps membership when group and members move together", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    groupSelection();
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const group = canvas.nodes.find((node) => node.kind === "group")!;
    const memberIds = canvas.groups.find(
      (g) => g.groupId === group.id,
    )!.childNodeIds;
    const positions: Record<string, { x: number; y: number }> = {
      [group.id]: { x: group.bounds.x + 500, y: group.bounds.y + 500 },
    };
    for (const memberId of memberIds) {
      const member = findNode(canvas, memberId)!;
      positions[memberId] = {
        x: member.bounds.x + 500,
        y: member.bounds.y + 500,
      };
    }
    moveNodes(positions);
    const after = useProjectStore.getState().moka!.canvas[0];
    expect(
      after.groups.find((g) => g.groupId === group.id)?.childNodeIds,
    ).toEqual(memberIds);
  });
});

describe("group/ungroup", () => {
  it("groups a multi-selection and ungroup selects the former members", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    groupSelection();
    let canvas = useProjectStore.getState().moka!.canvas[0];
    const group = canvas.nodes.find((node) => node.kind === "group")!;
    expect(
      canvas.groups.find((g) => g.groupId === group.id)?.childNodeIds,
    ).toEqual([ids.text, ids.image]);

    useEditorStore.getState().setSelection({
      nodeIds: [group.id],
      edgeIds: [],
    });
    ungroupSelection();
    canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.groups).toHaveLength(0);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([
      ids.text,
      ids.image,
    ]);
  });
});

describe("relatedHighlight", () => {
  it("lights direct neighbors of the hovered node", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setHoveredNode(ids.operation);
    const related = relatedHighlight();
    expect(related?.edgeIds.sort()).toEqual(
      [ids.edgeOpExport, ids.edgeTextOp].sort(),
    );
    expect(related?.nodeIds).toEqual(
      expect.arrayContaining([ids.operation, ids.text, ids.export]),
    );
  });

  it("uses the single selected node when nothing is hovered", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.export],
      edgeIds: [],
    });
    const related = relatedHighlight();
    expect(related?.edgeIds).toEqual([ids.edgeOpExport]);
  });

  it("returns null for isolated nodes and multi-selections", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setHoveredNode(ids.image);
    expect(relatedHighlight()).toBeNull();
    useEditorStore.getState().setHoveredNode(null);
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    expect(relatedHighlight()).toBeNull();
  });
});

describe("copy/paste fragment round trip", () => {
  it("clones a connected selection with fresh ids and internal edges only", async () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.operation, ids.export],
      edgeIds: [],
    });
    await copySelection();
    const before = useProjectStore.getState().moka!.canvas[0];
    await pasteAt({ x: 800, y: 400 });
    const after = useProjectStore.getState().moka!.canvas[0];
    expect(after.nodes).toHaveLength(before.nodes.length + 3);
    expect(after.edges).toHaveLength(before.edges.length + 2);
    const clones = after.nodes.filter((node) => !before.nodes.includes(node));
    expect(clones.some((node) => node.id === ids.text)).toBe(false);
    const selected = useEditorStore.getState().selection.nodeIds;
    expect(selected.sort()).toEqual(clones.map((node) => node.id).sort());
  });

  it("carries a generation spec across the fragment round trip", async () => {
    hydrate(buildGenerationMokaFile());
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const image = canvas.nodes.find((node) => node.kind === "image")!;
    const spec = (image.data as { generation: GenerationSpec }).generation;

    useEditorStore.getState().setSelection({
      nodeIds: [image.id],
      edgeIds: [],
    });
    await copySelection();
    await pasteAt({ x: 900, y: 400 });

    const after = useProjectStore.getState().moka!.canvas[0];
    const clone = after.nodes.find(
      (node) => node.kind === "image" && node.id !== image.id,
    )!;
    expect((clone.data as { generation?: GenerationSpec }).generation).toEqual(
      spec,
    );
  });

  it("strips asset references missing from the target project", async () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.image],
      edgeIds: [],
    });
    await copySelection();
    // Paste into a project whose registry lacks the image asset.
    const foreign = buildGoldenMokaFile();
    foreign.resources.images = [];
    hydrate(foreign);
    await pasteAt({ x: 0, y: 0 });
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const clone = canvas.nodes.find(
      (node) => node.kind === "image" && node.id !== ids.image,
    )!;
    expect((clone.data as { assetId?: string }).assetId).toBeUndefined();
    expect(
      useAppStore.getState().toasts.some((toast) => toast.kind === "error"),
    ).toBe(true);
  });
});

describe("pasteClipboard", () => {
  /** Answers each upload with an entry filed under the file's own name. */
  function serveUploads() {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    fetchMock.mockImplementation((input, init) => {
      const request = init as RequestInit;
      if (
        String(input) === "/api/v1/projects/current/assets" &&
        request?.method === "POST"
      ) {
        const file = (request.body as FormData).get("file") as File;
        return Promise.resolve(
          json({
            entry: {
              id: `filed-${file.name}`,
              name: file.name,
              path: `assets/images/${file.name}`,
              mime: "image/png",
              bytes: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            revision: 3,
            updatedAt: "2026-01-01T00:00:01.000Z",
          }),
        );
      }
      return Promise.resolve(
        json({ code: "NOT_FOUND", message: String(input), status: 404 }),
      );
    });
  }

  function pasteEvent(init: { files?: File[]; data?: Record<string, string> }) {
    const preventDefault = vi.fn();
    const event = {
      preventDefault,
      clipboardData: {
        files: init.files ?? [],
        getData: (type: string) => init.data?.[type] ?? "",
      },
    } as unknown as ClipboardEvent;
    return { event, preventDefault };
  }

  it("files every file a paste carries and lays a node on each", async () => {
    hydrate();
    serveUploads();
    const { event, preventDefault } = pasteEvent({
      files: [
        new File(["a"], "one.png", { type: "image/png" }),
        new File(["b"], "two.png", { type: "image/png" }),
      ],
    });

    await pasteClipboard(event, { x: 100, y: 100 });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    const moka = useProjectStore.getState().moka!;
    expect(moka.resources.images.map((entry) => entry.name)).toEqual([
      "lake.png",
      "one.png",
      "two.png",
    ]);
    const made = moka.canvas[0].nodes.filter((node) =>
      node.title.endsWith(".png"),
    );
    expect(made.map((node) => node.title)).toEqual(["one.png", "two.png"]);
    // Laid out apart: a paste of several does not pile them on one spot, and
    // the second keeps off the first rather than covering it.
    const [one, two] = made.map((node) => node.bounds);
    const apart =
      two.x >= one.x + one.width ||
      one.x >= two.x + two.width ||
      two.y >= one.y + one.height ||
      one.y >= two.y + two.height;
    expect(apart).toBe(true);
    // Out of the way to the right and below, never back over the drop.
    expect(two.x).toBeGreaterThanOrEqual(one.x);
    expect(two.y).toBeGreaterThanOrEqual(one.y);
  });

  it("reads a fragment under the app's own MIME and inside plain text", async () => {
    const ids = goldenNodeIds();
    hydrate();
    const fragment = buildFragment(useProjectStore.getState().moka!.canvas[0], [
      ids.text,
      ids.operation,
    ])!;
    const payload = JSON.stringify(fragment);

    await pasteClipboard(
      pasteEvent({ data: { [MOKA_FRAGMENT_MIME]: payload } }).event,
      { x: 600, y: 300 },
    );
    let canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.nodes).toHaveLength(6);
    expect(canvas.edges).toHaveLength(3);

    // The same JSON inside the readable copy, the way the app leaves it for a
    // plain-text paste.
    await pasteClipboard(
      pasteEvent({
        data: { "text/plain": `2 canvas nodes\n${payload}` },
      }).event,
      { x: 600, y: 300 },
    );
    canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.nodes).toHaveLength(8);
    expect(canvas.edges).toHaveLength(4);
  });

  it("falls back to the last copy made in this window", async () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore
      .getState()
      .setSelection({ nodeIds: [ids.export], edgeIds: [] });
    await copySelection();
    const { event, preventDefault } = pasteEvent({});

    await pasteClipboard(event, { x: 0, y: 0 });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().moka!.canvas[0].nodes).toHaveLength(5);
  });

  it("reads anything else as words", async () => {
    hydrate();
    const { event, preventDefault } = pasteEvent({
      data: { "text/plain": "A lantern over a lake" },
    });

    await pasteClipboard(event, { x: 0, y: 0 });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    const canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.nodes).toHaveLength(5);
    const texts = canvas.nodes.filter((node) => node.kind === "text");
    expect((texts[1].data as { content: string }).content).toBe(
      "A lantern over a lake",
    );
  });
});

describe("resizeNodeTo", () => {
  it("commits one undoable bounds change", () => {
    const ids = goldenNodeIds();
    hydrate();
    resizeNodeTo(ids.text, { x: -320, y: -120, width: 400, height: 260 });
    let canvas = useProjectStore.getState().moka!.canvas[0];
    expect(findNode(canvas, ids.text)?.bounds.width).toBe(400);
    undo();
    canvas = useProjectStore.getState().moka!.canvas[0];
    expect(findNode(canvas, ids.text)?.bounds.width).toBe(280);
  });
});

describe("renameNode", () => {
  it("trims and skips empty or unchanged titles", () => {
    const ids = goldenNodeIds();
    hydrate();
    renameNode(ids.text, "   ");
    renameNode(ids.text, "Brief");
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
    renameNode(ids.text, "  Shot list  ");
    const canvas = useProjectStore.getState().moka!.canvas[0];
    expect(findNode(canvas, ids.text)?.title).toBe("Shot list");
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });
});

describe("setNodeGeneration", () => {
  function specOf(nodeId: string): GenerationSpec | undefined {
    const canvas = useProjectStore.getState().moka!.canvas[0];
    return (findNode(canvas, nodeId)!.data as { generation?: GenerationSpec })
      .generation;
  }

  function hydrateSpecNode() {
    const moka = hydrate(buildGenerationMokaFile());
    const canvas = moka.canvas[0];
    const image = canvas.nodes.find((node) => node.kind === "image")!;
    return {
      canvasId: canvas.id,
      nodeId: image.id,
      spec: (image.data as { generation: GenerationSpec }).generation,
    };
  }

  it("rewrites and clears a spec through undo and redo", () => {
    const { canvasId, nodeId, spec } = hydrateSpecNode();

    setNodeGeneration(canvasId, nodeId, {
      ...spec,
      prompt: "Repaint at dusk.",
    });
    expect(specOf(nodeId)?.prompt).toBe("Repaint at dusk.");

    undo();
    expect(specOf(nodeId)).toEqual(spec);
    redo();
    expect(specOf(nodeId)?.prompt).toBe("Repaint at dusk.");

    setNodeGeneration(canvasId, nodeId, null);
    expect(specOf(nodeId)).toBeUndefined();
    undo();
    expect(specOf(nodeId)?.prompt).toBe("Repaint at dusk.");
  });

  it("records one entry per committed change, not per keystroke", () => {
    const { canvasId, nodeId, spec } = hydrateSpecNode();

    setNodeGeneration(canvasId, nodeId, { ...spec, prompt: "A lan" });
    setNodeGeneration(canvasId, nodeId, { ...spec, prompt: "A lan" });
    setNodeGeneration(canvasId, nodeId, { ...spec, prompt: "A lantern" });

    expect(useHistoryStore.getState().undoStack).toHaveLength(2);
  });

  it("leaves structural nodes alone", () => {
    const ids = goldenNodeIds();
    hydrate();
    setNodeGeneration(ids.canvasMain, ids.operation, {
      capability: "text",
      mode: "generate",
      model: "",
      prompt: "Summarise the board",
      inputMode: "upstream",
      params: {},
      referenceNodeIds: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(specOf(ids.operation)).toBeUndefined();
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });
});

describe("group drag integration", () => {
  it("selecting a group member keeps members together through moves", () => {
    const ids = goldenNodeIds();
    hydrate();
    execute("Group", [
      {
        type: "addNode",
        canvasId: ids.canvasMain,
        node: {
          ...findNode(buildGoldenMokaFile().canvas[0], ids.text)!,
          id: "grp-1",
          kind: "group",
          title: "Group",
          ports: [],
          bounds: { x: -400, y: -200, width: 800, height: 700 },
          data: { color: "#6d8cff", childNodeIds: [ids.text, ids.image] },
        },
      },
      {
        type: "setGroupMembership",
        canvasId: ids.canvasMain,
        groupId: "grp-1",
        childNodeIds: [ids.text, ids.image],
      },
    ]);
    selectNodeWithMembers("grp-1", false);
    expect(useEditorStore.getState().selection.nodeIds.sort()).toEqual(
      ["grp-1", ids.image, ids.text].sort(),
    );
  });
});

describe("chooseResult", () => {
  const batch = batchNodeIds();

  function shown(nodeId: string) {
    const canvas = useProjectStore.getState().moka!.canvas[0];
    return findNode(canvas, nodeId)!.data as {
      assetId?: string;
      resultSlots?: ResultSlot[];
    };
  }

  it("makes one of several results the one a node shows", () => {
    hydrate(buildBatchMokaFile());

    chooseResult(batch.poster, "result-3");

    expect(shown(batch.poster).assetId).toBe("asset-three");
    expect(
      shown(batch.poster).resultSlots?.map((slot) => slot.isPrimary),
    ).toEqual([false, false, true]);
    // One choice, one step back.
    undo();
    expect(shown(batch.poster).assetId).toBe("asset-one");
    expect(shown(batch.poster).resultSlots?.[0]?.isPrimary).toBe(true);
  });

  it("takes a choice made on a card back to the node holding the batch", () => {
    hydrate(buildBatchMokaFile());

    chooseResult(batch.second, "result");

    expect(shown(batch.poster).assetId).toBe("asset-two");
    expect(
      shown(batch.poster).resultSlots?.map((slot) => slot.isPrimary),
    ).toEqual([false, true, false]);
    // The card holds its own answer either way; the holder is what changes.
    expect(shown(batch.second).assetId).toBe("asset-two");
  });

  it("offers what can still be chosen, and nothing past that", () => {
    const moka = hydrate(buildBatchMokaFile());
    const canvas = moka.canvas[0];
    expect(
      choosableResults(canvas, findNode(canvas, batch.poster)!).map(
        (choice) => choice.slotId,
      ),
    ).toEqual(["result-2", "result-3"]);

    chooseResult(batch.second, "result");

    const after = useProjectStore.getState().moka!.canvas[0];
    // A card the holder now shows has nothing left to offer.
    expect(choosableResults(after, findNode(after, batch.second)!)).toEqual([]);
    expect(choosableResults(after, findNode(after, batch.third)!)).toHaveLength(
      1,
    );
  });

  it("leaves a node with no results to choose between alone", () => {
    const ids = goldenNodeIds();
    const moka = hydrate();
    const canvas = moka.canvas[0];

    expect(choosableResults(canvas, findNode(canvas, ids.image)!)).toEqual([]);
    chooseResult(ids.image, "result");

    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });
});

describe("arranging a selection", () => {
  function select(nodeIds: string[]) {
    useEditorStore.getState().setSelection({ nodeIds, edgeIds: [] });
  }

  function boundsOf(nodeId: string) {
    const canvas = useProjectStore.getState().moka!.canvas[0];
    return findNode(canvas, nodeId)!.bounds;
  }

  it("lines the selected nodes up on the edge asked for", () => {
    const ids = goldenNodeIds();
    hydrate();
    select([ids.text, ids.operation]);

    alignNodes("left");

    expect(boundsOf(ids.operation)).toMatchObject({ x: -320, y: -120 });
    expect(boundsOf(ids.text)).toMatchObject({ x: -320, y: -120 });
    undo();
    expect(boundsOf(ids.operation).x).toBe(40);
  });

  it("writes nothing when everyone is already on the line", () => {
    const ids = goldenNodeIds();
    hydrate();
    select([ids.text, ids.operation]);
    const before = useHistoryStore.getState().undoStack.length;

    alignNodes("top");

    expect(useHistoryStore.getState().undoStack.length).toBe(before);
  });

  it("spreads the middle nodes so the room between neighbours matches", () => {
    const ids = goldenNodeIds();
    hydrate();
    moveNodes({ [ids.export]: { x: 700, y: -120 } });
    select([ids.text, ids.operation, ids.export]);

    distributeNodes("horizontal");

    // The ends stay put and the node between them takes the middle it leaves.
    expect(boundsOf(ids.text).x).toBe(-320);
    expect(boundsOf(ids.operation).x).toBe(180);
    expect(boundsOf(ids.export).x).toBe(700);
  });

  it("leaves two nodes to the ends they already have", () => {
    const ids = goldenNodeIds();
    hydrate();
    select([ids.text, ids.operation]);
    const before = useHistoryStore.getState().undoStack.length;

    distributeNodes("horizontal");

    expect(useHistoryStore.getState().undoStack.length).toBe(before);
  });

  it("gives every selected node the widest node's width", () => {
    const ids = goldenNodeIds();
    hydrate();
    select([ids.text, ids.operation]);

    equalizeNodes("width");

    expect(boundsOf(ids.text)).toMatchObject({
      x: -320,
      y: -120,
      width: 300,
      height: 200,
    });
    expect(boundsOf(ids.operation).width).toBe(300);
    undo();
    expect(boundsOf(ids.text).width).toBe(280);
  });

  it("levels the height the same way", () => {
    const ids = goldenNodeIds();
    hydrate();
    select([ids.text, ids.operation]);

    equalizeNodes("height");

    expect(boundsOf(ids.text).height).toBe(220);
    expect(boundsOf(ids.operation).height).toBe(220);
  });

  it("arranges the members of a selection rather than a frame over them", () => {
    const ids = goldenNodeIds();
    hydrate();
    select([ids.text, ids.image]);
    groupSelection();
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const groupId = canvas.groups[0].groupId;
    const frame = { ...boundsOf(groupId) };

    select([groupId, ids.operation]);
    equalizeNodes("width");
    alignNodes("left");

    // One member is nothing to arrange, so neither act touched anything.
    expect(boundsOf(groupId)).toEqual(frame);
    expect(boundsOf(ids.operation).x).toBe(40);
  });
});

describe("editTextContent", () => {
  it("writes what a text node says and leaves what it asks for alone", () => {
    const moka = hydrate(buildGenerationMokaFile());
    const text = moka.canvas[0].nodes.find((node) => node.kind === "text")!;
    const asked = (text.data as { generation: GenerationSpec }).generation
      .prompt;

    editTextContent(text.id, "Written by hand.");

    const after = findNode(
      useProjectStore.getState().moka!.canvas[0],
      text.id,
    )!;
    expect((after.data as { content: string }).content).toBe(
      "Written by hand.",
    );
    expect(
      (after.data as { generation: GenerationSpec }).generation.prompt,
    ).toBe(asked);
  });
});

describe("addNodeAt placement", () => {
  /** Whether two node cards cover any part of each other. */
  function overlaps(a: { bounds: Rect }, b: { bounds: Rect }): boolean {
    return (
      a.bounds.x < b.bounds.x + b.bounds.width &&
      b.bounds.x < a.bounds.x + a.bounds.width &&
      a.bounds.y < b.bounds.y + b.bounds.height &&
      b.bounds.y < a.bounds.y + a.bounds.height
    );
  }

  function canvasNow() {
    return useProjectStore.getState().moka!.canvas[0];
  }

  it("moves a dropped card clear of the nodes already there", () => {
    hydrate();
    const target = canvasNow().nodes.find((node) => node.kind === "image")!;
    // Dropped right on top of the image node: the spot asked for is taken,
    // so the card lands below the canvas's cards instead of inside one.
    const made = addNodeAt(
      { x: target.bounds.x + 60, y: target.bounds.y + 50 },
      "audio",
      null,
    )!;
    const node = findNode(canvasNow(), made)!;
    for (const other of canvasNow().nodes) {
      if (other.id === node.id) continue;
      expect(overlaps(node, other), `overlaps ${other.title}`).toBe(false);
    }
  });

  it("keeps a card dragged off a connection clear of the node it came from", () => {
    const ids = goldenNodeIds();
    hydrate();
    const source = findNode(canvasNow(), ids.image)!;
    // A short wire is released close to where it started: the drop point is
    // on the source node itself, the case that used to bury the new card
    // under the one it is wired to.
    const made = addNodeAt(
      { x: source.bounds.x + 20, y: source.bounds.y + 20 },
      "operation",
      { nodeId: ids.image, portId: "out" },
    )!;
    const node = findNode(canvasNow(), made)!;
    for (const other of canvasNow().nodes) {
      if (other.id === node.id) continue;
      expect(overlaps(node, other), `overlaps ${other.title}`).toBe(false);
    }
    // The connection the drag asked for is still what arrived.
    const edge = canvasNow().edges.find(
      (entry) => entry.target.nodeId === made,
    );
    expect(edge?.source).toEqual({ nodeId: ids.image, portId: "out" });
  });

  it("leaves a drop on empty canvas where it was asked for", () => {
    hydrate();
    const made = addNodeAt({ x: 2000, y: 2000 }, "audio", null)!;
    const node = findNode(canvasNow(), made)!;
    expect(node.bounds.x).toBe(2000 - DEFAULT_NODE_WIDTH / 2);
    expect(node.bounds.y).toBe(2000 - 40);
  });
});

describe("filing a node as an asset", () => {
  it("says why the filing waits when a change will not save, not that it is still saving", async () => {
    const ids = goldenNodeIds();
    hydrate();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (init?.method === "POST" && url.includes("/commands")) {
        return json({ code: "INTERNAL", message: "io error: disk full" }, 500);
      }
      return json({});
    });
    // A change of the reader's that the server will not take: what is on its
    // way stays in this window, and filing the node as it stands would file
    // the words as they were before it.
    renameNode(ids.text, "站台上的两个人");
    await useProjectStore.getState().flush();
    expect(useProjectStore.getState().saveStatus).toBe("error");

    const fileNode = vi.spyOn(assetsApi, "fileNode");
    await fileNodeAsAsset(ids.canvasMain, ids.text);

    const said = useAppStore.getState().toasts.at(-1);
    expect(said?.message).toBe("io error: disk full");
    expect(said?.detail).toBe(
      "Changes are still being saved — try again in a moment",
    );
    expect(fileNode).not.toHaveBeenCalled();
  });
});

describe("importing files", () => {
  /** A server that will not take the reader's changes. */
  function refusingWrites() {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (init?.method === "POST" && url.includes("/commands")) {
        return json({ code: "INTERNAL", message: "io error: disk full" }, 500);
      }
      return json({});
    });
  }

  it("lets what is waiting go out before it files, so the import makes no conflict", async () => {
    const ids = goldenNodeIds();
    hydrate();
    // A document that takes the reader's change, as it usually does.
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/commands")) {
        return new Response(
          JSON.stringify({ revision: 9, updatedAt: "2026-01-01T00:00:02Z" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    let waitingAtUpload: number | null = null;
    const upload = vi
      .spyOn(assetsApi, "upload")
      .mockImplementation(async () => {
        waitingAtUpload = useProjectStore.getState().pending.length;
        return {
          entry: {
            id: "asset-imported",
            name: "one.png",
            path: "assets/images/one-00000000.png",
            mime: "image/png",
            bytes: 8,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          revision: 10,
          updatedAt: "2026-01-01T00:00:03Z",
        };
      });
    // The reader's change is waiting, and the upload would move the document
    // on under it: it goes up first, so the file lands on a revision the room
    // is not resting behind.
    renameNode(ids.text, "站台上的两个人");
    expect(useProjectStore.getState().pending.length).toBeGreaterThan(0);

    const imported = await importFiles([new File(["x"], "one.png")]);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(waitingAtUpload).toBe(0);
    expect(imported).toEqual(["asset-imported"]);
    expect(useProjectStore.getState().pending).toEqual([]);
  });

  it("says why it will not file, and marks every row it did not reach", async () => {
    const ids = goldenNodeIds();
    hydrate();
    refusingWrites();
    renameNode(ids.text, "站台上的两个人");
    await useProjectStore.getState().flush();
    expect(useProjectStore.getState().saveStatus).toBe("error");

    const upload = vi.spyOn(assetsApi, "upload");
    const done: Array<[number, string | undefined]> = [];
    const imported = await importFiles(
      [new File(["x"], "one.png"), new File(["x"], "two.png")],
      { onFileDone: (index, message) => done.push([index, message]) },
    );

    expect(imported).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    // Both rows are told; a row left spinning would be the shelf waiting for
    // an upload that is not coming.
    expect(done).toEqual([
      [0, "io error: disk full"],
      [1, "io error: disk full"],
    ]);
    const said = useAppStore.getState().toasts.at(-1);
    expect(said?.message).toBe("io error: disk full");
    expect(said?.detail).toBe(
      "Changes are still being saved — try again in a moment",
    );
  });
});
