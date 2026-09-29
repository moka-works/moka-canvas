// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createTimeline, defaultTextStyle } from "../../../shared/domain";
import type { MokaFile } from "../../../shared/domain";
import {
  buildCutMokaFile,
  buildGoldenMokaFile,
} from "../../../shared/domain/fixtures";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  initialTimelineId,
  rememberedMasterVolume,
  rememberedQuality,
  rememberedSnapEnabled,
  rememberTimelineId,
  rememberedTimelineId,
  rememberedView,
  useClipStore,
} from "./clipStore";
import { msAt, xAt } from "../timeline/geometry";

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

function open(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: `/tmp/${moka.metadata.id}`,
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
}

function store() {
  return useClipStore.getState();
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.getState().close();
  useClipStore.setState({
    activeTimelineId: null,
    face: "cut",
    selection: { clipIds: [], transitionId: null },
    adjustDraft: null,
    textDraft: null,
    cueEditor: null,
    mediaSelection: null,
    newTimelineOpen: false,
    view: { pxPerSec: 60, scrollLeftPx: 0 },
    playheadMs: 0,
    playing: false,
    quality: "full",
    masterVolume: 1,
    snapEnabled: true,
    loop: false,
    viewportPx: 0,
  });
});

describe("which timeline a project opens onto", () => {
  it("opens onto the first timeline when nothing is remembered", () => {
    const moka = project("p1", 2);
    expect(rememberedTimelineId("p1")).toBeNull();
    expect(initialTimelineId(moka)).toBe(moka.timelines![0].id);
  });

  it("opens onto the timeline this machine was left on", () => {
    const moka = project("p1", 2);
    rememberTimelineId("p1", moka.timelines![1].id);
    expect(initialTimelineId(moka)).toBe(moka.timelines![1].id);
  });

  it("falls back to the first when the remembered one left the document", () => {
    const moka = project("p1", 2);
    rememberTimelineId("p1", "timeline-gone");
    expect(initialTimelineId(moka)).toBe(moka.timelines![0].id);
  });

  it("has nothing to open onto in a document without timelines", () => {
    expect(initialTimelineId(project("p1", 0))).toBeNull();
  });

  it("keeps one project's timeline out of another's", () => {
    const first = project("p1", 2);
    const second = project("p2", 2);
    rememberTimelineId("p1", first.timelines![1].id);
    expect(initialTimelineId(second)).toBe(second.timelines![0].id);
    expect(rememberedTimelineId("p2")).toBeNull();
  });

  it("takes nothing from a store holding something else", () => {
    localStorage.setItem(
      "moka-canvas:clip-timeline:p1",
      JSON.stringify({ id: "x" }),
    );
    expect(rememberedTimelineId("p1")).toBeNull();
    localStorage.setItem("moka-canvas:clip-timeline:p1", "{not json");
    expect(rememberedTimelineId("p1")).toBeNull();
    localStorage.setItem("moka-canvas:clip-timeline:p1", JSON.stringify(""));
    expect(rememberedTimelineId("p1")).toBeNull();
  });
});

