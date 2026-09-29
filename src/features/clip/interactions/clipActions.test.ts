import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MokaFile,
  type ResourceEntry,
  type TimelineClip,
  type TimelineDocument,
  type TimelineTrack,
  type TimelineTransition,
} from "../../../shared/domain";
import {
  buildCutMokaFile,
  buildTimelineMokaFile,
  cutFixtureIds,
  timelineIds,
} from "../../../shared/domain/fixtures";
import { undo } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import {
  useHistoryStore,
  isBoundary,
  type HistoryEntry,
} from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import { frameAligned } from "../timeline/timecode";
import {
  addAssetAtPlayhead,
  addAssetsAtPlayhead,
  addTrackOfKind,
  alignSelection,
  clickSelection,
  clipsCrossingPlayhead,
  deleteSelection,
  detachAudio,
  dropAssetOnTrack,
  dropPreview,
  duplicateSelection,
  materialOf,
  nearestClipEdgeMs,
  rangeBetween,
  removeTrack,
  renameTrack,
  selectAll,
  selectedClips,
  setTrackFlag,
  splitSelectionAtPlayhead,
} from "./clipActions";

const NOW = "2026-01-01T00:00:00.000Z";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useClipStore.setState({
    activeTimelineId: null,
    selection: { clipIds: [], transitionId: null },
    playheadMs: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Opens a document onto one cut, with a selection and a playhead. */
function open(
  moka: MokaFile,
  options: {
    timelineId: string;
    clipIds?: string[];
    transitionId?: string | null;
    playheadMs?: number;
  },
): MokaFile {
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka,
    selfCheck: { ok: true, issues: [] },
  });
  useClipStore.setState({
    activeTimelineId: options.timelineId,
    selection: {
      clipIds: options.clipIds ?? [],
      transitionId: options.transitionId ?? null,
    },
    playheadMs: options.playheadMs ?? 0,
  });
  return moka;
}

function cut(): TimelineDocument {
  const moka = useProjectStore.getState().moka;
  const id = useClipStore.getState().activeTimelineId;
  const timeline = (moka?.timelines ?? []).find((each) => each.id === id);
  if (!timeline) throw new Error("no cut is open");
  return timeline;
}

/** The newest history entry, which is what one action recorded. */
function lastEntry(): HistoryEntry {
  const top = useHistoryStore.getState().undoStack.at(-1);
  if (!top || isBoundary(top)) throw new Error("no history entry was recorded");
  return top;
}

function entryCount(): number {
  return useHistoryStore
    .getState()
    .undoStack.filter((item) => !isBoundary(item)).length;
}

function messages(): string[] {
  return useAppStore.getState().toasts.map((toast) => toast.message);
}

/** A cut of one four-second clip reading the whole of its material at 1.5×. */
function spedCut(): { moka: MokaFile; timelineId: string; clipId: string } {
  const ids = timelineIds();
  const moka = buildTimelineMokaFile();
  const timeline = moka.timelines![0];
  timeline.clips = timeline.clips.map((clip) =>
    clip.id === ids.videoClip
      ? {
          ...clip,
          speed: 1.5,
          durationMs: 2_000,
          inPointMs: 0,
          outPointMs: 3_000,
        }
      : clip,
  );
  return { moka, timelineId: ids.timeline, clipId: ids.videoClip };
}

function identityHolds(clip: TimelineClip): boolean {
  return (
    Math.round(clip.durationMs * clip.speed) ===
    clip.outPointMs - clip.inPointMs
  );
}

