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
import {
  canvasImagePromptContext,
  canvasVideoPromptContext,
} from "./promptRewrite";

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
        position: 1,
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
        position: 1,
        name: "Opening",
        description: "image",
      },
    ]);
  });

  it("keeps both pictures a director hands along", () => {
    const input = scene();
    const director = createNode("director", { x: 0, y: 0 });
    director.title = "Stage";
    director.data = {
      director: {
        sceneId: "scene",
        frameAssetId: ids.assetImage,
        blockingAssetId: ids.assetImage,
      },
    };
    input.canvas.nodes.push(director);
    input.canvas.edges.push(
      {
        id: "edge-frame",
        source: { nodeId: director.id, portId: "frame" },
        target: { nodeId: input.video.id, portId: "firstFrame" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "edge-blocking",
        source: { nodeId: director.id, portId: "blocking" },
        target: { nodeId: input.video.id, portId: "images" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );

    const context = contextOf(input, spec("upstream", "Film it."));

    expect(context.inputs).toEqual([
      {
        kind: "image",
        role: "firstFrame",
        position: 1,
        name: "Stage",
        description: "frame",
      },
      {
        kind: "image",
        role: "reference",
        position: 2,
        name: "Stage",
        description: "blocking reference",
      },
    ]);
  });
});

function imageScene() {
  const moka = buildGoldenMokaFile();
  const canvas = moka.canvas[0];
  const target = createNode("image", { x: 900, y: 0 });
  const plate = createNode("image", { x: 400, y: 0 });
  const detail = createNode("image", { x: 400, y: 300 });
  const words = createNode("text", { x: 400, y: 600 });
  target.title = "Poster";
  plate.title = "Opening";
  plate.data = { assetId: ids.assetImage };
  detail.title = "Detail";
  detail.data = { assetId: ids.assetImage };
  words.title = "Direction";
  words.data = { content: "The lantern drifts left." };
  canvas.nodes.push(target, plate, detail, words);
  return { moka, canvas, target, plate, detail, words };
}

function imageSpec(
  inputMode: GenerationInputMode,
  prompt: string,
  referenceNodeIds: string[] = [],
): GenerationSpec {
  return {
    ...defaultGenerationSpec("image")!,
    prompt,
    inputMode,
    referenceNodeIds,
    params: { size: "1024x1024" },
  };
}

function imageContextOf(
  input: ReturnType<typeof imageScene>,
  asked: GenerationSpec,
) {
  return canvasImagePromptContext({
    canvas: input.canvas,
    node: input.target,
    spec: asked,
    resources: buildResourceIndex(input.moka),
    inputMode: asked.inputMode,
    prompt: asked.prompt,
  });
}

describe("the material a canvas image rewrite is given", () => {
  it("lists the pictures the wiring sends, in order, and leaves words and masks out", () => {
    const input = imageScene();
    input.canvas.edges.push(
      {
        id: "edge-plate",
        source: { nodeId: input.plate.id, portId: "out" },
        target: { nodeId: input.target.id, portId: "images" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "edge-mask",
        source: { nodeId: input.detail.id, portId: "out" },
        target: { nodeId: input.target.id, portId: "mask" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "edge-words",
        source: { nodeId: input.words.id, portId: "out" },
        target: { nodeId: input.target.id, portId: "prompt" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );

    const context = imageContextOf(input, imageSpec("upstream", "A poster."));

    expect(context.mode).toBe("edit");
    expect(context.references).toEqual([
      { position: 1, name: "Opening", description: "image" },
    ]);
  });

  it("reads the list by hand rather than the wiring", () => {
    const input = imageScene();
    input.canvas.edges.push({
      id: "edge-plate",
      source: { nodeId: input.plate.id, portId: "out" },
      target: { nodeId: input.target.id, portId: "images" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const context = imageContextOf(
      input,
      imageSpec("manual", "A poster.", [input.detail.id]),
    );

    expect(context.references).toEqual([
      { position: 1, name: "Detail", description: "image" },
    ]);
  });

  it("leaves a text card carrying words out of the picture list", () => {
    const input = imageScene();
    // A card with words of its own contributes those words to a manual ask,
    // even when it also holds a picture.
    input.words.data = {
      content: "The lantern drifts left.",
      assetId: ids.assetImage,
    };

    const context = imageContextOf(
      input,
      imageSpec("manual", "A poster.", [input.words.id]),
    );

    expect(context.references).toEqual([]);
    expect(context.mode).toBe("generate");
  });

  it("carries a mentioned picture's token at its travel position", () => {
    const input = imageScene();
    const context = imageContextOf(
      input,
      imageSpec("mentions", `Draw ${`@[node:${input.plate.id}]`} twice.`),
    );

    expect(context.references).toEqual([
      {
        position: 1,
        name: "Opening",
        description: "image",
        token: `@[node:${input.plate.id}]`,
      },
    ]);
  });

  it("renumbers a director's two outputs as the two pictures they are", () => {
    const input = imageScene();
    const director = createNode("director", { x: 0, y: 0 });
    director.title = "Stage";
    director.data = {
      director: {
        sceneId: "scene",
        frameAssetId: ids.assetImage,
        blockingAssetId: ids.assetImage,
      },
    };
    input.canvas.nodes.push(director);
    input.canvas.edges.push(
      {
        id: "edge-frame",
        source: { nodeId: director.id, portId: "frame" },
        target: { nodeId: input.target.id, portId: "images" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "edge-blocking",
        source: { nodeId: director.id, portId: "blocking" },
        target: { nodeId: input.target.id, portId: "images" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );

    const context = imageContextOf(input, imageSpec("upstream", "A poster."));

    expect(context.references.map((reference) => reference.position)).toEqual([
      1, 2,
    ]);
    expect(
      context.references.map((reference) => reference.description),
    ).toEqual(["frame", "blocking reference"]);
  });
});