describe("what the cutting room is looking at", () => {
  it("remembers the switch for the project it was made in", () => {
    const moka = project("p1", 2);
    open(moka);
    store().setActiveTimeline(moka.timelines![1].id);
    expect(
      JSON.parse(localStorage.getItem("moka-canvas:clip-timeline:p1")!),
    ).toBe(moka.timelines![1].id);
  });

  it("forgets the place when there is no timeline to be at", () => {
    const moka = project("p1", 2);
    open(moka);
    store().setActiveTimeline(moka.timelines![0].id);
    store().setActiveTimeline(null);
    expect(localStorage.getItem("moka-canvas:clip-timeline:p1")).toBeNull();
    expect(store().activeTimelineId).toBeNull();
  });

  it("turns the column to the face it was asked for", () => {
    expect(store().face).toBe("cut");
    store().setFace("filters");
    expect(store().face).toBe("filters");
  });

  it("merges a selection patch rather than replacing the choice", () => {
    store().select({ clipIds: ["clip-a"] });
    store().select({ transitionId: "transition-a" });
    expect(store().selection).toEqual({
      clipIds: ["clip-a"],
      transitionId: "transition-a",
    });
    store().select({ clipIds: [] });
    expect(store().selection).toEqual({
      clipIds: [],
      transitionId: "transition-a",
    });
  });

  it("opens and closes the new-timeline question", () => {
    expect(store().newTimelineOpen).toBe(false);
    store().setNewTimelineOpen(true);
    expect(store().newTimelineOpen).toBe(true);
    store().setNewTimelineOpen(false);
    expect(store().newTimelineOpen).toBe(false);
  });

  it("keeps the shelf's chosen file apart from the timeline's own choice", () => {
    store().selectMedia("asset-a");
    store().select({ clipIds: ["clip-a"] });
    expect(store().mediaSelection).toBe("asset-a");
    expect(store().selection.clipIds).toEqual(["clip-a"]);
    store().selectMedia(null);
    expect(store().mediaSelection).toBeNull();
    expect(store().selection.clipIds).toEqual(["clip-a"]);
  });

  it("opens the in-place cue editor and lets it go, draft and all", () => {
    const session = { kind: "clip" as const, clipId: "clip-a", seed: "One" };
    store().setCueEditor(session);
    expect(store().cueEditor).toEqual(session);

    // The words a session was drafting belong to it: closing the session
    // hands the preview back to the document.
    store().setTextDraft({
      clipIds: ["clip-a"],
      text: { content: "One more", style: defaultTextStyle() },
    });
    store().setCueEditor(null);
    expect(store().cueEditor).toBeNull();
    expect(store().textDraft).toBeNull();
  });

  it("keeps a cue session from travelling to the next timeline", () => {
    const moka = project("p1", 2);
    open(moka);
    store().setCueEditor({ kind: "clip", clipId: "clip-a", seed: "One" });
    store().setActiveTimeline(moka.timelines![1].id);
    expect(store().cueEditor).toBeNull();
  });

  it("brings a moment into view only when it stands outside it", () => {
    const moka = project("p1", 1);
    open(moka);
    store().setActiveTimeline(moka.timelines![0].id);
    store().setViewportPx(800);

    // A moment on screen leaves the view where the reader left it.
    store().setView({ scrollLeftPx: 0 });
    store().revealMs(2_000);
    expect(store().view.scrollLeftPx).toBe(0);

    // One past the edge lands a fifteenth of the pane in, with room ahead.
    store().revealMs(20_000);
    expect(store().view.scrollLeftPx).toBe(1_080);
    const state = store();
    expect(xAt(20_000, state.view)).toBeCloseTo(120, 6);
  });
});