describe("splitting", () => {
  it("cuts a sped clip into two pieces, each honest about its own window", () => {
    const sped = spedCut();
    const original = open(sped.moka, {
      timelineId: sped.timelineId,
      clipIds: [sped.clipId],
      playheadMs: 1_000,
    });

    splitSelectionAtPlayhead();

    const clips = cut().clips;
    expect(clips).toHaveLength(2);
    const left = clips.find((clip) => clip.id === sped.clipId)!;
    const right = clips.find((clip) => clip.id !== sped.clipId)!;
    expect(left).toMatchObject({
      startMs: 0,
      durationMs: 1_000,
      inPointMs: 0,
      outPointMs: 1_500,
    });
    expect(right).toMatchObject({
      startMs: 1_000,
      durationMs: 1_000,
      inPointMs: 1_500,
      outPointMs: 3_000,
      speed: 1.5,
    });
    expect(identityHolds(left)).toBe(true);
    expect(identityHolds(right)).toBe(true);
    // The right-hand piece stays chosen, ready to be cut again.
    expect(useClipStore.getState().selection.clipIds).toEqual([right.id]);

    undo();
    expect(useProjectStore.getState().moka).toEqual(original);
  });

  it("refuses a split that would leave a piece too short to see", () => {
    const ids = timelineIds();
    const moka = buildTimelineMokaFile();
    for (const playheadMs of [50, 3_950]) {
      open(moka, {
        timelineId: ids.timeline,
        clipIds: [ids.videoClip],
        playheadMs,
      });
      splitSelectionAtPlayhead();
      expect(cut().clips).toHaveLength(1);
      expect(messages()).toEqual(["Too short to split at the playhead"]);
      expect(entryCount()).toBe(0);
      useAppStore.setState({ toasts: [] });
    }
  });

  it("takes a trailing seam down and puts it back on the right-hand piece", () => {
    const ids = cutFixtureIds();
    const original = open(buildCutMokaFile(), {
      timelineId: ids.timeline,
      clipIds: [ids.clipA],
      playheadMs: 2_000,
    });
    const before = cut().transitions[0];

    splitSelectionAtPlayhead();

    const entry = lastEntry();
    expect(entry.label).toBe("Split clip(s)");
    expect(entry.forwardCommands.map((command) => command.type)).toEqual([
      "removeTransitions",
      "updateClips",
      "addClips",
      "addTransitions",
    ]);
    expect(entry.forwardCommands[0]).toMatchObject({
      transitionIds: [before.id],
    });
    const clips = cut().clips;
    const right = clips.find(
      (clip) => clip.trackId === ids.videoTrack && clip.startMs === 2_000,
    )!;
    const reattached = (
      entry.forwardCommands[3] as { transitions: TimelineTransition[] }
    ).transitions[0];
    // The seam's record is the same one, on the same moment; only who stands
    // on the left of it moved from the shortened clip to the piece behind.
    expect(reattached).toEqual({ ...before, afterClipId: right.id });
    const follower = clips.find((clip) => clip.id === ids.clipB)!;
    expect(follower.startMs).toBe(3_500);

    undo();
    expect(useProjectStore.getState().moka).toEqual(original);
  });

  it("splits every crossing clip on unlocked rows when nothing is chosen", () => {
    const ids = timelineIds();
    const moka = buildTimelineMokaFile();
    open(moka, { timelineId: ids.timeline, playheadMs: 1_000 });

    splitSelectionAtPlayhead();

    expect(cut().clips).toHaveLength(2);
    expect(messages()).toEqual([]);
  });

  it("says so when the playhead is over no clip at all", () => {
    const ids = timelineIds();
    const moka = buildTimelineMokaFile();
    open(moka, {
      timelineId: ids.timeline,
      clipIds: [ids.videoClip],
      playheadMs: 6_000,
    });

    splitSelectionAtPlayhead();

    expect(messages()).toEqual(["The playhead is not over the selected clip"]);
    expect(entryCount()).toBe(0);
  });
});

describe("deleting", () => {
  it("takes the chosen clip and its seam out in one step, and one undo brings both back", () => {
    const ids = cutFixtureIds();
    open(buildCutMokaFile(), {
      timelineId: ids.timeline,
      clipIds: [ids.clipA],
    });
    const before = { ...cut() };

    deleteSelection();

    const idsLeft = new Set(cut().clips.map((clip) => clip.id));
    expect(idsLeft.has(ids.clipA)).toBe(false);
    expect(idsLeft.has(ids.clipB)).toBe(true);
    expect(cut().transitions).toEqual([]);
    expect(useClipStore.getState().selection.clipIds).toEqual([]);
    expect(lastEntry().label).toBe("Delete clips");

    undo();
    // The clips are read by id rather than by place: the array's order is
    // not something the document promises (01's second consequence).
    const restored = cut();
    expect(new Set(restored.clips.map((clip) => clip.id))).toEqual(
      new Set(before.clips.map((clip) => clip.id)),
    );
    for (const clip of before.clips) {
      expect(restored.clips.find((each) => each.id === clip.id)).toEqual(clip);
    }
    expect(restored.transitions).toEqual(before.transitions);
  });

  it("takes a chosen seam off without touching the clips", () => {
    const ids = cutFixtureIds();
    const original = open(buildCutMokaFile(), {
      timelineId: ids.timeline,
      transitionId: ids.transition,
    });

    deleteSelection();

    expect(cut().clips).toHaveLength(4);
    expect(cut().transitions).toEqual([]);
    // Releasing the seam gives the follower its place back.
    expect(cut().clips.find((clip) => clip.id === ids.clipB)!.startMs).toBe(
      4_000,
    );

    undo();
    expect(useProjectStore.getState().moka).toEqual(original);
  });
});

