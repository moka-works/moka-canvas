import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "bson";
import {
  CANVAS_SCHEMA_VERSION,
  MOKA_MAGIC,
  REFERENCE_IMAGES_MAX,
} from "./constants";
import {
  buildConversationMokaFile,
  buildCutMokaFile,
  buildGenerationMokaFile,
  buildGoldenMokaFile,
  buildShelfMokaFile,
  buildStoryMokaFile,
  buildTreeMokaFile,
} from "./fixtures";
import { decodeMokaFile, encodeMokaFile, MokaCodecError } from "./codec";
import { derivePorts } from "./factories";
import type { MediaNodeData, MokaFile } from "./types";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);
const GOLDEN_JSON = join(FIXTURE_DIR, "minimal.moka.json");
const GOLDEN_BINARY = join(FIXTURE_DIR, "minimal.canvas.moka");
const CONVERSATION_JSON = join(FIXTURE_DIR, "conversation.moka.json");
const CONVERSATION_BINARY = join(FIXTURE_DIR, "conversation.canvas.moka");
const SHELF_JSON = join(FIXTURE_DIR, "shelf.moka.json");
const SHELF_BINARY = join(FIXTURE_DIR, "shelf.canvas.moka");
const TREE_JSON = join(FIXTURE_DIR, "tree.moka.json");
const TREE_BINARY = join(FIXTURE_DIR, "tree.canvas.moka");
const CUT_JSON = join(FIXTURE_DIR, "cut.moka.json");
const CUT_BINARY = join(FIXTURE_DIR, "cut.canvas.moka");

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

