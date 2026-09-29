// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { buildGoldenMokaFile } from "../../../shared/domain/fixtures";
import type { MokaFile } from "../../../shared/domain";
import { useOpenCanvases } from "./openCanvases";
import { useProjectStore } from "./projectStore";

/** The golden document, which holds two boards, under a name of its own. */
function project(id: string): MokaFile {
  const moka = buildGoldenMokaFile();
  return { ...moka, metadata: { ...moka.metadata, id } };
}

function ids(): string[] {
  return useOpenCanvases.getState().ids;
}

function store() {
  return useOpenCanvases.getState();
}

beforeEach(() => {
  localStorage.clear();
  store().forget();
});

describe("which boards are open", () => {
  it("opens a project onto its first board when nothing is remembered", () => {
    const moka = project("p1");
    expect(store().adopt(moka)).toBe(moka.canvas[0].id);
    expect(ids()).toEqual([moka.canvas[0].id]);
  });

  it("opens a project back onto the board it was left on", () => {
    const moka = project("p1");
    store().adopt(moka);
    store().open(moka.canvas[1].id);
    expect(ids()).toEqual([moka.canvas[0].id, moka.canvas[1].id]);

    store().forget();
    expect(store().adopt(moka)).toBe(moka.canvas[1].id);
  });

  it("keeps one project's boards out of another's", () => {
    const first = project("p1");
    const second = project("p2");
    store().adopt(first);
    store().open(first.canvas[1].id);
    expect(store().adopt(second)).toBe(second.canvas[0].id);
    expect(ids()).toEqual([second.canvas[0].id]);
  });

  it("keeps the board being looked at when the document is read again", () => {
    const moka = project("p1");
    store().adopt(moka);
    // A board opened and then left again: the list still holds both, and the
    // one being looked at is the one first opened.
    store().open(moka.canvas[1].id);
    useProjectStore.getState().hydrate({
      moka,
      root: "/tmp/p1",
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
    useProjectStore.getState().switchCanvas(moka.canvas[0].id);

    // A run files what it made by rewriting the document, which reads it again.
    // That is not a reopening, so the reader is not moved to another board.
    useProjectStore.getState().hydrate({
      moka,
      root: "/tmp/p1",
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
    expect(useProjectStore.getState().activeCanvasId).toBe(moka.canvas[0].id);
  });

  it("drops a remembered board the document no longer has", () => {
    const moka = project("p1");
    store().adopt(moka);
    store().open(moka.canvas[1].id);
    const gone = moka.canvas[1].id;
    const without = {
      ...moka,
      canvas: moka.canvas.filter((canvas) => canvas.id !== gone),
    };
    store().forget();
    expect(store().adopt(without)).toBe(moka.canvas[0].id);
    expect(ids()).toEqual([moka.canvas[0].id]);
  });

  it("looks at the board beside the one put down", () => {
    const moka = project("p1");
    store().adopt(moka);
    store().open(moka.canvas[1].id);
    const [first, second] = moka.canvas;
    expect(store().close(second.id, second.id)).toBe(first.id);
    expect(ids()).toEqual([first.id]);
  });

  it("puts a background board down without moving the view", () => {
    const moka = project("p1");
    store().adopt(moka);
    store().open(moka.canvas[1].id);
    expect(store().close(moka.canvas[1].id, moka.canvas[0].id)).toBeNull();
    expect(ids()).toEqual([moka.canvas[0].id]);
  });

  it("keeps the last tab up rather than showing nothing", () => {
    const moka = project("p1");
    store().adopt(moka);
    expect(store().close(moka.canvas[0].id, moka.canvas[0].id)).toBeNull();
    expect(ids()).toEqual([moka.canvas[0].id]);
  });

  it("looks at a neighbour when the board on screen is deleted", () => {
    const moka = project("p1");
    store().adopt(moka);
    store().open(moka.canvas[1].id);
    const left = [moka.canvas[0].id];
    expect(store().prune(left, moka.canvas[1].id)).toBe(moka.canvas[0].id);
    expect(ids()).toEqual(left);
  });

  it("leaves the strip alone when a board not on it is deleted", () => {
    const moka = project("p1");
    store().adopt(moka);
    store().open(moka.canvas[1].id);
    expect(
      store().prune(
        [moka.canvas[0].id, moka.canvas[1].id, "other"],
        moka.canvas[1].id,
      ),
    ).toBeNull();
    expect(ids()).toEqual([moka.canvas[0].id, moka.canvas[1].id]);
  });

  it("drops the tab of a board the document has lost", () => {
    const moka = project("p1");
    store().adopt(moka);
    store().open(moka.canvas[1].id);
    expect(store().prune([moka.canvas[0].id], moka.canvas[0].id)).toBeNull();
    expect(ids()).toEqual([moka.canvas[0].id]);
  });

  it("puts a tab back up when the last one is deleted", () => {
    const moka = project("p1");
    store().adopt(moka);
    expect(store().prune([moka.canvas[1].id], moka.canvas[0].id)).toBe(
      moka.canvas[1].id,
    );
    expect(ids()).toEqual([moka.canvas[1].id]);
  });
});