describe("duplicating", () => {
  it("lays a copy on the tail of the chosen clip", () => {
    const ids = cutFixtureIds();
    open(buildCutMokaFile(), {
      timelineId: ids.timeline,
      clipIds: [ids.clipB],
    });

    duplicateSelection();

    const copies = cut().clips.filter((clip) => clip.id !== ids.clipB);
    const copy = copies.find((clip) => clip.startMs === 5_500)!;
    expect(copy).toMatchObject({
      label: "closing.mp4",
      assetId: ids.videoAssetB,
      durationMs: 2_000,
      inPointMs: 0,
      outPointMs: 4_000,
      speed: 2,
    });
    expect(copy.id).not.toBe(ids.clipB);
  });

  it("refuses the whole batch when a copy lands on something", () => {
    const ids = cutFixtureIds();
    const moka = open(buildCutMokaFile(), {
      timelineId: ids.timeline,
      clipIds: [ids.clipA],
    });

    duplicateSelection();

    expect(useProjectStore.getState().moka).toEqual(moka);
    expect(entryCount()).toBe(0);
    expect(messages().join(" ")).toContain("hold the same place on one track");
  });
});

describe("detaching audio", () => {
  it("grows an audio row when the cut has none, and mutes the picture", () => {
    const ids = timelineIds();
    const moka = buildTimelineMokaFile();
    moka.timelines![0].tracks = moka.timelines![0].tracks.filter(
      (track) => track.kind !== "audio",
    );
    const original = open(moka, {
      timelineId: ids.timeline,
      clipIds: [ids.videoClip],
    });

    detachAudio();

    const entry = lastEntry();
    expect(entry.label).toBe("Detach audio");
    expect(entry.forwardCommands[0].type).toBe("addTrack");
    const added = (entry.forwardCommands[0] as { track: TimelineTrack }).track;
    expect(added.kind).toBe("audio");
    const sound = cut().clips.find((clip) => clip.kind === "audio")!;
    expect(sound).toMatchObject({
      trackId: added.id,
      assetId: ids.videoAsset,
      startMs: 0,
      durationMs: 4_000,
      inPointMs: 0,
      outPointMs: 4_000,
    });
    expect(cut().clips.find((clip) => clip.id === ids.videoClip)!.muted).toBe(
      true,
    );

    undo();
    expect(useProjectStore.getState().moka).toEqual(original);
  });

  it("lands the sound on the first audio row that will take an edit", () => {
    const ids = timelineIds();
    open(buildTimelineMokaFile(), {
      timelineId: ids.timeline,
      clipIds: [ids.videoClip],
    });

    detachAudio();

    const entry = lastEntry();
    expect(entry.forwardCommands[0].type).toBe("addClips");
    const sound = cut().clips.find((clip) => clip.kind === "audio")!;
    expect(sound.trackId).toBe(ids.audioTrack);
  });
});

