// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import { useHistoryStore } from "../stores/historyStore";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { pageTextSelected, useEditorKeyboard } from "./keyboard";

const writeText = vi.fn<(text: string) => Promise<void>>();

/** Puts words on the page and selects them, as a panel read would. */
function selectPageWords(words: string) {
  document.body.innerHTML = `<p id="words">${words}</p>`;
  const range = document.createRange();
  range.selectNodeContents(document.getElementById("words")!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function pressModC(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "c",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka: buildGoldenMokaFile(),
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useEditorStore.getState().setSelection({
    nodeIds: [goldenNodeIds().text],
    edgeIds: [],
  });
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useProjectStore.getState().close();
});

describe("pageTextSelected", () => {
  it("sees words a panel has selected", () => {
    selectPageWords("A lantern floats over a quiet lake");
    expect(pageTextSelected()).toBe(true);
  });

  it("sees nothing where nothing is selected", () => {
    document.body.innerHTML = "<p>A lantern floats over a quiet lake</p>";
    expect(pageTextSelected()).toBe(false);
  });
});

describe("useEditorKeyboard temporary tool", () => {
  function press(key: string, type: "keydown" | "keyup" = "keydown") {
    window.dispatchEvent(
      new KeyboardEvent(type, { key, bubbles: true, cancelable: true }),
    );
  }

  it("borrows the pan tool while Ctrl is held over the select tool", () => {
    renderHook(() => useEditorKeyboard());
    useEditorStore.getState().setTool("select");

    press("Control");
    expect(useEditorStore.getState().temporaryTool).toBe("pan");

    press("Control", "keyup");
    expect(useEditorStore.getState().temporaryTool).toBeNull();
  });

  it("borrows the select tool while Ctrl is held over the pan tool", () => {
    renderHook(() => useEditorKeyboard());
    useEditorStore.getState().setTool("pan");

    press("Control");
    expect(useEditorStore.getState().temporaryTool).toBe("select");

    press("Control", "keyup");
    expect(useEditorStore.getState().temporaryTool).toBeNull();
    useEditorStore.getState().setTool("select");
  });

  it("borrows the pan tool while Space is held, whatever tool is in hand", () => {
    renderHook(() => useEditorKeyboard());
    useEditorStore.getState().setTool("pan");

    press(" ");
    expect(useEditorStore.getState().temporaryTool).toBe("pan");

    press(" ", "keyup");
    expect(useEditorStore.getState().temporaryTool).toBeNull();
    useEditorStore.getState().setTool("select");
  });
});

describe("useEditorKeyboard copy", () => {
  it("leaves selected words to the browser instead of a fragment", async () => {
    renderHook(() => useEditorKeyboard());
    selectPageWords("A lantern floats over a quiet lake");

    const event = pressModC();
    await vi.waitFor(() => expect(writeText).not.toHaveBeenCalled());

    expect(event.defaultPrevented).toBe(false);
  });

  it("copies the selection as a fragment where no words are selected", async () => {
    renderHook(() => useEditorKeyboard());
    document.body.innerHTML = "<p>A lantern floats over a quiet lake</p>";

    const event = pressModC();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(event.defaultPrevented).toBe(true);
    expect(writeText.mock.calls[0][0]).toMatch(/^Node: Brief\n\{/);
  });

  it("leaves selected words alone for a cut, rather than deleting nodes", () => {
    renderHook(() => useEditorKeyboard());
    selectPageWords("A lantern floats over a quiet lake");

    const event = new KeyboardEvent("keydown", {
      key: "x",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(useProjectStore.getState().moka!.canvas[0].nodes).toContainEqual(
      expect.objectContaining({ id: goldenNodeIds().text }),
    );
  });
});
