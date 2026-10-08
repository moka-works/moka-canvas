import { describe, expect, it } from "vitest";
import { applyCommands, CommandError } from "./commands";
import {
  MAX_ASSET_KEYWORD_LENGTH,
  MAX_ASSET_NOTE_LENGTH,
  MAX_ASSET_TAG_LENGTH,
  MAX_ASSET_TAGS,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  MAX_ASSISTANT_MESSAGES_PER_SESSION,
  MAX_ASSISTANT_SESSIONS_PER_CANVAS,
  MAX_PROMPT_LENGTH,
  MAX_RESULT_SLOTS,
  PROVIDER_EXECUTOR_KEY,
  type AssetOrigin,
  type Capability,
} from "./constants";
import {
  buildGoldenMokaFile,
  buildShelfMokaFile,
  buildStoryMokaFile,
  goldenNodeIds,
  storyIds,
  timelineIds,
} from "./fixtures";
import {
  boundsForShape,
  capabilityServes,
  createCanvas,
  createNode,
  createProject,
  createSession,
  executorKeyForNode,
  generationCapabilityFor,
  generationSpecFromSnapshot,
  paramsForCapability,
} from "./factories";
import { newId } from "./ids";
import type {
  AssistantMessage,
  AssistantRole,
  AssistantSession,
  CanvasDocument,
  DocumentCommand,
  GenerationSpec,
  MediaNodeData,
  MokaFile,
  ResourceEntry,
  ResultSlot,
  WorkflowNode,
} from "./types";
import {
  assetHolders,
  mentionNodeIds,
  modelIdentifierShaped,
  topologicalOrder,
  unreferencedAssets,
  validateBounds,
  validateCanvas,
  validateEdgeCandidate,
  validateMokaFile,
  validateResourcePath,
} from "./validate";

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as CommandError).code;
  }
  return "OK";
}