describe("landing a file from the shelf", () => {
  it("refuses the texts shelf with a pointer to the page that makes words", () => {
    const ids = timelineIds();
    const moka = buildTimelineMokaFile();
    const notes: ResourceEntry = {
      id: "asset-notes",
      name: "notes.md",
      path: "assets/texts/notes-00000000.md",
      mime: "text/markdown",
      bytes: 120,
      createdAt: NOW,
      updatedAt: NOW,
    };
    moka.resources.texts.push(notes);
    open(moka, { timelineId: ids.timeline });

    dropAssetOnTrack(cut(), notes.id, ids.videoTrack, 0);

    expect(cut().clips).toHaveLength(1);
    expect(messages()).toEqual(["Text clips are made on the Text page"]);
  });

  it("says what a file's kind needs of a row, and keeps off locked rows", () => {
    const ids = timelineIds();
    open(buildTimelineMokaFile(), { timelineId: ids.timeline });

    // The fixture's one video file dropped on the audio row.
    dropAssetOnTrack(cut(), ids.videoAsset, ids.audioTrack, 0);
    expect(messages()).toEqual(["A video or an image goes on a video track"]);
    expect(cut().clips).toHaveLength(1);
  });

  it("will not lay anything on a row that is locked", () => {
    const ids = timelineIds();
    const moka = buildTimelineMokaFile();
    moka.timelines![0].tracks = moka.timelines![0].tracks.map((track) =>
      track.kind === "video" ? { ...track, locked: true } : track,
    );
    open(moka, { timelineId: ids.timeline });

    dropAssetOnTrack(cut(), ids.videoAsset, ids.videoTrack, 0);

    expect(messages()).toEqual(["That track is locked"]);
    expect(cut().clips).toHaveLength(1);
  });

  it("ignores a drag whose asset the project no longer holds", () => {
    const ids = timelineIds();
    open(buildTimelineMokaFile(), { timelineId: ids.timeline });

    dropAssetOnTrack(cut(), "asset-gone", ids.videoTrack, 0);

    expect(cut().clips).toHaveLength(1);
    expect(messages()).toEqual([]);
  });
});

describe("the ghost a hanging file draws", () => {
  it("places the block where the release would, and the magnet catches its head", () => {
    const ids = timelineIds();
    open(buildTimelineMokaFile(), { timelineId: ids.timeline });

    // A hand's width clear of the block already there: the pointer's own
    // frame, and the file's own four seconds.
    const free = dropPreview(cut(), ids.videoAsset, ids.videoTrack, 3_000);
    expect(free?.clip).toMatchObject({
      trackId: ids.videoTrack,
      kind: "video",
      startMs: 3_000,
      durationMs: 4_000,
    });
    expect(free?.guideMs).toBeNull();

    // Within the magnet's reach of the block's tail, the head is caught by
    // it: the ghost butts the block rather than drawing an overlap.
    const caught = dropPreview(cut(), ids.videoAsset, ids.videoTrack, 3_950);
    expect(caught?.clip.startMs).toBe(4_000);
    expect(caught?.guideMs).toBe(4_000);
  });

  it("lands exactly the block the ghost drew", () => {
    const ids = timelineIds();
    open(buildTimelineMokaFile(), { timelineId: ids.timeline });

    // A moment the magnet pulls onto the block's tail: the ghost butts it,
    // and the drop that follows lays the very block down instead of asking
    // for an overlap it would be refused.
    const drawn = dropPreview(cut(), ids.followerAsset, ids.videoTrack, 3_950);
    expect(drawn?.clip.startMs).toBe(4_000);
    const before = new Set(cut().clips.map((clip) => clip.id));
    dropAssetOnTrack(cut(), ids.followerAsset, ids.videoTrack, 3_950);

    const landed = cut().clips.find((clip) => !before.has(clip.id));
    expect(landed?.startMs).toBe(drawn?.clip.startMs);
    expect(landed?.durationMs).toBe(drawn?.clip.durationMs);
    expect(messages()).toEqual([]);
  });

  it("draws nothing over a place that would refuse the file", () => {
    const ids = timelineIds();
    const moka = buildTimelineMokaFile();
    const notes: ResourceEntry = {
      id: "asset-notes",
      name: "notes.md",
      path: "assets/texts/notes-00000000.md",
      mime: "text/markdown",
      bytes: 120,
      createdAt: NOW,
      updatedAt: NOW,
    };
    moka.resources.texts.push(notes);
    moka.timelines![0].tracks = moka.timelines![0].tracks.map((track) =>
      track.kind === "video" ? { ...track, locked: true } : track,
    );
    open(moka, { timelineId: ids.timeline });

    // A locked row, another kind's row, a file that makes no clip, no row at
    // all, and an id the project no longer holds.
    expect(dropPreview(cut(), ids.videoAsset, ids.videoTrack, 0)).toBeNull();
    expect(dropPreview(cut(), ids.videoAsset, ids.audioTrack, 0)).toBeNull();
    expect(dropPreview(cut(), notes.id, ids.videoTrack, 0)).toBeNull();
    expect(dropPreview(cut(), ids.videoAsset, null, 0)).toBeNull();
    expect(dropPreview(cut(), "asset-gone", ids.videoTrack, 0)).toBeNull();
  });
});