describe("moka codec", () => {
  it("round-trips the golden fixture semantically", () => {
    const golden = buildGoldenMokaFile();
    const encoded = encodeMokaFile(golden);
    const decoded = decodeMokaFile(encoded);
    expect(normalize(decoded)).toEqual(normalize(golden));
  });

  it("carries what a telling was assembled from, and reads one that never said", () => {
    // A document written before the digest existed carries none, and is read
    // as the telling it is rather than refused.
    const old = buildStoryMokaFile();
    expect(old.stories![0]!.edit.assembledDigest).toBeUndefined();
    const read = decodeMokaFile(encodeMokaFile(old));
    expect(read.stories![0]!.edit.assembledDigest).toBeUndefined();

    const withDigest = buildStoryMokaFile();
    const story = withDigest.stories![0]!;
    story.edit = { ...story.edit, assembledDigest: "0f3a91cd" };
    const back = decodeMokaFile(encodeMokaFile(withDigest));
    expect(back.stories![0]!.edit.assembledDigest).toBe("0f3a91cd");
  });

  it("is byte-canonical on re-save", () => {
    const golden = buildGoldenMokaFile();
    const first = encodeMokaFile(golden);
    const second = encodeMokaFile(decodeMokaFile(first));
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it("matches the shared golden fixtures", () => {
    const golden = buildGoldenMokaFile();
    const encoded = encodeMokaFile(golden);
    const json = `${JSON.stringify(golden, null, 2)}\n`;

    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(GOLDEN_BINARY)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(GOLDEN_BINARY, encoded);
      writeFileSync(GOLDEN_JSON, json);
    }

    expect(
      Buffer.from(readFileSync(GOLDEN_BINARY)).equals(Buffer.from(encoded)),
    ).toBe(true);
    expect(readFileSync(GOLDEN_JSON, "utf8")).toBe(json);
  });

  it("decodes the shared golden binary to the same model", () => {
    const decoded = decodeMokaFile(new Uint8Array(readFileSync(GOLDEN_BINARY)));
    expect(normalize(decoded)).toEqual(normalize(buildGoldenMokaFile()));
  });

  it("rejects a bad magic prefix", () => {
    const encoded = encodeMokaFile(buildGoldenMokaFile());
    encoded[0] = 0x00;
    expect(() => decodeMokaFile(encoded)).toThrowError(MokaCodecError);
    try {
      decodeMokaFile(encoded);
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("MOKA_MAGIC_INVALID");
    }
  });

  it("rejects truncated BSON", () => {
    const encoded = encodeMokaFile(buildGoldenMokaFile());
    const truncated = encoded.slice(0, encoded.length - 8);
    try {
      decodeMokaFile(truncated);
      expect.unreachable();
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("MOKA_BSON_INVALID");
    }
  });

  it("rejects an unknown version", () => {
    const golden = buildGoldenMokaFile();
    const tampered = { ...golden, version: "v9" as never };
    const encoded = encodeMokaFile(tampered);
    try {
      decodeMokaFile(encoded);
      expect.unreachable();
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("MOKA_VERSION_UNSUPPORTED");
    }
  });

  it("refuses a canvas schema that is not the one this build reads", () => {
    for (const version of [
      CANVAS_SCHEMA_VERSION - 1,
      CANVAS_SCHEMA_VERSION + 1,
    ]) {
      const golden = buildGoldenMokaFile();
      golden.canvas[0].schemaVersion = version;
      try {
        decodeMokaFile(encodeMokaFile(golden));
        expect.unreachable();
      } catch (error) {
        expect((error as MokaCodecError).code).toBe("MOKA_VERSION_UNSUPPORTED");
      }
    }
  });

  it("round-trips generation specs", () => {
    const golden = buildGenerationMokaFile();
    const decoded = decodeMokaFile(encodeMokaFile(golden));
    expect(normalize(decoded)).toEqual(normalize(golden));
  });

  it("keeps an act filmed in pieces whole, and writes every take as the same list", () => {
    const story = buildStoryMokaFile();
    const clip = story.stories![0].chapters[0].acts[0].video.takes[0];
    const one = clip.assetIds[0];
    clip.assetIds = ["asset-piece-1", "asset-piece-2"];
    const pieces = decodeMokaFile(encodeMokaFile(story));
    expect(
      pieces.stories![0].chapters[0].acts[0].video.takes[0].assetIds,
    ).toEqual(["asset-piece-1", "asset-piece-2"]);

    // One file and several are the one shape: the list is what a take is, on
    // the wire and in the file, so neither half has to guess what the other
    // meant. A lone assetId an older document carries is still read.
    const single = buildStoryMokaFile();
    expect(Buffer.from(encodeMokaFile(single)).includes("assetIds")).toBe(true);
    expect(
      decodeMokaFile(encodeMokaFile(single)).stories![0].chapters[0].acts[0]
        .video.takes[0].assetIds,
    ).toEqual([one]);
  });

  it("reads a frame's shoot role, and reads the plain use as no word at all", () => {
    const story = buildStoryMokaFile();
    story.stories![0].chapters[0].acts[0].keyframes[0].filmRole =
      "firstLastFrame";
    const read = decodeMokaFile(encodeMokaFile(story));
    expect(read.stories![0].chapters[0].acts[0].keyframes[0].filmRole).toBe(
      "firstLastFrame",
    );
    // The frame beside it was never given a role: the plain use is the
    // absence, and a board that has never heard of roles keeps the shape it
    // came in with.
    expect(
      "filmRole" in read.stories![0].chapters[0].acts[0].keyframes[1],
    ).toBe(false);

    // A word this build does not read falls back to the plain use, the way
    // every other word of a board does.
    const raw = deserialize(
      Buffer.from(encodeMokaFile(buildStoryMokaFile())).subarray(4),
    ) as Record<string, unknown>;
    const storyDoc = (raw.stories as Record<string, unknown>[])[0];
    const chapters = storyDoc.chapters as Record<string, unknown>[];
    const acts = chapters[0].acts as Record<string, unknown>[];
    const frames = acts[0].keyframes as Record<string, unknown>[];
    frames[0].filmRole = "solo";
    const bson = serialize(raw);
    const bytes = new Uint8Array(4 + bson.length);
    bytes.set(MOKA_MAGIC, 0);
    bytes.set(bson, 4);
    expect(
      decodeMokaFile(bytes).stories![0].chapters[0].acts[0].keyframes[0]
        .filmRole,
    ).toBe("reference");
  });

  it("reads a story's reference limit whole, and one beyond the bound as the bound", () => {
    const story = buildStoryMokaFile();
    story.stories![0].maxReferenceImages = 7;
    expect(
      decodeMokaFile(encodeMokaFile(story)).stories![0].maxReferenceImages,
    ).toBe(7);

    // A number no command would accept is read as the nearest bound rather
    // than refusing the whole story.
    const beyond = buildStoryMokaFile();
    beyond.stories![0].maxReferenceImages = 99;
    expect(
      decodeMokaFile(encodeMokaFile(beyond)).stories![0].maxReferenceImages,
    ).toBe(REFERENCE_IMAGES_MAX);
  });

  it("gives a line of a telling written before lines had names one as it is read", () => {
    const moka = buildStoryMokaFile();
    const raw = deserialize(
      Buffer.from(encodeMokaFile(moka)).subarray(4),
    ) as Record<string, unknown>;
    const storyDoc = (raw.stories as Record<string, unknown>[])[0];
    const chapters = storyDoc.chapters as Record<string, unknown>[];
    const acts = chapters[0].acts as Record<string, unknown>[];
    const frames = acts[0].keyframes as Record<string, unknown>[];
    const dialogue = frames[0].dialogue as Record<string, unknown>[];
    for (const line of dialogue) delete line.id;
    const bson = serialize(raw);
    const bytes = new Uint8Array(4 + bson.length);
    bytes.set(MOKA_MAGIC, 0);
    bytes.set(bson, 4);

    const read = decodeMokaFile(bytes);
    const lines = read.stories![0].chapters[0].acts[0].keyframes[0].dialogue;
    expect(lines[0]?.id).toBeTruthy();
    // The name is written out with the document, so the read after it — and
    // every ask made against it — knows the same line by the same name.
    const again = decodeMokaFile(encodeMokaFile(read));
    expect(
      again.stories![0].chapters[0].acts[0].keyframes[0].dialogue[0]?.id,
    ).toBe(lines[0]?.id);
  });

  it("round-trips the voice of the cast and of the narrator", () => {
    const moka = buildStoryMokaFile();
    moka.stories![0].elements[0].voice = {
      model: "voice-model",
      voice: "longxiaochun",
      rate: 1.2,
      instructions: "低沉、慢",
      referenceAssetId: "asset-hero-voice",
    };
    moka.stories![0].narrator = { model: "", voice: "旁白的音色", pitch: 0.9 };

    const read = decodeMokaFile(encodeMokaFile(moka));
    expect(read.stories![0].elements[0].voice).toEqual({
      model: "voice-model",
      voice: "longxiaochun",
      rate: 1.2,
      instructions: "低沉、慢",
      referenceAssetId: "asset-hero-voice",
    });
    expect(read.stories![0].narrator).toEqual({
      model: "",
      voice: "旁白的音色",
      pitch: 0.9,
    });
    // A voice that names no recording carries none, and none is written for
    // it: the second way of saying a voice is left off rather than emptied.
    expect("referenceAssetId" in read.stories![0].narrator!).toBe(false);
    // The other characters never said anything about a voice, and none is
    // written for them: a voice holding nothing is not a voice.
    expect("voice" in read.stories![0].elements[1]).toBe(false);
  });

  it("reads a telling stored before voices existed as having none", () => {
    const moka = buildStoryMokaFile();
    const raw = deserialize(
      Buffer.from(encodeMokaFile(moka)).subarray(4),
    ) as Record<string, unknown>;
    const story = (raw.stories as Record<string, unknown>[])[0];
    delete story.narrator;
    for (const element of story.elements as Record<string, unknown>[]) {
      delete element.voice;
    }
    const bson = serialize(raw);
    const bytes = new Uint8Array(4 + bson.length);
    bytes.set(MOKA_MAGIC, 0);
    bytes.set(bson, 4);

    const read = decodeMokaFile(bytes);
    expect(read.stories![0].narrator).toBeUndefined();
    expect(read.stories![0].elements[0].voice).toBeUndefined();
    // And nothing is written about a voice that was never given one.
    const again = deserialize(
      Buffer.from(encodeMokaFile(read)).subarray(4),
    ) as Record<string, unknown>;
    const rewritten = (again.stories as Record<string, unknown>[])[0];
    expect("narrator" in rewritten).toBe(false);
    for (const element of rewritten.elements as Record<string, unknown>[]) {
      expect("voice" in element).toBe(false);
    }
  });

  it("reads the steps a document settled one place at a time as settled steps", () => {
    // A story written before the room confirmed whole steps said the same
    // thing a piece at a time: this is that document, put back on the wire.
    const moka = buildStoryMokaFile();
    const raw = deserialize(
      Buffer.from(encodeMokaFile(moka)).subarray(4),
    ) as Record<string, unknown>;
    const story = (raw.stories as Record<string, unknown>[])[0];
    delete story.confirmedSteps;
    for (const chapter of story.chapters as Record<string, unknown>[]) {
      chapter.synopsisConfirmed = true;
      for (const act of chapter.acts as Record<string, unknown>[]) {
        (act.video as Record<string, unknown>).confirmed = true;
        act.videoConfirmed = true;
        for (const frame of act.keyframes as Record<string, unknown>[]) {
          (frame.art as Record<string, unknown>).confirmed = true;
          (frame.video as Record<string, unknown>).confirmed = true;
        }
      }
    }
    for (const element of story.elements as Record<string, unknown>[]) {
      element.descriptionConfirmed = true;
      (element.main as Record<string, unknown>).confirmed = true;
      const turnaround = element.turnaround as
        Record<string, unknown> | undefined;
      if (turnaround !== undefined) turnaround.confirmed = true;
    }
    const bson = serialize(raw);
    const bytes = new Uint8Array(4 + bson.length);
    bytes.set(MOKA_MAGIC, 0);
    bytes.set(bson, 4);

    const read = decodeMokaFile(bytes);
    expect(read.stories![0].confirmedSteps).toEqual([
      "idea",
      "outline",
      "elements",
      "storyboard",
    ]);
    // And the answers themselves are not carried on: what a step keeps is
    // whether it was settled, not how many pieces it was settled in.
    expect("confirmed" in read.stories![0].elements[0].main).toBe(false);
    expect("synopsisConfirmed" in read.stories![0].chapters[0]).toBe(false);
  });

  it("reads a story's steps as settled only when it says so", () => {
    const moka = buildStoryMokaFile();
    moka.stories![0].confirmedSteps = [];
    expect(
      decodeMokaFile(encodeMokaFile(moka)).stories![0].confirmedSteps,
    ).toEqual([]);
  });

  /**
   * A media kind has no whitelist entry of its own for the child nodes holding
   * results past the first, so this is what keeps the encoder's shared tail
   * from losing them.
   */
  it("round-trips the extra results a generation leaves on child nodes", () => {
    const golden = buildGenerationMokaFile();
    const canvas = golden.canvas[0];
    const asked = canvas.nodes[1];
    const childId = "00000000-0000-7000-8000-0000000000f1";
    const firstAsset = "00000000-0000-7000-8000-0000000000e1";
    const secondAsset = "00000000-0000-7000-8000-0000000000e2";

    const askedData = asked.data as MediaNodeData;
    askedData.assetId = firstAsset;
    askedData.resultSlots = [
      {
        id: "slot-first",
        status: "succeeded",
        assetId: firstAsset,
        isPrimary: true,
      },
      {
        id: "slot-second",
        status: "succeeded",
        assetId: secondAsset,
        isPrimary: false,
      },
    ];
    askedData.resultNodeIds = [childId];

    canvas.nodes.push({
      id: childId,
      kind: "image",
      title: "Poster (2)",
      bounds: { x: 320, y: 240, width: 280, height: 220 },
      zIndex: 2,
      ports: derivePorts("image"),
      data: { assetId: secondAsset },
      createdAt: asked.createdAt,
      updatedAt: asked.updatedAt,
    });

    const decoded = decodeMokaFile(encodeMokaFile(golden));
    const decodedAsked = decoded.canvas[0].nodes[1].data as MediaNodeData;
    expect(decodedAsked.resultNodeIds).toEqual([childId]);
    expect(decodedAsked.resultSlots?.map((slot) => slot.assetId)).toEqual([
      firstAsset,
      secondAsset,
    ]);
    expect(decoded.canvas[0].nodes[2].id).toBe(childId);
    expect(normalize(decoded)).toEqual(normalize(golden));
  });

  it("rejects a resource path that escapes the project root", () => {
    const golden = buildGoldenMokaFile();
    golden.resources.images[0].path = "../outside.png";
    const encoded = encodeMokaFile(golden);
    try {
      decodeMokaFile(encoded);
      expect.unreachable();
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("PATH_ESCAPE");
    }
  });

  it("enforces the encoded size cap", () => {
    const golden = buildGoldenMokaFile();
    expect(() => encodeMokaFile(golden, 16)).toThrowError(MokaCodecError);
    try {
      encodeMokaFile(golden, 16);
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("MOKA_TOO_LARGE");
    }
  });

  it("round-trips the conversations a canvas carries", () => {
    const carried = buildConversationMokaFile();
    const decoded = decodeMokaFile(encodeMokaFile(carried));
    expect(normalize(decoded)).toEqual(normalize(carried));
  });

  /**
   * The shared pair the other language reads: it decodes the binary to this
   * model and writes the binary back byte for byte, so what a conversation
   * looks like on the disk is one contract rather than two opinions about it.
   */
  it("matches the shared conversation fixtures", () => {
    const carried = buildConversationMokaFile();
    const encoded = encodeMokaFile(carried);
    const json = `${JSON.stringify(carried, null, 2)}\n`;

    if (
      process.env.UPDATE_FIXTURES === "1" ||
      !existsSync(CONVERSATION_BINARY)
    ) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(CONVERSATION_BINARY, encoded);
      writeFileSync(CONVERSATION_JSON, json);
    }

    expect(
      Buffer.from(readFileSync(CONVERSATION_BINARY)).equals(
        Buffer.from(encoded),
      ),
    ).toBe(true);
    expect(readFileSync(CONVERSATION_JSON, "utf8")).toBe(json);
  });

  /**
   * The field came in without a schema version of its own, so a document stored
   * before it existed has to read as carrying no conversations and write back
   * unchanged — otherwise opening an old project would quietly rewrite it.
   */
  it("reads a document stored before conversations existed as carrying none", () => {
    const stored = new Uint8Array(readFileSync(GOLDEN_BINARY));
    const decoded = decodeMokaFile(stored);
    expect(decoded.canvas.map((canvas) => canvas.sessions)).toEqual([
      undefined,
      undefined,
    ]);
    expect(
      Buffer.from(encodeMokaFile(decoded)).equals(Buffer.from(stored)),
    ).toBe(true);
  });

  it("round-trips what the shelf says about an asset", () => {
    const shelf = buildShelfMokaFile();
    const decoded = decodeMokaFile(encodeMokaFile(shelf));
    expect(normalize(decoded)).toEqual(normalize(shelf));
  });

  /**
   * The shared pair the other language reads: it decodes the binary to this
   * model and writes the binary back byte for byte, so what the shelf looks
   * like on the disk is one contract rather than two opinions about it.
   */
  it("matches the shared shelf fixtures", () => {
    const shelf = buildShelfMokaFile();
    const encoded = encodeMokaFile(shelf);
    const json = `${JSON.stringify(shelf, null, 2)}\n`;

    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(SHELF_BINARY)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(SHELF_BINARY, encoded);
      writeFileSync(SHELF_JSON, json);
    }

    expect(
      Buffer.from(readFileSync(SHELF_BINARY)).equals(Buffer.from(encoded)),
    ).toBe(true);
    expect(readFileSync(SHELF_JSON, "utf8")).toBe(json);
  });

  it("round-trips the canvas tree", () => {
    const tree = buildTreeMokaFile();
    const decoded = decodeMokaFile(encodeMokaFile(tree));
    expect(normalize(decoded)).toEqual(normalize(tree));
  });

  /**
   * The shared pair the other language reads: it decodes the binary to this
   * model and writes the binary back byte for byte, so where a board sits in
   * the tree is one contract rather than two opinions about it.
   */
  it("matches the shared tree fixtures", () => {
    const tree = buildTreeMokaFile();
    const encoded = encodeMokaFile(tree);
    const json = `${JSON.stringify(tree, null, 2)}\n`;

    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(TREE_BINARY)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(TREE_BINARY, encoded);
      writeFileSync(TREE_JSON, json);
    }

    expect(
      Buffer.from(readFileSync(TREE_BINARY)).equals(Buffer.from(encoded)),
    ).toBe(true);
    expect(readFileSync(TREE_JSON, "utf8")).toBe(json);
  });

  it("reads an asset stored before the shelf existed as saying nothing", () => {
    const stored = new Uint8Array(readFileSync(GOLDEN_BINARY));
    const decoded = decodeMokaFile(stored);
    const said = decoded.resources.images[0];
    expect([
      said.tags,
      said.note,
      said.favorite,
      said.origin,
      said.keyword,
    ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(
      Buffer.from(encodeMokaFile(decoded)).equals(Buffer.from(stored)),
    ).toBe(true);
  });

  /**
   * A word the shelf does not know is written back as it was read rather than
   * dropped: validation is the one that says it is wrong, and quietly rewriting
   * a document to agree with a newer vocabulary would lose what it had in it.
   */
  it("carries an origin outside the vocabulary through unchanged", () => {
    const shelf = buildShelfMokaFile();
    const entry: { origin?: string } = shelf.resources.images[0];
    entry.origin = "inherited";
    const decoded = decodeMokaFile(encodeMokaFile(shelf));
    expect(decoded.resources.images[0].origin).toBe("inherited");
  });

  it("round-trips the cut timeline semantically", () => {
    const cut = buildCutMokaFile();
    const decoded = decodeMokaFile(encodeMokaFile(cut));
    expect(normalize(decoded)).toEqual(normalize(cut));
    const style = decoded.timelines![0].clips[3].text!.style;
    expect([style.strokeWidth, style.strokeColor, style.background]).toEqual([
      4,
      "#101010",
      null,
    ]);
  });

  it("keeps the cut timeline byte-canonical on re-save", () => {
    const cut = buildCutMokaFile();
    const first = encodeMokaFile(cut);
    const second = encodeMokaFile(decodeMokaFile(first));
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  /**
   * The shared pair the other language reads: it decodes the binary to this
   * model and writes the binary back byte for byte, so what a cut timeline
   * looks like on the disk is one contract rather than two opinions about it.
   */
  it("matches the shared cut fixtures", () => {
    const cut = buildCutMokaFile();
    const encoded = encodeMokaFile(cut);
    const json = `${JSON.stringify(cut, null, 2)}\n`;

    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(CUT_BINARY)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(CUT_BINARY, encoded);
      writeFileSync(CUT_JSON, json);
    }

    expect(
      Buffer.from(readFileSync(CUT_BINARY)).equals(Buffer.from(encoded)),
    ).toBe(true);
    expect(readFileSync(CUT_JSON, "utf8")).toBe(json);
  });

  /**
   * The other language refuses an enum word it does not know when it
   * deserializes, so the reader here has to refuse the same bytes: a word
   * two builds read differently must not pass through either of them.
   */
  it("refuses an enum word this build does not read", () => {
    const breakages: ((cut: MokaFile) => void)[] = [
      (cut) => {
        cut.timelines![0].tracks[0].kind = "subtitle" as never;
      },
      (cut) => {
        cut.timelines![0].clips[0].kind = "sticker" as never;
      },
      (cut) => {
        cut.timelines![0].clips[3].text!.style.align = "justify" as never;
      },
      (cut) => {
        cut.timelines![0].clips[3].text!.style.position = "middle" as never;
      },
    ];
    for (const breakIt of breakages) {
      const cut = buildCutMokaFile();
      breakIt(cut);
      try {
        decodeMokaFile(encodeMokaFile(cut));
        expect.unreachable();
      } catch (error) {
        expect((error as MokaCodecError).code).toBe("MOKA_BSON_INVALID");
      }
    }
  });
});
