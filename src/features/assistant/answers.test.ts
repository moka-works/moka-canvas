import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CanvasDocument,
  MokaFile,
  WorkflowNode,
} from "../../shared/domain";
import { MAX_TEXT_CONTENT_LENGTH, findNode } from "../../shared/domain";
import {
  buildConversationMokaFile,
  buildGoldenMokaFile,
  conversationIds,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { undo } from "../editor/commands/execute";
import { useAppStore } from "../editor/stores/appStore";
import { useEditorStore } from "../editor/stores/editorStore";
import { isBoundary, useHistoryStore } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import {
  answerFile,
  copyWords,
  fileAnswer,
  overwriteCard,
  overwriteTarget,
  runsOfAssets,
  showOnCanvas,
} from "./answers";
import { titleFor } from "./conversation";

/**
 * What a line of a conversation is done with, from the answer's side: whether the
 * document came out holding what it was asked to hold, and what a reader was told
 * when it did not.
 */

const BRIEF = "A lantern, drifting. It has been over the lake since dusk.";

/** A card no fixture puts on the board: one taken away since it was asked about. */
const ABSENT = "00000000-0000-7000-8000-0000000000ff";

function open(moka: MokaFile): CanvasDocument {
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka,
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  return moka.canvas[0];
}

function board(): CanvasDocument {
  return useProjectStore.getState().moka!.canvas[0];
}

function find(nodeId: string): WorkflowNode | undefined {
  return findNode(board(), nodeId);
}

const wordsOf = (node: WorkflowNode) =>
  (node.data as { content?: string }).content ?? "";

const undone = () =>
  useHistoryStore.getState().undoStack.filter((item) => !isBoundary(item));

/** The golden document with one more thing written onto its text card. */
function mokaWith(data: Record<string, unknown>): MokaFile {
  const moka = buildGoldenMokaFile();
  const brief = moka.canvas[0].nodes.find(
    (n) => n.id === goldenNodeIds().text,
  )!;
  brief.data = { ...brief.data, ...data };
  return moka;
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    announcement: "",
    selection: { nodeIds: [], edgeIds: [] },
  });
});

afterEach(() => {
  useProjectStore.getState().close();
  vi.unstubAllGlobals();
});

describe("fileAnswer", () => {
  it("puts the words on a text card of their own and chooses it", () => {
    const canvas = open(buildGoldenMokaFile());
    const nodeId = fileAnswer(canvas, BRIEF);
    expect(nodeId).not.toBeNull();

    const laid = find(nodeId!);
    expect(laid?.kind).toBe("text");
    expect(wordsOf(laid!)).toBe(BRIEF);
    expect(laid?.title).toBe(titleFor(BRIEF));
    // The new card rather than the one the question was about.
    expect(useEditorStore.getState().selection.nodeIds).toEqual([nodeId]);
    expect(useEditorStore.getState().announcement).toBe(
      "An answer is on the canvas",
    );
  });

  it("is one thing to undo", () => {
    const canvas = open(buildGoldenMokaFile());
    const before = board().nodes.length;
    const nodeId = fileAnswer(canvas, BRIEF)!;
    expect(undone()).toHaveLength(1);

    expect(undo()).toBe(true);
    expect(board().nodes).toHaveLength(before);
    expect(find(nodeId)).toBeUndefined();
  });

  it("holds the whole answer, up to what a card can carry", () => {
    const canvas = open(buildGoldenMokaFile());
    const long = "y".repeat(MAX_TEXT_CONTENT_LENGTH + 40);
    const nodeId = fileAnswer(canvas, long)!;
    expect(wordsOf(find(nodeId)!)).toBe("y".repeat(MAX_TEXT_CONTENT_LENGTH));
  });

  it("writes nothing for an answer that is not any words", () => {
    const canvas = open(buildGoldenMokaFile());
    const before = board().nodes.length;
    expect(fileAnswer(canvas, "  \n\t ")).toBeNull();
    expect(board().nodes).toHaveLength(before);
    expect(undone()).toHaveLength(0);
  });

  it("leaves a refusal to the toast the document layer already sent", () => {
    const canvas = open(buildGoldenMokaFile());
    const before = canvas.nodes.length;
    // The refusal a reader meets most: the document on screen has fallen behind
    // the one on disk, and nothing may be written over it.
    useProjectStore.setState({ saveStatus: "conflicted" });

    expect(fileAnswer(canvas, BRIEF)).toBeNull();
    expect(board().nodes).toHaveLength(before);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([]);
    expect(useAppStore.getState().toasts.map((toast) => toast.message)).toEqual(
      ["Resolve the save conflict before making more changes"],
    );
  });
});