describe("how the timeline is looked at", () => {
  /** A project with one timeline open on the store. */
  function openOne(): MokaFile {
    const moka = project("p1", 1);
    open(moka);
    store().setActiveTimeline(moka.timelines![0].id);
    store().setViewportPx(800);
    return moka;
  }

  it("zooms by a step of one and a half and stops at the limits", () => {
    openOne();
    expect(store().view.pxPerSec).toBe(60);

    store().zoomBy(1.5);
    expect(store().view.pxPerSec).toBe(90);
    store().zoomBy(1 / 1.5);
    expect(store().view.pxPerSec).toBe(60);

    store().zoomTo(10_000);
    expect(store().view.pxPerSec).toBe(960);
    store().zoomTo(0.1);
    expect(store().view.pxPerSec).toBe(4);
  });

  it("holds the playhead where it stands when it is on screen", () => {
    openOne();
    store().setPlayhead(5_000);
    store().zoomTo(90);
    expect(store().view).toEqual({ pxPerSec: 90, scrollLeftPx: 50 });
    // The playhead sits exactly where it sat: 400px into an 800px screen.
    expect(
      (5_000 / 1_000) * store().view.pxPerSec - store().view.scrollLeftPx,
    ).toBe(400);
  });

  it("zooms about the middle of the screen when the playhead is out of sight", () => {
    openOne();
    store().setView({ scrollLeftPx: 2_000 });
    const anchor = msAt(400, { pxPerSec: 60, scrollLeftPx: 2_000 });
    store().zoomTo(30);
    // 40s of anchor at 30px/s wants an 800px offset; 34s of content stop it at 220.
    expect(store().view).toEqual({ pxPerSec: 30, scrollLeftPx: 220 });
    expect((anchor / 1_000) * 30 - 220).toBeCloseTo(980);
  });

  it("clamps what a hand sets on the view", () => {
    openOne();
    store().setView({ pxPerSec: 1, scrollLeftPx: -20 });
    expect(store().view).toEqual({ pxPerSec: 4, scrollLeftPx: 0 });
  });

  it("fits the whole cut on screen", () => {
    openOne();
    store().fit(800, 30_000);
    expect(store().view.pxPerSec).toBeCloseTo(800 / 30, 2);
    expect(store().view.scrollLeftPx).toBe(0);
    // Nothing to fit, nothing to do.
    store().zoomTo(120);
    store().fit(0, 30_000);
    expect(store().view.pxPerSec).toBe(120);
  });

  it("remembers each timeline's own view and playhead, on this machine", () => {
    const moka = project("p1", 2);
    open(moka);
    const [first, second] = moka.timelines!;

    store().setActiveTimeline(first.id);
    store().setPlayhead(4_321);
    store().zoomTo(120);
    store().setView({ scrollLeftPx: 90 });

    store().setActiveTimeline(second.id);
    expect(store().view).toEqual({ pxPerSec: 60, scrollLeftPx: 0 });
    expect(store().playheadMs).toBe(0);
    store().zoomTo(240);

    store().setActiveTimeline(first.id);
    expect(store().view).toEqual({ pxPerSec: 120, scrollLeftPx: 90 });
    expect(store().playheadMs).toBe(4_321);

    // Written down by id, and nothing about a view goes into the document.
    expect(
      JSON.parse(localStorage.getItem(`moka-canvas:clip-view:${first.id}`)!),
    ).toEqual({ pxPerSec: 120, scrollLeftPx: 90, playheadMs: 4_321 });
    expect(localStorage.getItem("moka-canvas:clip-view:p1")).toBeNull();
  });

  it("starts a timeline it has never seen at the default", () => {
    openOne();
    expect(rememberedView("fresh")).toBeNull();
    expect(store().view).toEqual({ pxPerSec: 60, scrollLeftPx: 0 });
  });

  it("takes nothing from a view store holding something else", () => {
    localStorage.setItem("moka-canvas:clip-view:t1", "{not json");
    expect(rememberedView("t1")).toBeNull();
    localStorage.setItem(
      "moka-canvas:clip-view:t1",
      JSON.stringify({ pxPerSec: "90", scrollLeftPx: -5, playheadMs: -2 }),
    );
    expect(rememberedView("t1")).toEqual({
      view: { pxPerSec: 60, scrollLeftPx: 0 },
      playheadMs: 0,
    });
    localStorage.setItem(
      "moka-canvas:clip-view:t1",
      JSON.stringify({ pxPerSec: 20_000, scrollLeftPx: 12 }),
    );
    expect(rememberedView("t1")).toEqual({
      view: { pxPerSec: 960, scrollLeftPx: 12 },
      playheadMs: 0,
    });
  });

  it("holds the playhead at the head rather than before it", () => {
    openOne();
    store().setPlayhead(-25);
    expect(store().playheadMs).toBe(0);
    store().setPlayhead(Number.NaN);
    expect(store().playheadMs).toBe(0);
  });
});