describe("graph validation", () => {
  it("accepts the golden document", () => {
    expect(validateMokaFile(buildGoldenMokaFile())).toEqual([]);
  });

  it("rejects incompatible port types", () => {
    const moka = buildGoldenMokaFile();
    const canvas = moka.canvas[0];
    const result = validateEdgeCandidate(
      canvas,
      { nodeId: goldenNodeIds().text, portId: "out" },
      { nodeId: goldenNodeIds().export, portId: "audio" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PORT_TYPE_MISMATCH");
  });

  it("rejects self loops", () => {
    const moka = buildGoldenMokaFile();
    const result = validateEdgeCandidate(
      moka.canvas[0],
      { nodeId: goldenNodeIds().operation, portId: "out" },
      { nodeId: goldenNodeIds().operation, portId: "text" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SELF_LOOP");
  });

  it("rejects a second edge into a one-cardinality input", () => {
    const moka = buildGoldenMokaFile();
    const canvas = moka.canvas[0];
    const imageNode = createNode("image", { x: 0, y: 0 });
    canvas.nodes.push(imageNode);
    const result = validateEdgeCandidate(
      canvas,
      { nodeId: imageNode.id, portId: "out" },
      { nodeId: goldenNodeIds().operation, portId: "images" },
    );
    expect(result.ok).toBe(true);

    const extraImage = createNode("image", { x: 0, y: 400 });
    canvas.nodes.push(extraImage);
    const result2 = validateEdgeCandidate(
      canvas,
      { nodeId: extraImage.id, portId: "out" },
      { nodeId: goldenNodeIds().export, portId: "video" },
    );
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.code).toBe("PORT_TYPE_MISMATCH");
  });

  it("detects cycles", () => {
    const moka = buildGoldenMokaFile();
    const result = validateEdgeCandidate(
      moka.canvas[0],
      { nodeId: goldenNodeIds().operation, portId: "out" },
      { nodeId: goldenNodeIds().operation, portId: "text" },
    );
    expect(result.ok).toBe(false);

    // text → operation exists; operation → text would close a cycle if
    // text had an input. Build the cycle manually with two operations.
    const opA = createNode("operation", { x: 0, y: 0 });
    const opB = createNode("operation", { x: 400, y: 0 });
    const canvas = { ...moka.canvas[0], nodes: [opA, opB], edges: [] };
    const ab = validateEdgeCandidate(
      canvas,
      { nodeId: opA.id, portId: "out" },
      { nodeId: opB.id, portId: "text" },
    );
    expect(ab.ok).toBe(true);
    const withEdge = {
      ...canvas,
      edges: [
        {
          id: newId(),
          source: { nodeId: opA.id, portId: "out" },
          target: { nodeId: opB.id, portId: "text" },
          createdAt: new Date(0).toISOString(),
        },
      ],
    };
    const cycle = validateEdgeCandidate(
      withEdge,
      { nodeId: opB.id, portId: "out" },
      { nodeId: opA.id, portId: "text" },
    );
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.code).toBe("GRAPH_CYCLE");
  });

  it("rejects invalid bounds and escaping paths", () => {
    expect(validateBounds({ x: 0, y: 0, width: 10, height: 10 })).toBe(true);
    expect(validateBounds({ x: NaN, y: 0, width: 10, height: 10 })).toBe(false);
    expect(validateBounds({ x: 0, y: 0, width: -1, height: 10 })).toBe(false);
    expect(validateBounds({ x: 2_000_000, y: 0, width: 10, height: 10 })).toBe(
      false,
    );

    expect(validateResourcePath("assets/images/a.png")).toBe(true);
    expect(validateResourcePath("../a.png")).toBe(false);
    expect(validateResourcePath("/etc/passwd")).toBe(false);
    expect(validateResourcePath("assets/../a.png")).toBe(false);
    expect(validateResourcePath("assets\\a.png")).toBe(false);
    expect(validateResourcePath("C:/a.png")).toBe(false);
  });

  it("orders nodes topologically with deterministic tie-breaks", () => {
    const moka = buildGoldenMokaFile();
    const ordered = topologicalOrder(moka.canvas[0]).map((n) => n.id);
    const ids = goldenNodeIds();
    expect(ordered.indexOf(ids.text)).toBeLessThan(
      ordered.indexOf(ids.operation),
    );
    expect(ordered.indexOf(ids.operation)).toBeLessThan(
      ordered.indexOf(ids.export),
    );
  });

  it("flags dangling asset references", () => {
    const moka = buildGoldenMokaFile();
    moka.resources.images = [];
    const issues = validateMokaFile(moka);
    expect(issues.some((i) => i.code === "ASSET_MISSING")).toBe(true);
  });
});

describe("what a reader says about an asset", () => {
  /** What the shelf has to say about one asset once it is said. */
  function said(about: Partial<ResourceEntry>): string[] {
    const moka = buildShelfMokaFile();
    Object.assign(moka.resources.images[0], about);
    return validateMokaFile(moka)
      .filter((issue) => issue.code === "VALIDATION_FAILED")
      .map((issue) => issue.message);
  }

  it("accepts the shelf as a reader leaves it", () => {
    expect(validateMokaFile(buildShelfMokaFile())).toEqual([]);
  });

  it("holds the words an asset is filed under to their number", () => {
    const many = Array.from({ length: MAX_ASSET_TAGS + 1 }, (_, index) =>
      index.toString(),
    );
    expect(said({ tags: many })).toContainEqual(
      expect.stringContaining("more tags than"),
    );
    const atTheLimit = Array.from({ length: MAX_ASSET_TAGS }, (_, index) =>
      index.toString(),
    );
    expect(said({ tags: atTheLimit })).toEqual([]);
  });

  it("holds one of those words to a length worth reading", () => {
    expect(
      said({ tags: ["k".repeat(MAX_ASSET_TAG_LENGTH + 1)] }),
    ).toContainEqual(expect.stringContaining("a tag over"));
    expect(said({ tags: ["k".repeat(MAX_ASSET_TAG_LENGTH)] })).toEqual([]);
  });

  it("holds a note to its size", () => {
    expect(
      said({ note: "n".repeat(MAX_ASSET_NOTE_LENGTH + 1) }),
    ).toContainEqual(expect.stringContaining("a note over"));
    expect(said({ note: "n".repeat(MAX_ASSET_NOTE_LENGTH) })).toEqual([]);
  });

  it("holds a summary to its size", () => {
    expect(
      said({ keyword: "w".repeat(MAX_ASSET_KEYWORD_LENGTH + 1) }),
    ).toContainEqual(expect.stringContaining("a summary over"));
    expect(said({ keyword: "w".repeat(MAX_ASSET_KEYWORD_LENGTH) })).toEqual([]);
  });

  it("refuses an origin nothing recognises", () => {
    expect(said({ origin: "inherited" as AssetOrigin })).toContainEqual(
      expect.stringContaining("an origin nothing recognises"),
    );
    expect(said({ origin: "filed" })).toEqual([]);
  });
});

describe("generation validation", () => {
  const ids = goldenNodeIds();

  function goldenCanvas(): CanvasDocument {
    return buildGoldenMokaFile().canvas[0];
  }

  function nodeOf(canvas: CanvasDocument, id: string): WorkflowNode {
    const node = canvas.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`golden canvas has no node ${id}`);
    return node;
  }

  function spec(capability: Capability, prompt: string): GenerationSpec {
    return {
      capability,
      mode: "generate",
      model: "",
      prompt,
      inputMode: "upstream",
      params: {},
      referenceNodeIds: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  function patchData(node: WorkflowNode, patch: Record<string, unknown>) {
    Object.assign(node.data as Record<string, unknown>, patch);
  }

  function flagged(canvas: CanvasDocument, nodeId: string, code: string) {
    return validateCanvas(canvas).some(
      (issue) => issue.code === code && issue.nodeId === nodeId,
    );
  }

  function messages(canvas: CanvasDocument, code: string): string[] {
    return validateCanvas(canvas)
      .filter((issue) => issue.code === code)
      .map((issue) => issue.message);
  }

  it("accepts a canvas whose nodes carry no spec", () => {
    expect(validateCanvas(goldenCanvas())).toEqual([]);
  });

  it("flags a spec that disagrees with its node", () => {
    const canvas = goldenCanvas();
    const broken = spec("image", "Redraw @[node:missing] in ink");
    // An old "channel::model" reference is not a model configuration id.
    broken.model = "channel-1::painter";
    patchData(nodeOf(canvas, ids.text), { generation: broken });

    expect(flagged(canvas, ids.text, "GENERATION_CAPABILITY_MISMATCH")).toBe(
      true,
    );
    expect(flagged(canvas, ids.text, "GENERATION_MODEL_MISSING")).toBe(true);
    expect(flagged(canvas, ids.text, "MENTION_NODE_NOT_FOUND")).toBe(true);
  });

  it("refuses specs on structural nodes", () => {
    const canvas = goldenCanvas();
    patchData(nodeOf(canvas, ids.operation), {
      generation: spec("text", "Summarise the board"),
    });
    expect(
      flagged(canvas, ids.operation, "GENERATION_CAPABILITY_MISMATCH"),
    ).toBe(true);
  });

  it("flags a prompt that mentions its own node", () => {
    const canvas = goldenCanvas();
    patchData(nodeOf(canvas, ids.text), {
      generation: spec("text", `Rewrite @[node:${ids.text}]`),
    });
    expect(flagged(canvas, ids.text, "MENTION_SELF_REFERENCE")).toBe(true);
  });

  it("needs an upstream prompt or references when the prompt is empty", () => {
    const canvas = goldenCanvas();
    patchData(nodeOf(canvas, ids.text), { generation: spec("text", "   ") });
    patchData(nodeOf(canvas, ids.image), { generation: spec("image", "") });
    expect(flagged(canvas, ids.text, "GENERATION_PROMPT_EMPTY")).toBe(true);
    expect(flagged(canvas, ids.image, "GENERATION_PROMPT_EMPTY")).toBe(true);

    canvas.edges.push({
      id: newId(),
      source: { nodeId: ids.text, portId: "out" },
      target: { nodeId: ids.image, portId: "prompt" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(flagged(canvas, ids.image, "GENERATION_PROMPT_EMPTY")).toBe(false);
    expect(
      validateCanvas(canvas).some((i) => i.code === "PORT_TYPE_MISMATCH"),
    ).toBe(false);
    expect(flagged(canvas, ids.text, "GENERATION_PROMPT_EMPTY")).toBe(true);
  });

  it("accepts an empty prompt that lists references", () => {
    const canvas = goldenCanvas();
    const manual = spec("image", "");
    manual.inputMode = "manual";
    manual.referenceNodeIds = [ids.text];
    patchData(nodeOf(canvas, ids.image), { generation: manual });
    expect(flagged(canvas, ids.image, "GENERATION_PROMPT_EMPTY")).toBe(false);
  });

  it("rejects parameters outside the capability whitelist", () => {
    const canvas = goldenCanvas();
    const withParams = spec("image", "A poster of the lake");
    withParams.params = { size: "1:1", brush: "wet" };
    patchData(nodeOf(canvas, ids.image), { generation: withParams });
    expect(messages(canvas, "VALIDATION_FAILED")).toEqual([
      'Unknown parameter "brush" for image generation',
    ]);
  });

  it("rejects an overlong prompt", () => {
    const canvas = goldenCanvas();
    patchData(nodeOf(canvas, ids.text), {
      generation: spec("text", "a".repeat(MAX_PROMPT_LENGTH + 1)),
    });
    expect(messages(canvas, "VALIDATION_FAILED")).toEqual([
      `Generation prompt exceeds the ${MAX_PROMPT_LENGTH} character limit`,
    ]);
  });

  it("enforces the result slot limit", () => {
    const canvas = goldenCanvas();
    const slots: ResultSlot[] = Array.from(
      { length: MAX_RESULT_SLOTS + 1 },
      (_, index) => ({
        id: `slot-${index}`,
        status: "empty" as const,
        isPrimary: index === 0,
      }),
    );
    patchData(nodeOf(canvas, ids.operation), { resultSlots: slots });
    expect(flagged(canvas, ids.operation, "RESULT_SLOT_LIMIT")).toBe(true);
  });

  it("scans mentions and model references", () => {
    expect(mentionNodeIds("Paint @[node:a] beside @[node:b]")).toEqual([
      "a",
      "b",
    ]);
    expect(mentionNodeIds("no mentions here")).toEqual([]);
    expect(mentionNodeIds("@[node:] and @[node")).toEqual([]);

    expect(modelIdentifierShaped("painter")).toBe(true);
    // An old "channel::model" reference names nothing now.
    expect(modelIdentifierShaped("main::painter")).toBe(false);
    expect(modelIdentifierShaped("::painter")).toBe(false);
    expect(modelIdentifierShaped("")).toBe(false);
    expect(modelIdentifierShaped("two words")).toBe(false);
  });
});

describe("document commands", () => {
  function apply(moka: MokaFile, ...commands: DocumentCommand[]) {
    return applyCommands(moka, commands);
  }

  it("sets the project's own words, and the undo puts back exactly what was there", () => {
    const moka = buildGoldenMokaFile();
    const { next, inverse } = apply(moka, {
      type: "updateProjectMetadata",
      name: "  Autumn campaign  ",
      description: "  A launch teaser  ",
    });
    expect(next.metadata.name).toBe("Autumn campaign");
    expect(next.metadata.description).toBe("A launch teaser");

    const undone = apply(next, ...inverse).next;
    expect(undone.metadata.name).toBe(moka.metadata.name);
    expect(undone.metadata.description).toBe(moka.metadata.description);

    // An emptied description is no description at all, while an emptied name
    // is refused: the command asks what the settings form asks.
    const cleared = apply(next, {
      type: "updateProjectMetadata",
      name: "Autumn campaign",
      description: "   ",
    }).next;
    expect(cleared.metadata.description).toBeUndefined();
    expect(
      codeOf(() =>
        apply(cleared, {
          type: "updateProjectMetadata",
          name: "   ",
          description: "",
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("adds and removes a node with exact inverse", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const node = createNode("text", { x: 800, y: 200 });
    const { next, inverse } = apply(moka, {
      type: "addNode",
      canvasId,
      node,
    });
    expect(next.canvas[0].nodes).toHaveLength(5);
    const undone = apply(next, ...inverse).next;
    expect(undone.canvas[0].nodes).toHaveLength(4);
    expect(undone.canvas[0].nodes.map((n) => n.id)).toEqual(
      moka.canvas[0].nodes.map((n) => n.id),
    );
  });

  it("moves nodes and restores positions via inverse", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const ids = goldenNodeIds();
    const { next, inverse } = apply(moka, {
      type: "moveNodes",
      canvasId,
      positions: { [ids.text]: { x: 10, y: 20 } },
    });
    const moved = next.canvas[0].nodes.find((n) => n.id === ids.text)!;
    expect(moved.bounds.x).toBe(10);
    const undone = apply(next, ...inverse).next;
    const restored = undone.canvas[0].nodes.find((n) => n.id === ids.text)!;
    expect(restored.bounds.x).toBe(-320);
  });

  it("removes a node together with its incident edges", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const { next, inverse } = apply(moka, {
      type: "removeNodes",
      canvasId,
      nodeIds: [goldenNodeIds().operation],
    });
    expect(next.canvas[0].nodes).toHaveLength(3);
    expect(next.canvas[0].edges).toHaveLength(0);
    const undone = apply(next, ...inverse).next;
    expect(undone.canvas[0].nodes).toHaveLength(4);
    expect(undone.canvas[0].edges).toHaveLength(2);
  });

  it("rejects invalid edges at the command boundary", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const ids = goldenNodeIds();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addEdge",
          canvasId,
          edge: {
            id: newId(),
            source: { nodeId: ids.text, portId: "out" },
            target: { nodeId: ids.export, portId: "audio" },
            createdAt: new Date(0).toISOString(),
          },
        }),
      ),
    ).toBe("PORT_TYPE_MISMATCH");
  });

  it("clamps the viewport zoom range", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const { next } = apply(moka, {
      type: "setViewport",
      canvasId,
      viewport: { x: 0, y: 0, zoom: 99 },
    });
    expect(next.canvas[0].viewport.zoom).toBe(5);
  });

  it("changes a canvas's own view settings and restores them", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const { next, inverse } = apply(moka, {
      type: "setCanvasSettings",
      canvasId,
      settings: { showMinimap: false },
    });
    // Only what was named moved; the background it was left as stayed.
    expect(next.canvas[0].settings).toEqual({
      background: "dots",
      showMinimap: false,
      snapToGrid: true,
    });
    const undone = apply(next, ...inverse).next;
    expect(undone.canvas[0].settings).toEqual(moka.canvas[0].settings);
  });

  it("refuses a background that is not one of the three", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setCanvasSettings",
          canvasId,
          settings: { background: "checks" as never },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("adds, renames, reorders, and removes canvases", () => {
    const moka = buildGoldenMokaFile();
    const canvas = createCanvas("Scratch");
    const { next: added, inverse: addInverse } = apply(moka, {
      type: "addCanvas",
      canvas,
    });
    expect(added.canvas.map((c) => c.name)).toEqual([
      "Canvas 1",
      "Canvas 2",
      "Scratch",
    ]);

    const { next: renamed } = apply(added, {
      type: "renameCanvas",
      canvasId: canvas.id,
      name: "Ideas",
    });
    expect(renamed.canvas[2].name).toBe("Ideas");

    const { next: reordered } = apply(renamed, {
      type: "reorderCanvas",
      canvasId: canvas.id,
      index: 0,
    });
    expect(reordered.canvas[0].name).toBe("Ideas");

    const { next: removed } = apply(reordered, {
      type: "removeCanvas",
      canvasId: canvas.id,
    });
    expect(removed.canvas).toHaveLength(2);

    const undone = apply(added, ...addInverse).next;
    expect(undone.canvas.map((c) => c.id)).toEqual(
      moka.canvas.map((c) => c.id),
    );
  });

  it("refuses to remove the last canvas", () => {
    const moka = buildGoldenMokaFile();
    apply(moka, { type: "removeCanvas", canvasId: moka.canvas[1].id });
    expect(
      codeOf(() =>
        apply(
          { ...moka, canvas: [moka.canvas[0]] },
          { type: "removeCanvas", canvasId: moka.canvas[0].id },
        ),
      ),
    ).toBe("CANVAS_REQUIRED");
  });

  it("dissolves groups that fall below two members", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const ids = goldenNodeIds();
    const groupNode = createNode("group", { x: 0, y: 0 });
    const grouped = apply(
      moka,
      { type: "addNode", canvasId, node: groupNode },
      {
        type: "setGroupMembership",
        canvasId,
        groupId: groupNode.id,
        childNodeIds: [ids.text, ids.image],
      },
    ).next;
    expect(grouped.canvas[0].groups).toHaveLength(1);

    const reduced = apply(grouped, {
      type: "setGroupMembership",
      canvasId,
      groupId: groupNode.id,
      childNodeIds: [ids.text],
    }).next;
    expect(reduced.canvas[0].groups).toHaveLength(0);
    expect(reduced.canvas[0].nodes.some((n) => n.id === groupNode.id)).toBe(
      false,
    );
    expect(reduced.canvas[0].nodes.some((n) => n.id === ids.text)).toBe(true);
  });

  it("rejects duplicate group members and self-membership", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const ids = goldenNodeIds();
    const groupNode = createNode("group", { x: 0, y: 0 });
    const withGroup = apply(moka, {
      type: "addNode",
      canvasId,
      node: groupNode,
    }).next;
    expect(
      codeOf(() =>
        apply(withGroup, {
          type: "setGroupMembership",
          canvasId,
          groupId: groupNode.id,
          childNodeIds: [ids.text, ids.text],
        }),
      ),
    ).toBe("GROUP_INVALID");
    expect(
      codeOf(() =>
        apply(withGroup, {
          type: "setGroupMembership",
          canvasId,
          groupId: groupNode.id,
          childNodeIds: [groupNode.id, ids.text],
        }),
      ),
    ).toBe("GROUP_INVALID");
  });
});

describe("conversations a canvas carries", () => {
  function apply(moka: MokaFile, ...commands: DocumentCommand[]) {
    return applyCommands(moka, commands);
  }

  /** A moment after the one before it, so recency can be told apart. */
  function at(second: number): string {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  }

  function line(role: AssistantRole, text: string, second: number) {
    return { id: newId(), role, text, createdAt: at(second) };
  }

  function said(canvas: CanvasDocument | undefined, index = 0): string[] {
    return (canvas?.sessions?.[index]?.messages ?? []).map(
      (message) => message.text,
    );
  }

  function opened(moka: MokaFile, title: string) {
    const canvasId = moka.canvas[0].id;
    const session: AssistantSession = {
      ...createSession(title),
      createdAt: at(0),
      updatedAt: at(0),
    };
    return {
      canvasId,
      session,
      next: apply(moka, { type: "addSession", canvasId, session }).next,
    };
  }

  it("adds, renames, and removes a conversation with exact inverses", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const session = createSession("Over the lake");

    const { next, inverse } = apply(moka, {
      type: "addSession",
      canvasId,
      session,
    });
    expect(next.canvas[0].sessions?.map((one) => one.id)).toEqual([session.id]);

    const renamed = apply(next, {
      type: "renameSession",
      canvasId,
      sessionId: session.id,
      title: "The lantern",
    });
    expect(renamed.next.canvas[0].sessions?.[0].title).toBe("The lantern");
    // What a conversation is called is not something said in it, so the moment
    // something was last said is left alone: the newest one is found by it.
    expect(renamed.next.canvas[0].sessions?.[0].updatedAt).toBe(
      session.updatedAt,
    );

    const undone = apply(renamed.next, ...renamed.inverse, ...inverse).next;
    expect(undone.canvas[0]).toEqual(moka.canvas[0]);
  });

  it("puts a conversation back where it was among the others", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const first = createSession("First");
    const second = createSession("Second");
    const both = apply(
      apply(moka, { type: "addSession", canvasId, session: first }).next,
      { type: "addSession", canvasId, session: second },
    ).next;
    expect(both.canvas[0].sessions?.map((one) => one.title)).toEqual([
      "First",
      "Second",
    ]);

    const removed = apply(both, {
      type: "removeSession",
      canvasId,
      sessionId: first.id,
    });
    const undone = apply(removed.next, ...removed.inverse).next;
    expect(undone.canvas[0].sessions?.map((one) => one.title)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("appends what was said and takes it back", () => {
    const moka = buildGoldenMokaFile();
    const { canvasId, session, next } = opened(moka, "Over the lake");

    const asked = line("user", "What is on the card?", 0);
    const answered = line("assistant", "A lantern.", 1);
    const appended = apply(next, {
      type: "appendMessages",
      canvasId,
      sessionId: session.id,
      messages: [asked, answered],
    });
    expect(said(appended.next.canvas[0])).toEqual([asked.text, answered.text]);
    expect(appended.next.canvas[0].sessions?.[0].updatedAt).toBe(
      answered.createdAt,
    );

    const undone = apply(appended.next, ...appended.inverse).next;
    expect(said(undone.canvas[0])).toEqual([]);
    // The moment something was last said only moves forward, so it stays where
    // the turn put it: a conversation just taken back out of is still the one to
    // open onto.
    expect(undone.canvas[0].sessions?.[0].updatedAt).toBe(answered.createdAt);
  });

  /**
   * The ceiling is a trim rather than a refusal, and the trim reaches the
   * document, so undoing the turn that pushed past it has to give the lost lines
   * back and not only the new one away.
   */
  it("lets the oldest lines go at the ceiling and gives them back on undo", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const session = createSession("A long one");
    const full: AssistantMessage[] = Array.from(
      { length: MAX_ASSISTANT_MESSAGES_PER_SESSION },
      (_, index) => line("user", `Line ${index}`, index),
    );
    const filled = apply(moka, {
      type: "addSession",
      canvasId,
      session: { ...session, messages: full },
    }).next;

    const appended = apply(filled, {
      type: "appendMessages",
      canvasId,
      sessionId: session.id,
      messages: [
        line("assistant", "One more", MAX_ASSISTANT_MESSAGES_PER_SESSION),
      ],
    });
    const trimmed = appended.next.canvas[0].sessions?.[0].messages ?? [];
    expect(trimmed).toHaveLength(MAX_ASSISTANT_MESSAGES_PER_SESSION);
    expect(trimmed[0].text).toBe("Line 1");
    expect(trimmed.at(-1)?.text).toBe("One more");

    const undone = apply(appended.next, ...appended.inverse).next;
    const restored = undone.canvas[0].sessions?.[0].messages ?? [];
    expect(restored.map((message) => message.id)).toEqual(
      full.map((message) => message.id),
    );
  });

  it("refuses a conversation the canvas has no room for", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    let full = moka;
    for (let index = 0; index < MAX_ASSISTANT_SESSIONS_PER_CANVAS; index += 1) {
      full = apply(full, {
        type: "addSession",
        canvasId,
        session: createSession(`Talk ${index}`),
      }).next;
    }
    expect(full.canvas[0].sessions).toHaveLength(
      MAX_ASSISTANT_SESSIONS_PER_CANVAS,
    );
    expect(
      codeOf(() =>
        apply(full, {
          type: "addSession",
          canvasId,
          session: createSession("One too many"),
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("refuses a conversation that is not there and a line that is not there", () => {
    const moka = buildGoldenMokaFile();
    const { canvasId, session, next } = opened(moka, "Over the lake");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "appendMessages",
          canvasId,
          sessionId: session.id,
          messages: [line("user", "Hello", 0)],
        }),
      ),
    ).toBe("SESSION_NOT_FOUND");
    expect(
      codeOf(() =>
        apply(next, {
          type: "removeMessages",
          canvasId,
          sessionId: session.id,
          messageIds: [newId()],
        }),
      ),
    ).toBe("MESSAGE_NOT_FOUND");
  });

  it("refuses a line too long to become a card", () => {
    const moka = buildGoldenMokaFile();
    const { canvasId, session, next } = opened(moka, "Over the lake");
    expect(
      codeOf(() =>
        apply(next, {
          type: "appendMessages",
          canvasId,
          sessionId: session.id,
          messages: [
            line("assistant", "a".repeat(MAX_ASSISTANT_MESSAGE_LENGTH + 1), 0),
          ],
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("reports a conversation past its ceiling as a fault in the document", () => {
    const canvas = buildGoldenMokaFile().canvas[0];
    expect(validateCanvas(canvas)).toEqual([]);
    canvas.sessions = [
      {
        ...createSession("Too long"),
        messages: Array.from(
          { length: MAX_ASSISTANT_MESSAGES_PER_SESSION + 1 },
          (_, index) => line("user", `Line ${index}`, index),
        ),
      },
    ];
    expect(validateCanvas(canvas).map((issue) => issue.message)).toEqual([
      `Session "Too long" exceeds the message limit (${MAX_ASSISTANT_MESSAGES_PER_SESSION})`,
    ]);
  });
});

describe("which executor a node runs on", () => {
  it("sends a node carrying a spec to the provider", () => {
    const node = createNode("image", { x: 0, y: 0 }, { generate: true });
    expect(executorKeyForNode(node)).toBe(PROVIDER_EXECUTOR_KEY);
  });

  it("sends an operation node to the executor it names", () => {
    const node = createNode("operation", { x: 0, y: 0 });
    expect(executorKeyForNode(node)).toBe("deterministic");
  });

  it("sends nothing for a node a run could not drive", () => {
    expect(executorKeyForNode(createNode("image", { x: 0, y: 0 }))).toBeNull();
    expect(executorKeyForNode(createNode("group", { x: 0, y: 0 }))).toBeNull();
    expect(executorKeyForNode(createNode("export", { x: 0, y: 0 }))).toBeNull();
  });
});

describe("a node asked for a shape", () => {
  const waiting = { x: 100, y: 40, width: 280, height: 200 };

  it("keeps the centre it has and follows the width it has", () => {
    expect(boundsForShape(waiting, "16:9")).toEqual({
      x: 100,
      y: 61,
      width: 280,
      height: 158,
    });
    expect(boundsForShape(waiting, "9:16")).toEqual({
      x: 100,
      y: -109,
      width: 280,
      height: 498,
    });
  });

  it("widens a shape too flat to leave a node as short as a node may be", () => {
    // At its own width this shape would be 86 tall, and a node that short is
    // refused by the document, so the shape is kept and the width gives way.
    expect(
      boundsForShape({ x: 0, y: 0, width: 200, height: 200 }, "21:9"),
    ).toEqual({ x: -40, y: 40, width: 280, height: 120 });
  });

  it("reads a size in pixels as the shape it describes", () => {
    expect(boundsForShape(waiting, "1024x1536")).toEqual({
      x: 100,
      y: -70,
      width: 280,
      height: 420,
    });
  });

  it("reshapes nothing for a value that states no shape", () => {
    expect(boundsForShape(waiting, "auto")).toBeNull();
    expect(boundsForShape(waiting, "")).toBeNull();
    expect(boundsForShape(waiting, "0:512")).toBeNull();
    expect(boundsForShape(waiting, "1024")).toBeNull();
  });
});

describe("a spec rebuilt from what an asset recorded", () => {
  const asked = {
    capability: "image",
    mode: "edit",
    model: "demo::painter",
    prompt: "Redraw the lake at night",
    inputMode: "mentions",
    params: { size: "1:1", count: 2 },
    referenceNodeIds: ["node-one", "node-two"],
  };

  it("asks again for what the snapshot says", () => {
    const spec = generationSpecFromSnapshot(asked, "image");
    expect(spec?.capability).toBe("image");
    expect(spec?.mode).toBe("edit");
    expect(spec?.model).toBe("demo::painter");
    expect(spec?.prompt).toBe("Redraw the lake at night");
    expect(spec?.inputMode).toBe("mentions");
    expect(spec?.params).toEqual({ size: "1:1", count: 2 });
    expect(spec?.referenceNodeIds).toEqual(["node-one", "node-two"]);
    // A snapshot records what to ask for, not when it was asked for.
    expect(spec?.updatedAt).not.toBe("");
  });

  it("refuses a snapshot that belongs to another kind of node", () => {
    expect(generationSpecFromSnapshot(asked, "text")).toBeNull();
    expect(generationSpecFromSnapshot(asked, "operation")).toBeNull();
    expect(generationSpecFromSnapshot(undefined, "image")).toBeNull();
  });

  it("refuses a snapshot with no prompt to ask for", () => {
    expect(
      generationSpecFromSnapshot({ ...asked, prompt: 7 }, "image"),
    ).toBeNull();
  });

  it("falls back on the parts a hand-edited document got wrong", () => {
    const spec = generationSpecFromSnapshot(
      {
        ...asked,
        mode: "sideways",
        params: "large",
        referenceNodeIds: ["node-one", 3],
      },
      "image",
    );
    expect(spec?.mode).toBe("generate");
    expect(spec?.inputMode).toBe("mentions");
    expect(spec?.params).toEqual({});
    expect(spec?.referenceNodeIds).toEqual(["node-one"]);
  });

  it("takes either sound capability on a sound node, and no other", () => {
    const spoken = { ...asked, capability: "speech" };
    const scored = { ...asked, capability: "music" };
    expect(generationSpecFromSnapshot(spoken, "audio")?.capability).toBe(
      "speech",
    );
    expect(generationSpecFromSnapshot(scored, "audio")?.capability).toBe(
      "music",
    );
    // A picture was asked for with a picture's words; on a sound node it is
    // not an ask to put back but a mismatch the document already reports.
    expect(generationSpecFromSnapshot(spoken, "image")).toBeNull();
    expect(generationSpecFromSnapshot(asked, "audio")).toBeNull();
    expect(generationSpecFromSnapshot(spoken, "group")).toBeNull();
  });
});

describe("the capabilities a sound node is served by", () => {
  it("serves sound from speech and music, and nothing else from either", () => {
    expect(capabilityServes("speech", "audio")).toBe(true);
    expect(capabilityServes("music", "audio")).toBe(true);
    expect(capabilityServes("image", "audio")).toBe(false);
    expect(capabilityServes("speech", "image")).toBe(false);
    expect(capabilityServes("music", "video")).toBe(false);
    expect(capabilityServes("video", "video")).toBe(true);
  });

  it("starts a fresh sound ask as a read-aloud one", () => {
    expect(generationCapabilityFor("audio")).toBe("speech");
    expect(generationCapabilityFor("image")).toBe("image");
    expect(generationCapabilityFor("group")).toBeNull();
  });

  it("cuts parameters to the vocabulary of the capability they land in", () => {
    const asked = {
      voice: "alloy",
      format: "mp3",
      speed: 1.2,
      instrumental: true,
      lyrics: "la la",
    };
    expect(paramsForCapability("speech", asked)).toEqual({
      voice: "alloy",
      format: "mp3",
      speed: 1.2,
    });
    expect(paramsForCapability("music", asked)).toEqual({
      format: "mp3",
      instrumental: true,
      lyrics: "la la",
    });
  });
});

describe("the assets a package would leave behind", () => {
  const WHEN = "2026-01-01T00:00:00.000Z";

  function shelf(id: string, path: string, bytes: number): ResourceEntry {
    return {
      id,
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      bytes,
      createdAt: WHEN,
      updatedAt: WHEN,
    };
  }

  function pointingAt(kind: "assetId" | "posterAssetId", id: string) {
    const node = createNode(kind === "posterAssetId" ? "video" : "image", {
      x: 0,
      y: 0,
    });
    (node.data as MediaNodeData)[kind] = id;
    return node;
  }

  /**
   * One asset behind each of the three pointers a node can hold, and two that
   * nothing points at — the second filed somewhere other than the images, so
   * the sweep has to reach every shelf rather than stop at the first.
   */
  function shelfDocument(): MokaFile {
    const moka = createProject("Shelf Fixture");
    const answered = createNode("image", { x: 640, y: 0 });
    (answered.data as MediaNodeData).resultSlots = [
      {
        id: "result",
        status: "succeeded",
        assetId: "in-a-slot",
        isPrimary: true,
      },
    ];
    moka.canvas[0].nodes = [
      pointingAt("assetId", "on-a-node"),
      pointingAt("posterAssetId", "as-a-poster"),
      answered,
    ];
    moka.resources.images = [
      shelf("on-a-node", "assets/images/on-a-node.png", 1),
      shelf("in-a-slot", "assets/images/in-a-slot.png", 2),
      shelf("left-image", "assets/images/left-image.png", 3),
    ];
    moka.resources.videos = [
      shelf("as-a-poster", "assets/videos/as-a-poster.mp4", 4),
      shelf("left-video", "assets/videos/left-video.mp4", 5),
    ];
    return moka;
  }

  it("leaves out only what no pointer holds, on every shelf", () => {
    expect(
      unreferencedAssets(shelfDocument()).map((entry) => entry.id),
    ).toEqual(["left-image", "left-video"]);
  });

  it("counts a pointer held on a canvas other than the first", () => {
    const moka = shelfDocument();
    const second = createCanvas("Canvas 2");
    second.nodes = [pointingAt("assetId", "left-image")];
    moka.canvas.push(second);
    expect(unreferencedAssets(moka).map((entry) => entry.id)).toEqual([
      "left-video",
    ]);
  });

  it("has nothing to leave out when every asset is placed", () => {
    expect(unreferencedAssets(buildGoldenMokaFile())).toEqual([]);
  });

  it("keeps a voice's recording as used, narrator and character alike", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    moka.resources.voice.push(
      shelf(
        "asset-hero-voice",
        "assets/voice/asset-hero-voice-00000000.wav",
        6,
      ),
      shelf(
        "asset-narrator-voice",
        "assets/voice/asset-narrator-voice-00000000.wav",
        7,
      ),
      shelf(
        "asset-left-voice",
        "assets/voice/asset-left-voice-00000000.wav",
        8,
      ),
    );
    const story = moka.stories![0];
    story.narrator = {
      model: "",
      voice: "",
      referenceAssetId: "asset-narrator-voice",
    };
    story.elements.find((element) => element.id === ids.hero)!.voice = {
      model: "",
      voice: "",
      referenceAssetId: "asset-hero-voice",
    };
    const left = unreferencedAssets(moka).map((entry) => entry.id);
    expect(left).toContain("asset-left-voice");
    expect(left).not.toContain("asset-hero-voice");
    expect(left).not.toContain("asset-narrator-voice");
  });
});

describe("what holds an asset", () => {
  const WHEN = "2026-01-01T00:00:00.000Z";

  /** The story fixture with the hero redrawn: `heroMain` is now an old picture. */
  function redrawn(): MokaFile {
    const moka = buildStoryMokaFile();
    const hero = moka.stories![0].elements.find(
      (element) => element.id === storyIds().hero,
    )!;
    hero.main.takes.push({
      assetIds: ["asset-hero-redrawn"],
      createdAt: WHEN,
    });
    return moka;
  }

  it("tells a card from a story picture and a picture in use", () => {
    const ids = goldenNodeIds();
    expect(assetHolders(buildGoldenMokaFile(), ids.assetImage)).toEqual([
      { kind: "node", canvasId: ids.canvasMain, nodeId: ids.image },
    ]);

    const moka = redrawn();
    expect(assetHolders(moka, storyIds().heroMain)).toEqual([
      {
        kind: "drawing",
        storyId: storyIds().story,
        storyName: "雨夜列车",
        target: { kind: "element", elementId: storyIds().hero, view: "main" },
      },
    ]);
    // The redraw is the picture the place is using, which no delete may take.
    expect(assetHolders(moka, "asset-hero-redrawn")).toEqual([
      {
        kind: "drawingInUse",
        storyId: storyIds().story,
        storyName: "雨夜列车",
        target: { kind: "element", elementId: storyIds().hero, view: "main" },
      },
    ]);
  });

  it("names the shot a frame belongs to, and the clip that reads a file", () => {
    const moka = buildStoryMokaFile();
    expect(assetHolders(moka, storyIds().frameArt)).toEqual([
      {
        kind: "drawingInUse",
        storyId: storyIds().story,
        storyName: "雨夜列车",
        target: {
          kind: "keyframe",
          chapterId: storyIds().chapterFirst,
          actId: storyIds().act,
          keyframeId: storyIds().frameFirst,
        },
      },
    ]);
    expect(assetHolders(moka, timelineIds().videoAsset)).toEqual([
      {
        kind: "clip",
        timelineId: timelineIds().timeline,
        timelineName: "Timeline 1",
        clipId: timelineIds().videoClip,
        clipLabel: "opening.mp4",
      },
    ]);
  });

  it("keeps a manuscript out of a delete's reach", () => {
    const moka = buildStoryMokaFile();
    expect(assetHolders(moka, storyIds().source)).toEqual([
      {
        kind: "storyFile",
        storyId: storyIds().story,
        storyName: "雨夜列车",
        what: "manuscript",
      },
    ]);
  });

  it("holds the voice naming a file as its reference, cast and narrator alike", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const story = moka.stories![0];
    story.narrator = {
      model: "",
      voice: "",
      referenceAssetId: "asset-narrator-voice",
    };
    story.elements.find((element) => element.id === ids.hero)!.voice = {
      model: "",
      voice: "",
      referenceAssetId: "asset-hero-voice",
    };
    expect(assetHolders(moka, "asset-hero-voice")).toEqual([
      {
        kind: "voiceReference",
        storyId: ids.story,
        storyName: "雨夜列车",
        elementId: ids.hero,
      },
    ]);
    expect(assetHolders(moka, "asset-narrator-voice")).toEqual([
      { kind: "voiceReference", storyId: ids.story, storyName: "雨夜列车" },
    ]);
  });

  it("holds nothing for a file nothing points at", () => {
    expect(assetHolders(buildGoldenMokaFile(), "asset-nobody")).toEqual([]);
  });
});
