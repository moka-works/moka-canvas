// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createTimeline } from "../../../shared/domain";
import type { MokaFile } from "../../../shared/domain";
import { buildGoldenMokaFile } from "../../../shared/domain/fixtures";
import { currentUiPrefs, resetUiPrefs } from "../../../shared/prefs/prefsData";
import { useOpenTimelines } from "./openTimelines";

/** A project of its own name holding the given number of timelines. */
function project(id: string, timelines: number): MokaFile {
  const moka = buildGoldenMokaFile();
  return {
    ...moka,
    metadata: { ...moka.metadata, id },
    timelines: Array.from({ length: timelines }, (_, index) =>
      createTimeline(`Timeline ${index + 1}`),
    ),
  };
}

function ids(): string[] {
  return useOpenTimelines.getState().ids;
}

function store() {
  return useOpenTimelines.getState();
}

beforeEach(() => {
  resetUiPrefs();
  store().forget();
});

describe("which cuts are open", () => {
  it("shows every cut on a project this machine has never opened", () => {
    const moka = project("p1", 3);
    expect(store().adopt(moka)).toEqual(moka.timelines!.map((t) => t.id));
    expect(ids()).toEqual(moka.timelines!.map((t) => t.id));
  });

  it("comes back to the tabs the project was left with", () => {
    const moka = project("p1", 2);
    store().adopt(moka);
    expect(store().close(moka.timelines![1].id)).toBe(true);
    store().forget();
    expect(store().adopt(moka)).toEqual([moka.timelines![0].id]);
  });

  it("drops a remembered cut the document no longer has", () => {
    const moka = project("p1", 2);
    store().adopt(moka);
    const gone = moka.timelines![1].id;
    const without = {
      ...moka,
      timelines: moka.timelines!.filter((timeline) => timeline.id !== gone),
    };
    store().forget();
    expect(store().adopt(without)).toEqual([moka.timelines![0].id]);
  });

  it("puts a cut up when it is opened", () => {
    const moka = project("p1", 2);
    store().adopt(moka);
    store().close(moka.timelines![1].id);
    store().open(moka.timelines![1].id);
    expect(ids()).toEqual([moka.timelines![0].id, moka.timelines![1].id]);
  });

  it("puts nothing up before a project has been adopted", () => {
    store().open("timeline-elsewhere");
    expect(ids()).toEqual([]);
    expect(currentUiPrefs().clipOpenTimelines).toEqual({});
  });

  it("keeps the last tab up rather than showing nothing", () => {
    const moka = project("p1", 2);
    store().adopt(moka);
    store().close(moka.timelines![1].id);
    expect(store().close(moka.timelines![0].id)).toBe(false);
    expect(ids()).toEqual([moka.timelines![0].id]);
  });

  it("shuts a row the document has lost, and says what to look at instead", () => {
    const moka = project("p1", 3);
    store().adopt(moka);
    store().close(moka.timelines![1].id);
    const left = [moka.timelines![0].id, moka.timelines![1].id];
    expect(store().prune(left, moka.timelines![2].id)).toBe(left[0]);
    expect(ids()).toEqual([left[0]]);
  });

  it("leaves the strip alone when a closed cut is deleted", () => {
    const moka = project("p1", 2);
    store().adopt(moka);
    store().close(moka.timelines![1].id);
    expect(store().prune([moka.timelines![0].id], moka.timelines![0].id)).toBe(
      null,
    );
    expect(ids()).toEqual([moka.timelines![0].id]);
  });

  it("puts a tab up when every cut was deleted and one comes back", () => {
    const moka = project("p1", 1);
    store().adopt(moka);
    expect(store().prune([], moka.timelines![0].id)).toBeNull();
    expect(ids()).toEqual([]);
    expect(store().prune([moka.timelines![0].id], null)).toBe(
      moka.timelines![0].id,
    );
    expect(ids()).toEqual([moka.timelines![0].id]);
  });

  it("keeps one project's cuts out of another's", () => {
    const first = project("p1", 2);
    const second = project("p2", 2);
    store().adopt(first);
    store().close(first.timelines![1].id);
    expect(store().adopt(second)).toEqual(second.timelines!.map((t) => t.id));
  });

  it("writes the list down beside the project", () => {
    const moka = project("p1", 2);
    store().adopt(moka);
    store().close(moka.timelines![1].id);
    expect(currentUiPrefs().clipOpenTimelines.p1).toEqual([
      moka.timelines![0].id,
    ]);
  });
});