describe("the clock the cut is played by", () => {
  /** The cut fixture open on the store, which is a timeline with clips on it. */
  function openCut(): MokaFile {
    const moka = buildCutMokaFile();
    open(moka);
    store().setActiveTimeline(moka.timelines![0].id);
    return moka;
  }

  it("plays nothing when no row that draws holds anything", () => {
    const moka = project("p1", 1);
    open(moka);
    store().setActiveTimeline(moka.timelines![0].id);
    store().play();
    expect(store().playing).toBe(false);
  });

  it("plays from where the playhead stands, and pauses there", () => {
    openCut();
    store().setPlayhead(1_000);
    store().play();
    expect(store().playing).toBe(true);
    store().pause();
    expect(store().playing).toBe(false);
    expect(store().playheadMs).toBe(1_000);
  });

  it("asks for the cut from its head when play is pressed at the tail", () => {
    openCut();
    store().setPlayhead(8_000);
    store().play();
    expect(store().playing).toBe(true);
    expect(store().playheadMs).toBe(0);
  });

  it("does nothing on a second play while the clock already runs", () => {
    openCut();
    store().play();
    store().setPlayheadFromClock(500);
    store().play();
    expect(store().playing).toBe(true);
    expect(store().playheadMs).toBe(500);
  });

  it("toggles between the two, from whichever side it is on", () => {
    openCut();
    store().togglePlay();
    expect(store().playing).toBe(true);
    store().togglePlay();
    expect(store().playing).toBe(false);
  });

  it("stops the clock for a hand at the playhead, but not for its own writes", () => {
    openCut();
    store().play();
    store().setPlayhead(2_000);
    expect(store().playing).toBe(false);
    expect(store().playheadMs).toBe(2_000);

    // The running clock's own writes never pause what they are moving.
    store().play();
    store().setPlayheadFromClock(2_500);
    expect(store().playing).toBe(true);
    expect(store().playheadMs).toBe(2_500);
  });

  it("stops the clock when the room turns to another timeline", () => {
    const moka = project("p2", 2);
    open(moka);
    store().setActiveTimeline(moka.timelines![0].id);
    // A fixture with clips, since an empty cut cannot be played.
    const cut = buildCutMokaFile().timelines![0];
    useProjectStore.setState({
      moka: { ...moka, timelines: [cut, moka.timelines![1]] },
    });
    store().setActiveTimeline(cut.id);
    store().play();
    expect(store().playing).toBe(true);
    store().setActiveTimeline(moka.timelines![1].id);
    expect(store().playing).toBe(false);
  });

  it("remembers the preview tier and the master level on this machine", () => {
    store().setQuality("quarter");
    store().setMasterVolume(0.4);
    expect(localStorage.getItem("moka-canvas:clip-quality")).toBe("quarter");
    expect(localStorage.getItem("moka-canvas:clip-volume")).toBe("0.4");
    expect(rememberedQuality()).toBe("quarter");
    expect(rememberedMasterVolume()).toBe(0.4);
  });

  it("holds the master level inside the range it can be", () => {
    store().setMasterVolume(4);
    expect(store().masterVolume).toBe(1);
    store().setMasterVolume(-2);
    expect(store().masterVolume).toBe(0);
    store().setMasterVolume(Number.NaN);
    expect(store().masterVolume).toBe(0);
  });

  it("reads a preference store holding something else as the start", () => {
    localStorage.setItem("moka-canvas:clip-quality", "gigantic");
    expect(rememberedQuality()).toBe("full");
    localStorage.setItem("moka-canvas:clip-volume", "loud");
    expect(rememberedMasterVolume()).toBe(1);
    localStorage.setItem("moka-canvas:clip-volume", "4");
    expect(rememberedMasterVolume()).toBe(1);
  });

  it("remembers the magnet on this machine, on by default", () => {
    expect(rememberedSnapEnabled()).toBe(true);
    store().setSnapEnabled(false);
    expect(localStorage.getItem("moka-canvas:clip-snap")).toBe("off");
    expect(rememberedSnapEnabled()).toBe(false);
    store().setSnapEnabled(true);
    expect(rememberedSnapEnabled()).toBe(true);
    // A store holding something else is read as the default, not as off.
    localStorage.setItem("moka-canvas:clip-snap", "nonsense");
    expect(rememberedSnapEnabled()).toBe(true);
  });

  it("keeps the repeat a session's own arrangement, never the machine's", () => {
    expect(store().loop).toBe(false);
    store().toggleLoop();
    expect(store().loop).toBe(true);
    expect(localStorage.getItem("moka-canvas:clip-loop")).toBeNull();
  });
});

