import { describe, expect, it } from "vitest";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import {
  createNode,
  defaultGenerationSpec,
  type GenerationInputMode,
  type GenerationSpec,
} from "../../shared/domain";
import { buildResourceIndex } from "./canvas/mediaCards";
import { canvasVideoPromptContext } from "./promptRewrite";

const ids = goldenNodeIds();

function scene() {
  const moka = buildGoldenMokaFile();
  const canvas = moka.canvas[0];
  const video = createNode("video", { x: 800, y: 0 });
  const plate = createNode("image", { x: 400, y: 0 });
  const words = createNode("text", { x: 400, y: 300 });
  plate.title = "Opening";
  plate.data = { assetId: ids.assetImage };
  words.title = "Direction";
  words.data = { content: "The lantern drifts left." };
  canvas.nodes.push(video, plate, words);
  return { moka, canvas, video, plate, words };
}

function spec(
  inputMode: GenerationInputMode,
  prompt: string,
  referenceNodeIds: string[] = [],
  pictures: "auto" | "reference" = "auto",
): GenerationSpec {
  return {
    ...defaultGenerationSpec("video")!,
    prompt,
    inputMode,
    referenceNodeIds,
    params: { ratio: "16:9", seconds: 5, mode: pictures },
  };
}

function contextOf(input: ReturnType<typeof scene>, asked: GenerationSpec) {
  return canvasVideoPromptContext({
    canvas: input.canvas,
    node: input.video,
    spec: asked,
    resources: buildResourceIndex(input.moka),
    inputMode: asked.inputMode,
    prompt: asked.prompt,
  });
}

describe("the material a canvas video rewrite is given", () => {
  it("keeps the frames the wiring sends and leaves wired words out", () => {
    const input = scene();
    input.canvas.edges.push(
      {
        id: "edge-frame",
        source: { nodeId: input.plate.id, portId: "out" },
        target: { nodeId: input.video.id, portId: "firstFrame" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "edge-words",
        source: { nodeId: input.words.id, portId: "out" },
        target: { nodeId: input.video.id, portId: "prompt" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );

    const context = contextOf(input, spec("upstream", "Film the frame."));

    expect(context.pictures).toBe("frames");
    expect(context.aspect).toBe("16:9");
    expect(context.seconds).toBe(5);
    expect(context.inputs).toEqual([
      {
        kind: "image",
        role: "firstFrame",
        name: "Opening",
        description: "image",
      },
    ]);
  });

  it("carries a mentioned node's token and its own words", () => {
    const input = scene();
    const context = contextOf(
      input,
      spec("mentions", `Act on ${`@[node:${input.words.id}]`}.`),
    );

    expect(context.inputs).toEqual([
      {
        kind: "text",
        role: "reference",
        name: "Direction",
        description: "The lantern drifts left.",
        token: `@[node:${input.words.id}]`,
      },
    ]);
  });

  it("reads the list by hand rather than the wiring", () => {
    const input = scene();
    input.canvas.edges.push({
      id: "edge-frame",
      source: { nodeId: input.words.id, portId: "out" },
      target: { nodeId: input.video.id, portId: "prompt" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const context = contextOf(
      input,
      spec("manual", "Film the plate.", [input.plate.id], "reference"),
    );

    expect(context.pictures).toBe("references");
    expect(context.inputs).toEqual([
      {
        kind: "image",
        role: "reference",
        name: "Opening",
        description: "image",
      },
    ]);
  });
});