describe("overwriteTarget", () => {
  it("offers the one text card that was chosen", () => {
    const canvas = open(buildGoldenMokaFile());
    const ids = goldenNodeIds();
    expect(overwriteTarget(canvas, [ids.text])).toBe(ids.text);
  });

  it("offers nothing else, since an answer was not asked to replace it", () => {
    const canvas = open(buildGoldenMokaFile());
    const ids = goldenNodeIds();
    // A picture's one thing is the picture.
    expect(overwriteTarget(canvas, [ids.image])).toBeNull();
    // Two cards and the answer would have to be split, or guessed at.
    expect(overwriteTarget(canvas, [ids.text, ids.image])).toBeNull();
    expect(overwriteTarget(canvas, [])).toBeNull();
    // A card taken off the board since the question was asked.
    expect(overwriteTarget(canvas, [ABSENT])).toBeNull();
  });
});

describe("overwriteCard", () => {
  it("writes over the words and leaves the rest of the card as it was", () => {
    open(mokaWith({ style: "storyboard" }));
    const ids = goldenNodeIds();
    overwriteCard(ids.text, BRIEF);

    const after = find(ids.text)!;
    expect(wordsOf(after)).toBe(BRIEF);
    expect(after.data).toMatchObject({ style: "storyboard" });
    expect(undone()).toHaveLength(1);
  });

  it("takes back what it wrote as one thing", () => {
    open(buildGoldenMokaFile());
    const ids = goldenNodeIds();
    const held = wordsOf(find(ids.text)!);
    overwriteCard(ids.text, BRIEF);
    expect(wordsOf(find(ids.text)!)).toBe(BRIEF);
    expect(undo()).toBe(true);
    expect(wordsOf(find(ids.text)!)).toBe(held);
  });
});

describe("showOnCanvas", () => {
  it("chooses the card the answer put on the board", () => {
    const canvas = open(buildGoldenMokaFile());
    showOnCanvas(canvas, goldenNodeIds().image);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([
      goldenNodeIds().image,
    ]);
    expect(useEditorStore.getState().announcement).toBe("");
  });

  it("says the card is gone, rather than moving nowhere at all", () => {
    const canvas = open(buildGoldenMokaFile());
    const ids = goldenNodeIds();
    useEditorStore.getState().selectOnly(ids.text);
    showOnCanvas(canvas, ABSENT);
    // Gone means gone: the card that was chosen still is, and the words say so.
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.text]);
    expect(useEditorStore.getState().announcement).toBe(
      "That card is not on this canvas any more",
    );
  });
});

describe("runsOfAssets", () => {
  it("groups what a run filed under the run that filed it", () => {
    const moka = buildConversationMokaFile();
    const filed = runsOfAssets(moka);
    expect([...filed.keys()]).toEqual([conversationIds().run]);
    expect(filed.get(conversationIds().run)?.map((entry) => entry.id)).toEqual([
      goldenNodeIds().assetImage,
    ]);
  });

  it("holds nothing for a document no run has filed into", () => {
    expect(runsOfAssets(buildGoldenMokaFile()).size).toBe(0);
  });
});

describe("copyWords", () => {
  function clipboard(writeText: () => Promise<void>) {
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  }

  it("carries the answer off and says that it did", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    clipboard(writeText);
    await copyWords(BRIEF);
    expect(writeText).toHaveBeenCalledWith(BRIEF);
    expect(useEditorStore.getState().announcement).toBe("Copied");
  });

  it("says so when the clipboard refuses, rather than implying it was copied", async () => {
    clipboard(() => Promise.reject(new Error("denied")));
    await copyWords(BRIEF);
    expect(useEditorStore.getState().announcement).toBe(
      "The clipboard would not take it",
    );
  });
});

describe("answerFile", () => {
  it("names the file after the answer, on one line", () => {
    const { name } = answerFile("A lantern over the lake.\nIt is  dusk.");
    expect(name).toBe("A lantern over the lake. It is dusk..txt");
  });

  it("leaves nothing in the name that would point elsewhere", () => {
    const { name } = answerFile('out/door: "the lake"? <now>');
    expect(name).toBe("outdoor the lake now.txt");
  });

  it("holds the whole answer, in a form a browser will open", () => {
    const words = "A & b = c\n换行\n🙂";
    const { href } = answerFile(words);
    expect(href.startsWith("data:text/plain;charset=utf-8,")).toBe(true);
    expect(
      decodeURIComponent(href.slice("data:text/plain;charset=utf-8,".length)),
    ).toBe(words);
  });
});