/** A cut with a second video row on top and a sound chosen on the audio row. */
function stackedCut(options: { lockUpper: boolean }): {
  moka: MokaFile;
  ids: ReturnType<typeof timelineIds>;
  upperId: string;
} {
  const ids = timelineIds();
  const moka = buildTimelineMokaFile();
  const timeline = moka.timelines![0];
  moka.resources.music.push({
    id: "asset-score",
    name: "score.mp3",
    path: "assets/music/score-00000000.mp3",
    mime: "audio/mpeg",
    bytes: 1_024,
    createdAt: NOW,
    updatedAt: NOW,
    probe: {
      mime: "audio/mpeg",
      bytes: 1_024,
      sha256: "a".repeat(64),
      durationMs: 6_000,
    },
  });
  timeline.clips.push({
    id: "clip-score",
    trackId: ids.audioTrack,
    kind: "audio",
    label: "score.mp3",
    assetId: "asset-score",
    startMs: 6_000,
    durationMs: 1_000,
    inPointMs: 0,
    outPointMs: 1_000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const upper: TimelineTrack = {
    id: "track-video-2",
    kind: "video",
    name: "Video 2",
    muted: false,
    hidden: false,
    locked: options.lockUpper,
    createdAt: NOW,
  };
  timeline.tracks = [...timeline.tracks, upper];
  return { moka, ids, upperId: upper.id };
}

describe("adding at the playhead", () => {
  /** A video file to land, with the length its probe says it runs. */
  function videoEntry(id: string, durationMs: number): ResourceEntry {
    return {
      id,
      name: `${id}.mp4`,
      path: `assets/videos/${id}.mp4`,
      mime: "video/mp4",
      bytes: 1_000,
      createdAt: NOW,
      updatedAt: NOW,
      probe: {
        mime: "video/mp4",
        bytes: 1_000,
        sha256: "b".repeat(64),
        durationMs,
      },
    };
  }

  it("takes the topmost unlocked row of the file's kind, whatever is chosen", () => {
    const { moka, ids, upperId } = stackedCut({ lockUpper: false });
    open(moka, {
      timelineId: ids.timeline,
      clipIds: ["clip-score"],
      playheadMs: 1_234,
    });

    addAssetAtPlayhead(ids.videoAsset);

    const landed = cut().clips.filter(
      (clip) => clip.assetId === ids.videoAsset,
    );
    expect(landed).toHaveLength(2);
    const added = landed.find((clip) => clip.id !== ids.videoClip)!;
    expect(added).toMatchObject({
      trackId: upperId,
      kind: "video",
      label: "opening.mp4",
      startMs: frameAligned(1_234, 30),
    });
    expect(useClipStore.getState().selection.clipIds).toEqual([added.id]);
    expect(messages()).toEqual(["Added opening.mp4"]);
  });

  it("steps past a locked top row to the next that takes the file", () => {
    const { moka, ids, upperId } = stackedCut({ lockUpper: true });
    // Past the fixture's own clip, so the fallback row can actually take it.
    open(moka, { timelineId: ids.timeline, playheadMs: 5_000 });

    addAssetAtPlayhead(ids.videoAsset);

    const added = cut().clips.find(
      (clip) => clip.assetId === ids.videoAsset && clip.id !== ids.videoClip,
    )!;
    expect(added.trackId).toBe(ids.videoTrack);
    expect(added.trackId).not.toBe(upperId);
  });

  it("refuses words here too", () => {
    const ids = timelineIds();
    const moka = buildTimelineMokaFile();
    moka.resources.texts.push({
      id: "asset-notes",
      name: "notes.md",
      path: "assets/texts/notes-00000000.md",
      mime: "text/markdown",
      createdAt: NOW,
      updatedAt: NOW,
    });
    open(moka, { timelineId: ids.timeline, playheadMs: 500 });

    addAssetAtPlayhead("asset-notes");

    expect(cut().clips).toHaveLength(1);
    expect(messages()).toEqual(["Text clips are made on the Text page"]);
  });

  it("lands a batch one after another, the cursor walking along", () => {
    const { moka, ids } = stackedCut({ lockUpper: false });
    moka.resources.videos.push(
      videoEntry("asset-b", 2_000),
      videoEntry("asset-c", 3_000),
    );
    open(moka, { timelineId: ids.timeline, playheadMs: 1_234 });

    addAssetsAtPlayhead([ids.videoAsset, "asset-b", "asset-c"]);

    const start = frameAligned(1_234, 30);
    const landed = cut()
      .clips.filter(
        (clip) =>
          clip.assetId === "asset-b" ||
          clip.assetId === "asset-c" ||
          (clip.assetId === ids.videoAsset && clip.id !== ids.videoClip),
      )
      .sort((left, right) => left.startMs - right.startMs);
    expect(landed.map((clip) => clip.startMs)).toEqual([
      start,
      start + 4_000,
      start + 6_000,
    ]);
    // The last of the run is what is left chosen, and one line says the lot.
    expect(useClipStore.getState().selection.clipIds).toEqual([landed[2].id]);
    expect(messages()).toEqual(["Added 3 files, one after another"]);
  });

  it("skips words in a batch and still lands the rest", () => {
    const { moka, ids } = stackedCut({ lockUpper: false });
    moka.resources.texts.push({
      id: "asset-notes",
      name: "notes.md",
      path: "assets/texts/notes-00000000.md",
      mime: "text/markdown",
      createdAt: NOW,
      updatedAt: NOW,
    });
    open(moka, { timelineId: ids.timeline, playheadMs: 0 });

    addAssetsAtPlayhead(["asset-notes", "asset-score", ids.videoAsset]);

    expect(messages()).toEqual([
      "Text clips are made on the Text page",
      "Added 2 files, one after another",
    ]);
    const audio = cut().clips.find(
      (clip) => clip.assetId === "asset-score" && clip.id !== "clip-score",
    )!;
    expect(audio.startMs).toBe(0);
    // The video lands after the sound that took its place in the run, not at
    // the playhead the sound already used: six seconds of score, then the cut.
    const video = cut().clips.find(
      (clip) => clip.assetId === ids.videoAsset && clip.id !== ids.videoClip,
    )!;
    expect(video.startMs).toBe(6_000);
  });

  it("refuses a locked kind in a batch and still lands the rest", () => {
    const { moka, ids, upperId } = stackedCut({ lockUpper: true });
    const timeline = moka.timelines![0];
    // Both video rows locked, so only the sound has a row to land on; the
    // fixture's own sound is cleared away so the landing place is free.
    timeline.tracks = timeline.tracks.map((track) =>
      track.id === upperId
        ? track
        : { ...track, locked: track.kind === "video" },
    );
    timeline.clips = timeline.clips.filter((clip) => clip.id !== "clip-score");
    open(moka, { timelineId: ids.timeline, playheadMs: 500 });

    addAssetsAtPlayhead([ids.videoAsset, "asset-score"]);

    expect(messages()).toEqual(["That track is locked"]);
    const late = cut().clips.filter((clip) => clip.startMs >= 500);
    expect(late.map((clip) => clip.assetId)).toEqual(["asset-score"]);
  });
});

describe("selecting", () => {
  it("replaces, ranges and toggles as the pointer asks", () => {
    const ids = cutFixtureIds();
    open(buildCutMokaFile(), { timelineId: ids.timeline });
    const timeline = cut();
    const clipA = timeline.clips.find((clip) => clip.id === ids.clipA)!;
    const clipB = timeline.clips.find((clip) => clip.id === ids.clipB)!;

    const replaced = clickSelection(
      timeline,
      { clipIds: [ids.clipC], transitionId: null },
      { kind: "clip", clip: clipA },
      "replace",
      null,
    );
    expect(replaced).toEqual({ clipIds: [ids.clipA], transitionId: null });

    // Shift reaches from the anchor along the row the two clips share.
    const ranged = clickSelection(
      timeline,
      { clipIds: [], transitionId: null },
      { kind: "clip", clip: clipB },
      "add",
      ids.clipA,
    );
    expect(ranged.clipIds).toEqual([ids.clipA, ids.clipB]);

    const toggled = clickSelection(
      timeline,
      { clipIds: [ids.clipA, ids.clipB], transitionId: null },
      { kind: "clip", clip: clipB },
      "toggle",
      ids.clipA,
    );
    expect(toggled.clipIds).toEqual([ids.clipA]);
    expect(toggled.transitionId).toBeNull();

    // A click on another row's clip has no range to reach from here.
    const otherRow = clickSelection(
      timeline,
      { clipIds: [], transitionId: null },
      { kind: "clip", clip: timeline.clips.find((c) => c.id === ids.clipD)! },
      "add",
      ids.clipA,
    );
    expect(otherRow.clipIds).toEqual([ids.clipD]);

    const seam = clickSelection(
      timeline,
      { clipIds: [ids.clipA], transitionId: null },
      { kind: "transition", transition: timeline.transitions[0] },
      "replace",
      ids.clipA,
    );
    expect(seam).toEqual({ clipIds: [], transitionId: ids.transition });

    const cleared = clickSelection(
      timeline,
      { clipIds: [ids.clipA], transitionId: null },
      { kind: "empty", trackId: ids.videoTrack },
      "replace",
      ids.clipA,
    );
    expect(cleared).toEqual({ clipIds: [], transitionId: null });
  });

  it("reads the chosen clips, the crossing clips and a whole-track range", () => {
    const ids = cutFixtureIds();
    open(buildCutMokaFile(), { timelineId: ids.timeline });
    const timeline = cut();

    expect(
      selectedClips(timeline, {
        clipIds: [ids.clipD, ids.clipA],
        transitionId: null,
      }).map((clip) => clip.id),
    ).toEqual([ids.clipA, ids.clipD]);
    // Crossing skips the locked audio row.
    expect(
      clipsCrossingPlayhead(timeline, 1_000).map((clip) => clip.id),
    ).toEqual([ids.clipA, ids.clipD]);
    expect(rangeBetween(timeline, ids.clipA, ids.clipB)).toEqual([
      ids.clipA,
      ids.clipB,
    ]);
    expect(rangeBetween(timeline, ids.clipA, ids.clipD)).toBeNull();

    selectAll();
    expect(useClipStore.getState().selection.clipIds).toEqual(
      timeline.clips.map((clip) => clip.id),
    );
  });
});

describe("nearestClipEdgeMs", () => {
  it("steps to the next edge that way, and past one it already stands on", () => {
    const ids = cutFixtureIds();
    open(buildCutMokaFile(), { timelineId: ids.timeline });
    const timeline = cut();

    expect(nearestClipEdgeMs(timeline, 3_000, 1)).toBe(3_500);
    expect(nearestClipEdgeMs(timeline, 3_000, -1)).toBe(2_000);
    expect(nearestClipEdgeMs(timeline, 2_000, -1)).toBe(0);
    expect(nearestClipEdgeMs(timeline, 2_000, 1)).toBe(3_500);
    expect(nearestClipEdgeMs(timeline, 9_000, 1)).toBeNull();
    expect(nearestClipEdgeMs(timeline, 0, -1)).toBeNull();

    // A row that is hidden draws nothing, so its edges are not places to go.
    const hidden: TimelineDocument = {
      ...timeline,
      tracks: timeline.tracks.map((track) =>
        track.id === ids.textTrack ? { ...track, hidden: true } : track,
      ),
    };
    expect(nearestClipEdgeMs(hidden, 3_000, -1)).toBe(0);
  });

  it("has nowhere to go on a cut with no clips", () => {
    const ids = timelineIds();
    const moka = buildTimelineMokaFile();
    moka.timelines![0].clips = [];
    open(moka, { timelineId: ids.timeline });

    expect(nearestClipEdgeMs(cut(), 0, 1)).toBeNull();
    expect(nearestClipEdgeMs(cut(), 5_000, -1)).toBeNull();
  });
});

describe("the guard rails", () => {
  it("refuses an edit that would touch a locked row", () => {
    const ids = cutFixtureIds();
    open(buildCutMokaFile(), {
      timelineId: ids.timeline,
      clipIds: [ids.clipC],
    });

    deleteSelection();

    expect(cut().clips.map((clip) => clip.id)).toContain(ids.clipC);
    expect(messages()).toEqual(["That track is locked"]);
    expect(entryCount()).toBe(0);
  });
});

describe("what a clip's material allows", () => {
  it("reads a measured file's end and the open bound of one nobody measured", () => {
    const ids = timelineIds();
    open(buildTimelineMokaFile(), { timelineId: ids.timeline });
    expect(materialOf(cut().clips[0])).toEqual({
      ownClock: false,
      durationMs: 4_000,
      unprobed: false,
    });

    const bare = buildTimelineMokaFile();
    delete bare.resources.videos[0].probe;
    open(bare, { timelineId: ids.timeline });
    expect(materialOf(cut().clips[0])).toEqual({
      ownClock: false,
      durationMs: null,
      unprobed: true,
    });
  });
});

describe("the rows themselves", () => {
  it("turns one switch as one step of history", () => {
    const ids = timelineIds();
    const original = open(buildTimelineMokaFile(), {
      timelineId: ids.timeline,
    });
    setTrackFlag(cut(), ids.videoTrack, "muted", true);
    expect(cut().tracks.find((row) => row.id === ids.videoTrack)).toMatchObject(
      {
        muted: true,
        locked: false,
      },
    );
    expect(entryCount()).toBe(1);

    undo();
    expect(useProjectStore.getState().moka).toEqual(original);
  });

  it("adds a row of the kind asked for, named past the ones taken", () => {
    const ids = timelineIds();
    open(buildTimelineMokaFile(), { timelineId: ids.timeline });
    addTrackOfKind(cut(), "audio");
    const tracks = cut().tracks;
    expect(tracks).toHaveLength(4);
    expect(tracks[3]).toMatchObject({ kind: "audio", name: "Audio 2" });
    expect(entryCount()).toBe(1);
  });

  it("refuses to take a row that still holds clips", () => {
    const ids = timelineIds();
    open(buildTimelineMokaFile(), { timelineId: ids.timeline });
    removeTrack(cut(), ids.videoTrack);
    expect(cut().tracks).toHaveLength(3);
    expect(messages()).toEqual(["That track still holds clips"]);
    expect(entryCount()).toBe(0);
  });

  it("renames a row, and does nothing at all for a name that is not one", () => {
    const ids = timelineIds();
    open(buildTimelineMokaFile(), { timelineId: ids.timeline });
    renameTrack(cut(), ids.textTrack, "  Titles  ");
    expect(cut().tracks.find((row) => row.id === ids.textTrack)?.name).toBe(
      "Titles",
    );
    renameTrack(cut(), ids.textTrack, "   ");
    expect(cut().tracks.find((row) => row.id === ids.textTrack)?.name).toBe(
      "Titles",
    );
    expect(entryCount()).toBe(1);
  });
});

describe("tidying a selection", () => {
  /** The golden cut with a second video row, the two heads six seconds apart. */
  function twoRows(): MokaFile {
    const moka = buildTimelineMokaFile();
    const timeline = moka.timelines![0];
    timeline.tracks = [
      ...timeline.tracks,
      {
        id: "track-video-2",
        kind: "video",
        name: "Video 2",
        muted: false,
        hidden: false,
        locked: false,
        createdAt: NOW,
      },
    ];
    timeline.clips = [
      ...timeline.clips,
      {
        ...timeline.clips[0],
        id: "clip-two",
        trackId: "track-video-2",
        startMs: 6_000,
      },
    ];
    return moka;
  }

  it("moves a chosen pair onto the earliest head as one step", () => {
    const ids = timelineIds();
    open(twoRows(), {
      timelineId: ids.timeline,
      clipIds: [ids.videoClip, "clip-two"],
    });
    alignSelection("left");
    expect(cut().clips.map((clip) => clip.startMs)).toEqual([0, 0]);
    expect(lastEntry().label).toBe("Align left");
    expect(entryCount()).toBe(1);
  });

  it("sends nothing when the heads already stand together", () => {
    const ids = timelineIds();
    const moka = twoRows();
    moka.timelines![0].clips = moka.timelines![0].clips.map((clip) => ({
      ...clip,
      startMs: 0,
    }));
    open(moka, {
      timelineId: ids.timeline,
      clipIds: [ids.videoClip, "clip-two"],
    });
    alignSelection("left");
    expect(entryCount()).toBe(0);
  });

  it("says so when a chosen clip sits on a locked row", () => {
    const ids = cutFixtureIds();
    open(buildCutMokaFile(), {
      timelineId: ids.timeline,
      clipIds: [ids.clipA, ids.clipC],
    });
    alignSelection("left");
    expect(messages()).toEqual(["That track is locked"]);
    expect(entryCount()).toBe(0);
  });
});