describe("the grade a hand is dragging", () => {
  it("holds the draft apart from the document, clamped to what a grade is", () => {
    store().setAdjustDraft({
      clipIds: ["clip-1"],
      adjust: { brightness: 4, contrast: -0.25, saturation: Number.NaN },
    });
    expect(store().adjustDraft).toEqual({
      clipIds: ["clip-1"],
      adjust: { brightness: 1, contrast: -0.25, saturation: 0 },
    });
  });

  it("lets the draft go when nothing is written or nothing is named", () => {
    store().setAdjustDraft({
      clipIds: ["clip-1"],
      adjust: { brightness: 0.5, contrast: 0, saturation: 0 },
    });
    store().setAdjustDraft(null);
    expect(store().adjustDraft).toBeNull();
    store().setAdjustDraft({
      clipIds: [],
      adjust: { brightness: 0.5, contrast: 0, saturation: 0 },
    });
    expect(store().adjustDraft).toBeNull();
  });

  it("drops a draft standing for clips that are no longer chosen", () => {
    store().setAdjustDraft({
      clipIds: ["clip-1"],
      adjust: { brightness: 0.5, contrast: 0, saturation: 0 },
    });
    store().select({ clipIds: ["clip-2"] });
    expect(store().adjustDraft).toBeNull();
    // A write that says nothing about the clips is not a new choice.
    store().setAdjustDraft({
      clipIds: ["clip-2"],
      adjust: { brightness: 0.5, contrast: 0, saturation: 0 },
    });
    store().select({ transitionId: null });
    expect(store().adjustDraft).not.toBeNull();
  });
});

describe("the words a hand is editing", () => {
  const words = { content: "hello", style: defaultTextStyle() };

  it("holds the draft apart from the document, copied as it was written", () => {
    const clipIds = ["clip-1"];
    store().setTextDraft({ clipIds, text: words });
    expect(store().textDraft).toEqual({ clipIds: ["clip-1"], text: words });
    // The caller's own list going stale cannot change what stands in for it.
    clipIds.push("clip-2");
    expect(store().textDraft?.clipIds).toEqual(["clip-1"]);
  });

  it("lets the draft go when nothing is written or nothing is named", () => {
    store().setTextDraft({ clipIds: ["clip-1"], text: words });
    store().setTextDraft(null);
    expect(store().textDraft).toBeNull();
    store().setTextDraft({ clipIds: [], text: words });
    expect(store().textDraft).toBeNull();
  });

  it("drops a draft standing for clips that are no longer chosen", () => {
    store().setTextDraft({ clipIds: ["clip-1"], text: words });
    store().select({ clipIds: ["clip-2"] });
    expect(store().textDraft).toBeNull();
    // A write that says nothing about the clips is not a new choice.
    store().setTextDraft({ clipIds: ["clip-2"], text: words });
    store().select({ transitionId: null });
    expect(store().textDraft).not.toBeNull();
  });

  it("keeps the two kinds of draft apart", () => {
    store().setAdjustDraft({
      clipIds: ["clip-1"],
      adjust: { brightness: 0.5, contrast: 0, saturation: 0 },
    });
    store().setTextDraft({ clipIds: ["clip-1"], text: words });
    expect(store().adjustDraft).not.toBeNull();
    expect(store().textDraft).not.toBeNull();
    store().select({ clipIds: ["clip-2"] });
    expect(store().adjustDraft).toBeNull();
    expect(store().textDraft).toBeNull();
  });
});
